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

import {
  closeRegistry,
  listVaults,
  openRegistry,
  realIdentityRunner,
  runGitReadOnly,
  runGitRemoteObservation,
  type GitRunOptions,
  type GitRunResult,
  type VaultRow,
  type VaultSnapshot,
} from "@younndai/lyt-vault";

import {
  collectScopedSyncCheckObservations,
  evaluateScopedSyncCheck,
  planScopedSyncCheck,
} from "./scoped-sync-check.js";

export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

export interface SyncCheckArgs {
  vaultNames?: readonly string[];
  runGit?: GitRunner;
  now?: Date;
  // Skip online observation. The resulting remote state is intentionally unknown.
  noFetch?: boolean;
  ghAuthOk?: () => boolean | null;
}

export interface VaultCheckReport {
  rid: string;
  name: string;
  path: string;
  status: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  /** 0.20.16 explicit units; legacy fields above remain for one release. */
  aheadCommitCount: number;
  behindCommitCount: number;
  dirtyFileCount: number;
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
    dirtyVaultCount: number;
    aheadVaultCount: number;
    behindVaultCount: number;
    diverged: number;
    frozen: number;
    noUpstream: number;
    skippedNonActive: number;
  };
  exitCode: number;
}

export async function syncCheckFlow(args: SyncCheckArgs = {}): Promise<SyncCheckResult> {
  const local = args.runGit ?? runGitReadOnly;
  const remote =
    args.noFetch === true ? noRemoteObservation : (args.runGit ?? runGitRemoteObservation);
  const now = args.now ?? new Date();
  const ghAuthOk = args.ghAuthOk ?? (() => realIdentityRunner.ghAuthStatus());
  const db = await openRegistry();
  let candidates: VaultRow[];
  try {
    const all = await listVaults(db);
    candidates =
      args.vaultNames && args.vaultNames.length > 0
        ? all.filter((vault) => args.vaultNames!.includes(vault.name))
        : all;
  } finally {
    await closeRegistry(db);
  }

  const reports: VaultCheckReport[] = [];
  const summary = emptySummary();
  let exitCode = 0;
  for (const candidate of candidates) {
    const vault = snapshotFromRow(candidate);
    const plan = planScopedSyncCheck(Object.freeze({ kind: "one", vault }));
    const observed = await collectScopedSyncCheckObservations(plan, {
      runGitReadOnly: local,
      runGitRemoteObservation: remote,
      now: () => now,
      ghAuthOk,
    });
    const evaluated = evaluateScopedSyncCheck(vault, observed.local, observed.remote);
    const checked = evaluated.report;
    reports.push({
      rid: checked.rid,
      name: checked.name,
      path: checked.path,
      status: checked.status,
      ahead: checked.ahead ?? 0,
      behind: checked.behind ?? 0,
      dirtyCount: checked.dirtyCount ?? 0,
      aheadCommitCount: checked.aheadCommitCount ?? checked.ahead ?? 0,
      behindCommitCount: checked.behindCommitCount ?? checked.behind ?? 0,
      dirtyFileCount: checked.dirtyFileCount ?? checked.dirtyCount ?? 0,
      hasUpstream: checked.hasUpstream,
      frozen: checked.frozen,
      frozenUntil: checked.frozenUntil,
      remaining: checked.remaining,
      vaultStatus: checked.vaultStatus,
    });
    summary.clean += evaluated.summary.clean;
    summary.dirty += evaluated.summary.dirty;
    summary.ahead += evaluated.summary.ahead;
    summary.behind += evaluated.summary.behind;
    summary.dirtyVaultCount += (checked.dirtyFileCount ?? checked.dirtyCount ?? 0) > 0 ? 1 : 0;
    summary.aheadVaultCount += (checked.aheadCommitCount ?? checked.ahead ?? 0) > 0 ? 1 : 0;
    summary.behindVaultCount += (checked.behindCommitCount ?? checked.behind ?? 0) > 0 ? 1 : 0;
    summary.diverged += evaluated.summary.diverged;
    summary.frozen += evaluated.summary.frozen;
    summary.noUpstream += evaluated.summary.noUpstream;
    summary.skippedNonActive += evaluated.summary.skippedNonActive;
    if (evaluated.exitCode === 1) exitCode = 1;
    else if (evaluated.exitCode === 2 && exitCode === 0) exitCode = 2;
  }

  return { reports, summary, exitCode };
}

function snapshotFromRow(vault: VaultRow): VaultSnapshot {
  return Object.freeze({
    rid: vault.ridHex,
    canonicalName: vault.name,
    storedName: vault.name,
    path: vault.path,
    status: vault.status,
    source: vault.source,
    homeMesh: null,
    destination: Object.freeze({
      kind: vault.destinationKind,
      source: vault.destinationSource,
      target: vault.destinationTarget,
      targetKind: vault.destinationTargetKind,
      repositoryName: vault.destinationRepositoryName,
    }),
    gitUrl: vault.gitUrl,
  });
}

function emptySummary(): SyncCheckResult["summary"] {
  return {
    clean: 0,
    dirty: 0,
    ahead: 0,
    behind: 0,
    dirtyVaultCount: 0,
    aheadVaultCount: 0,
    behindVaultCount: 0,
    diverged: 0,
    frozen: 0,
    noUpstream: 0,
    skippedNonActive: 0,
  };
}

const noRemoteObservation: GitRunner = async () => ({ code: 1, stdout: "", stderr: "" });
