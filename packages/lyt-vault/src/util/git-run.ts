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

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  cwd: string;
  // When true, a non-zero exit doesn't throw — caller inspects `code`.
  allowFailure?: boolean;
  // Extra environment entries merged over process.env (e.g. GIT_INDEX_FILE
  // for temp-index plumbing in snapshot's working-tree capture — F11).
  env?: Record<string, string>;
}

export function runGit(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
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
        reject(new Error("`git` not found on PATH. Install Git: https://git-scm.com/."));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      const result: GitRunResult = { code: code ?? -1, stdout, stderr };
      if ((code ?? -1) !== 0 && opts.allowFailure !== true) {
        reject(
          new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`),
        );
        return;
      }
      resolve(result);
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(["rev-parse", "--git-dir"], { cwd, allowFailure: true });
  return r.code === 0;
}

export interface PorcelainStatus {
  clean: boolean;
  dirtyCount: number;
  lines: string[];
}

export async function gitStatusPorcelain(cwd: string): Promise<PorcelainStatus> {
  const r = await runGit(["status", "--porcelain"], { cwd });
  const lines = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return { clean: lines.length === 0, dirtyCount: lines.length, lines };
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const r = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return r.stdout.trim();
}

export async function getDefaultBranch(cwd: string): Promise<string> {
  // Prefer origin/HEAD symbolic ref; fall back to current branch.
  const r = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
    cwd,
    allowFailure: true,
  });
  if (r.code === 0) {
    const ref = r.stdout.trim();
    const idx = ref.lastIndexOf("/");
    if (idx >= 0) return ref.slice(idx + 1);
  }
  return getCurrentBranch(cwd);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const r = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd,
    allowFailure: true,
  });
  return r.code === 0;
}

export async function hasUpstream(cwd: string): Promise<boolean> {
  const r = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd,
    allowFailure: true,
  });
  return r.code === 0;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export async function aheadBehind(cwd: string): Promise<AheadBehind | null> {
  const r = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
    cwd,
    allowFailure: true,
  });
  if (r.code !== 0) return null;
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length < 2) return { ahead: 0, behind: 0 };
  return { ahead: Number(parts[0]) || 0, behind: Number(parts[1]) || 0 };
}

export interface BranchInfo {
  branch: string;
  timestamp: string;
  label: string | null;
  sha: string;
  subject: string;
}

export async function listBranchesWithPrefix(cwd: string, prefix: string): Promise<BranchInfo[]> {
  // Sort by refname descending — the embedded ISO timestamp in branch names
  // (lyt-snapshot/<YYYY-MM-DDTHH-mm-ss>[-<slug>]) sorts lexically, so newer
  // snapshots come first. Falls back to committerdate sort only when branch
  // names don't follow the prefix scheme — but listBranchesWithPrefix only
  // returns branches with the prefix, so refname ordering is the right primary.
  const r = await runGit(
    [
      "for-each-ref",
      "--sort=-refname",
      "--format=%(refname:short)|%(committerdate:iso-strict)|%(objectname:short)|%(subject)",
      `refs/heads/${prefix}*`,
    ],
    { cwd },
  );
  const out: BranchInfo[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split("|");
    const branch = parts[0];
    const isoDate = parts[1];
    const sha = parts[2];
    if (!branch || !sha) continue;
    // Branch shape: <prefix><YYYY-MM-DDTHH-mm-ss>[-<slug>]
    const after = branch.startsWith(prefix) ? branch.slice(prefix.length) : branch;
    const m = after.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2})(?:-(.+))?$/);
    const timestamp = m ? m[1]! : (isoDate ?? "");
    const label = m && m[2] ? m[2]! : null;
    out.push({
      branch,
      timestamp,
      label,
      sha,
      subject: parts.slice(3).join("|"),
    });
  }
  return out;
}

export function timestampForBranchName(now: Date = new Date()): string {
  // YYYY-MM-DDTHH-mm-ss (filesystem/branch-safe ISO variant)
  const iso = now.toISOString();
  return iso.slice(0, 19).replace(/:/g, "-");
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
