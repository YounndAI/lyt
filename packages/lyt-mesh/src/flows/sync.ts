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

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as lytVaultSourceBridge from "@younndai/lyt-vault";
import {
  buildVaultCommitMessage,
  closeRegistry,
  deriveWriteGate,
  GIT_READ_ONLY_POLICY,
  GitRemoteProvider,
  getHandleFromIdentity,
  getVaultByRid,
  isAccessRemoved,
  isConfigPath,
  isFigmentPath,
  isLytDbCorrupt,
  isPermissionDeniedPush,
  listMeshes,
  listFederationStates,
  migrateVaultGitignoreIndexRule,
  listSubscriptionsForMesh,
  listVaults,
  narrate,
  narrateAccessRemoved,
  normalizeGitHubRepoCoordinate,
  openRegistry,
  observePublicationPermission,
  parseFederationYon,
  withCanonicalVaultPublicationAttempt,
  readFigmentTitle,
  readFrozenLock,
  realIdentityRunner,
  regenContextFlow,
  runGit as defaultRunGit,
  runGitCommitWithIdentityFallback,
  updateVaultStatus,
  upsertArcsCache,
  upsertFtsCache,
  upsertLanesCache,
  upsertLedgerCache,
  uuid7BytesToHex,
  writeIndexWatermark,
  type ChangedFigment,
  type GhExecutor,
  type GitRunOptions,
  type GitRunResult,
  type Inverse,
  type RemoteProvider,
  type SyncHorizon,
  type VaultRow,
  type PublicationPermissionObserver,
  type CanonicalVaultPublicationAuthority,
  type PushTarget,
  type PullTarget,
} from "@younndai/lyt-vault";

// Structural source-wave bridge: mesh typechecks against the last built vault
// declaration, while runtime/tests resolve the current vault source.
const inspectWindowsGitPath = (
  lytVaultSourceBridge as typeof lytVaultSourceBridge & {
    inspectWindowsGitPath(
      root: string,
      relativePath: string,
    ): {
      readonly ok: boolean;
      readonly requiresGitLongPaths: boolean;
      readonly fullPathLength: number;
      readonly refusal?: { readonly code: string };
    };
  }
).inspectWindowsGitPath;

// Increment 1 · Phase A.4 — the sync flow emits a SyncOperation per pushing
// vault so its reversibility horizon is read back from the ACTUAL push result.
import { SyncOperation } from "../op/operations/sync-op.js";

export type VaultSyncStatus =
  | "clean"
  | "committed"
  | "pushed"
  | "pushed-verification-pending"
  | "pulled"
  | "diverged-synced"
  | "conflict"
  | "skipped-frozen"
  // hardening pass (Cohort-1 fix-pass) — a PURE-SUBSCRIBER read-only vault: sync PULLS
  // (read-only vaults stay fresh) but skips BOTH commit and push, so a stray
  // local change never becomes an unpushable outbox op. Mirrors skipped-frozen:
  // sync makes no write claim on the vault. The recovery rider surfaces
  // `readonlyDiverged` + a reset-to-origin remedy when the vault already
  // carries an unpushable local commit (the live-tester wedged state).
  | "skipped-readonly"
  | "skipped-tombstoned"
  | "skipped-disconnected"
  | "skipped-missing"
  | "no-upstream"
  | "not-git-repo"
  // 0.12.0 Phase D · A6 — the online copy replied `Repository not found` / 404:
  // our access was revoked (or the repo was deleted). Distinct from a transient
  // `error` (couldn't reach) — this is a definite access-loss, persisted to the
  // registry as `access_lost` so `vault info` reflects it.
  | "access-lost"
  | "origin-mismatch"
  | "error";

// 0.12.0 Phase D · A1 — concurrent-write conflict resolution choice. A 2-machine/
// 2-user edit that rebase-conflicts is resolved by ONE plain choice — never a raw
// marker. `mine` keeps the local version, `theirs` keeps the online version, and
// `both` is the safe never-lose default (preserve local on disk + the online copy
// stays online; nothing overwritten).
export type ConflictChoice = "mine" | "theirs" | "both";

export interface ConflictContext {
  vaultName: string;
  /** The plain note paths that conflicted (never a git noun). */
  conflictPaths: readonly string[];
}

/**
 * Resolve a concurrent-write conflict to a single plain choice. Supplied by the
 * command layer (a TTY prompt, or a non-TTY safe default of `both`). When absent
 * (programmatic callers / legacy tests), the flow preserves its pre-A1 behavior:
 * abort + a plain `conflict` report.
 */
export type ConflictResolver = (ctx: ConflictContext) => ConflictChoice | Promise<ConflictChoice>;

export interface VaultSyncReport {
  name: string;
  path: string;
  status: VaultSyncStatus;
  message: string;
  /** Local housekeeping changed tracked Lyt state after this vault's publication pass. */
  pendingLytMutation?: boolean;
  ahead?: number;
  behind?: number;
  dirtyCount?: number;
  meshContextResolved?: boolean;
  errorOutput?: string;
  /** A bounded, control-escaped refusal proving why Lyt did not stage this batch. */
  pathRefusal?: SyncPathRefusalEvidence;
  /** False means this sync invocation did not mutate the Git index. */
  staged?: false;
  // v1.C.2 — true when this vault is referenced by at least one
  // @MESH_SUBSCRIPTION row in some registered mesh's mesh.yon (i.e. the
  // vault is BOTH home in its own mesh AND a subscription target from
  // another). Additive discriminator; absent on reports for vaults with
  // no subscription references — preserves backward-compat per the ratified default
  // default extension path.
  subscribed?: boolean;
  // hardening pass (hardening fix-pass) — true when the vault's per-vault search
  // index (.lyt/indexes/lyt.db) is present but corrupt. Sync's git layer can
  // be perfectly healthy while the index tier is garbage; before this field
  // a corrupt index was invisible to the verb users run most ("clean / up to
  // date" over a dead search index). The `status` stays git-layer truth; the
  // message is suffixed with the `lyt reindex` remedy. Additive; absent when
  // the index is healthy or missing (never-indexed vaults are healthy).
  indexCorrupt?: boolean;
  // hardening pass recovery rider (Cohort-1 fix-pass) — true on a `skipped-readonly`
  // vault that ALREADY carries a local commit ahead of (or divergent from) its
  // upstream that can never be pushed (the live-tester wedged state, created by
  // the pre-fix hardening pass stray write + hardening pass commit). The `message` then names the
  // reset-to-origin remedy so the user can un-jam it. Additive; absent when the
  // read-only vault is clean (the common case).
  readonlyDiverged?: boolean;
  // Increment 1 · Phase A.4 — the safe-write spine's honest horizon, emitted by
  // the SyncOperation and READ BACK from the actual push result (never asserted
  // from the verb). `horizon` = where the effects reached (`pushed` = on the
  // online copy; `committed-not-pushed` = local commit that didn't land the
  // push); `reversible` = the inverse class (`none` once pushed; `clean-undo`
  // while still local). Additive + optional: present only when a push was
  // attempted (ahead > 0) — absent for pull-only / up-to-date / skipped syncs,
  // preserving backward-compat.
  horizon?: SyncHorizon;
  // Derived from the Operation's Inverse union (NOT a hand-copied literal) so a
  // future inverse class can't silently drift this field out of sync (a review finding,
  // coupled-constant discipline).
  reversible?: Inverse["class"];
  // 0.12.0 Phase D · A1 — set when a concurrent-write conflict was resolved via
  // the plain keep-mine/theirs/both choice (absent when there was no conflict, or
  // when no resolver was supplied and the legacy `conflict` report was returned).
  conflictResolution?: "mine" | "online" | "both";
  /** Local terminal events not yet confirmed present on the online copy. */
  pendingPublication?: number;
  /** Latest local event includes pending; latest published reads tracked SoT only. */
  latestLocalSync?: string;
  latestPublishedSync?: string;
  /** Provenance failures never relabel the actual sync outcome. */
  syncProvenanceWarning?: string;
  podAlias?: string | null;
  lastSyncMachineId?: string;
  lastSyncMachineAlias?: string | null;
  lastSyncAccount?: string | null;
}

export interface SyncPathRefusalEvidence {
  readonly code: string;
  readonly path: string;
  readonly pathLength: number;
  readonly fullPathLength: number;
  readonly requiresGitLongPaths: boolean;
}

export interface SyncFrictionHint {
  vaultName: string;
  vaultStatus: VaultSyncStatus;
  category: "sync.failed" | "sync.conflict";
  message: string;
}

export interface SyncFlowResult {
  reports: VaultSyncReport[];
  ok: boolean;
  frictionHints: SyncFrictionHint[];
}

export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

export interface SyncFlowArgs {
  vaultNames?: readonly string[];
  /** Exact registry identities to sync. Preferred over display names for scoped work. */
  vaultRids?: readonly string[];
  resolveMeshContext?: boolean;
  runGit?: GitRunner;
  now?: Date;
  // Brief C (F2) — optional caller-supplied commit message (e.g. an
  // agent-issued `lyt sync` passing a richer multiline semantic summary). When
  // absent, each vault gets the deterministic metadata-driven message. The CLI
  // NEVER calls an LLM — the override is the caller's responsibility.
  message?: string;
  // 0.9.3 — injectable gh executor for the read-only skip-push verdict
  // (deriveWriteGate). Defaults to the real `gh` CLI; tests inject a fake to
  // exercise the foreign-mesh subscription skip deterministically. Only
  // consulted for SUBSCRIPTION vaults — own vaults never probe in the loop.
  gh?: GhExecutor;
  // Increment 1 · Phase A.4 — injectable git-remote port. Defaults to the
  // firewalled GitRemoteProvider wrapping the same `runGit` (byte-identical to
  // the pre-A.4 inline push/pull). Tests inject a fake to drive the honest
  // horizon (pushed vs committed-not-pushed) deterministically.
  remote?: RemoteProvider;
  // 0.12.0 Phase D · A1 — concurrent-write conflict resolver. When supplied and a
  // rebase conflict occurs, the flow surfaces a plain keep-mine/theirs/both choice
  // through this callback and applies it (never a raw marker). When absent, the
  // pre-A1 legacy `conflict` report is returned unchanged (back-compat).
  resolveConflict?: ConflictResolver;
  // A6-1 (0.12.0 Phase D fix-pass) — the current gh-auth verdict, consulted ONLY
  // when a fetch fails with a `Repository not found` / 404. GitHub returns that
  // same 404 for a private repo the user is merely UNAUTHORIZED to see (logged-out
  // HTTPS creds / expired-or-underscoped token / SSO) — a fixable auth state, not a
  // revoke. When auth is not confirmed valid, the 404 is treated as a transient
  // reach failure (never `access_lost`). Defaults to the real `gh auth status`;
  // injectable for deterministic tests.
  ghAuthOk?: () => boolean | null;
  /** local-only saves writable local work and never touches a network seam. */
  networkMode?: "online" | "local-only";
  /**
   * Deprecated compatibility marker. Online work is always authority-gated;
   * setting this to false no longer restores implicit publication authority.
   */
  enforceOnlineAuthority?: boolean;
  /** Canonical online authority keyed only by stable vault RID hex. */
  onlineAuthorityByVaultRid?: Readonly<Record<string, SyncOnlineVaultAuthority>>;
  permissionObserver?: PublicationPermissionObserver;
  permissionAttemptId?: string;
}

export interface SyncPublicationAuthority {
  actor: string;
  target: string;
  repository: string;
  vaultRid: Uint8Array;
  podRid: string;
  podRoot?: string;
  policy: CanonicalVaultPublicationAuthority;
}

// Structural source-wave bridge: lyt-mesh typechecks against the last built
// lyt-vault declaration, while runtime/tests resolve the current source.
interface PublicationAttemptContext {
  runOutwardChild<T>(child: () => Promise<T>): Promise<T>;
}

export interface SyncOnlineVaultAuthority {
  expectedOrigin: string;
  publication: SyncPublicationAuthority;
}

const MESH_CONTEXT_PATH = ".lyt/mesh-context.md";

interface ProvenanceBridge {
  acknowledgePromotedSyncProvenance(vaultPath: string, eventIds: readonly string[]): void;
  getMachineId(): string;
  getIdentity(): string;
  getFederationRoot(): string;
  housekeepFlow(args: { vaultRid: string; ledger: "sync"; machineId: string }): Promise<unknown>;
  getSyncProvenanceStatus(vaultPath: string): {
    pendingPublication: number;
    degradedPending: number;
    latestLocalSync: {
      timestamp: string;
      machineId: string;
      alias: string | null;
      account: string | null;
      podAlias: string | null;
    } | null;
    latestPublishedSync: { timestamp: string } | null;
  };
  promotePendingSyncProvenance(vaultPath: string, machineId: string): string[];
  ensureSyncProvenancePendingIgnored(vaultPath: string): unknown;
  sanitizeSyncProvenanceText(value: string): string;
  queueSyncProvenance(args: {
    vaultPath: string;
    podRid: string;
    vaultRid: string;
    machineId: string;
    podAlias?: string | null;
    alias: string | null;
    account: string | null;
    timestamp?: string;
    outcome: string;
    details: string;
  }): unknown;
  readCurrentMachine(
    podRoot?: string,
    machineId?: string,
  ): {
    alias: string;
    accountIdentity: string | null;
  } | null;
  registerCurrentMachine(args?: { accountIdentity?: string; podRoot?: string }): {
    alias: string;
    accountIdentity: string | null;
  };
  recordCurrentMachineSyncSuccess(args?: {
    accountIdentity?: string;
    machineId?: string;
    podRoot?: string;
  }): unknown;
  readPodIdentity(podRoot: string): { podAlias?: string; podRid?: string } | null;
  readPodAlias(podRoot: string, podRid: string): { alias: string } | null;
  readSyncProvenance(
    vaultPath: string,
  ): Array<{ machineId: string; hlc: { wallMs: number; counter: number }; seq: number }>;
  appendSyncObserved(args: {
    podRoot?: string;
    vaultRid: string;
    sourceMachineId: string;
    throughHlc: { wallMs: number; counter: number };
    throughSeq: number;
  }): unknown;
}

const provenance = lytVaultSourceBridge as typeof lytVaultSourceBridge & ProvenanceBridge;

export async function syncFlow(args: SyncFlowArgs = {}): Promise<SyncFlowResult> {
  const runGit = args.runGit ?? defaultRunGit;
  const networkMode = args.networkMode ?? "online";
  if (networkMode === "online" && args.onlineAuthorityByVaultRid === undefined) {
    throw new Error(
      'Online sync requires canonical publication authority; pass networkMode: "local-only" for no-publish work.',
    );
  }
  // Increment 1 · Phase A.4 — the git-remote port. Default wraps the SAME runGit
  // seam, so behavior is unchanged when no fake is injected.
  const remote = networkMode === "online" ? (args.remote ?? new GitRemoteProvider(runGit)) : null;
  const now = args.now ?? new Date();
  // A6-1 (0.12.0 Phase D fix-pass) — the gh-auth verdict, consulted only on a
  // fetch-404 to distinguish a genuine revoke from an unauthed/expired 404.
  const ghAuthOk =
    networkMode === "online"
      ? (args.ghAuthOk ?? (() => realIdentityRunner.ghAuthStatus()))
      : () => null;
  const db = await openRegistry();
  let candidates: VaultRow[];
  let podRid: string | null = null;
  // v1.C.2 — derive the set of subscribed-vault rids across all
  // registered meshes BEFORE iterating, so each report can be tagged
  // with `subscribed: true` when applicable. Subscribed vaults are
  // already registered locally (clone-on-subscribe lands them in the
  // vaults table), so no double-dispatch is needed; the cross-mesh
  // subscription view is purely classificatory at sync time. Per
  // brief default extension path: no meta-CLI edit, no new
  // syncOneVault call — additive discriminator only.
  let subscribedRidHexes = new Set<string>();
  // 0.9.3 — the rids of read-only vaults the user can't push to, keyed
  // on the LIVE writability verdict (deriveWriteGate), NOT the static role. The
  // prior fix used `isPureSubscriberVault` (subscribed, not home), which a
  // subscribe-to-a-foreign-mesh vault does NOT satisfy (it gets a local `home`
  // role), so the cohort's younndai/lyt-docs was push-attempted and jammed the
  // outbox. deriveWriteGate keeps the loop cheap: an OWN vault (no subscription
  // signal) is never read-only here with NO gh probe; only a SUBSCRIPTION
  // consults the (cached) verdict — a pure subscriber short-circuits with no
  // probe, a foreign-home subscription pays one cached probe. syncOneVault skips
  // commit+push for these (pull-only); reconcile-publish separately EXCLUDES
  // them from its publish work-set, so no outbox op is ever enqueued. A
  // subscription the user was granted write access to (verdict true) is NOT
  // read-only and syncs normally. Computed once here, keyed by rid hex.
  const readOnlyRidHexes = new Set<string>();
  try {
    const all = await listVaults(db);
    const federationStates = await listFederationStates(db);
    podRid = federationStates.length === 1 ? federationStates[0]!.fedRidHex : null;
    candidates =
      args.vaultRids !== undefined
        ? all.filter((v) => args.vaultRids!.includes(v.ridHex))
        : args.vaultNames && args.vaultNames.length > 0
          ? all.filter((v) => args.vaultNames!.includes(v.name))
          : all;
    const meshes = await listMeshes(db);
    for (const m of meshes) {
      const subs = await listSubscriptionsForMesh(db, m.rid);
      for (const s of subs) {
        subscribedRidHexes.add(uuid7BytesToHex(s.externalVaultRid));
      }
    }
    for (const v of candidates) {
      const ridHex = uuid7BytesToHex(v.rid);
      const policyOnline = networkMode === "online" && authorityForVault(args, v) !== undefined;
      if (!policyOnline) {
        if (subscribedRidHexes.has(ridHex)) readOnlyRidHexes.add(ridHex);
        continue;
      }
      const gate = await deriveWriteGate(v, db, args.gh !== undefined ? { gh: args.gh } : {});
      if (gate.blocked) readOnlyRidHexes.add(ridHex);
    }
  } finally {
    await closeRegistry(db);
  }

  const reports: VaultSyncReport[] = [];
  let machine: { machineId: string; alias: string | null; account: string | null } | null = null;
  const podRoot = resolveProvenPodRoot(podRid);
  try {
    if (podRoot === null) throw new Error("pod identity is not materialized");
    const machineId = provenance.getMachineId();
    let account: string | null = null;
    try {
      account = provenance.getIdentity();
    } catch {
      // Machine presence is local pod state and must not depend on forge auth.
    }
    const current = provenance.registerCurrentMachine(
      account === null ? { podRoot } : { accountIdentity: account, podRoot },
    );
    machine = { machineId, alias: current.alias, account: current.accountIdentity };
  } catch {
    // Per-vault reports surface the inability to record; sync behavior is unchanged.
  }
  for (const v of candidates) {
    const ridHex = uuid7BytesToHex(v.rid);
    const onlineAuthority = authorityForVault(args, v);
    const vaultNetworkMode =
      networkMode === "online" && onlineAuthority !== undefined ? "online" : "local-only";
    let promotedEventIds: string[] = [];
    let hadNonProvenanceChanges = false;
    let provenanceWarning: string | undefined;
    let report: VaultSyncReport;
    try {
      report = await syncOneVault(
        v,
        runGit,
        remote,
        now,
        args.resolveMeshContext === true,
        args.message,
        readOnlyRidHexes.has(ridHex),
        args.resolveConflict,
        ghAuthOk,
        vaultNetworkMode,
        onlineAuthority?.expectedOrigin,
        onlineAuthority?.publication,
        args.permissionObserver ?? observePublicationPermission,
        args.permissionAttemptId ?? randomUUID(),
        false,
        undefined,
        machine === null || podRid === null
          ? undefined
          : async () => {
              try {
                const before = await readPorcelainStatus(runGit, v.path);
                hadNonProvenanceChanges = before.some((record) =>
                  porcelainPaths([record]).some(
                    (path) => !path.replaceAll("\\", "/").startsWith(".lyt/ledgers/sync/"),
                  ),
                );
                provenance.ensureSyncProvenancePendingIgnored(v.path);
                await provenance.housekeepFlow({
                  vaultRid: ridHex,
                  ledger: "sync",
                  machineId: machine!.machineId,
                });
                if (vaultNetworkMode === "online") {
                  promotedEventIds = provenance.promotePendingSyncProvenance(
                    v.path,
                    machine!.machineId,
                  );
                }
              } catch (err) {
                provenanceWarning = `Could not prepare pending sync provenance: ${safeProvenanceError(err)}`;
              }
            },
      );
    } catch (error) {
      if (machine !== null && podRid !== null) {
        try {
          provenance.queueSyncProvenance({
            vaultPath: v.path,
            podRid,
            vaultRid: ridHex,
            machineId: machine.machineId,
            podAlias:
              provenance.readPodAlias(
                onlineAuthority?.publication.podRoot ?? provenance.getFederationRoot(),
                podRid,
              )?.alias ?? null,
            alias: machine.alias,
            account: machine.account,
            timestamp: new Date().toISOString(),
            outcome: "error",
            details: JSON.stringify({ message: safeProvenanceError(error) }),
          });
        } catch {
          // Preserve and rethrow the original sync failure.
        }
      }
      throw error;
    }
    const provenanceOnlyPublication =
      promotedEventIds.length > 0 &&
      !hadNonProvenanceChanges &&
      (report.status === "committed" || report.status === "pushed");
    if (promotedEventIds.length > 0 && syncReachedPublication(report.status, vaultNetworkMode)) {
      try {
        provenance.acknowledgePromotedSyncProvenance(v.path, promotedEventIds);
      } catch (err) {
        provenanceWarning = `Could not acknowledge published sync provenance: ${safeProvenanceError(err)}`;
      }
    }
    if (provenanceOnlyPublication) {
      report.status = "clean";
      report.dirtyCount = 0;
      report.message =
        vaultNetworkMode === "online"
          ? "Up to date with the online copy."
          : "Up to date locally; no online service was contacted.";
    }
    if (machine === null || podRid === null) {
      provenanceWarning ??=
        "Sync provenance identity is unavailable; the sync outcome was not relabelled.";
    } else if (!(
      (promotedEventIds.length > 0 &&
        !hadNonProvenanceChanges &&
        (report.status === "clean" ||
          report.status === "committed" ||
          report.status === "pushed")) ||
      (promotedEventIds.length === 0 &&
        !hadNonProvenanceChanges &&
        report.status === "clean" &&
        provenance.getSyncProvenanceStatus(v.path).latestPublishedSync !== null)
    )) {
      try {
        provenance.queueSyncProvenance({
          vaultPath: v.path,
          podRid,
          vaultRid: ridHex,
          machineId: machine.machineId,
          podAlias:
            provenance.readPodAlias(
              onlineAuthority?.publication.podRoot ?? provenance.getFederationRoot(),
              podRid,
            )?.alias ?? null,
          alias: machine.alias,
          account: machine.account,
          timestamp: new Date().toISOString(),
          outcome: report.status,
          details: JSON.stringify({
            message: report.message,
            ...(report.ahead === undefined ? {} : { ahead: report.ahead }),
            ...(report.behind === undefined ? {} : { behind: report.behind }),
            ...(report.dirtyCount === undefined ? {} : { dirtyCount: report.dirtyCount }),
            ...(report.horizon === undefined ? {} : { horizon: report.horizon }),
          }),
        });
      } catch (err) {
        provenanceWarning = `Could not queue sync provenance: ${safeProvenanceError(err)}`;
      }
    }
    try {
      const status = provenance.getSyncProvenanceStatus(v.path);
      report.pendingPublication = status.pendingPublication;
      if (status.degradedPending > 0) {
        provenanceWarning ??= `${status.degradedPending} pending sync provenance file(s) are unreadable and retained for recovery.`;
      }
      if (status.latestLocalSync !== null)
        report.latestLocalSync = status.latestLocalSync.timestamp;
      if (status.latestLocalSync !== null) {
        report.podAlias = status.latestLocalSync.podAlias;
        report.lastSyncMachineId = status.latestLocalSync.machineId;
        report.lastSyncMachineAlias = status.latestLocalSync.alias;
        report.lastSyncAccount = status.latestLocalSync.account;
      }
      if (status.latestPublishedSync !== null)
        report.latestPublishedSync = status.latestPublishedSync.timestamp;
    } catch (err) {
      provenanceWarning ??= `Could not read sync provenance: ${safeProvenanceError(err)}`;
    }
    if (provenanceWarning !== undefined) report.syncProvenanceWarning = provenanceWarning;
    if (machine !== null && vaultNetworkMode === "online" && isReachedOnlineStatus(report.status)) {
      try {
        const bySource = new Map<
          string,
          { hlc: { wallMs: number; counter: number }; seq: number }
        >();
        for (const event of provenance.readSyncProvenance(v.path)) {
          const current = bySource.get(event.machineId);
          if (
            current === undefined ||
            event.hlc.wallMs > current.hlc.wallMs ||
            (event.hlc.wallMs === current.hlc.wallMs &&
              (event.hlc.counter > current.hlc.counter ||
                (event.hlc.counter === current.hlc.counter && event.seq > current.seq)))
          )
            bySource.set(event.machineId, event);
        }
        for (const [sourceMachineId, through] of bySource) {
          provenance.appendSyncObserved({
            podRoot: provenance.getFederationRoot(),
            vaultRid: ridHex,
            sourceMachineId,
            throughHlc: through.hlc,
            throughSeq: through.seq,
          });
        }
      } catch {
        // Pending/local-only observations never advance published watermarks.
      }
    }
    if (subscribedRidHexes.has(ridHex)) {
      report.subscribed = true;
    }
    // index-corruption surface. One probe at the loop chokepoint
    // (not per-return inside syncOneVault). Skipped-* statuses are excluded:
    // sync didn't touch the vault, so it makes no claims about it (the probe
    // itself is READ-ONLY — raw client + PRAGMA quick_check, no migrations —
    // so this is a consistency choice, not a freeze-safety requirement;
    // doctor/repair probe frozen vaults with the same read-only probe). The
    // probe is detect-only (isLytDbCorrupt never heals); failures of the
    // probe itself are non-fatal — sync's git work already succeeded.
    if (!report.status.startsWith("skipped-") && report.status !== "not-git-repo") {
      try {
        if (await isLytDbCorrupt(v.path)) {
          report.indexCorrupt = true;
          report.message =
            `${report.message} Heads up: this vault's search index is damaged, so search and recall may ` +
            `miss things — everything else synced fine. Run \`lyt reindex --vault ${v.name}\` to rebuild it.`;
        }
      } catch {
        // probe failure (e.g. transient lock) — never fail the sync over it
      }
    }
    reports.push(report);
  }
  if (machine !== null && reports.some((report) => isSuccessfulEligibleStatus(report.status))) {
    try {
      provenance.recordCurrentMachineSyncSuccess({
        machineId: machine.machineId,
        ...(podRoot === null ? {} : { podRoot }),
        ...(machine.account === null ? {} : { accountIdentity: machine.account }),
      });
    } catch {
      // Machine status persistence cannot relabel completed vault outcomes.
    }
  }
  // 0.12.0 Phase D · A6 — reconcile the registry from what the loop observed. Done
  // once, post-loop (syncOneVault has no db handle); best-effort — a persist hiccup
  // never fails the sync (the report already carries the honest per-vault status).
  //
  // A6-3 fix-pass — key the persist by RID via INDEX correlation (reports[i]
  // corresponds to candidates[i]), NOT by `name`. `vaults.name UNIQUE` was dropped
  // (registry/migrations.ts:248 — two same-named vaults from different origins can
  // coexist), so matching on `name` false-flipped an innocent same-named sibling.
  //
  // A6-2 fix-pass — reconcile BOTH directions: persist `access_lost` for a fresh
  // revoke, AND recover `access_lost → active` for a vault that reached its online
  // copy cleanly this run (a re-granted share). Without the recovery leg, a vault
  // that syncs fine still reported "no access" on `vault info` / `sync --check`.
  const reconcileTargets: { rid: Uint8Array; status: "access_lost" | "active" }[] = [];
  for (let i = 0; networkMode === "online" && i < candidates.length; i += 1) {
    const v = candidates[i];
    const r = reports[i];
    if (v === undefined || r === undefined) continue;
    if (r.status === "access-lost" && v.status !== "access_lost") {
      reconcileTargets.push({ rid: v.rid, status: "access_lost" });
    } else if (v.status === "access_lost" && isReachedOnlineStatus(r.status)) {
      // Recovery: a previously-lost vault that reached online cleanly this run.
      reconcileTargets.push({ rid: v.rid, status: "active" });
    }
  }
  if (reconcileTargets.length > 0) {
    const persistDb = await openRegistry();
    try {
      for (const t of reconcileTargets) {
        try {
          await updateVaultStatus(persistDb, t.rid, t.status);
        } catch {
          // non-fatal — the report already surfaces the honest status this run.
        }
      }
    } finally {
      await closeRegistry(persistDb);
    }
  }
  const ok = reports.every(
    (r) =>
      r.status !== "conflict" &&
      r.status !== "error" &&
      r.status !== "access-lost" &&
      r.status !== "origin-mismatch" &&
      r.status !== "pushed-verification-pending",
  );
  return { reports, ok, frictionHints: deriveFrictionHints(reports) };
}

function resolveProvenPodRoot(podRid: string | null): string | null {
  if (podRid === null) return null;
  const podRoot = provenance.getFederationRoot();
  const manifestPath = join(podRoot, "pod.yon");
  const gitPath = join(podRoot, ".git");
  if (!existsSync(manifestPath) || !existsSync(gitPath)) return null;
  try {
    const rootStat = lstatSync(podRoot);
    const manifestStat = lstatSync(manifestPath);
    const gitStat = lstatSync(gitPath);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      gitStat.isSymbolicLink() ||
      !(gitStat.isDirectory() || gitStat.isFile())
    ) {
      return null;
    }
    return parseFederationYon(readFileSync(manifestPath, "utf8")).federation.fedRidHex === podRid
      ? podRoot
      : null;
  } catch {
    return null;
  }
}

function isSuccessfulEligibleStatus(status: VaultSyncStatus): boolean {
  return (
    status === "clean" ||
    status === "committed" ||
    status === "pushed" ||
    status === "pulled" ||
    status === "diverged-synced"
  );
}

function parseGitObjectId(stdout: string): string | null {
  const objectId = stdout.trim().toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(objectId) ? objectId : null;
}

function parseRemoteObjectId(stdout: string, expectedRef: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const [objectId = "", ref = ""] = line.trim().split(/\s+/, 2);
    if (ref === expectedRef) return parseGitObjectId(objectId);
  }
  return null;
}

function syncReachedPublication(
  status: VaultSyncStatus,
  networkMode: "online" | "local-only",
): boolean {
  if (networkMode === "local-only") return false;
  return (
    status === "pushed" || status === "diverged-synced" || status === "pulled" || status === "clean"
  );
}

function safeProvenanceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return provenance.sanitizeSyncProvenanceText(message).slice(0, 256);
}

function authorityForVault(
  args: SyncFlowArgs,
  vault: VaultRow,
): SyncOnlineVaultAuthority | undefined {
  const ridHex = uuid7BytesToHex(vault.rid);
  const online = args.onlineAuthorityByVaultRid?.[ridHex];
  if (online === undefined || uuid7BytesToHex(online.publication.vaultRid) !== ridHex) {
    return undefined;
  }
  return normalizeGitHubRepoCoordinate(
    `https://github.com/${online.expectedOrigin}`,
  )?.toLowerCase() === online.publication.repository.toLowerCase()
    ? online
    : undefined;
}

// Arc §10.4 — on a sync that hits a friction-worthy outcome, surface a
// one-line capture nudge so the handler can log it without re-typing
// boilerplate. The hints are returned as data; the calling command
// (packages/lyt-mesh/src/commands/sync.ts) decides whether to emit them
// to stderr (gated by --quiet + --json — both silence).
// v1.M.0 (P0-b) — reconcile the four .db caches (ledger → lanes → arcs →
// fts) from the on-disk SoT (YON ledgers + lanes/arcs.yon + notes/*.md).
// Extracted from the former post-pull-only block so a single sync
// reconciles caches UNCONDITIONALLY — whether the new state arrived via a
// local commit (no-remote vault) or a successful pull. Each upsert is
// best-effort + non-fatal (matches the prior post-pull posture); a failure
// in one upsert logs and does NOT abort the others or fail the sync.
// Deterministic call order matches the master-plan search-tier dependency:
// ledger → lanes → arcs → fts. The downstream upsert flows each early-
// return ran=false when their SoT is absent, so calling all four on a
// vault that only has notes/ (or only ledgers) is cheap, not wasteful.
async function reconcileVaultCaches(
  vaultPath: string,
  vaultName: string,
  opts?: { skipGitignoreMigration?: boolean },
): Promise<void> {
  // CRIT-A (residual sweep): self-heal a stale bare `.lyt/indexes/`
  // gitignore rule → `.lyt/indexes/*` on every sync post-pull, so the installed
  // base (which fresh-init never touched) starts staging the committed
  // lanes.yon/arcs.yon. Best-effort + non-fatal, matching the upsert posture
  // below; idempotent + no-op when already migrated/absent.
  //
  // re-release review Major (residual sweep): GATED to writable/own vaults.
  // `reconcileVaultCaches` also runs on the READ-ONLY subscriber pull path (the
  // two `if (readOnly)` call sites pass `skipGitignoreMigration: true`). A
  // subscriber can never stage/push the reincluded cluster YON, so rewriting its
  // tracked `.gitignore` there is pure downside: it dirties the read-only tree →
  // the NEXT sync sees ` M .gitignore` → `dirtyCount>0` → a false
  // `readonlyDiverged` with a looping "discard to match the shared original"
  // remedy for a file Lyt itself wrote. The migration therefore fires only on
  // the writable/own call sites (default), never on the read-only path.
  if (!opts?.skipGitignoreMigration) {
    try {
      migrateVaultGitignoreIndexRule(vaultPath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `lyt sync: gitignore index-rule migration failed for ${vaultName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    await upsertLedgerCache(vaultPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `lyt sync: ledger upsert failed for ${vaultName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await upsertLanesCache(vaultPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `lyt sync: lanes upsert failed for ${vaultName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await upsertArcsCache(vaultPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `lyt sync: arcs upsert failed for ${vaultName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await upsertFtsCache(vaultPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `lyt sync: fts upsert failed for ${vaultName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // V-C-1 Phase B (L2) — stamp the index watermark after a post-pull cache
  // reconcile. The FTS full-walk above re-reads the pulled markdown (so Tier-2
  // search is fresh); lanes/arcs REFLECT the pulled committed SoT (we don't
  // re-cluster on pull — that would churn the git tree, reindex-inbound.ts:14).
  // Stamping "indexed as of now" keeps the L3 self-heal from redundantly
  // re-clustering a vault we just reconciled.
  //
  // KNOWN TRADEOFF (release review, deferred to v1.V.x.1): if a peer
  // pushed notes WITHOUT a fresh lanes.yon/arcs.yon (a pre-Phase-A pusher),
  // those reflected tiers are stale — and this stamp then suppresses the L3 heal
  // that would catch it, so Tier-0/1 (arc/lane) search stays degraded until a
  // manual `lyt reindex`. Tier-2 FTS still surfaces the content (search is never
  // EMPTY), so this is tier-degradation, not loss. Post-Phase-A pushers commit
  // fresh SoT via index-on-write, so the stale case is a shrinking legacy edge;
  // the structural fix (detect stale lanes.yon vs newest pulled figment +
  // re-cluster those two tiers on pull) is booked for v1.V.x.1.
  writeIndexWatermark(vaultPath);
}

// A6-2 (0.12.0 Phase D fix-pass) — true when a per-vault sync status proves the
// online copy was REACHED cleanly this run (the fetch succeeded and the sync
// completed without an error/conflict/skip). These are exactly the statuses that
// can only be produced after a successful `git fetch`, so they are the honest
// signal that a previously `access_lost` vault has recovered. `no-upstream`
// (no remote), `not-git-repo`, `error`, `conflict`, `access-lost`, and every
// `skipped-*` are excluded — none of them proves a clean reach.
function isReachedOnlineStatus(status: VaultSyncStatus): boolean {
  return (
    status === "clean" ||
    status === "committed" ||
    status === "pushed" ||
    status === "pulled" ||
    status === "diverged-synced"
  );
}

function deriveFrictionHints(reports: readonly VaultSyncReport[]): SyncFrictionHint[] {
  const hints: SyncFrictionHint[] = [];
  for (const r of reports) {
    if (r.status === "conflict") {
      hints.push({
        vaultName: r.name,
        vaultStatus: r.status,
        category: "sync.conflict",
        message: `Log this as friction with: lyt friction note --category=sync.conflict "${r.name}: ${r.message.replace(/"/g, '\\"').slice(0, 200)}"`,
      });
    } else if (r.status === "error" || r.status === "origin-mismatch") {
      hints.push({
        vaultName: r.name,
        vaultStatus: r.status,
        category: "sync.failed",
        message: `Log this as friction with: lyt friction note --category=sync.failed "${r.name}: ${r.message.replace(/"/g, '\\"').slice(0, 200)}"`,
      });
    }
  }
  return hints;
}

async function syncOneVault(
  vault: VaultRow,
  runGit: GitRunner,
  remote: RemoteProvider | null,
  now: Date,
  resolveMeshContext: boolean,
  messageOverride?: string,
  readOnly = false,
  resolveConflict?: ConflictResolver,
  ghAuthOk: () => boolean | null = () => realIdentityRunner.ghAuthStatus(),
  networkMode: "online" | "local-only" = "online",
  expectedOrigin?: string,
  publicationAuthority?: SyncPublicationAuthority,
  permissionObserver: PublicationPermissionObserver = observePublicationPermission,
  permissionAttemptId: string = randomUUID(),
  authorityHeld = false,
  publicationAttempt?: PublicationAttemptContext,
  beforeEligibleSync?: () => void | Promise<void>,
): Promise<VaultSyncReport> {
  const base: VaultSyncReport = {
    name: vault.name,
    path: vault.path,
    status: "clean",
    message: "",
  };
  if (vault.status === "tombstoned") {
    return { ...base, status: "skipped-tombstoned", message: "vault is tombstoned" };
  }
  if (vault.status === "disconnected") {
    return { ...base, status: "skipped-disconnected", message: "vault is disconnected" };
  }
  if (vault.status === "missing") {
    return { ...base, status: "skipped-missing", message: "vault path missing on disk" };
  }
  if (!existsSync(vault.path)) {
    return { ...base, status: "skipped-missing", message: `path does not exist: ${vault.path}` };
  }
  const frozen = readFrozenLock(vault.path, now);
  if (frozen.frozen && !frozen.expired) {
    return {
      ...base,
      status: "skipped-frozen",
      message: `frozen until ${frozen.frozenUntil ?? "?"} (${frozen.remaining ?? "?"})`,
    };
  }

  const gitDir = await runGit(["rev-parse", "--git-dir"], { cwd: vault.path, allowFailure: true });
  if (gitDir.code !== 0) {
    return { ...base, status: "not-git-repo", message: "This vault isn't set up for syncing yet." };
  }

  if (networkMode === "local-only") {
    if (readOnly) {
      const statusRecords = await readPorcelainStatus(runGit, vault.path);
      const dirtyCount = statusRecords.length;
      await reconcileVaultCaches(vault.path, vault.name, { skipGitignoreMigration: true });
      return {
        ...base,
        status: "skipped-readonly",
        dirtyCount,
        message:
          "This is a read-only shared vault; local-only sync made no Git changes and contacted no online service.",
      };
    }
    await beforeEligibleSync?.();
    const statusRecords = await readPorcelainStatus(runGit, vault.path);
    const dirtyCount = statusRecords.length;
    let committed = false;
    if (statusRecords.length > 0) {
      const staging = await stagePorcelainRecords(runGit, vault.path, statusRecords);
      if (!staging.staged) {
        return stagingRefusalReport(base, dirtyCount, staging.pathRefusal);
      }
      const commitMsg = messageOverride ?? buildSyncCommitMessage(vault, statusRecords, now);
      const commitRes = await runGitCommitWithIdentityFallback(runGit, ["-m", commitMsg], {
        cwd: vault.path,
        allowFailure: true,
      });
      if (commitRes.code !== 0) {
        return {
          ...base,
          status: "error",
          dirtyCount,
          message: "Lyt could not save these changes locally. They remain on this machine.",
          errorOutput: commitRes.stderr || commitRes.stdout,
        };
      }
      committed = true;
    }
    await reconcileVaultCaches(vault.path, vault.name);
    return {
      ...base,
      status: committed ? "committed" : "clean",
      dirtyCount,
      message: committed
        ? `Saved ${dirtyCount} change(s) locally; no online service was contacted.`
        : "Up to date locally; no online service was contacted.",
    };
  }

  if (remote === null) throw new Error("online sync requires a remote provider");

  let pushTarget: PushTarget | null = null;
  let pullTarget: PullTarget | null = null;
  let destinationRef = "";
  let branchRemoteName = "";
  let validatedFetchUrl = "";
  let canonicalOriginMissing = false;
  if (expectedOrigin !== undefined) {
    const pushRemote = "origin";
    const origin = await runGit(["remote", "get-url", "--push", pushRemote], {
      cwd: vault.path,
      allowFailure: true,
    });
    const pushUrl = origin.stdout.trim();
    if (origin.code !== 0 || pushUrl.length === 0) {
      canonicalOriginMissing = true;
    } else {
      const actual = normalizeGitHubRepoCoordinate(pushUrl);
      if (actual === null || actual.toLowerCase() !== expectedOrigin.toLowerCase()) {
        return {
          ...base,
          status: "origin-mismatch",
          message: `Online sync refused: expected ${expectedOrigin}, found ${actual ?? pushUrl}.`,
        };
      }
      pushTarget = { url: pushUrl, refspec: "" };
    }
    const fetchOrigin = await runGit(["remote", "get-url", pushRemote], {
      cwd: vault.path,
      allowFailure: true,
    });
    validatedFetchUrl = fetchOrigin.stdout.trim();
    const fetchCoordinate =
      fetchOrigin.code === 0 ? normalizeGitHubRepoCoordinate(validatedFetchUrl) : null;
    if (fetchOrigin.code !== 0 || validatedFetchUrl.length === 0) {
      canonicalOriginMissing = true;
    } else if (
      fetchCoordinate === null ||
      fetchCoordinate.toLowerCase() !== expectedOrigin.toLowerCase()
    ) {
      return {
        ...base,
        status: "origin-mismatch",
        message: `Online sync refused: expected ${expectedOrigin}, found ${fetchCoordinate ?? (validatedFetchUrl || "missing origin")}.`,
      };
    }
  }

  // A canonical owned vault with neither origin nor upstream is a legitimate
  // first-publication candidate. Keep this public flow local-only and return
  // `no-upstream`; the command layer alone may route that outcome to the
  // existing scoped materializer. Any inconsistent state with an upstream but
  // no canonical origin remains fail-closed before fetch or local mutation.
  const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: vault.path,
    allowFailure: true,
  });
  const hasUpstreamFlag = upstreamRes.code === 0;
  // A hostile/stale branch binding can be present even when `@{u}` does not
  // currently resolve (for example, its remote-tracking ref has not been
  // fetched yet). Refuse that state before treating the vault as a legitimate
  // first-publication candidate.
  if (expectedOrigin !== undefined) {
    const currentBranch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: vault.path,
      allowFailure: true,
    });
    const currentBranchName = currentBranch.stdout.trim();
    if (currentBranch.code === 0 && currentBranchName.length > 0) {
      const configuredRemote = await runGit(
        ["config", "--get", `branch.${currentBranchName}.remote`],
        { cwd: vault.path, allowFailure: true },
      );
      if (configuredRemote.code === 0 && configuredRemote.stdout.trim() !== "origin") {
        return {
          ...base,
          status: "origin-mismatch",
          message: "Online sync refused: the current branch does not track the authorized origin.",
        };
      }
    }
  }
  if (canonicalOriginMissing && hasUpstreamFlag) {
    return {
      ...base,
      status: "origin-mismatch",
      message: `Online sync refused: expected ${expectedOrigin}, but origin is missing while an upstream is configured.`,
    };
  }
  if (hasUpstreamFlag) {
    const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: vault.path,
      allowFailure: true,
    });
    const branchName = branch.stdout.trim();
    const branchRemote =
      branch.code === 0 && branchName.length > 0
        ? await runGit(["config", "--get", `branch.${branchName}.remote`], {
            cwd: vault.path,
            allowFailure: true,
          })
        : { code: 1, stdout: "", stderr: "" };
    const mergeRef =
      branch.code === 0 && branchName.length > 0
        ? await runGit(["config", "--get", `branch.${branchName}.merge`], {
            cwd: vault.path,
            allowFailure: true,
          })
        : { code: 1, stdout: "", stderr: "" };
    destinationRef = mergeRef.stdout.trim();
    branchRemoteName = branchRemote.stdout.trim();
    const expectedUpstream = `${branchRemoteName}/${destinationRef.replace(/^refs\/heads\//, "")}`;
    if (
      branchRemote.code !== 0 ||
      branchRemoteName.length === 0 ||
      (expectedOrigin !== undefined && branchRemoteName !== "origin") ||
      mergeRef.code !== 0 ||
      !destinationRef.startsWith("refs/heads/") ||
      destinationRef === "refs/heads/" ||
      upstreamRes.stdout.trim() !== expectedUpstream
    ) {
      return {
        ...base,
        status: "origin-mismatch",
        message: "Online sync refused: the authorized origin branch could not be resolved.",
      };
    }
    const validRef = await runGit(["check-ref-format", destinationRef], {
      cwd: vault.path,
      allowFailure: true,
    });
    if (validRef.code !== 0) {
      return {
        ...base,
        status: "origin-mismatch",
        message: "Online sync refused: the authorized origin branch is invalid.",
      };
    }
    if (validatedFetchUrl.length === 0) {
      const fetchOrigin = await runGit(["remote", "get-url", branchRemoteName], {
        cwd: vault.path,
        allowFailure: true,
      });
      validatedFetchUrl = fetchOrigin.stdout.trim();
    }
    if (
      validatedFetchUrl.length === 0 ||
      validatedFetchUrl.startsWith("-") ||
      /[\0\r\n]/u.test(validatedFetchUrl)
    ) {
      return {
        ...base,
        status: "origin-mismatch",
        message: "Online sync refused: the authorized sync source is invalid.",
      };
    }
    pullTarget = { url: validatedFetchUrl, ref: destinationRef };
    if (pushTarget !== null) pushTarget = { ...pushTarget, refspec: `HEAD:${destinationRef}` };
  }
  if (hasUpstreamFlag) {
    if (pullTarget === null) {
      return {
        ...base,
        status: "origin-mismatch",
        message: "Online sync refused: no authorized sync source was resolved.",
      };
    }
    if (publicationAuthority !== undefined && !authorityHeld) {
      // Keep the repository binding explicit even while lyt-mesh typechecks
      // against the last built lyt-vault declaration during this source wave.
      const canonicalAttempt = {
        vaultRid: publicationAuthority.vaultRid,
        podRid: publicationAuthority.podRid,
        ...(publicationAuthority.podRoot === undefined
          ? {}
          : { podRoot: publicationAuthority.podRoot }),
        authority: publicationAuthority.policy,
        expectedRepository: publicationAuthority.repository,
        capability: "repository-push" as const,
        target: publicationAuthority.target,
        repository: publicationAuthority.repository,
        actor: publicationAuthority.actor,
        attemptId: permissionAttemptId,
        permissionObserver,
        action: async (attempt?: PublicationAttemptContext) => {
          if (attempt === undefined) {
            throw new Error("Publication refused: subject-lock renewal context is unavailable.");
          }
          const currentDb = await openRegistry();
          try {
            const current = await getVaultByRid(currentDb, publicationAuthority.vaultRid);
            if (
              current === null ||
              current.path !== vault.path ||
              current.status !== "active" ||
              current.source !== "own"
            ) {
              throw new Error(
                "Publication refused: vault identity changed before the outward action.",
              );
            }
          } finally {
            await closeRegistry(currentDb);
          }
          // Repeat the local coordinate/ref validation while the subject lock is
          // held. The recursive pass skips only this authority wrapper; its
          // immutable-URL fetch, rebase/local history changes, and explicit push
          // all remain inside the same subject-lock lifetime.
          return syncOneVault(
            vault,
            runGit,
            remote,
            now,
            resolveMeshContext,
            messageOverride,
            readOnly,
            resolveConflict,
            ghAuthOk,
            networkMode,
            expectedOrigin,
            publicationAuthority,
            permissionObserver,
            permissionAttemptId,
            true,
            attempt,
            beforeEligibleSync,
          );
        },
      };
      return withCanonicalVaultPublicationAttempt(canonicalAttempt);
    }
    const fetchChild = () =>
      runGit(["fetch", "--quiet", pullTarget.url, pullTarget.ref], {
        cwd: vault.path,
        allowFailure: true,
      });
    const fetched =
      publicationAttempt === undefined
        ? await fetchChild()
        : await publicationAttempt.runOutwardChild(fetchChild);
    if (fetched.code !== 0) {
      // 0.12.0 Phase D · A6 — a `Repository not found` / 404 on fetch means our
      // access was revoked (or the repo was deleted) — a DEFINITE access-loss,
      // distinct from a transient reachability blip. `isAccessRemoved` excludes
      // offline signals (host unreachable / timeout) so a merely-disconnected
      // machine is never mis-flagged. Surface the plain "access removed"
      // narration + the `access-lost` status (persisted to the registry by the
      // syncFlow loop) so the human — and `vault info` — see the real state
      // instead of a stale `active`. Raw stderr stays on `errorOutput`.
      // A6-1 fix-pass — a `Repository not found` / 404 is only a genuine revoke
      // when gh auth is CONFIRMED valid; the same 404 under logged-out / expired /
      // SSO-unauthorized creds is a FIXABLE auth state, not a revoke. Pass the auth
      // verdict so an unauthed 404 falls through to the transient reach-failure
      // surface below (never a false `access_lost` flip).
      if (isAccessRemoved(fetched.stderr, { ghAuthOk: ghAuthOk() })) {
        const narrated = narrateAccessRemoved();
        return {
          ...base,
          status: "access-lost",
          message: `${narrated.plain} ${narrated.nextAction}`,
          errorOutput: fetched.stderr,
        };
      }
      // firewall-C1 fix-pass — this is an allowFailure path (no throw), so the raw
      // stderr never passed through the spawn-wrapper's narration. This is a READ
      // failure (couldn't reach the online copy to check for updates); narrate()'s
      // category strings are save/push-framed, so a read-framed plain message is
      // authored directly here. Raw stderr stays on `errorOutput` (debug/--json
      // only, never the human renderer).
      return {
        ...base,
        status: "error",
        message:
          "Lyt couldn't reach your online copy to check for updates right now. Try `lyt sync` again in a moment, or run `lyt doctor` if it keeps happening.",
        errorOutput: fetched.stderr,
      };
    }
  }

  let statusRecords = await readPorcelainStatus(runGit, vault.path);
  let dirtyCount = statusRecords.length;

  let ahead = 0;
  let behind = 0;
  if (hasUpstreamFlag) {
    const ab = await runGit(["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"], {
      cwd: vault.path,
      allowFailure: true,
    });
    if (ab.code === 0) {
      const parts = ab.stdout.trim().split(/\s+/);
      ahead = Number(parts[0]) || 0;
      behind = Number(parts[1]) || 0;
    }
  }

  // hardening pass (Cohort-1 fix-pass) — PURE-SUBSCRIBER READ-ONLY vault: PULL-ONLY.
  // The documented `[lyt.sync]` contract: "read-only/subscriber/orphan/no-remote
  // vaults pull but skip push." The pre-fix path COMMITTED a stray local change
  // and push-ATTEMPTED a vault the user can't push to → a permission-denied
  // push (and, downstream in reconcile-publish, a jammed outbox: "2 publish
  // op(s) pending … resumable", re-erroring every run). Here we pull to stay
  // fresh (read-only consumption), reconcile the caches, and SKIP both commit
  // and push. The outbox is reconcile-publish's; sync's contribution is simply
  // to never create the local commit that would later feed an unpushable
  // publish op. A divergent/unpushable local commit (ahead>0) OR an uncommitted
  // local change (dirtyCount>0) is the recovery case: surface `readonlyDiverged`
  // + a plain-language recovery remedy so the user can un-jam a vault the pre-fix
  // bug already wedged. We never auto-reset (discarding local edits is the
  // handler's call), and — firewall-C1 fix-pass — the remedy is now plain Lyt
  // vocabulary, never a raw git command (see the reframed block below).
  if (readOnly) {
    let pulledMsg = "";
    if (hasUpstreamFlag && behind > 0 && ahead === 0) {
      // Clean fast-forwardable subscriber → pull to stay fresh, then reconcile.
      // A.4 note (release review R2-O2): this read-only pull is intentionally NOT
      // routed through the RemoteProvider port — a read-only sync never pushes
      // and emits no SyncOperation/horizon, so porting it would be pure churn
      // with no honest-horizon benefit. Same git args either way.
      // A2c fix — `--autostash` (mirrors the pod-ledger pull, sync-pod-ledger.ts)
      // so a subscriber that carries an uncommitted TRACKED edit STILL receives
      // upstream. Without it, `git pull --rebase` ABORTS on the dirty tree
      // ("cannot pull with rebase: You have unstaged changes") and the read-only
      // copy silently stops receiving. Autostash stashes the edit, replays the
      // (fast-forward — a pure subscriber has no local commits) pull, then pops
      // the edit back.
      if (pullTarget === null) {
        return {
          ...base,
          status: "origin-mismatch",
          message: "Online sync refused: no authorized sync source was resolved.",
          ahead,
          behind,
          dirtyCount,
        };
      }
      const refetched = await runGit(["fetch", "--quiet", pullTarget.url, pullTarget.ref], {
        cwd: vault.path,
        allowFailure: true,
      });
      const pulled =
        refetched.code === 0
          ? await runGit(["rebase", "--autostash", "--quiet", "FETCH_HEAD"], {
              cwd: vault.path,
              allowFailure: true,
            })
          : refetched;
      if (pulled.code === 0) {
        // Edge: `--autostash` COMPLETES the pull (exit 0, upstream received) yet
        // can leave the tree with an UNRESOLVED autostash-pop conflict when the
        // local edit overlaps an incoming change on the same lines — git prints
        // "Applying autostash resulted in conflicts" but still exits 0. Detect
        // it explicitly; never silently swallow a pop failure (the tree would
        // carry `UU` conflict markers behind a false "clean receive" report).
        const unmerged = await runGit(["diff", "--name-only", "--diff-filter=U"], {
          cwd: vault.path,
          allowFailure: true,
        });
        const popConflicted = unmerged.code === 0 && unmerged.stdout.trim().length > 0;
        if (popConflicted) {
          // The upstream updates DID land (HEAD moved forward); only re-applying
          // the local edit conflicted. Git RETAINS the autostash entry in the
          // stash on a pop conflict, so the edit is NOT lost — it lives in this
          // vault's `git stash` (reachable there; NOT via `lyt capture`, which
          // cannot see stash content — the pre-fix message pointed there and was
          // a dead end). Clear the half-applied pop so this read-only copy is
          // left genuinely CLEAN (never carrying `UU` markers, which would
          // re-wedge the next pull). `git reset --hard HEAD` returns every
          // tracked path to the received upstream in ALL cases — including the
          // modify/delete edge where upstream DELETED a file the local edit
          // modified (a plain `checkout HEAD -- .` cannot restore a path absent
          // from HEAD, so its unmerged entry would linger and the tree would
          // never be clean). `reset --hard` does not touch the stash, so the
          // edit stays recoverable in every case.
          const reset = await runGit(["reset", "--hard", "HEAD"], {
            cwd: vault.path,
            allowFailure: true,
          });
          // re-release review Major — read-only subscriber path: never rewrite the
          // tracked `.gitignore` here (it would dirty the tree and loop a false
          // readonlyDiverged on the next sync). Caches still reconcile.
          await reconcileVaultCaches(vault.path, vault.name, { skipGitignoreMigration: true });
          // VERIFY the remedy before claiming clean — never fall through to a
          // "now matches the original" clean-claim on an unverified reset (the
          // exact false-clean state this guard exists to prevent). Re-check for
          // unmerged paths; report honestly if any linger or the reset failed.
          const recheck = await runGit(["diff", "--name-only", "--diff-filter=U"], {
            cwd: vault.path,
            allowFailure: true,
          });
          const residualUnmerged = recheck.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          const treeClean = reset.code === 0 && recheck.code === 0 && residualUnmerged.length === 0;
          const stashHint =
            `Your edit was kept safely in this vault's git stash — view it with ` +
            `\`git -C "${vault.path}" stash show -p\`, or bring it back with ` +
            `\`git -C "${vault.path}" stash pop\` and copy it into a vault you own.`;
          if (treeClean) {
            return {
              ...base,
              status: "skipped-readonly",
              readonlyDiverged: true,
              message:
                `Brought in ${behind} update(s) from the shared original. One of your local edits ` +
                `overlapped an incoming change and couldn't be re-applied automatically, so this ` +
                `shared copy now matches the original. ${stashHint}`,
              ahead,
              behind: 0,
              dirtyCount: 0,
            };
          }
          // Honest non-clean report — the reset did NOT fully clear the tree
          // (reset failed, or unmerged paths remain). Do not claim clean; the
          // edit is still preserved in the stash.
          return {
            ...base,
            status: "skipped-readonly",
            readonlyDiverged: true,
            message:
              `Brought in ${behind} update(s) from the shared original, but one of your local ` +
              `edits overlapped an incoming change and this shared copy could not be automatically ` +
              `returned to a clean state (it may still carry conflict markers). ${stashHint} Run ` +
              `\`lyt doctor\` if this keeps happening.`,
            ahead,
            behind: 0,
            dirtyCount: residualUnmerged.length,
          };
        } else {
          // re-release review Major — read-only subscriber path: skip the tracked
          // `.gitignore` self-heal (dirtying it would loop a false
          // readonlyDiverged next sync). Caches still reconcile.
          await reconcileVaultCaches(vault.path, vault.name, { skipGitignoreMigration: true });
          pulledMsg = `Brought in ${behind} update(s) from the shared original; `;
          behind = 0;
        }
      }
      // A pull failure on a read-only vault is non-fatal here — we still report
      // skipped-readonly (no push is attempted regardless); the user's read-only
      // copy just stays a few commits behind until the divergence is resolved.
    }
    // The recovery remedy branches on the ACTUAL state so the plain guidance is
    // both correct and safe (Cohort-1 fix-pass semantics, now firewall-C1 plain):
    //
    // (a) UNTRACKED stray (dirty, NOT ahead) — a new file was written into the
    // read-only vault but never saved into history. A discard-to-original would
    // NOT remove such new files, so the remedy tells the user to MOVE them into a
    // vault they own (and warns they're lost on the next refresh) — never a reset.
    //
    // (b) SAVED local work (ahead>0) — real edits were saved only on this machine.
    // Lead non-destructive: re-save the work into a vault the handler owns FIRST;
    // only then describe discarding the local-only changes (no raw command — there
    // is no single clean Lyt discard verb yet; the load-bearing step is preserving).
    //
    // Both are `readonlyDiverged: true` (the recovery rider fires); the WORDING
    // differs so the user takes the right (and safe) action.
    const untrackedCount = statusRecords.filter((record) => record.xy === "??").length;
    const trackedDirtyCount = dirtyCount - untrackedCount;
    const diverged = ahead > 0 || dirtyCount > 0;
    if (diverged) {
      // firewall-C1 fix-pass — the remedy is reframed in plain, Lyt-verb language
      // (no raw git command, no git noun). Semantics preserved from the prior
      // git-recipe version: keep-the-work-FIRST (re-save into a vault the handler
      // owns) and only then discard the local-only divergence. The destructive
      // discard has no single clean Lyt verb today, so it is DESCRIBED (never a
      // raw command) — the load-bearing step is preserving the work.
      let remedy: string;
      if (ahead > 0) {
        // (b) Work already saved on THIS machine that can't reach the original.
        const changeBits: string[] = [`${ahead} change-set(s) saved only on this machine`];
        if (trackedDirtyCount > 0) changeBits.push(`${trackedDirtyCount} edited note(s)`);
        if (untrackedCount > 0) changeBits.push(`${untrackedCount} new file(s)`);
        remedy =
          `This is a read-only shared vault, so the ${changeBits.join(" + ")} here can't be saved ` +
          `back to the shared original. Keep that work safe FIRST: open those notes and re-save them ` +
          `into one of your own vaults with \`lyt capture\`. Only once your work is safe somewhere you ` +
          `own should you discard the local-only changes here, so this vault matches the shared original again.`;
      } else {
        // (a) Uncommitted stray — new (untracked) and/or edited (tracked) files.
        const strayBits: string[] = [];
        if (untrackedCount > 0) strayBits.push(`${untrackedCount} new file(s)`);
        if (trackedDirtyCount > 0) strayBits.push(`${trackedDirtyCount} edited note(s)`);
        remedy =
          `This is a read-only shared vault, so the ${strayBits.join(" + ")} here can't be saved ` +
          `back to the shared original. ` +
          (untrackedCount > 0
            ? `Move the new file(s) into one of your own vaults and re-save them there with ` +
              `\`lyt capture\` — anything left here will be lost the next time Lyt refreshes this shared copy.`
            : `Copy those changes into one of your own vaults (save them as a note with ` +
              `\`lyt capture\`), or discard them here to match the shared original.`);
      }
      return {
        ...base,
        status: "skipped-readonly",
        readonlyDiverged: true,
        message: `${pulledMsg}${remedy}`,
        ahead,
        behind,
        dirtyCount,
      };
    }
    return {
      ...base,
      status: "skipped-readonly",
      message:
        pulledMsg.length > 0
          ? `${pulledMsg.trimEnd()} This is a read-only shared vault — Lyt keeps it up to date but doesn't save your changes back to it.`
          : "This is a read-only shared vault — Lyt keeps it up to date but doesn't save your changes back to it.",
      ahead,
      behind,
      dirtyCount,
    };
  }

  await beforeEligibleSync?.();
  statusRecords = await readPorcelainStatus(runGit, vault.path);
  dirtyCount = statusRecords.length;

  // v1.M.0 (P0-b) — single-reconcile guard. Each sync reconciles the .db
  // caches AT MOST ONCE, via reconcileVaultCaches(). It fires after a local
  // commit OR after a successful pull (the two ways on-disk SoT can change
  // within one sync); the guard prevents the local-commit-then-pull path
  // from reconciling twice.
  let reconciled = false;

  // Stage + commit dirty changes from Git's literal NUL-delimited path records.
  let committed = false;
  if (dirtyCount > 0) {
    if (statusRecords.length > 0) {
      const staging = await stagePorcelainRecords(runGit, vault.path, statusRecords);
      if (!staging.staged) {
        return stagingRefusalReport(base, dirtyCount, staging.pathRefusal);
      }
      // Brief C (F2) — metadata-driven commit message (subject + per-figment
      // body, +new/~updated/-deleted from git status), unless the caller
      // supplied an explicit `message` override (e.g. an agent's semantic
      // summary). The deterministic path NEVER calls an LLM.
      const commitMsg = messageOverride ?? buildSyncCommitMessage(vault, statusRecords, now);
      const commitRes = await runGitCommitWithIdentityFallback(runGit, ["-m", commitMsg], {
        cwd: vault.path,
        allowFailure: true,
      });
      if (commitRes.code === 0) {
        committed = true;
        ahead += 1;
        // v1.M.0 (P0-b) — reconcile right after the local commit lands, but
        // ONLY when no pull will follow (behind === 0). When behind > 0 the
        // pull below can bring in NEW remote SoT (notes another machine
        // pushed); reconciling here would miss that, so we defer to the
        // single post-pull reconcile which sees committed + pulled state at
        // once. This keeps it exactly-once AND correct: the no-pull paths
        // (no-remote, nothing-to-pull) previously skipped reconcile entirely
        // and left search silently stale — that is the P0-b bug being fixed.
        if (behind === 0) {
          await reconcileVaultCaches(vault.path, vault.name);
          reconciled = true;
        }
      } else {
        return {
          ...base,
          status: "error",
          ahead,
          behind,
          dirtyCount,
          message: "Lyt could not save these changes locally, so nothing was sent online.",
          errorOutput: commitRes.stderr || commitRes.stdout,
        };
      }
    }
  }

  if (!hasUpstreamFlag) {
    // No remote to pull/push from. A local-only vault still needs its caches
    // reconciled — if the commit above already reconciled, skip; otherwise
    // (e.g. a commit that didn't change indexed SoT, or a defensive re-run)
    // reconcile here before the early return so no-remote vaults are never
    // left with stale search. Cheap when SoT is unchanged (upserts no-op).
    if (committed && !reconciled) {
      await reconcileVaultCaches(vault.path, vault.name);
      reconciled = true;
    }
    return {
      ...base,
      status: "no-upstream",
      message: committed
        ? `Saved ${dirtyCount} change(s) on this machine. This vault has no online copy set up, so nothing was sent online.`
        : "This vault has no online copy set up.",
      dirtyCount,
    };
  }

  let meshContextResolved = false;
  // 0.12.0 Phase D · A1 — set when a concurrent-write conflict was resolved via
  // the plain keep-mine/theirs/both choice, so the final report carries it.
  let conflictChoice: ConflictChoice | undefined;
  if (behind > 0) {
    // Increment 1 · Phase A.4 — pull routed through the RemoteProvider port. The
    // default GitRemoteProvider wraps the SAME `git pull --rebase --quiet` with
    // allowFailure, so `pulled.code`/`pulled.stderr` below are unchanged and the
    // conflict-recovery path is byte-identical.
    if (pullTarget === null) {
      return {
        ...base,
        status: "origin-mismatch",
        message: "Online sync refused: no authorized sync source was resolved.",
        ahead,
        behind,
        dirtyCount,
      };
    }
    const pullChild = () => remote.pull(vault.path, pullTarget);
    const pulled =
      publicationAttempt === undefined
        ? await pullChild()
        : await publicationAttempt.runOutwardChild(pullChild);
    // v1.A.2 Lock 0.2 / v1.D.1b / v1.D.2b / v1.D.3a — after a successful
    // pull, reconcile the .db caches (ledger → lanes → arcs → fts) so
    // audit-export / provenance-trace / lanes / arcs / FTS search see
    // records another machine appended. v1.M.0 (P0-b) folded the four
    // formerly-inline upserts into reconcileVaultCaches() and guarded it
    // with `reconciled`: if a local commit already reconciled this sync,
    // skip the redundant re-walk here (the pulled state plus the committed
    // state are both on disk, so one reconcile covers both).
    if (pulled.code === 0 && !reconciled) {
      await reconcileVaultCaches(vault.path, vault.name);
      reconciled = true;
    }
    if (pulled.code !== 0) {
      const conflictPaths = await readConflictPaths(runGit, vault.path);
      const isMeshContextOnly =
        conflictPaths.length > 0 && conflictPaths.every((p) => p === MESH_CONTEXT_PATH);
      if (resolveMeshContext && isMeshContextOnly) {
        // Apply the documented recipe.
        await runGit(["checkout", "--theirs", "--", MESH_CONTEXT_PATH], { cwd: vault.path });
        try {
          await regenContextFlow(vault.name);
        } catch {
          // best-effort regen — proceed
        }
        await runGit(["add", "--", MESH_CONTEXT_PATH], { cwd: vault.path });
        const continued = await runGit(["rebase", "--continue"], {
          cwd: vault.path,
          allowFailure: true,
        });
        if (continued.code !== 0) {
          await runGit(["rebase", "--abort"], { cwd: vault.path, allowFailure: true });
          return {
            ...base,
            status: "conflict",
            message:
              "Your vault's shared settings changed here and online at the same time, and the differences went further than Lyt could safely sort out on its own. Your notes are safe and unchanged.",
            ahead,
            behind,
            dirtyCount,
            errorOutput: continued.stderr,
          };
        }
        meshContextResolved = true;
        // v1.M.0 (P0-b) — the heal applied the pulled commits to disk
        // (rebase --continue), so remote SoT is now present. Reconcile here
        // since the earlier `pulled.code === 0` branch did not run (the pull
        // initially conflicted). Guarded so we never double-reconcile.
        if (!reconciled) {
          await reconcileVaultCaches(vault.path, vault.name);
          reconciled = true;
        }
      } else if (resolveConflict !== undefined && conflictPaths.length > 0 && !isMeshContextOnly) {
        // A1-1 fix-pass — the `conflictPaths.length > 0` guard is load-bearing: a
        // pull can fail with NO unmerged paths (a transient network blip mid-pull,
        // a dirty-tree abort) — that is NOT a concurrent-write conflict. Without
        // this guard, such a failure entered the resolver branch and, under the
        // non-TTY `both` default, mis-narrated a plain reach failure as "you and
        // your online copy changed the same note(s) … Lyt kept BOTH". With the
        // guard, an empty-conflict pull failure falls through to the generic
        // conflict/reach-failure surface below instead of the concurrent-write UX.
        //
        // 0.12.0 Phase D · A1 — a concurrent 2-machine/2-user write conflict.
        // Surface the PLAIN keep-mine / keep-theirs / keep-both choice and apply
        // it — never a raw rebase marker, never a silent data loss.
        //
        // MECHANISM: abort the rebase first (returns the tree to the clean local
        // state — your version fully intact, no markers), THEN reconcile via a
        // strategy MERGE. A merge (not a mid-rebase `checkout --ours/--theirs`)
        // is used deliberately: the rebase ours/theirs are inverted + a
        // conflict-resolved-to-one-side commit can go EMPTY and wedge
        // `rebase --continue`; a merge with `-X ours`/`-X theirs` resolves
        // conflicting hunks to the chosen side, keeps the OTHER side's
        // non-conflicting changes, and always produces a clean, pushable merge
        // commit. For a merge, "ours" = the local branch and "theirs" = the
        // online copy (NOT inverted).
        await runGit(["rebase", "--abort"], { cwd: vault.path, allowFailure: true });
        const choice = await resolveConflict({ vaultName: vault.name, conflictPaths });
        if (choice === "both") {
          // The safe never-lose default (also the non-TTY default): keep BOTH —
          // the local version stays on disk here, the online version stays online
          // (still in the fetched remote copy). Nothing is overwritten; the user
          // decides later. Reported as `conflict` so it still signals attention.
          return {
            ...base,
            status: "conflict",
            conflictResolution: "both",
            message:
              `You and your online copy changed the same note(s) at the same time: ` +
              `${conflictPaths.join(", ") || "(unknown)"}. Lyt kept BOTH — your version is right ` +
              `here on this machine and the online version is safe online, so nothing was ` +
              `overwritten. Re-run \`lyt sync --vault "${vault.name}" --resolve-conflict mine\`, ` +
              `\`--resolve-conflict online\`, or \`--resolve-conflict both\` when ready.`,
            ahead,
            behind,
            dirtyCount,
            errorOutput: pulled.stderr,
          };
        }
        // mine → keep local ( `-X ours` ); theirs → keep online ( `-X theirs` ).
        const strategyOpt = choice === "mine" ? "ours" : "theirs";
        const merged = await runGit(["merge", "--no-edit", `-X${strategyOpt}`, "FETCH_HEAD"], {
          cwd: vault.path,
          allowFailure: true,
        });
        if (merged.code !== 0) {
          // The strategy merge didn't complete cleanly (rare — e.g. a
          // rename/rename). Abort to a safe state (local intact) and fall back to
          // the plain conflict report; never leak a marker.
          await runGit(["merge", "--abort"], { cwd: vault.path, allowFailure: true });
          return {
            ...base,
            status: "conflict",
            message:
              `You and your online copy changed the same note(s) in different ways, so Lyt ` +
              `couldn't combine them automatically: ${conflictPaths.join(", ") || "(unknown)"}. ` +
              `Your notes are safe and unchanged — nothing was overwritten. Re-run ` +
              `\`lyt sync --vault "${vault.name}" --resolve-conflict mine\`, ` +
              `\`--resolve-conflict online\`, or \`--resolve-conflict both\`.`,
            ahead,
            behind,
            dirtyCount,
            errorOutput: merged.stderr || pulled.stderr,
          };
        }
        // Resolved. Reconcile caches from the merged tree, recompute ahead/behind
        // (the merge commit is now ahead of the online copy, behind is cleared),
        // then fall through to the push leg so the resolution reaches online.
        conflictChoice = choice;
        if (!reconciled) {
          await reconcileVaultCaches(vault.path, vault.name);
          reconciled = true;
        }
        const ab2 = await runGit(["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"], {
          cwd: vault.path,
          allowFailure: true,
        });
        if (ab2.code === 0) {
          const parts = ab2.stdout.trim().split(/\s+/);
          ahead = Number(parts[0]) || 0;
          behind = Number(parts[1]) || 0;
        }
      } else {
        await runGit(["rebase", "--abort"], { cwd: vault.path, allowFailure: true });
        // firewall-C1 fix-pass — plain conflict language (no git recipe). The
        // mesh-context-only case points at the ONE Lyt verb that heals it; the
        // general case names the affected notes (plain paths, not git nouns) and
        // reassures the work is safe. The keep-mine/theirs/both resolver branch
        // above (A1) supersedes this when a resolver is supplied; this legacy
        // branch is the no-resolver / mesh-context path.
        const recipe = isMeshContextOnly
          ? `Your vault's shared settings changed here and online at the same time. Re-run \`lyt sync --resolve-mesh-context\` and Lyt will sort it out for you.`
          : `You and your online copy changed the same note(s) in different ways, so Lyt couldn't combine them automatically: ${conflictPaths.join(", ") || "(unknown)"}. Your notes are safe and unchanged — nothing was overwritten. Re-run \`lyt sync --vault "${vault.name}" --resolve-conflict mine\`, \`--resolve-conflict online\`, or \`--resolve-conflict both\`.`;
        return {
          ...base,
          status: "conflict",
          message: recipe,
          ahead,
          behind,
          dirtyCount,
          errorOutput: pulled.stderr,
        };
      }
    }
  }

  // Increment 1 · Phase A.4 — the SyncOperation emitted for the push leg (when
  // there are outgoing commits). Hoisted so the final return can attach its
  // honest horizon + reversibility class to the report.
  let syncOp: SyncOperation | null = null;
  if (ahead > 0) {
    if (pushTarget === null || pushTarget.refspec.length === 0) {
      return {
        ...base,
        status: "origin-mismatch",
        message: "Online sync refused: no authorized push destination was resolved.",
        ahead,
        behind,
        dirtyCount,
      };
    }
    // Emit a SyncOperation that OWNS the push through the RemoteProvider port.
    // Its horizon is READ BACK from the actual push result (pushed vs
    // committed-not-pushed) — never asserted from the verb. `lastPushResult`
    // carries the raw code+stderr, so the terminal-vs-retryable classification
    // below remains unchanged while the destination is explicit.
    // NOTE (A.4 scope, release review a review finding): unlike CaptureOperation, this op is
    // NOT persisted to the op-log — a `pushed` sync is un-undoable (`none`) and
    // the `committed-not-pushed` reset-commit executor is deferred (class-only),
    // so there is nothing for `lyt undo` to replay yet. It is emitted for the
    // report's honest horizon only; op-log persistence lands with the executor.
    syncOp = new SyncOperation(
      {
        vaultName: vault.name,
        vaultPath: vault.path,
        hasOutgoing: true,
        pushTarget,
      },
      {
        remote,
        // Canonical online attempts enter this operation only after the
        // immutable fetch boundary acquired the subject lock above. The push
        // therefore shares one authority lifetime with fetch/rebase/local
        // history mutation instead of probing a second, narrower permission.
        executeAuthorizedPush: async (push) =>
          publicationAttempt === undefined ? push() : publicationAttempt.runOutwardChild(push),
      },
    );
    await syncOp.apply();
    const pushed = syncOp.lastPushResult ?? { pushed: false, code: -1, stderr: "" };
    if (!pushed.pushed) {
      // hardening pass (Cohort-1 fix-pass) — a permission-denied push is a TERMINAL
      // failure (a re-run can never succeed). Surface ONE actionable line and
      // SUPPRESS the raw `fatal: unable to access …` stderr (it leaked
      // truncated mid-word in the live repro). A non-permission push failure
      // (rejected-non-fast-forward, transient network) keeps the raw stderr so
      // the user can act on it. Read-only subscriber vaults never reach here —
      // they return `skipped-readonly` above — so this is the OWNED-repo
      // unexpected-403 path (e.g. a transient auth state).
      if (isPermissionDeniedPush(pushed.stderr)) {
        // firewall-C1 fix-pass — narrate the raw denial stderr into plain sense
        // (the firewall's `auth` narration). The prior hand-authored message named
        // `gh auth status` + "remote"; the raw stderr now stays on `errorOutput`
        // (debug/--json only, never the human renderer).
        const narrated = narrate(pushed.stderr, { op: "save your notes online" });
        return {
          ...base,
          status: "error",
          message: `${narrated.plain} ${narrated.nextAction}`,
          ahead,
          behind,
          dirtyCount,
          errorOutput: pushed.stderr,
          // Increment 1 · Phase A.4 (release review a review finding/a review finding) — a failed push
          // after a local commit is the honest `committed-not-pushed → clean-undo`
          // case; the horizon MUST reach the report on THIS error path, not only
          // on success. Dropping it here made the whole point of A.4 invisible.
          ...(syncOp !== null
            ? { horizon: syncOp.horizon, reversible: syncOp.inverse().class }
            : {}),
        };
      }
      // firewall-C1 fix-pass — a generic (non-permission) push failure is also an
      // allowFailure path; narrate its stderr into plain sense (unknown → the safe
      // `lyt doctor` fallback), keeping the raw stderr on `errorOutput` only.
      const narrated = narrate(pushed.stderr, { op: "save your notes online" });
      return {
        ...base,
        status: "error",
        message: `${narrated.plain} ${narrated.nextAction}`,
        ahead,
        behind,
        dirtyCount,
        errorOutput: pushed.stderr,
        // Increment 1 · Phase A.4 (release review a review finding/a review finding) — carry the honest
        // horizon onto the generic push-failure report too (see note above).
        ...(syncOp !== null ? { horizon: syncOp.horizon, reversible: syncOp.inverse().class } : {}),
      };
    }

    const localHead = await runGit(["rev-parse", "HEAD"], {
      cwd: vault.path,
      allowFailure: true,
    });
    const onlineHead = await runGit(
      ["ls-remote", "--exit-code", pushTarget.url, destinationRef],
      { cwd: vault.path, allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 1024 },
    );
    const localObject = parseGitObjectId(localHead.stdout);
    const onlineObject = parseRemoteObjectId(onlineHead.stdout, destinationRef);
    if (
      localHead.code !== 0 ||
      onlineHead.code !== 0 ||
      localObject === null ||
      onlineObject === null ||
      localObject !== onlineObject
    ) {
      return {
        ...base,
        status: "pushed-verification-pending",
        message:
          `Lyt sent ${ahead} change(s), but could not yet verify that the exact online copy matches. ` +
          `Run \`lyt sync --check --vault "${vault.name}" --json\` when online access is stable.`,
        ahead,
        behind,
        dirtyCount,
        ...(syncOp !== null ? { horizon: syncOp.horizon, reversible: syncOp.inverse().class } : {}),
      };
    }
    const trackingRef = `refs/remotes/${branchRemoteName}/${destinationRef.replace(/^refs\/heads\//, "")}`;
    const refreshedTracking = await runGit(["update-ref", trackingRef, localObject], {
      cwd: vault.path,
      allowFailure: true,
    });
    if (refreshedTracking.code !== 0) {
      return {
        ...base,
        status: "error",
        message:
          "The exact online copy is saved, but Lyt could not refresh its local online pointer. " +
          `Run \`lyt sync --check --vault "${vault.name}" --json\` before the next sync.`,
        ahead,
        behind,
        dirtyCount,
        errorOutput: refreshedTracking.stderr,
        ...(syncOp !== null ? { horizon: syncOp.horizon, reversible: syncOp.inverse().class } : {}),
      };
    }
  }

  // firewall-C1 fix-pass — plain success wording (no git noun): "Brought in" for
  // incoming updates, "saved … online" for outgoing changes. The machine `status`
  // enum (pushed/pulled/diverged-synced) is unchanged (a stable machine label);
  // only the human `message` is narrated.
  let finalStatus: VaultSyncStatus = "clean";
  let message = "Up to date.";
  if (committed && behind > 0) {
    finalStatus = "diverged-synced";
    message = `Brought in ${behind} update(s) and saved ${ahead} of your change(s) online.`;
  } else if (committed) {
    finalStatus = "pushed";
    message = `Saved ${dirtyCount} change(s) online.`;
  } else if (ahead > 0 && behind > 0) {
    finalStatus = "diverged-synced";
    message = `Brought in ${behind} update(s) and saved ${ahead} of your change(s) online.`;
  } else if (ahead > 0) {
    finalStatus = "pushed";
    message = `Saved ${ahead} of your change(s) online.`;
  } else if (behind > 0) {
    finalStatus = "pulled";
    message = `Brought in ${behind} update(s) from your online copy.`;
  }
  // 0.12.0 Phase D · A1 — when a concurrent-write conflict was just resolved via
  // keep-mine/keep-theirs, override the message with plain confirmation of which
  // version was kept (the machine `status` stays the honest pushed/diverged
  // label). `both` returns earlier, so only mine/theirs reach here.
  if (conflictChoice === "mine") {
    message =
      "You and your online copy changed the same note(s) — Lyt kept your version and saved it online.";
  } else if (conflictChoice === "theirs") {
    message = "You and your online copy changed the same note(s) — Lyt kept the online version.";
  }
  return {
    ...base,
    status: finalStatus,
    message,
    ahead,
    behind,
    dirtyCount,
    meshContextResolved,
    ...(conflictChoice !== undefined
      ? { conflictResolution: conflictChoice === "theirs" ? "online" : conflictChoice }
      : {}),
    // Increment 1 · Phase A.4 — attach the honest horizon + reversibility class
    // when a push was attempted (ahead > 0). Read back from the SyncOperation's
    // actual push result; absent on pull-only / up-to-date / no-push syncs.
    ...(syncOp !== null ? { horizon: syncOp.horizon, reversible: syncOp.inverse().class } : {}),
  };
}

// hardening pass / C1 (Cohort-1 fix-pass release review) — the permission-denied (terminal)
// classifier now lives in ONE place, `isPermissionDeniedPush` from
// @younndai/lyt-vault (util/push-classify.ts), imported above. The former
// in-file copy here and the byte-identical copy in reconcile-publish.ts were
// deleted — a single shared definition can't drift. Terminal only on a genuine
// permission/auth co-signal; a bare 403 (secondary rate-limit) or a bare SSH
// "access rights" connection failure stays NON-terminal (retry-safe).

interface PorcelainV1Record {
  xy: string;
  /** Destination/current path. Git emits this first under `-z`. */
  path: string;
  /** Original path for rename/copy records. */
  sourcePath?: string;
}

const PORCELAIN_V1_STATUS_CHARS = new Set([" ", "M", "T", "A", "D", "R", "C", "U", "?", "!"]);

function malformedPorcelain(reason: "record" | "rename-source"): never {
  const detail =
    reason === "rename-source"
      ? "missing rename/copy source record"
      : "truncated or invalid record";
  throw new Error(`Malformed Git status output: ${detail}.`);
}

/** Parse `git status --porcelain=v1 -z` without line, quote, or arrow interpretation. */
function parsePorcelainV1Z(output: string): PorcelainV1Record[] {
  if (output.length === 0) return [];
  const records: PorcelainV1Record[] = [];
  let cursor = 0;
  while (cursor < output.length) {
    const end = output.indexOf("\0", cursor);
    if (end < 0) malformedPorcelain("record");
    const raw = output.slice(cursor, end);
    if (
      raw.length < 4 ||
      raw[2] !== " " ||
      raw.slice(3).length === 0 ||
      !PORCELAIN_V1_STATUS_CHARS.has(raw[0]!) ||
      !PORCELAIN_V1_STATUS_CHARS.has(raw[1]!)
    ) {
      malformedPorcelain("record");
    }
    const xy = raw.slice(0, 2);
    const path = raw.slice(3);
    cursor = end + 1;
    if (/[RC]/.test(xy)) {
      const sourceEnd = output.indexOf("\0", cursor);
      if (sourceEnd < 0 || sourceEnd === cursor) malformedPorcelain("rename-source");
      records.push({ xy, path, sourcePath: output.slice(cursor, sourceEnd) });
      cursor = sourceEnd + 1;
    } else {
      records.push({ xy, path });
    }
  }
  return records;
}

function porcelainPaths(records: readonly PorcelainV1Record[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const record of records) {
    // The index column is already staged. Re-adding those paths can fail when a
    // tracked deletion intentionally leaves an ignored local-only file behind.
    if (record.xy[1] === " ") continue;
    for (const path of [record.path, record.sourcePath]) {
      if (path !== undefined && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

async function readPorcelainStatus(runGit: GitRunner, cwd: string): Promise<PorcelainV1Record[]> {
  const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
  });
  if (status.stdoutTruncated === true) {
    throw new Error("Malformed Git status output: output limit reached.");
  }
  return parsePorcelainV1Z(status.stdout);
}

async function stagePorcelainRecords(
  runGit: GitRunner,
  cwd: string,
  records: readonly PorcelainV1Record[],
): Promise<StagePorcelainResult> {
  const paths = porcelainPaths(records);
  if (paths.length === 0) return { staged: true };

  const inspections = paths.map((path) => ({ path, inspection: inspectWindowsGitPath(cwd, path) }));
  const invalid = inspections.find(({ inspection }) => !inspection.ok);
  if (invalid !== undefined) {
    return {
      staged: false,
      pathRefusal: pathRefusalEvidence(
        invalid.path,
        invalid.inspection.refusal?.code ?? "path-escape",
        invalid.inspection.fullPathLength,
        false,
      ),
    };
  }

  const longPath = inspections.find(({ inspection }) => inspection.requiresGitLongPaths);
  if (longPath !== undefined) {
    let capability: "enabled" | "disabled" | "indeterminate" = "indeterminate";
    try {
      const result = await runGit(["config", "--bool", "--get", "core.longpaths"], {
        cwd,
        allowFailure: true,
        policy: GIT_READ_ONLY_POLICY,
      });
      const value = result.stdout.trim().toLowerCase();
      if (result.code === 0 && value === "true" && result.stdoutTruncated !== true) {
        capability = "enabled";
      } else if (
        result.code === 1 ||
        (result.code === 0 && value === "false" && result.stdoutTruncated !== true)
      ) {
        capability = "disabled";
      }
    } catch {
      capability = "indeterminate";
    }
    if (capability !== "enabled") {
      return {
        staged: false,
        pathRefusal: pathRefusalEvidence(
          longPath.path,
          capability === "disabled" ? "git-longpaths-disabled" : "git-longpaths-indeterminate",
          longPath.inspection.fullPathLength,
          true,
        ),
      };
    }
  }
  await runGit(
    ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
    { cwd, stdin: Buffer.from(`${paths.join("\0")}\0`, "utf8") },
  );
  return { staged: true };
}

type StagePorcelainResult =
  | { readonly staged: true }
  | { readonly staged: false; readonly pathRefusal: SyncPathRefusalEvidence };

const PATH_REFUSAL_EVIDENCE_MAX_LENGTH = 240;

function pathRefusalEvidence(
  path: string,
  code: SyncPathRefusalEvidence["code"],
  fullPathLength: number,
  requiresGitLongPaths: boolean,
): SyncPathRefusalEvidence {
  const escaped = visibleEscapeControls(path);
  return {
    code,
    path:
      escaped.length <= PATH_REFUSAL_EVIDENCE_MAX_LENGTH
        ? escaped
        : `${escaped.slice(0, PATH_REFUSAL_EVIDENCE_MAX_LENGTH - 1)}…`,
    pathLength: path.length,
    fullPathLength,
    requiresGitLongPaths,
  };
}

function stagingRefusalReport(
  base: VaultSyncReport,
  dirtyCount: number,
  pathRefusal: SyncPathRefusalEvidence,
): VaultSyncReport {
  const capability = pathRefusal.requiresGitLongPaths
    ? "Git for Windows does not have a confirmed core.longpaths=true setting"
    : "one of its paths cannot be represented safely on Windows";
  const remedy = pathRefusal.requiresGitLongPaths
    ? "Enable Git long-path support or shorten the affected path, then retry."
    : "Rename the affected path, then retry.";
  return {
    ...base,
    status: "error",
    message: `Sync refused before staging because ${capability}. ${remedy}`,
    dirtyCount,
    staged: false,
    pathRefusal,
  };
}

// Brief C (F2) — assemble the deterministic metadata-driven commit message for
// a vault's ongoing-changes commit. Classifies each porcelain status line into
// a figment change (+new/~updated/-deleted), resolves each figment's display
// title from its frontmatter (filename fallback; the path's basename for a
// deletion, which can't be read), folds `.lyt/**` churn into a single
// `+ .lyt config` line, and stamps the subject with the handle + `<mesh>/<vault>`
// + a minute-granularity timestamp. The pure heavy-lifting lives in lyt-vault
// sync-helpers (unit-tested); this is the fs glue. No LLM is ever called.
function buildSyncCommitMessage(
  vault: VaultRow,
  statusRecords: readonly PorcelainV1Record[],
  now: Date,
): string {
  const figments: ChangedFigment[] = [];
  let configChanged = false;
  for (const record of statusRecords) {
    if (isConfigPath(record.path)) {
      configChanged = true;
      continue;
    }
    if (!isFigmentPath(record.path)) continue; // non-figment, non-config: not enumerated
    const changeType: ChangedFigment["changeType"] =
      record.xy === "??"
        ? "add"
        : record.xy.includes("D")
          ? "delete"
          : record.xy.includes("A")
            ? "add"
            : "modify";
    const title =
      changeType === "delete"
        ? figmentBasename(record.path)
        : (readVaultFigmentTitle(vault.path, record.path) ?? figmentBasename(record.path));
    figments.push({ path: record.path, changeType, title });
  }
  let handle = "";
  try {
    handle = getHandleFromIdentity();
  } catch {
    // No identity resolvable → the `(<handle>)` subject segment is omitted.
  }
  const shortTs = `${now.toISOString().slice(0, 16)}Z`;
  return buildVaultCommitMessage(figments, {
    handle,
    vaultName: vault.name,
    shortTs,
    configChanged,
  });
}

// Read a figment's frontmatter title from disk (non-deleted figments only).
// Non-fatal: an unreadable file returns null → the caller falls back to the
// filename.
function readVaultFigmentTitle(vaultPath: string, relPath: string): string | null {
  try {
    return readFigmentTitle(readFileSync(join(vaultPath, relPath), "utf8"));
  } catch {
    return null;
  }
}

// Basename without the `.md` extension — the filename fallback / deletion title.
function figmentBasename(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return visibleEscapeControls(base.replace(/\.md$/i, ""));
}

function visibleEscapeControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (char) => {
    const named: Readonly<Record<string, string>> = {
      "\b": "\\b",
      "\t": "\\t",
      "\n": "\\n",
      "\f": "\\f",
      "\r": "\\r",
    };
    return named[char] ?? `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

async function readConflictPaths(runGit: GitRunner, cwd: string): Promise<string[]> {
  const r = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd, allowFailure: true });
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// `git status --porcelain` field interpretation used downstream by `sync --check`.
export function classifyCheckStatus(args: {
  ahead: number;
  behind: number;
  dirtyCount: number;
  hasUpstream: boolean;
  frozen: boolean;
}): string {
  if (args.frozen) return "frozen";
  if (!args.hasUpstream) return "no-upstream";
  if (args.dirtyCount > 0) {
    // A2a fix — a dirty tree must NOT erase a pending inbound-receive signal.
    // The pre-fix `return "dirty"` short-circuited before `behind` was ever
    // tested, so a subscriber that is BOTH dirty AND behind classified as bare
    // "dirty" and the "to receive" count vanished. When there are updates to
    // receive, return the combined `dirty-behind` status so the renderer can
    // surface both the unsaved change count AND the pending receive count.
    if (args.behind > 0) return "dirty-behind";
    return "dirty";
  }
  if (args.ahead > 0 && args.behind > 0) return "diverged";
  if (args.ahead > 0) return `ahead-${args.ahead}`;
  if (args.behind > 0) return `behind-${args.behind}`;
  return "clean";
}

// Test-only surfaces for the structural Git boundary.
export {
  parsePorcelainV1Z as _parsePorcelainV1Z,
  readPorcelainStatus as _readPorcelainStatus,
  stagePorcelainRecords as _stagePorcelainRecords,
  syncOneVault as _syncOneVault,
};
