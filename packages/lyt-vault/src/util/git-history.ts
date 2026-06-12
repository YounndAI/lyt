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

// v1.C.4 — git-history primitive used by `lyt repair --apply` to restore
// an unparseable mesh.yon from the last-known-good revision in Git
// (federation-design §11:521 "offer to restore from last-known-good in
// Git history"). Mirrors the `GhExecutor` injectable-executor pattern
// from util/gh-discover.ts so tests can substitute a fake without
// reaching into the real `git` binary.
//
// Two responsibilities:
// 1. Enumerate the SHA revisions that touched the mesh.yon path in
// the main vault's git repo, newest first (`git log --pretty=%H -- <rel>`).
// 2. Materialize the file content at a given SHA (`git show <sha>:<rel>`).
//
// Both helpers run the `git` binary scoped to the vault directory via the
// child_process spawn `cwd` option; no shell, no string interpolation.

export interface GitExecutor {
  (args: readonly string[], opts: { cwd: string }): Promise<string>;
}

const defaultGit: GitExecutor = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
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
            "`git` CLI not found on PATH. Install Git ≥ 2.40 from https://git-scm.com/downloads. " +
              "lyt repair --apply needs `git` to restore mesh.yon from history.",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });

export function getDefaultGitExecutor(): GitExecutor {
  return defaultGit;
}

// Enumerate every revision that touched `<vaultPath>/.lyt/mesh.yon`, newest
// first. Returns the bare 40-char SHA list (one per array entry). Empty
// array = the file has no history at this path (uncommitted vault, or
// path-rename without --follow). Caller surfaces the empty case as
// GitHistoryEmptyError.
export async function enumerateMeshYonRevisions(opts: {
  mainVaultPath: string;
  git?: GitExecutor;
}): Promise<string[]> {
  const git = opts.git ?? defaultGit;
  const raw = await git(["log", "--pretty=%H", "--", ".lyt/mesh.yon"], { cwd: opts.mainVaultPath });
  const shas: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    shas.push(trimmed);
  }
  return shas;
}

// Read the on-disk content of `<vaultPath>/.lyt/mesh.yon` at the given
// revision. Throws if `git show <sha>:.lyt/mesh.yon` fails (bad SHA, path
// not present at that SHA, etc.) — caller wraps for structured error.
export async function readMeshYonAtRevision(opts: {
  mainVaultPath: string;
  sha: string;
  git?: GitExecutor;
}): Promise<string> {
  const git = opts.git ?? defaultGit;
  return await git(["show", `${opts.sha}:.lyt/mesh.yon`], { cwd: opts.mainVaultPath });
}
