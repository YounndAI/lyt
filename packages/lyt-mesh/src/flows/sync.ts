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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildVaultCommitMessage,
  classifyPorcelainLine,
  closeRegistry,
  deriveWriteGate,
  GitRemoteProvider,
  getHandleFromIdentity,
  isAccessRemoved,
  isConfigPath,
  isFigmentPath,
  isLytDbCorrupt,
  isPermissionDeniedPush,
  listMeshes,
  migrateVaultGitignoreIndexRule,
  listSubscriptionsForMesh,
  listVaults,
  narrate,
  narrateAccessRemoved,
  normalizeGitHubRepoCoordinate,
  openRegistry,
  readFigmentTitle,
  readFrozenLock,
  realIdentityRunner,
  regenContextFlow,
  runGit as defaultRunGit,
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
} from "@younndai/lyt-vault";

// Increment 1 · Phase A.4 — the sync flow emits a SyncOperation per pushing
// vault so its reversibility horizon is read back from the ACTUAL push result.
import { SyncOperation } from "../op/operations/sync-op.js";

export type VaultSyncStatus =
  | "clean"
  | "committed"
  | "pushed"
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
export type ConflictResolver = (
  ctx: ConflictContext,
) => ConflictChoice | Promise<ConflictChoice>;

export interface VaultSyncReport {
  name: string;
  path: string;
  status: VaultSyncStatus;
  message: string;
  ahead?: number;
  behind?: number;
  dirtyCount?: number;
  meshContextResolved?: boolean;
  errorOutput?: string;
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
  conflictResolution?: ConflictChoice;
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
  /** Expected GitHub owner/repo for guarded online syncs, keyed by canonical vault name. */
  expectedOriginByVault?: Readonly<Record<string, string>>;
}

const MESH_CONTEXT_PATH = ".lyt/mesh-context.md";

export async function syncFlow(args: SyncFlowArgs = {}): Promise<SyncFlowResult> {
  const runGit = args.runGit ?? defaultRunGit;
  const networkMode = args.networkMode ?? "online";
  // Increment 1 · Phase A.4 — the git-remote port. Default wraps the SAME runGit
  // seam, so behavior is unchanged when no fake is injected.
  const remote =
    networkMode === "online" ? (args.remote ?? new GitRemoteProvider(runGit)) : null;
  const now = args.now ?? new Date();
  // A6-1 (0.12.0 Phase D fix-pass) — the gh-auth verdict, consulted only on a
  // fetch-404 to distinguish a genuine revoke from an unauthed/expired 404.
  const ghAuthOk =
    networkMode === "online"
      ? (args.ghAuthOk ?? (() => realIdentityRunner.ghAuthStatus()))
      : () => null;
  const db = await openRegistry();
  let candidates: VaultRow[];
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
    candidates =
      args.vaultNames && args.vaultNames.length > 0
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
      if (networkMode === "local-only") {
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
  for (const v of candidates) {
    const ridHex = uuid7BytesToHex(v.rid);
    const report = await syncOneVault(
      v,
      runGit,
      remote,
      now,
      args.resolveMeshContext === true,
      args.message,
      readOnlyRidHexes.has(ridHex),
      args.resolveConflict,
      ghAuthOk,
      networkMode,
      args.expectedOriginByVault?.[v.name],
    );
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
      r.status !== "origin-mismatch",
  );
  return { reports, ok, frictionHints: deriveFrictionHints(reports) };
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
    const status = await runGit(["status", "--porcelain"], { cwd: vault.path });
    const statusLines = status.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const dirtyCount = statusLines.length;
    if (readOnly) {
      await reconcileVaultCaches(vault.path, vault.name, { skipGitignoreMigration: true });
      return {
        ...base,
        status: "skipped-readonly",
        dirtyCount,
        message:
          "This is a read-only shared vault; local-only sync made no Git changes and contacted no online service.",
      };
    }
    let committed = false;
    const paths = statusLines
      .map((line) => parsePorcelainPath(line))
      .filter((path): path is string => path !== null);
    if (paths.length > 0) {
      await runGit(["add", "--", ...paths], { cwd: vault.path });
      const commitMsg = messageOverride ?? buildSyncCommitMessage(vault, statusLines, now);
      const commitRes = await runGit(["commit", "-m", commitMsg], {
        cwd: vault.path,
        allowFailure: true,
      });
      committed = commitRes.code === 0;
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

  if (expectedOrigin !== undefined) {
    const origin = await runGit(["remote", "get-url", "origin"], {
      cwd: vault.path,
      allowFailure: true,
    });
    if (origin.code === 0) {
      const actual = normalizeGitHubRepoCoordinate(origin.stdout);
      if (actual === null || actual.toLowerCase() !== expectedOrigin.toLowerCase()) {
        return {
          ...base,
          status: "origin-mismatch",
          message: `Online sync refused: expected ${expectedOrigin}, found ${actual ?? (origin.stdout.trim() || "an unrecognized origin")}.`,
        };
      }
    }
  }

  // Fetch first so ahead/behind reflects truth (if upstream is configured).
  const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: vault.path,
    allowFailure: true,
  });
  const hasUpstreamFlag = upstreamRes.code === 0;
  if (hasUpstreamFlag) {
    const fetched = await runGit(["fetch", "--quiet"], { cwd: vault.path, allowFailure: true });
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

  const status = await runGit(["status", "--porcelain"], { cwd: vault.path });
  const statusLines = status.stdout
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const dirtyCount = statusLines.length;

  let ahead = 0;
  let behind = 0;
  if (hasUpstreamFlag) {
    const ab = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
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
      const pulled = await runGit(["pull", "--rebase", "--autostash", "--quiet"], {
        cwd: vault.path,
        allowFailure: true,
      });
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
          const treeClean =
            reset.code === 0 && recheck.code === 0 && residualUnmerged.length === 0;
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
    const untrackedCount = statusLines.filter((l) => l.startsWith("??")).length;
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

  // v1.M.0 (P0-b) — single-reconcile guard. Each sync reconciles the .db
  // caches AT MOST ONCE, via reconcileVaultCaches(). It fires after a local
  // commit OR after a successful pull (the two ways on-disk SoT can change
  // within one sync); the guard prevents the local-commit-then-pull path
  // from reconciling twice.
  let reconciled = false;

  // Stage + commit dirty changes (explicit paths only, never `git add -A`).
  let committed = false;
  if (dirtyCount > 0) {
    const paths = statusLines
      .map((line) => parsePorcelainPath(line))
      .filter((p): p is string => p !== null);
    if (paths.length > 0) {
      // Use `--` separator to keep paths from being interpreted as flags/refs.
      await runGit(["add", "--", ...paths], { cwd: vault.path });
      // Brief C (F2) — metadata-driven commit message (subject + per-figment
      // body, +new/~updated/-deleted from git status), unless the caller
      // supplied an explicit `message` override (e.g. an agent's semantic
      // summary). The deterministic path NEVER calls an LLM.
      const commitMsg = messageOverride ?? buildSyncCommitMessage(vault, statusLines, now);
      const commitRes = await runGit(["commit", "-m", commitMsg], {
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
    const pulled = await remote.pull(vault.path);
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
              `overwritten. Re-run \`lyt sync\` when you're ready to combine them.`,
            ahead,
            behind,
            dirtyCount,
            errorOutput: pulled.stderr,
          };
        }
        // mine → keep local ( `-X ours` ); theirs → keep online ( `-X theirs` ).
        const strategyOpt = choice === "mine" ? "ours" : "theirs";
        const merged = await runGit(
          ["merge", "--no-edit", `-X${strategyOpt}`, "@{u}"],
          { cwd: vault.path, allowFailure: true },
        );
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
              `Your notes are safe and unchanged — nothing was overwritten. Re-run \`lyt sync\` ` +
              `to try again, or copy your version into another vault to keep it.`,
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
        const ab2 = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
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
          : `You and your online copy changed the same note(s) in different ways, so Lyt couldn't combine them automatically: ${conflictPaths.join(", ") || "(unknown)"}. Your notes are safe and unchanged — nothing was overwritten. Re-run \`lyt sync\` to try again, or copy your version into another vault to keep it.`;
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
    // Emit a SyncOperation that OWNS the push through the RemoteProvider port.
    // Its horizon is READ BACK from the actual push result (pushed vs
    // committed-not-pushed) — never asserted from the verb. `lastPushResult`
    // carries the raw code+stderr, so the terminal-vs-retryable classification
    // below is byte-identical to the pre-A.4 inline `runGit(["push"])` path.
    // NOTE (A.4 scope, release review a review finding): unlike CaptureOperation, this op is
    // NOT persisted to the op-log — a `pushed` sync is un-undoable (`none`) and
    // the `committed-not-pushed` reset-commit executor is deferred (class-only),
    // so there is nothing for `lyt undo` to replay yet. It is emitted for the
    // report's honest horizon only; op-log persistence lands with the executor.
    syncOp = new SyncOperation(
      { vaultName: vault.name, vaultPath: vault.path, hasOutgoing: true },
      { remote },
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
        ...(syncOp !== null
          ? { horizon: syncOp.horizon, reversible: syncOp.inverse().class }
          : {}),
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
    message = "You and your online copy changed the same note(s) — Lyt kept your version and saved it online.";
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
    ...(conflictChoice !== undefined ? { conflictResolution: conflictChoice } : {}),
    // Increment 1 · Phase A.4 — attach the honest horizon + reversibility class
    // when a push was attempted (ahead > 0). Read back from the SyncOperation's
    // actual push result; absent on pull-only / up-to-date / no-push syncs.
    ...(syncOp !== null
      ? { horizon: syncOp.horizon, reversible: syncOp.inverse().class }
      : {}),
  };
}

// hardening pass / C1 (Cohort-1 fix-pass release review) — the permission-denied (terminal)
// classifier now lives in ONE place, `isPermissionDeniedPush` from
// @younndai/lyt-vault (util/push-classify.ts), imported above. The former
// in-file copy here and the byte-identical copy in reconcile-publish.ts were
// deleted — a single shared definition can't drift. Terminal only on a genuine
// permission/auth co-signal; a bare 403 (secondary rate-limit) or a bare SSH
// "access rights" connection failure stays NON-terminal (retry-safe).

function parsePorcelainPath(line: string): string | null {
  // Porcelain v1 lines: "XY <path>" or "XY <orig> -> <new>" (renames).
  if (line.length < 4) return null;
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  if (arrow >= 0) {
    return decodeGitQuotedPath(rest.slice(arrow + 4));
  }
  return decodeGitQuotedPath(rest);
}

// Git porcelain quotes pathnames using C-style escapes. Those quote characters
// are presentation, not part of the filename, and must never reach argv.
function decodeGitQuotedPath(path: string): string {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') return path;
  const bytes: number[] = [];
  const inner = path.slice(1, -1);
  for (let i = 0; i < inner.length; i += 1) {
    const codePoint = inner.codePointAt(i)!;
    const char = String.fromCodePoint(codePoint);
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      if (codePoint > 0xffff) i += 1;
      continue;
    }
    const escaped = inner[++i];
    if (escaped === undefined) return path;
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    if (simple[escaped] !== undefined) {
      bytes.push(simple[escaped]);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && i + 1 < inner.length && /[0-7]/.test(inner[i + 1]!)) {
        octal += inner[++i]!;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    return path;
  }
  return Buffer.from(bytes).toString("utf8");
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
  statusLines: readonly string[],
  now: Date,
): string {
  const figments: ChangedFigment[] = [];
  let configChanged = false;
  for (const line of statusLines) {
    const change = classifyPorcelainLine(line);
    if (change === null) continue;
    if (isConfigPath(change.path)) {
      configChanged = true;
      continue;
    }
    if (!isFigmentPath(change.path)) continue; // non-figment, non-config: not enumerated
    const title =
      change.changeType === "delete"
        ? figmentBasename(change.path)
        : (readVaultFigmentTitle(vault.path, change.path) ?? figmentBasename(change.path));
    figments.push({ path: change.path, changeType: change.changeType, title });
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
  return base.replace(/\.md$/i, "");
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

// Re-export for `sync.ts:syncOneVault` tests that want to seed paths.
export { parsePorcelainPath as _parsePorcelainPath };
