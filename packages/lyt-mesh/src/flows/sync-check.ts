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
  isAccessRemoved,
  listVaults,
  openRegistry,
  readFrozenLock,
  realIdentityRunner,
  runGit as defaultRunGit,
  updateVaultStatus,
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
  // A6-1 (0.12.0 Phase D fix-pass) — the current gh-auth verdict, consulted ONLY
  // on a fetch-404, so an unauthed/expired 404 is not mistaken for a revoke.
  // Defaults to the real `gh auth status`; injectable for deterministic tests.
  ghAuthOk?: () => boolean | null;
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
  // A6-1 (0.12.0 Phase D fix-pass) — gh-auth verdict, consulted only on a fetch-404.
  const ghAuthOk = args.ghAuthOk ?? (() => realIdentityRunner.ghAuthStatus());
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
  // 0.12.0 Phase D · A6 — vaults whose fetch proved access-loss; persisted to the
  // registry after the loop so `vault info` reflects `access_lost`.
  const accessLostRids: Uint8Array[] = [];
  // A6-2 (0.12.0 Phase D fix-pass) — previously-`access_lost` vaults whose fetch
  // now SUCCEEDS (a re-granted share); recovered to `active` after the loop.
  const recoveredRids: Uint8Array[] = [];
  // A6-2 — a `still access_lost` report shape (the vault couldn't be reached to
  // confirm recovery); mirrors the pre-fix skip report for a non-active vault.
  const pushStillAccessLost = (v: VaultRow): void => {
    reports.push({
      rid: v.ridHex,
      name: v.name,
      path: v.path,
      status: "access_lost",
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      hasUpstream: false,
      frozen: false,
      frozenUntil: null,
      remaining: null,
      vaultStatus: "access_lost",
    });
  };
  for (const v of candidates) {
    // A6-2 — an `access_lost` vault is NO LONGER skipped outright: it is re-checked
    // so a re-granted share can recover to `active`. Other non-active statuses
    // (disconnected / tombstoned / missing) still skip — nothing to re-check.
    if (v.status !== "active" && v.status !== "access_lost") {
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
    // A6-2 — recovery signal: a previously-`access_lost` vault whose fetch now
    // succeeds. Drives the effective vault status for this report + the post-loop
    // registry recovery persist.
    let recovered = false;
    if (hasUpstream && args.noFetch !== true) {
      const fetched = await runGit(["fetch", "--quiet"], { cwd: v.path, allowFailure: true });
      // 0.12.0 Phase D · A6 — a `Repository not found` / 404 on fetch means our
      // access was revoked (or the repo deleted). `sync --check` is the surface
      // that previously reported a stale `active`; surface (and persist) the
      // definite `access_lost` instead. `isAccessRemoved` excludes offline
      // signals so a disconnected machine is never mis-flagged.
      //
      // A6-1 fix-pass — auth-gate the 404: the same not-found under logged-out /
      // expired / SSO-unauthorized creds is a FIXABLE auth state, not a revoke, so
      // it must NOT flip a vault to `access_lost`.
      if (fetched.code !== 0) {
        if (isAccessRemoved(fetched.stderr, { ghAuthOk: ghAuthOk() })) {
          if (v.status !== "access_lost") accessLostRids.push(v.rid);
          reports.push({
            rid: v.ridHex,
            name: v.name,
            path: v.path,
            status: "access_lost",
            ahead: 0,
            behind: 0,
            dirtyCount: 0,
            hasUpstream,
            frozen: isFrozen,
            frozenUntil: frozen.frozenUntil,
            remaining: frozen.remaining,
            vaultStatus: "access_lost",
          });
          continue;
        }
        // Fetch failed for a non-revoke reason (offline / transient / unauthed
        // 404). A vault that was already `access_lost` can't be confirmed
        // recovered here — keep reporting `access_lost` (unchanged). An `active`
        // vault falls through to the ahead/behind read from cached refs (pre-fix
        // behaviour).
        if (v.status === "access_lost") {
          pushStillAccessLost(v);
          continue;
        }
      } else if (v.status === "access_lost") {
        // A6-2 — the fetch SUCCEEDED for a previously-lost vault: access recovered.
        recovered = true;
        recoveredRids.push(v.rid);
      }
    } else if (v.status === "access_lost") {
      // No fetch was performed (no upstream, or --no-fetch) — recovery can't be
      // confirmed, so keep reporting the last-known `access_lost`.
      pushStillAccessLost(v);
      continue;
    }
    // A6-2 — a recovered vault reports as `active` from here on; an already-active
    // vault is unchanged. (A non-recovered `access_lost` vault has `continue`d.)
    const effectiveVaultStatus: string = recovered ? "active" : v.status;
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
      vaultStatus: effectiveVaultStatus,
    });
  }

  // 0.12.0 Phase D · A6 — persist detected access-loss (best-effort; a persist
  // hiccup never fails a read-only check — the report already carries the state).
  if (accessLostRids.length > 0) {
    const persistDb = await openRegistry();
    try {
      for (const rid of accessLostRids) {
        try {
          await updateVaultStatus(persistDb, rid, "access_lost");
        } catch {
          // non-fatal
        }
      }
    } finally {
      await closeRegistry(persistDb);
    }
  }

  // A6-2 (0.12.0 Phase D fix-pass) — persist recovery for previously-lost vaults
  // whose fetch now succeeds, so `vault info` / a follow-up check stop reporting a
  // stale "no access". Best-effort; a persist hiccup never fails the check.
  if (recoveredRids.length > 0) {
    const persistDb = await openRegistry();
    try {
      for (const rid of recoveredRids) {
        try {
          await updateVaultStatus(persistDb, rid, "active");
        } catch {
          // non-fatal
        }
      }
    } finally {
      await closeRegistry(persistDb);
    }
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
    else if (r.status === "dirty-behind") {
      // A2a fix — a dirty+behind subscriber is BOTH unsaved and has updates to
      // receive, so it counts under both breakdown categories. The `dirty-behind`
      // status is why `needsSync` (printCheckHuman) counts DISTINCT reports rather
      // than summing these counters — otherwise this vault would be double-counted
      // in the headline "N vault(s) need sync".
      summary.dirty += 1;
      summary.behind += 1;
    } else if (r.status.startsWith("ahead-")) summary.ahead += 1;
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
