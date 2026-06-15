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
  getHandleFromIdentity,
  isConfigPath,
  isFigmentPath,
  isLytDbCorrupt,
  isPermissionDeniedPush,
  isPureSubscriberVault,
  listMeshes,
  listSubscriptionsForMesh,
  listVaults,
  openRegistry,
  readFigmentTitle,
  readFrozenLock,
  regenContextFlow,
  runGit as defaultRunGit,
  upsertArcsCache,
  upsertFtsCache,
  upsertLanesCache,
  upsertLedgerCache,
  uuid7BytesToHex,
  writeIndexWatermark,
  type ChangedFigment,
  type GitRunOptions,
  type GitRunResult,
  type VaultRow,
} from "@younndai/lyt-vault";

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
  | "error";

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
  // no subscription references — preserves backward-compat per OD-9
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
}

const MESH_CONTEXT_PATH = ".lyt/mesh-context.md";

export async function syncFlow(args: SyncFlowArgs = {}): Promise<SyncFlowResult> {
  const runGit = args.runGit ?? defaultRunGit;
  const now = args.now ?? new Date();
  const db = await openRegistry();
  let candidates: VaultRow[];
  // v1.C.2 — derive the set of subscribed-vault rids across all
  // registered meshes BEFORE iterating, so each report can be tagged
  // with `subscribed: true` when applicable. Subscribed vaults are
  // already registered locally (clone-on-subscribe lands them in the
  // vaults table), so no double-dispatch is needed; the cross-mesh
  // subscription view is purely classificatory at sync time. Per
  // brief OD-9 default extension path: no meta-CLI edit, no new
  // syncOneVault call — additive discriminator only.
  let subscribedRidHexes = new Set<string>();
  // hardening pass (Cohort-1 fix-pass) — the rids of PURE-SUBSCRIBER read-only vaults
  // (subscribed in some mesh, home in none), derived from the SAME cheap LOCAL
  // `mesh_vaults.role` signal the capture gate and `deriveVaultWritable`
  // use — NO gh probe in the sync loop. syncOneVault skips commit+push for
  // these (pull-only). The OUTBOX itself lives in reconcile-publish (the publish
  // pass), NOT here: sync's job is to skip the local COMMIT that would otherwise
  // feed an unpushable publish op downstream — reconcile-publish separately
  // EXCLUDES pure subscribers from its work-set, so no outbox op is ever
  // enqueued for them. Computed once here while the registry is open, keyed by
  // rid hex.
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
      if (await isPureSubscriberVault(db, v.rid)) {
        readOnlyRidHexes.add(uuid7BytesToHex(v.rid));
      }
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
      now,
      args.resolveMeshContext === true,
      args.message,
      readOnlyRidHexes.has(ridHex),
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
            `${report.message}; WARNING: search index (.lyt/indexes/lyt.db) is corrupt — ` +
            `git layer synced fine, but search/recall/primer are degraded. Run 'lyt reindex --vault '${v.name}'' to rebuild it.`;
        }
      } catch {
        // probe failure (e.g. transient lock) — never fail the sync over it
      }
    }
    reports.push(report);
  }
  const ok = reports.every((r) => r.status !== "conflict" && r.status !== "error");
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
async function reconcileVaultCaches(vaultPath: string, vaultName: string): Promise<void> {
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
    } else if (r.status === "error") {
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
  now: Date,
  resolveMeshContext: boolean,
  messageOverride?: string,
  readOnly = false,
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
    return { ...base, status: "not-git-repo", message: "not a Git repo (no .git/)" };
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
      return {
        ...base,
        status: "error",
        message: "git fetch failed",
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
  // + the reset-to-origin remedy so the user can un-jam a vault the pre-fix bug
  // already wedged. We do NOT auto-reset (it discards local edits — handler's
  // call), but we name the exact command.
  if (readOnly) {
    let pulledMsg = "";
    if (hasUpstreamFlag && behind > 0 && ahead === 0) {
      // Clean fast-forwardable subscriber → pull to stay fresh, then reconcile.
      const pulled = await runGit(["pull", "--rebase", "--quiet"], {
        cwd: vault.path,
        allowFailure: true,
      });
      if (pulled.code === 0) {
        await reconcileVaultCaches(vault.path, vault.name);
        pulledMsg = `pulled ${behind} commit(s) from upstream; `;
        behind = 0;
      }
      // A pull failure on a read-only vault is non-fatal here — we still report
      // skipped-readonly (no push is attempted regardless); the user's read-only
      // copy just stays a few commits behind until the divergence is resolved.
    }
    // Cohort-1 fix-pass release review (Major) — the recovery remedy must branch on
    // the ACTUAL state, and must NEVER lead with a destructive `reset --hard`:
    //
    // (a) UNTRACKED stray (dirty, NOT ahead) — the canonical hardening pass case: a
    // stray Figment was written into the read-only vault but never
    // committed. `git status --porcelain` (no `-uno`) counts these as
    // untracked (`??`), and `reset --hard @{u}` does NOT remove untracked
    // files — so the prior remedy did NOTHING for the very case it exists
    // for. Mirror the hardening pass refusal: tell the user to MOVE/REMOVE the stray
    // (relocate it to a home vault), not reset.
    //
    // (b) COMMITTED local work (ahead>0) — the user committed real edits into a
    // subscribed vault. The prior `reset --hard @{u}` would DESTROY them.
    // Lead non-destructive: preserve the commits onto a branch first (or
    // relocate the content to a home vault); only mention the destructive
    // discard last, explicitly flagged. Guard the `@{u}` ref on an upstream
    // actually existing — fall back to `origin/<branch>` (or `git fetch`)
    // when `@{u}` isn't configured, so the command can't error on a
    // no-upstream read-only vault.
    //
    // Both are `readonlyDiverged: true` (the recovery rider fires); the WORDING
    // differs so the user runs the right (and safe) command.
    const untrackedCount = statusLines.filter((l) => l.startsWith("??")).length;
    const trackedDirtyCount = dirtyCount - untrackedCount;
    const diverged = ahead > 0 || dirtyCount > 0;
    if (diverged) {
      // Resolve the upstream ref for a guarded reset (committed-work case only).
      const upstreamRef = hasUpstreamFlag
        ? `'git -C "${vault.path}" reset --hard @{u}'`
        : `'git -C "${vault.path}" fetch origin && git -C "${vault.path}" reset --hard origin/<branch>'`;

      let remedy: string;
      if (ahead > 0) {
        // (b) Committed unpushable work — non-destructive FIRST.
        const strayBits: string[] = [`${ahead} unpushable local commit(s)`];
        if (trackedDirtyCount > 0) strayBits.push(`${trackedDirtyCount} modified tracked file(s)`);
        if (untrackedCount > 0) strayBits.push(`${untrackedCount} untracked file(s)`);
        remedy =
          `This vault has ${strayBits.join(" + ")} that can never be pushed (no push rights). ` +
          `PRESERVE the work first — either move the content into one of your home vaults and ` +
          `re-capture it there, or stash/branch it: ` +
          `'git -C "${vault.path}" branch lyt-rescue-${vault.name.replace(/[^A-Za-z0-9._-]/g, "-")}' ` +
          `(keeps your commits on a side branch). ONLY after the work is safe, discard the ` +
          `divergence with ${upstreamRef} (this DISCARDS the local commits).`;
      } else {
        // (a) Uncommitted stray — untracked and/or tracked-modified, no commit.
        const strayBits: string[] = [];
        if (untrackedCount > 0) strayBits.push(`${untrackedCount} stray untracked file(s)`);
        if (trackedDirtyCount > 0) strayBits.push(`${trackedDirtyCount} modified tracked file(s)`);
        remedy =
          `This vault has ${strayBits.join(" + ")} that can't be pushed (read-only). ` +
          (untrackedCount > 0
            ? `MOVE or REMOVE the stray file(s) — relocate them into one of your home vaults and ` +
              `re-capture there ('git -C "${vault.path}" status' lists them; a hard reset would ` +
              `NOT remove untracked files, so do not reach for one here). `
            : `Discard the local edits to tracked files with ` +
              `'git -C "${vault.path}" checkout -- .', or relocate them to a home vault first. `);
      }
      return {
        ...base,
        status: "skipped-readonly",
        readonlyDiverged: true,
        message:
          `${pulledMsg}read-only subscribed vault — skipped push (you can't push to its upstream). ` +
          remedy +
          ` Capture into a home vault instead.`,
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
          ? `${pulledMsg.trimEnd()} read-only subscribed vault — pull-only (skipped push).`
          : "read-only subscribed vault — pull-only (skipped push).",
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
        ? `committed ${dirtyCount} file(s); no upstream configured for push`
        : "no upstream configured",
      dirtyCount,
    };
  }

  let meshContextResolved = false;
  if (behind > 0) {
    const pulled = await runGit(["pull", "--rebase", "--quiet"], {
      cwd: vault.path,
      allowFailure: true,
    });
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
              "rebase conflict beyond .lyt/mesh-context.md; --resolve-mesh-context could not heal alone",
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
      } else {
        await runGit(["rebase", "--abort"], { cwd: vault.path, allowFailure: true });
        const recipe = isMeshContextOnly
          ? `Conflict on .lyt/mesh-context.md only. Re-run with --resolve-mesh-context, or manually: 'git pull --rebase' → 'git checkout --theirs .lyt/mesh-context.md' → 'lyt vault regen-context ${vault.name}' → 'git add .lyt/mesh-context.md' → 'git rebase --continue'.`
          : `Rebase conflict on: ${conflictPaths.join(", ") || "(unknown paths)"}. Resolve with normal git tooling.`;
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

  if (ahead > 0) {
    const pushed = await runGit(["push"], { cwd: vault.path, allowFailure: true });
    if (pushed.code !== 0) {
      // hardening pass (Cohort-1 fix-pass) — a permission-denied push is a TERMINAL
      // failure (a re-run can never succeed). Surface ONE actionable line and
      // SUPPRESS the raw `fatal: unable to access …` stderr (it leaked
      // truncated mid-word in the live repro). A non-permission push failure
      // (rejected-non-fast-forward, transient network) keeps the raw stderr so
      // the user can act on it. Read-only subscriber vaults never reach here —
      // they return `skipped-readonly` above — so this is the OWNED-repo
      // unexpected-403 path (e.g. a transient auth state).
      if (isPermissionDeniedPush(pushed.stderr)) {
        return {
          ...base,
          status: "error",
          message:
            `push denied — you don't have push access to this vault's remote right now. ` +
            `Check 'gh auth status' and the remote URL; if this is a vault you only subscribe to, ` +
            `it is read-only (capture into a home vault instead).`,
          ahead,
          behind,
          dirtyCount,
        };
      }
      return {
        ...base,
        status: "error",
        message: "git push failed",
        ahead,
        behind,
        dirtyCount,
        errorOutput: pushed.stderr,
      };
    }
  }

  let finalStatus: VaultSyncStatus = "clean";
  let message = "up to date";
  if (committed && behind > 0) {
    finalStatus = "diverged-synced";
    message = `rebased ${behind} commit(s) + pushed ${ahead} local commit(s)`;
  } else if (committed) {
    finalStatus = "pushed";
    message = `committed ${dirtyCount} file(s) + pushed`;
  } else if (ahead > 0 && behind > 0) {
    finalStatus = "diverged-synced";
    message = `rebased ${behind} + pushed ${ahead}`;
  } else if (ahead > 0) {
    finalStatus = "pushed";
    message = `pushed ${ahead} commit(s)`;
  } else if (behind > 0) {
    finalStatus = "pulled";
    message = `pulled ${behind} commit(s) from upstream`;
  }
  return {
    ...base,
    status: finalStatus,
    message,
    ahead,
    behind,
    dirtyCount,
    meshContextResolved,
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
    return rest.slice(arrow + 4);
  }
  return rest;
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
  if (args.dirtyCount > 0) return "dirty";
  if (args.ahead > 0 && args.behind > 0) return "diverged";
  if (args.ahead > 0) return `ahead-${args.ahead}`;
  if (args.behind > 0) return `behind-${args.behind}`;
  return "clean";
}

// Re-export for `sync.ts:syncOneVault` tests that want to seed paths.
export { parsePorcelainPath as _parsePorcelainPath };
