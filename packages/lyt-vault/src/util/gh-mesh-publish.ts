/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFileSync } from "node:child_process";

import { inspectGhError } from "./gh-federation.js";

// v1.B.6 — injectable client for the publish-mesh GH surface. Mirrors
// `util/gh-mesh.ts` (v1.B.1) and `util/gh-federation.ts` (v1.A.0) —
// same interface + real-via-shell + fake-with-recordedCalls shape. Tests
// pass `makeFakePublishGhClient()` so the publish flow can be exercised
// end-to-end without hitting real `gh`.
//
// Surface (v1.B.6):
// - setRepoTopic(handle, repo, topic): adds a topic to a GH repo via
// `gh repo edit <handle>/<repo> --add-topic <topic>`. Used by
// `lyt mesh publish` to mark the mesh main vault's repo with the
// `lyt-public` topic for discovery via `gh search repos --topic lyt-public`.
// - getRemoteFileContent(handle, repo, path): fetches a file's content
// from a remote GH repo WITHOUT cloning, via `gh api
// repos/<handle>/<repo>/contents/<path>`. Used by `lyt mesh info --remote`
// to peek at a remote mesh.yon before subscribing.
//
// Graceful degradation: setRepoTopic logs and returns false-ish state when
// gh is unavailable (per the ratified default — publishers may be offline pre-gh;
// publish doesn't block on topic-set failure unless --strict is passed).
// getRemoteFileContent returns null on 404 (the legitimate "not found" case)
// and throws on other gh-cli failures (auth, network, etc.) — mirrors
// gh-federation.ts's inspectGhError classification.

export interface PublishGhClient {
  // Set a topic on a GH repo. Returns true on success; false when gh is
  // unavailable or the call fails non-fatally. --strict callers should
  // treat false as fail-the-publish.
  setRepoTopic(handle: string, repo: string, topic: string): Promise<boolean>;
  // Fetch a file's content from a remote GH repo without cloning.
  // Returns the file's UTF-8 decoded content, or null on HTTP 404
  // (the legitimate "not found" case — caller decides how to surface).
  // Throws on auth/network/other failures so the caller can distinguish
  // "absent" from "couldn't reach".
  getRemoteFileContent(handle: string, repo: string, path: string): Promise<string | null>;
}

const isWindows = process.platform === "win32";

function runGhStdout(args: readonly string[]): string {
  return execFileSync("gh", args as string[], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
  });
}

function runGhSilent(args: readonly string[]): void {
  execFileSync("gh", args as string[], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: isWindows,
  });
}

export const realPublishGhClient: PublishGhClient = {
  async setRepoTopic(handle, repo, topic): Promise<boolean> {
    try {
      runGhSilent(["repo", "edit", `${handle}/${repo}`, "--add-topic", topic]);
      return true;
    } catch (err) {
      // Per graceful-degrade: log a warning + return false. --strict
      // callers convert false to a hard fail.
      const { summary } = inspectGhError(err);
      // eslint-disable-next-line no-console
      console.warn(
        `lyt mesh publish: gh repo edit --add-topic failed for ${handle}/${repo} (${summary}); continuing without setting topic.`,
      );
      return false;
    }
  },

  async getRemoteFileContent(handle, repo, path): Promise<string | null> {
    try {
      // `gh api /repos/<o>/<r>/contents/<path>` returns JSON with
      // base64-encoded `content` field per the GitHub Contents API
      // (https://docs.github.com/en/rest/repos/contents#get-repository-content).
      const stdout = runGhStdout(["api", `/repos/${handle}/${repo}/contents/${path}`]);
      const payload = JSON.parse(stdout) as { content?: string; encoding?: string };
      if (payload.encoding !== "base64" || typeof payload.content !== "string") {
        throw new Error(
          `lyt mesh info --remote: gh api returned unexpected content shape (encoding=${payload.encoding ?? "<missing>"})`,
        );
      }
      // GH returns the base64 with embedded newlines; Buffer.from tolerates them.
      return Buffer.from(payload.content, "base64").toString("utf8");
    } catch (err) {
      const { is404, summary } = inspectGhError(err);
      if (is404) return null;
      throw new Error(
        `realPublishGhClient.getRemoteFileContent(${handle}/${repo}/${path}): ${summary}`,
      );
    }
  },
};

// Test seam — fake client recording calls + serving canned content. Tests
// inject this via `publishMeshFlow({ ghClient: makeFakePublishGhClient(...) })`.
export interface FakePublishGhClientInit {
  // Map of "<handle>/<repo>/<path>" → file content (or null to simulate 404).
  seedRemoteFiles?: ReadonlyMap<string, string | null>;
  // When true, every setRepoTopic call returns false (simulates gh-down).
  setRepoTopicShouldFail?: boolean;
  // When true, every getRemoteFileContent call throws (simulates network down).
  getRemoteFileContentShouldThrow?: boolean;
}

export interface FakePublishGhClient extends PublishGhClient {
  readonly setTopicCalls: ReadonlyArray<{ handle: string; repo: string; topic: string }>;
  readonly getContentCalls: ReadonlyArray<{ handle: string; repo: string; path: string }>;
}

export function makeFakePublishGhClient(init: FakePublishGhClientInit = {}): FakePublishGhClient {
  const setTopicCalls: { handle: string; repo: string; topic: string }[] = [];
  const getContentCalls: { handle: string; repo: string; path: string }[] = [];
  const seedRemoteFiles = init.seedRemoteFiles ?? new Map<string, string | null>();

  return {
    setTopicCalls,
    getContentCalls,
    async setRepoTopic(handle, repo, topic): Promise<boolean> {
      setTopicCalls.push({ handle, repo, topic });
      if (init.setRepoTopicShouldFail === true) return false;
      return true;
    },
    async getRemoteFileContent(handle, repo, path): Promise<string | null> {
      getContentCalls.push({ handle, repo, path });
      if (init.getRemoteFileContentShouldThrow === true) {
        throw new Error(`makeFakePublishGhClient: simulated gh-down for ${handle}/${repo}/${path}`);
      }
      const key = `${handle}/${repo}/${path}`;
      return seedRemoteFiles.has(key) ? (seedRemoteFiles.get(key) ?? null) : null;
    },
  };
}
