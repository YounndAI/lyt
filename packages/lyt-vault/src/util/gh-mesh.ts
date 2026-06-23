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
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { resolveRemoteUrl } from "./remote-url.js";

// v1.B.1 — injectable client for mesh-repo GH + git operations. Mirrors
// `util/gh-federation.ts` (v1.A.0) — same shape, different surface. Real
// impl shells out via `gh` + `git`; tests pass a fake (FakeMeshGhClient)
// that records calls + simulates filesystem effects.
//
// Surface (v1.B.1):
// - cloneRepo(handle, repoName, localDir) — `git clone` an existing mesh-main repo
// - pushRepo(localDir, remoteName, branch) — `git push -u origin main`
// - repoExists(handle, repoName) — probe via `gh api /repos/<owner>/<repo>`
//
// `lyt mesh init --push` flow uses pushRepo after the main vault is
// scaffolded + initial commit lands (scaffold/init.ts handles the
// pre-push `git init` + initial commit when commitInitial=true).
// `lyt mesh join --from <gh-target>` uses cloneRepo to materialise the
// main vault locally before reading its `.lyt/mesh.yon`.

export interface MeshGhClient {
  repoExists(handle: string, repoName: string): Promise<boolean>;
  cloneRepo(handle: string, repoName: string, localDir: string): Promise<void>;
  pushRepo(localDir: string): Promise<void>;
}

const isWindows = process.platform === "win32";

function runGh(args: readonly string[]): string {
  return execFileSync("gh", args as string[], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
  });
}

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync("git", args as string[], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    shell: isWindows,
  });
}

export const realMeshGhClient: MeshGhClient = {
  async repoExists(handle, repoName): Promise<boolean> {
    try {
      runGh(["api", `/repos/${handle}/${repoName}`]);
      return true;
    } catch {
      return false;
    }
  },

  async cloneRepo(handle, repoName, localDir): Promise<void> {
    mkdirSync(dirname(localDir), { recursive: true });
    const url = resolveRemoteUrl(handle, repoName);
    execFileSync("git", ["clone", url, localDir], {
      stdio: ["ignore", "ignore", "pipe"],
      shell: isWindows,
    });
    // Pin local-repo identity so subsequent commits never block on missing
    // global git config — mirrors gh-federation.ts cloneExisting guard.
    runGit(localDir, ["config", "user.name", handle]);
    runGit(localDir, ["config", "user.email", `${handle}@users.noreply.github.com`]);
  },

  async pushRepo(localDir): Promise<void> {
    if (!existsSync(localDir)) {
      throw new Error(`pushRepo: localDir does not exist: ${localDir}`);
    }
    runGit(localDir, ["push", "-u", "origin", "main"]);
  },
};
