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

import { resolveSpawnInvocation } from "./gh-federation.js";

// v1.C.3 — gh CLI client surface for `lyt discover` + `lyt mesh adopt`.
//
// Three responsibilities:
// 1. Walk the authenticated user's accessible repos via `gh api /user/repos
// --paginate` (mirrors lyt-mesh's `discovery/github.ts` walkGithub
// shape — we keep an in-package copy because lyt-vault has NO dep on
// lyt-mesh per package.json:* and adding one would create a cycle
// (lyt-mesh depends on lyt-vault). Brief default proposed reuse;
// cycle prevents it. v1.C.3 picks alt — new lyt-vault helper.
// 2. Fetch a candidate repo's `.lyt/vault.yon` via the GitHub Contents
// API (`gh api /repos/<owner>/<repo>/contents/.lyt/vault.yon --jq
// .content`). The response is base64-encoded; we decode + return the
// raw vault.yon string. Missing file (404) returns null so the caller
// can skip non-Lyt repos silently.
// 3. Probe the user's push permission to a target repo via `gh repo view
// <owner>/<repo> --json viewerPermission --jq .viewerPermission`. The
// probe gates `lyt mesh adopt --cluster` (master-plan §v1.C.3:643 +
// federation-design §11:512).
//
// Test seam: GhExecutor matches the lyt-mesh shape verbatim — `(args:
// readonly string[]) => Promise<string>` — so a single fake-gh router
// covers walk + fetch + push-probe.

export interface GhExecutor {
  (args: readonly string[]): Promise<string>;
}

export interface DiscoveredRepo {
  host: string;
  owner: string;
  name: string;
  cloneUrl: string;
  sshUrl: string;
  isPrivate: boolean;
  topics: readonly string[];
}

const defaultGh: GhExecutor = (args) =>
  new Promise((resolve, reject) => {
    // V-B-9: resolve the win32 gh invocation (.exe direct / .cmd shell-quoted)
    // so the push-permission probe doesn't ENOENT on Windows → writable:unknown.
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
              "lyt discover requires `gh` for `gh api` access.",
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

export function getDefaultGhExecutor(): GhExecutor {
  return defaultGh;
}

// Walk all repos accessible to the authenticated user; filter to those
// owned by `ownerLower` (case-insensitive). Mirrors lyt-mesh walkGithub's
// `gh api /user/repos --paginate` + jq projection. Throws GhUnavailableError
// when `gh` isn't installed; caller decides whether to surface vs. wrap.
export async function walkUserRepos(opts: {
  owner: string;
  gh?: GhExecutor;
}): Promise<DiscoveredRepo[]> {
  const gh = opts.gh ?? defaultGh;
  const ownerLower = opts.owner.toLowerCase();
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
        `Failed to parse gh /user/repos output line as JSON: ${(err as Error).message}\nLine: ${trimmed}`,
      );
    }
    if (parsed.owner.toLowerCase() !== ownerLower) continue;
    repos.push(parsed);
  }
  return repos;
}

// Fetch `.lyt/vault.yon` content from a GH repo via the Contents API.
// Returns the raw decoded file content on success; null on 404 (not a
// Lyt vault). Other errors propagate to the caller.
export async function fetchVaultYonContent(opts: {
  owner: string;
  repo: string;
  gh?: GhExecutor;
}): Promise<string | null> {
  const gh = opts.gh ?? defaultGh;
  let raw: string;
  try {
    raw = await gh([
      "api",
      `/repos/${opts.owner}/${opts.repo}/contents/.lyt/vault.yon`,
      "--jq",
      ".content",
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // gh exits non-zero with stderr containing "Not Found" for 404. Treat
    // as "this repo isn't a Lyt vault" — return null, don't propagate.
    if (/HTTP 404|Not Found|not found/.test(msg)) return null;
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // GH Contents API returns base64 with embedded newlines.
  const compact = trimmed.replace(/\s+/g, "");
  let decoded: string;
  try {
    decoded = Buffer.from(compact, "base64").toString("utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to base64-decode .lyt/vault.yon for ${opts.owner}/${opts.repo}: ${msg}`,
    );
  }
  if (decoded.length === 0) return null;
  return decoded;
}

// Push permissions that imply write access. GitHub's permission ladder is
// ADMIN > MAINTAIN > WRITE > TRIAGE > READ (+ NONE / null). The first three
// can push; the rest cannot.
const PUSH_CAPABLE_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

// Probe the user's push permission via `gh repo view ... --json
// viewerPermission`. Returns boolean. Throws on gh failure other than 404 (a
// 404 here would mean the repo doesn't exist — surface as `false` so the adopt
// path refuses cleanly).
//
// V-B-9b (2026-06-10): the prior query asked for `--json viewerCanPush`, a
// field `gh repo view` does NOT expose (gh 2.78.0 rejects it: "Unknown JSON
// field: viewerCanPush"). That threw on EVERY platform → caught by
// deriveVaultWritable → `writable` pinned to "unknown" via the gh path. The
// supported field is `viewerPermission` (the GitHub permission string); we map
// ADMIN/MAINTAIN/WRITE → pushable, everything else (TRIAGE/READ/NONE/empty) →
// not. Windows ENOENT (the bare-`spawn("gh")` V-B-9 papercut) previously
// masked this; once the spawn launched, the bad field surfaced.
export async function checkPushPermission(opts: {
  owner: string;
  repo: string;
  gh?: GhExecutor;
}): Promise<boolean> {
  const gh = opts.gh ?? defaultGh;
  let raw: string;
  try {
    raw = await gh([
      "repo",
      "view",
      `${opts.owner}/${opts.repo}`,
      "--json",
      "viewerPermission",
      "--jq",
      ".viewerPermission",
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Repo doesn't exist (or user can't see it) → no push permission.
    if (/HTTP 404|Not Found|could not resolve to a Repository/i.test(msg)) {
      return false;
    }
    throw err;
  }
  return PUSH_CAPABLE_PERMISSIONS.has(raw.trim().toUpperCase());
}
