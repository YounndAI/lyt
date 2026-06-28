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

export interface GhRepoInfo {
  description: string;
  topics: string[];
  isAdmin: boolean;
}

export interface GhClient {
  getRepo(owner: string, name: string): Promise<GhRepoInfo>;
  editRepo(
    owner: string,
    name: string,
    description: string,
    topics: readonly string[],
  ): Promise<void>;
}

export const realGhClient: GhClient = {
  async getRepo(owner, name): Promise<GhRepoInfo> {
    const raw = execFileSync("gh", ["api", `/repos/${owner}/${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const description =
      typeof parsed["description"] === "string" ? (parsed["description"] as string) : "";
    const topics = Array.isArray(parsed["topics"]) ? (parsed["topics"] as string[]) : [];
    const permissions = (parsed["permissions"] as Record<string, unknown> | undefined) ?? {};
    const isAdmin = permissions["admin"] === true;
    return { description, topics, isAdmin };
  },

  async editRepo(owner, name, description, topics): Promise<void> {
    // NOTE (Phase E release review): this is `--add-topic`-only — additive, never
    // removes. That's the load-bearing assumption behind the union-not-clobber
    // drift logic (sync-metadata.ts). It also means REVERSAL is unbuilt: un-
    // publishing a vault cannot strip `lyt-public` here. A proper un-publish
    // needs a `--remove-topic` capability and MUST ship WITH the conscious-public
    // flip (see PUBLIC_VAULT_TOPICS in scaffold/github-defaults.ts, gap #2).
    const args = ["repo", "edit", `${owner}/${name}`, "--description", description];
    for (const t of topics) {
      args.push("--add-topic", t);
    }
    execFileSync("gh", args, { stdio: ["ignore", "ignore", "pipe"] });
  },
};

export function parseOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
  let s = url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[\\/]+$/, "");
  if (s.length === 0) return null;

  let pathPart: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(.*)$/i);
    pathPart = m?.[1] ?? "";
  } else if (/^[^@/\\]+@[^:]+:/.test(s)) {
    pathPart = s.replace(/^[^@/\\]+@[^:]+:/, "");
  } else {
    pathPart = s;
  }

  pathPart = pathPart.replace(/^[\\/]+/, "");
  const segments = pathPart.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 2) return null;
  return { owner: segments[segments.length - 2]!, repo: segments[segments.length - 1]! };
}
