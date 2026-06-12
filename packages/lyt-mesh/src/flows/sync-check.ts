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

import { existsSync } from "node:fs";

import {
  closeRegistry,
  listVaults,
  openRegistry,
  readFrozenLock,
  runGit as defaultRunGit,
  type GitRunOptions,
  type GitRunResult,
  type VaultRow,
} from "@younndai/lyt-vault";

import { classifyCheckStatus } from "./sync.js";

export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

export interface SyncCheckArgs {
  vaultNames?: readonly string[];
  runGit?: GitRunner;
  now?: Date;
  // Skip `git fetch` (faster but ahead/behind may be stale).
  noFetch?: boolean;
}

export interface VaultCheckReport {
  rid: string; // dashed-UUIDv7 hex (vault.ridHex) — render boundary; bytes never reach stdout
  name: string;
  path: string;
  status: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  hasUpstream: boolean;
  frozen: boolean;
  frozenUntil: string | null;
  remaining: string | null;
  vaultStatus: string;
}

export interface SyncCheckResult {
  reports: VaultCheckReport[];
  summary: {
    clean: number;
    dirty: number;
    ahead: number;
    behind: number;
    diverged: number;
    frozen: number;
    noUpstream: number;
    skippedNonActive: number;
  };
  exitCode: number;
}

export async function syncCheckFlow(args: SyncCheckArgs = {}): Promise<SyncCheckResult> {
  const runGit = args.runGit ?? defaultRunGit;
  const now = args.now ?? new Date();
  const db = await openRegistry();
  let candidates: VaultRow[];
  try {
    const all = await listVaults(db);
    candidates =
      args.vaultNames && args.vaultNames.length > 0
        ? all.filter((v) => args.vaultNames!.includes(v.name))
        : all;
  } finally {
    await closeRegistry(db);
  }

  const reports: VaultCheckReport[] = [];
  for (const v of candidates) {
    if (v.status !== "active") {
      reports.push({
        rid: v.ridHex,
        name: v.name,
        path: v.path,
        status: v.status,
        ahead: 0,
        behind: 0,
        dirtyCount: 0,
        hasUpstream: false,
        frozen: false,
        frozenUntil: null,
        remaining: null,
        vaultStatus: v.status,
      });
      continue;
    }
    if (!existsSync(v.path)) {
      reports.push({
        rid: v.ridHex,
        name: v.name,
        path: v.path,
        status: "missing",
        ahead: 0,
        behind: 0,
        dirtyCount: 0,
        hasUpstream: false,
        frozen: false,
        frozenUntil: null,
        remaining: null,
        vaultStatus: v.status,
      });
      continue;
    }
    const frozen = readFrozenLock(v.path, now);
    const isFrozen = frozen.frozen && !frozen.expired;

    const gitDir = await runGit(["rev-parse", "--git-dir"], { cwd: v.path, allowFailure: true });
    if (gitDir.code !== 0) {
      reports.push({
        rid: v.ridHex,
        name: v.name,
        path: v.path,
        status: "not-git-repo",
        ahead: 0,
        behind: 0,
        dirtyCount: 0,
        hasUpstream: false,
        frozen: isFrozen,
        frozenUntil: frozen.frozenUntil,
        remaining: frozen.remaining,
        vaultStatus: v.status,
      });
      continue;
    }
    const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: v.path,
      allowFailure: true,
    });
    const hasUpstream = upstream.code === 0;
    if (hasUpstream && args.noFetch !== true) {
      await runGit(["fetch", "--quiet"], { cwd: v.path, allowFailure: true });
    }
    let ahead = 0;
    let behind = 0;
    if (hasUpstream) {
      const ab = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
        cwd: v.path,
        allowFailure: true,
      });
      if (ab.code === 0) {
        const parts = ab.stdout.trim().split(/\s+/);
        ahead = Number(parts[0]) || 0;
        behind = Number(parts[1]) || 0;
      }
    }
    const statusRes = await runGit(["status", "--porcelain"], {
      cwd: v.path,
      allowFailure: true,
    });
    const dirtyCount =
      statusRes.code === 0
        ? statusRes.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0).length
        : 0;

    reports.push({
      rid: v.ridHex,
      name: v.name,
      path: v.path,
      status: classifyCheckStatus({
        ahead,
        behind,
        dirtyCount,
        hasUpstream,
        frozen: isFrozen,
      }),
      ahead,
      behind,
      dirtyCount,
      hasUpstream,
      frozen: isFrozen,
      frozenUntil: frozen.frozenUntil,
      remaining: frozen.remaining,
      vaultStatus: v.status,
    });
  }

  const summary = {
    clean: 0,
    dirty: 0,
    ahead: 0,
    behind: 0,
    diverged: 0,
    frozen: 0,
    noUpstream: 0,
    skippedNonActive: 0,
  };
  for (const r of reports) {
    if (r.vaultStatus !== "active") {
      summary.skippedNonActive += 1;
      continue;
    }
    if (r.status === "clean") summary.clean += 1;
    else if (r.status === "dirty") summary.dirty += 1;
    else if (r.status.startsWith("ahead-")) summary.ahead += 1;
    else if (r.status.startsWith("behind-")) summary.behind += 1;
    else if (r.status === "diverged") summary.diverged += 1;
    else if (r.status === "frozen") summary.frozen += 1;
    else if (r.status === "no-upstream") summary.noUpstream += 1;
  }

  const anyDirtyOrAheadOrBehind =
    summary.dirty > 0 || summary.ahead > 0 || summary.behind > 0 || summary.diverged > 0;
  // Exit codes mirror `lyt doctor`: 0 all clean, 1 needs sync, 2 frozen-near-expiry (advisory).
  let exitCode = 0;
  if (anyDirtyOrAheadOrBehind) exitCode = 1;
  // Near-expiry detection happens in caller (we don't recompute it here to keep flow pure).
  return { reports, summary, exitCode };
}
