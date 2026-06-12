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

import { spawn } from "node:child_process";

import { resolveSpawnInvocation } from "@younndai/lyt-vault";

import type { VaultSource } from "../source/types.js";

export interface DiscoveredRepo {
  host: string;
  owner: string;
  name: string;
  cloneUrl: string;
  sshUrl: string;
  isPrivate: boolean;
  topics: readonly string[];
}

export interface GhExecutor {
  (args: readonly string[]): Promise<string>;
}

const defaultGh: GhExecutor = (args) =>
  new Promise((resolve, reject) => {
    // V-B-9: same win32 gh resolution as lyt-vault's gh-discover — without it
    // the engine's gh-walk ENOENTs on Windows (`gh.cmd` shim won't launch).
    const inv = resolveSpawnInvocation("gh", args);
    const child = spawn(inv.command, inv.args as string[], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: inv.shell,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(
          new Error(
            "`gh` CLI not found on PATH. Install GitHub CLI: https://cli.github.com/. " +
              "lyt-mesh discovery requires `gh` for `gh api` access (the Search API misses private repos).",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });

export interface WalkGithubOptions {
  source: VaultSource;
  gh?: GhExecutor;
}

export async function walkGithub(opts: WalkGithubOptions): Promise<DiscoveredRepo[]> {
  const gh = opts.gh ?? defaultGh;
  const source = opts.source;
  const ownerLower = source.owner.toLowerCase();
  const raw = await gh([
    "api",
    "/user/repos",
    "--paginate",
    "-q",
    '.[] | {host: "github.com", owner: .owner.login, name: .name, cloneUrl: .clone_url, sshUrl: .ssh_url, isPrivate: .private, topics: (.topics // [])}',
  ]);
  const repos: DiscoveredRepo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: DiscoveredRepo;
    try {
      parsed = JSON.parse(trimmed) as DiscoveredRepo;
    } catch (err) {
      throw new Error(
        `Failed to parse gh output line as JSON: ${(err as Error).message}\nLine: ${trimmed}`,
      );
    }
    if (parsed.owner.toLowerCase() !== ownerLower) continue;
    if (!matchesScope(parsed, source.scope)) continue;
    repos.push(parsed);
  }
  return repos;
}

function matchesScope(repo: DiscoveredRepo, scope: VaultSource["scope"]): boolean {
  if (scope === "all") return true;
  if ("topic" in scope) {
    return repo.topics.includes(scope.topic);
  }
  return scope.repos.includes(repo.name);
}
