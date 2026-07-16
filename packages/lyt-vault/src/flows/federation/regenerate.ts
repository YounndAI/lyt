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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Client } from "@libsql/client";

import { listFederationStates, readFederationState } from "../../registry/federation-state.js";
import { listMeshes, type MeshRow } from "../../registry/meshes-repo.js";
import { listVaults, type VaultRow } from "../../registry/repo.js";
import { resolveConfig } from "../../util/config.js";
import { compareHlcStamped } from "../../util/hlc.js";
import { getWriterId } from "../../util/writer-id.js";
import {
  getFederationRoot,
  getFederationYonPath,
  vaultRepoName,
} from "../../util/federation-paths.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import {
  renderFederationYon,
  type FedMeshRecord,
  type FedVaultRecord,
  type FederationDoc,
  type FederationVisibility,
} from "../../yon/federation-write.js";
import { appendFedVaultActive } from "../../yon/federation-vault-ledger-write.js";
import {
  foldFedVaults,
  liveFedVaults,
  listFedVaultShards,
  observedMaxFedVaultHlc,
  observedMaxHlcFromFedVaultRecords,
  readAllFedVaultRecords,
  type FedVaultLedgerRecord,
} from "../../yon/federation-vault-ledger-read.js";
import { appendFedMeshActive } from "../../yon/federation-mesh-ledger-write.js";
import {
  foldFedMeshes,
  liveFedMeshes,
  listFedMeshShards,
  observedMaxFedMeshHlc,
  observedMaxHlcFromFedMeshRecords,
  readAllFedMeshRecords,
  type FedMeshLedgerRecord,
} from "../../yon/federation-mesh-ledger-read.js";

// (Brief A) — the pod manifest (`pod.yon`) is a DERIVED view of the local
// registry, regenerated from `registry.db` exactly like the pod-map vault
// (pod-map-generate.ts). This is the SINGLE derivation path: both the lifecycle
// regen hooks (init / adopt / forget) and `lyt federation rebuild` route through
// `derivePodManifestDoc` so there is exactly one definition of "what the manifest
// should contain given the registry". Dissolves the empty-manifest
// limitation + the 2-SoT divergence (registry knew the vault; manifest didn't).
//
// The registry is the SoT; `pod.yon` is never hand-edited as truth. Anything a
// handler types into `pod.yon` is overwritten on the next mutation-triggered
// regen — same contract as pod-map.

export interface DerivePodManifestOptions {
  handle: string;
  // Federation-level fields NOT derivable from the registry's vault/mesh tables
  // — preserved across regens from the prior pod.yon (or defaulted on first
  // write). Visibility is the handler's repo choice; createdAt is birth time.
  visibility: FederationVisibility;
  createdAt: string;
  // The `last_synced_at` stamp value (the one drifting field).
  nowIso: string;
  // Inc-2 Phase 0 — whether to RECONCILE the live registry INTO the ledger
  // (author append-only @FED_VAULT/@FED_MESH events for new/changed rows) before
  // folding. Default TRUE (the lifecycle regen path: init/delete surface a
  // registry mutation into the manifest). Set FALSE on the SYNC-RECONSTITUTION
  // path (rebuildFederationCacheFlow), where the registry cache is itself being
  // rebuilt FROM the ledger — reconciling registry→ledger there is circular, and
  // (because each machine's federation_state.fed_rid is independent) would author
  // NON-CONVERGENT per-writer shards that break the git union's byte-identity.
  // A sync is a re-FOLD, never an event-author. Migration (pod.yon → ledger seed)
  // still runs either way — it is idempotent + convergent by construction.
  reconcile?: boolean;
}

// Inc-2 Phase 0 — the pod manifest is now DERIVED from the
// sharded-CRDT @FED_VAULT / @FED_MESH ledger register FOLD, not read directly
// from `registry.db`. `pod.yon` stays a byte-stable materialized view; the
// LEDGER is the git-synced write/merge SoT underneath it. This dissolves B1
// (regen clobber): the fold is the UNION of every writer shard (git-synced), so
// a partially-hydrated local registry can never DROP records another machine
// already committed — the reconcile below is append-only, never a delete.
//
// The derivation is three steps:
//   1. MIGRATE (idempotent, guard on ledger-empty): if `ledger/vaults/` is empty
//      and a committed `pod.yon` exists, seed each record from it onto THIS
// writer's shard (the single-file → ledger migration). Convergent by
//      construction: two machines seeding the same rid on their OWN shards fold
//      to one record (LWW).
//   2. RECONCILE the live registry INTO the ledger (append-only, event-shaped):
//      a genuinely-NEW vault/mesh (no ledger record for its rid) gets an
//      `active`; a live record whose registry-owned VALUE fields changed gets an
//      updated `active`; a rid whose ledger winner is a TOMBSTONE is LEFT ALONE
//      (respect the cross-machine delete — never resurrect). A registry vault
//      merely ABSENT locally is NEVER tombstoned here (that is what would
//      reintroduce B1); retraction is an explicit event on delete/forget.
//   3. FOLD the ledger shards → the live vault/mesh set → the FederationDoc.
//
// NOTE (Phase-0 bridge, DELIBERATE deviation from the design's "read the fold
// INSTEAD of listVaults" wording): the reconcile STILL reads the registry so a
// local `lyt vault init` / mesh mutation reaches `pod.yon` WITHOUT wiring an
// explicit @FED_VAULT event into every mutation flow (init/adopt/move/rename —
// Phase A/B per the 0.12.0 plan). The FederationDoc is still built from the
// FOLD; the registry read only authors append-only events into the ledger.
// R1-convergence — the cross-machine stale-field-UPDATE clobber (a lagging
// registry re-authoring an active over a fresher remote field-update, e.g. a
// synced rename) is now CLOSED, not a KNOWN limitation: (a) the sync-
// reconstitution path writes the folded @FED_VAULT/@FED_MESH winners BACK into
// the local registry (rebuildFederationCacheFlow), so the reconcile sees no
// spurious diff; and (b) the reconcile carries an origin-writer guard so a lagging
// machine can never re-author a FOREIGN writer's winner from its own stale
// registry. Together they drive the two-machine rename repro to a stable fixed
// point (bounded HLC). Deletes remain the explicit tombstone channel (respected
// above). Explicit Phase-A/B move/rename events are still the forward design for
// same-machine-authored propagation; the guard + write-back are the Phase-0
// convergence backstop underneath them.
export async function derivePodManifestDoc(
  db: Client,
  opts: DerivePodManifestOptions,
): Promise<FederationDoc> {
  const state = await readFederationState(db, opts.handle);
  if (state === null) {
    throw new Error(
      `Cannot derive pod manifest: no federation_state row for handle ${JSON.stringify(
        opts.handle,
      )}. Run \`lyt federation init\` to register the local pod first.`,
    );
  }

  // Step 1 — migrate the single-file pod.yon into the ledger on first run
  // (idempotent + convergent; runs on both the lifecycle and the sync path).
  migrateSingleFilePodYonToLedgerIfEmpty(opts.handle);

  // Step 2 — reconcile the live registry into the ledger (append-only), UNLESS
  // this is the sync-reconstitution path (reconcile === false; see the option
  // doc). Drop tombstoned registry rows first (the LOCAL soft-delete; manifest
  // retraction is the ledger `state` channel, wired at delete/forget).
  if (opts.reconcile !== false) {
    const registryVaults = (await listVaults(db)).filter((v) => v.status !== "tombstoned");
    const registryMeshes = await listMeshes(db);
    reconcileVaultsIntoLedger(registryVaults);
    reconcileMeshesIntoLedger(registryMeshes, state.fedRidHex, opts.handle);
  }

  // Step 3 — fold the ledger shards → the live vault/mesh set. The fold already
  // EXCLUDES tombstoned winners (the drop-retracted filter, now on `state`).
  const fedMeshes: FedMeshRecord[] = liveFedMeshes().map((m) => ({
    fedRidHex: m.fedRidHex.length > 0 ? m.fedRidHex : state.fedRidHex,
    meshRidHex: m.meshRid,
    meshName: m.meshName,
    pushTarget: m.pushTarget,
    pushKind: m.pushKind,
    role: m.role,
    addedAt: m.addedAt,
  }));

  const fedVaults: FedVaultRecord[] = liveFedVaults().map((v) => ({
    vaultRidHex: v.vaultRid,
    vaultName: v.vaultName,
    homeMeshRidHex: v.homeMeshRidHex,
    repo: v.repo,
    visibility: v.visibility,
    status: v.status,
    registeredAt: v.registeredAt,
  }));

  return {
    federation: {
      fedRidHex: state.fedRidHex,
      handle: opts.handle,
      visibility: opts.visibility,
      createdAt: opts.createdAt,
    },
    meshes: fedMeshes,
    vaults: fedVaults,
    lastSyncedAt: opts.nowIso,
  };
}

// Step 1 helper — the single-file `pod.yon` → ledger migration.
// Idempotent (guarded on the vault ledger being EMPTY). Seeds each @FED_VAULT /
// @FED_MESH from the committed pod.yon as an `active` register record on THIS
// writer's shard. Seeds from the durable pod.yon (git-SoT), NOT the local
// registry, so two machines migrating independently converge (same rid on their
// own shards → one folded record).
function migrateSingleFilePodYonToLedgerIfEmpty(handle: string): void {
  if (listFedVaultShards().length > 0) return; // ledger non-empty → already seeded
  const podYonPath = getFederationYonPath(handle);
  if (!existsSync(podYonPath)) return;
  let doc: FederationDoc;
  try {
    doc = parseFederationYon(readFileSync(podYonPath, "utf8"));
  } catch {
    return; // unparseable prior manifest — reconcile will populate from registry
  }
  const vObserved = observedMaxFedVaultHlc();
  for (const v of doc.vaults) {
    appendFedVaultActive({
      vaultRid: v.vaultRidHex,
      vaultName: v.vaultName,
      homeMeshRidHex: v.homeMeshRidHex,
      repo: v.repo,
      visibility: v.visibility,
      // R3 — normalize the seed to the constant `active` PRESENCE marker (the same
      // value the reconcile arms author), NOT the committed pod.yon's raw
      // pre-fix reachability. A stale `access_lost`/`disconnected` in an old
      // single-file pod.yon must not survive the ledger migration in the
      // converged VALUE — reachability is machine-local (R1 FIX 2), and absence
      // lives entirely in the `state` (tombstone) channel.
      status: "active",
      registeredAt: v.registeredAt,
      observedMaxHlc: vObserved,
    });
  }
  if (listFedMeshShards().length === 0) {
    const mObserved = observedMaxFedMeshHlc();
    for (const m of doc.meshes) {
      appendFedMeshActive({
        meshRid: m.meshRidHex,
        fedRidHex: m.fedRidHex,
        meshName: m.meshName,
        pushTarget: m.pushTarget,
        pushKind: m.pushKind,
        role: m.role,
        addedAt: m.addedAt,
        observedMaxHlc: mObserved,
      });
    }
  }
}

// R1-convergence — the total-order winner RECORD (with its writerId) per
// vault_rid, mirroring federation-vault-ledger-read.compareFedVaultRecords.
// reconcileVaultsIntoLedger needs the winner's WRITER identity (which the
// value-only LiveFedVault fold drops) for the origin-writer guard below. KEEP IN
// SYNC with the read module's comparator — same (hlc, writerId, seq) total order,
// same legacy delete-wins fallback for hlc-less records.
function fedVaultWinnersByRid(
  records: readonly FedVaultLedgerRecord[],
): Map<string, FedVaultLedgerRecord> {
  const winners = new Map<string, FedVaultLedgerRecord>();
  for (const rec of records) {
    const cur = winners.get(rec.vaultRid);
    if (cur === undefined || compareFedVaultLedgerRecords(rec, cur) > 0) {
      winners.set(rec.vaultRid, rec);
    }
  }
  return winners;
}

function compareFedVaultLedgerRecords(a: FedVaultLedgerRecord, b: FedVaultLedgerRecord): number {
  if (a.hlc !== null && b.hlc !== null) {
    return compareHlcStamped(
      { hlc: a.hlc, writerId: a.writerId, seq: a.seq },
      { hlc: b.hlc, writerId: b.writerId, seq: b.seq },
    );
  }
  if (a.hlc === null && b.hlc !== null) return -1;
  if (a.hlc !== null && b.hlc === null) return 1;
  if (a.state !== b.state) {
    const aRank = a.state === "tombstoned" ? 1 : 0;
    const bRank = b.state === "tombstoned" ? 1 : 0;
    return aRank < bRank ? -1 : 1;
  }
  if (a.registeredAt !== b.registeredAt) return a.registeredAt < b.registeredAt ? -1 : 1;
  if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
  return 0;
}

// Step 2 helper (vaults) — append-only reconcile of the live registry vault set
// into the @FED_VAULT ledger. NEW rid → active; live-active with a changed
// registry-owned VALUE → updated active (visibility carried from the ledger, now
// a first-class register value, NOT the old priorVaultVisibility hack);
// tombstoned winner → left untouched (respect the delete); matching → no-op
// (keeps the fold + pod.yon byte-stable and idempotent).
//
// R1 (FIX 2) — `status` is machine-SUBJECTIVE reachability (active / access_lost
// / …) and is now kept MACHINE-LOCAL in the registry (`vault info` reads it); it
// is NO LONGER authored into the converged @FED_VAULT VALUE (which would let an
// owner's `active` MASK a subscriber's `access_lost` at the folded/pod surface)
// nor compared for change-detection (which would churn the ledger on every local
// reachability flip). The ledger VALUE carries a constant `active` PRESENCE
// marker; absence/delete lives entirely in the `state` (tombstone) channel.
//
// R1 (FIX 1, origin-writer guard) — a lagging machine that synced a foreign
// writer's field-update (e.g. a cross-machine rename) but has not yet folded it
// back into its LOCAL registry must NOT re-author its STALE registry value over
// the fresher foreign winner: that is the non-terminating cross-machine
// flip-flop (unbounded HLC growth). The changed-existing arm therefore only
// re-authors when THIS writer already OWNS the current ledger head for the rid
// (advancing its own record) or the head is a legacy hlc-less record to heal
// forward. The sync-reconstitution path's ledger→registry WRITE-BACK
// (rebuildFederationCacheFlow) converges the local registry to the winner, so on
// a synced machine a remaining diff on THIS writer's own head is a genuine local
// mutation — which still authors. (decision-aligned: registry = rebuildable cache of
// the git-tracked ledger SoT; the write-back is the cache→SoT reconvergence, the
// guard is the anti-clobber backstop.)
function reconcileVaultsIntoLedger(vaults: readonly VaultRow[]): void {
  // F2 (latency) — take ONE ledger snapshot per reconcile and derive allRids +
  // the live-winner map + the winner-record map + the receive-rule observed-max
  // from it, instead of re-walking the whole ledger. Provably result-identical:
  // no append happens between these derivations, so one snapshot == N snapshots.
  // CORRECTNESS: `observed` is still computed BEFORE any append below, so
  // stampNext seeds above everything observed (the receive rule) exactly as before.
  const priorRecords = readAllFedVaultRecords();
  const allRids = new Set(priorRecords.map((r) => r.vaultRid));
  const liveByRid = new Map(foldFedVaults(priorRecords).map((v) => [v.vaultRid, v]));
  const winnerByRid = fedVaultWinnersByRid(priorRecords);
  const thisWriter = getWriterId();
  const defaultVisibility = resolveConfig().defaultRepoVisibility;
  const observed = observedMaxHlcFromFedVaultRecords(priorRecords);
  for (const v of vaults) {
    const rid = v.ridHex;
    const repo = vaultRepoName(v.name);
    if (!allRids.has(rid)) {
      appendFedVaultActive({
        vaultRid: rid,
        vaultName: v.name,
        homeMeshRidHex: v.homeMeshRidHex,
        repo,
        visibility: defaultVisibility,
        status: "active", // R1 (FIX 2) — presence marker, NOT machine reachability
        registeredAt: v.registeredAt,
        observedMaxHlc: observed,
      });
      continue;
    }
    const live = liveByRid.get(rid);
    if (live === undefined) continue; // ledger winner is a tombstone → do NOT resurrect
    // R1 (FIX 2) — `status` EXCLUDED from the change compare (machine-local).
    const changed =
      live.vaultName !== v.name ||
      (live.homeMeshRidHex ?? null) !== (v.homeMeshRidHex ?? null) ||
      live.repo !== repo;
    if (!changed) continue;
    // R1 (FIX 1) — origin-writer guard: do not clobber a FOREIGN writer's fresher
    // winner with this machine's stale registry value.
    const winner = winnerByRid.get(rid);
    if (winner !== undefined && winner.hlc !== null && winner.writerId !== thisWriter) continue;
    appendFedVaultActive({
      vaultRid: rid,
      vaultName: v.name,
      homeMeshRidHex: v.homeMeshRidHex,
      repo,
      visibility: live.visibility, // carry the converged register value
      status: "active", // R1 (FIX 2) — presence marker, NOT machine reachability
      registeredAt: v.registeredAt,
      observedMaxHlc: observed,
    });
  }
}

// R1-convergence — the mesh-rail analog of fedVaultWinnersByRid. KEEP IN SYNC
// with federation-mesh-ledger-read.compareFedMeshRecords.
function fedMeshWinnersByRid(
  records: readonly FedMeshLedgerRecord[],
): Map<string, FedMeshLedgerRecord> {
  const winners = new Map<string, FedMeshLedgerRecord>();
  for (const rec of records) {
    const cur = winners.get(rec.meshRid);
    if (cur === undefined || compareFedMeshLedgerRecords(rec, cur) > 0) {
      winners.set(rec.meshRid, rec);
    }
  }
  return winners;
}

function compareFedMeshLedgerRecords(a: FedMeshLedgerRecord, b: FedMeshLedgerRecord): number {
  if (a.hlc !== null && b.hlc !== null) {
    return compareHlcStamped(
      { hlc: a.hlc, writerId: a.writerId, seq: a.seq },
      { hlc: b.hlc, writerId: b.writerId, seq: b.seq },
    );
  }
  if (a.hlc === null && b.hlc !== null) return -1;
  if (a.hlc !== null && b.hlc === null) return 1;
  if (a.state !== b.state) {
    const aRank = a.state === "tombstoned" ? 1 : 0;
    const bRank = b.state === "tombstoned" ? 1 : 0;
    return aRank < bRank ? -1 : 1;
  }
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
  return 0;
}

// Step 2 helper (meshes) — the mesh analog.
//
// R1 (FIX 3) — `role` is DERIVED from the registry's own-vs-join provenance
// (`meshes.own_created`, migration 010) instead of the old hard-coded "own": a
// Phase-B `mesh join --clone-members` mesh is created locally with
// own_created=false and must fold as `role=join`, not claim ownership. Included
// in the change compare so a mislabeled `own` record heals forward to `join`.
//
// R1 (FIX 1, origin-writer guard) — same anti-clobber backstop as the vault rail:
// only re-author a changed record when THIS writer owns the current ledger head
// (or it is legacy). This also neutralizes the `fed_rid` flip-flop (fed_rid is
// per-machine, so a foreign winner's fed_rid always differs from the local one —
// without the guard every sync+mutation would re-author it and grow the HLC).
function reconcileMeshesIntoLedger(
  meshes: readonly MeshRow[],
  fedRidHex: string,
  handle: string,
): void {
  // F2 (latency) — ONE ledger snapshot per reconcile (mesh-rail analog of the
  // vault dedup above). allRids + live-winner map + winner-record map +
  // receive-rule observed-max all derived from `priorRecords`; result-identical
  // (no append between the reads) and `observed` still computed before any append.
  const priorRecords = readAllFedMeshRecords();
  const allRids = new Set(priorRecords.map((r) => r.meshRid));
  const liveByRid = new Map(foldFedMeshes(priorRecords).map((m) => [m.meshRid, m]));
  const winnerByRid = fedMeshWinnersByRid(priorRecords);
  const thisWriter = getWriterId();
  const observed = observedMaxHlcFromFedMeshRecords(priorRecords);
  for (const m of meshes) {
    const rid = m.ridHex;
    const pushTarget = m.pushTarget ?? handle;
    const pushKind = m.pushKind ?? "handle";
    const role = m.ownCreated ? "own" : "join"; // R1 (FIX 3)
    if (!allRids.has(rid)) {
      appendFedMeshActive({
        meshRid: rid,
        fedRidHex,
        meshName: m.name,
        pushTarget,
        pushKind,
        role,
        addedAt: m.createdAt,
        observedMaxHlc: observed,
      });
      continue;
    }
    const live = liveByRid.get(rid);
    if (live === undefined) continue;
    const changed =
      live.meshName !== m.name ||
      live.pushTarget !== pushTarget ||
      live.pushKind !== pushKind ||
      live.role !== role ||
      live.fedRidHex !== fedRidHex;
    if (!changed) continue;
    // R1 (FIX 1) — origin-writer guard (see reconcileVaultsIntoLedger).
    const winner = winnerByRid.get(rid);
    if (winner !== undefined && winner.hlc !== null && winner.writerId !== thisWriter) continue;
    appendFedMeshActive({
      meshRid: rid,
      fedRidHex,
      meshName: m.name,
      pushTarget,
      pushKind,
      role,
      addedAt: m.createdAt,
      observedMaxHlc: observed,
    });
  }
}

// Struct-level "substantive change" compare for the DERIVED manifest. Two docs
// are equal-modulo-stamp iff their federation block + meshes + vaults deep-equal
// (lastSyncedAt is intentionally omitted — it is the canonical drift field).
// Records are deterministically ordered by the writer; the parser preserves that
// order, so JSON.stringify is a stable structural comparison. (Mirrors the
// rebuild.ts helper but now spans @FED_VAULT too — the single source of the
// change-rule so callers don't each reinvent it.)
export function podManifestDocsEqualIgnoringStamp(a: FederationDoc, b: FederationDoc): boolean {
  const norm = (d: FederationDoc): string => {
    const meshes = [...d.meshes].sort(byMeshKey);
    const vaults = [...d.vaults].sort(byVaultKey);
    return JSON.stringify({ federation: d.federation, meshes, vaults });
  };
  return norm(a) === norm(b);
}

function byMeshKey(a: FedMeshRecord, b: FedMeshRecord): number {
  return a.meshName < b.meshName
    ? -1
    : a.meshName > b.meshName
      ? 1
      : a.meshRidHex < b.meshRidHex
        ? -1
        : a.meshRidHex > b.meshRidHex
          ? 1
          : 0;
}

function byVaultKey(a: FedVaultRecord, b: FedVaultRecord): number {
  return a.vaultName < b.vaultName
    ? -1
    : a.vaultName > b.vaultName
      ? 1
      : a.vaultRidHex < b.vaultRidHex
        ? -1
        : a.vaultRidHex > b.vaultRidHex
          ? 1
          : 0;
}

export interface RegeneratePodManifestOptions {
  handle: string;
  // Deterministic stamp seam — tests pin this; production defaults to now.
  nowIso?: string;
  // Inc-2 Phase 0 — forwarded to derivePodManifestDoc. Default TRUE (lifecycle).
  // The sync-reconstitution caller (rebuildFederationCacheFlow) passes FALSE so a
  // sync is a pure re-fold, never a ledger-event author. See DerivePodManifestOptions.
  reconcile?: boolean;
}

export interface RegeneratePodManifestResult {
  // skipped=true when the pod is not yet initialised (no federation_state row).
  // The lifecycle hooks call this on EVERY mutation, including before a pod has
  // been forged (e.g. `lyt vault init` with federation self-heal disabled); a
  // missing pod is a no-op, never an error.
  skipped: boolean;
  reason?: string;
  podYonPath: string;
  changed: boolean;
  meshCount: number;
  vaultCount: number;
  // True when a stale legacy `federation.yon` sibling was removed (
  // clean-slate: pod.yon is the single manifest; the old name is not orphaned).
  legacyRemoved: boolean;
}

// Lifecycle-facing regen. Requires the caller's already-open registry (open-once
// seam per Brief A A.4 / a review finding — init/adopt/forget all hold a db; opening a 2nd
// connection risks Windows SQLITE_BUSY). Preserves visibility + createdAt from
// the prior pod.yon when present; defaults them on first write. Best-effort
// removes a legacy `federation.yon` so exactly one manifest exists on disk.
export async function regeneratePodManifestFlow(
  db: Client,
  opts: RegeneratePodManifestOptions,
): Promise<RegeneratePodManifestResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const podYonPath = getFederationYonPath(opts.handle);

  const state = await readFederationState(db, opts.handle);
  if (state === null) {
    return {
      skipped: true,
      reason: "no-federation-state",
      podYonPath,
      changed: false,
      meshCount: 0,
      vaultCount: 0,
      legacyRemoved: false,
    };
  }

  // Preserve federation-level fields not derivable from the registry
  // (federation visibility + createdAt). Inc-2 Phase 0: per-vault visibility is
  // NO LONGER preserved via a hack here — it is a first-class converging VALUE
  // on the @FED_VAULT ledger register (carried across regens by the reconcile in
  // derivePodManifestDoc). The priorVaultVisibility map is DELETED.
  let visibility: FederationVisibility = "private";
  let createdAt = nowIso;
  let existingDoc: FederationDoc | null = null;
  if (existsSync(podYonPath)) {
    try {
      existingDoc = parseFederationYon(readFileSync(podYonPath, "utf8"));
      visibility = existingDoc.federation.visibility;
      if (existingDoc.federation.createdAt.length > 0) {
        createdAt = existingDoc.federation.createdAt;
      }
    } catch {
      // Unparseable prior manifest — regen heals it from the ledger fold using
      // the flow defaults (private / now) for the federation-level fields.
    }
  }

  const doc = await derivePodManifestDoc(db, {
    handle: opts.handle,
    visibility,
    createdAt,
    nowIso,
    ...(opts.reconcile !== undefined ? { reconcile: opts.reconcile } : {}),
  });

  const changed = existingDoc === null || !podManifestDocsEqualIgnoringStamp(existingDoc, doc);

  mkdirSync(dirname(podYonPath), { recursive: true });
  writeFileSync(podYonPath, renderFederationYon(doc), "utf8");

  // (clean-slate, dev mode): remove any legacy `federation.yon` sibling so
  // pod.yon is the single on-disk manifest. No migration — pod.yon is fully
  // derived from the registry, so the legacy file holds no unique truth.
  let legacyRemoved = false;
  const legacyPath = join(getFederationRoot(), "federation.yon");
  if (legacyPath !== podYonPath && existsSync(legacyPath)) {
    try {
      rmSync(legacyPath, { force: true });
      legacyRemoved = true;
    } catch {
      // best-effort — a leftover federation.yon is cosmetic, never fatal.
    }
  }

  return {
    skipped: false,
    podYonPath,
    changed,
    meshCount: doc.meshes.length,
    vaultCount: doc.vaults.length,
    legacyRemoved,
  };
}

// Lifecycle convenience: resolve the handle (hint → registry federation_state),
// regen, and SWALLOW every failure. The init / adopt / forget / mesh-init hooks
// call this AFTER their registry mutations land so `pod.yon` reflects the new
// state. A missing pod (no federation_state → skipped) or a parse/IO error must
// NEVER fail the host flow — same never-fail posture as the federation self-heal
// + Lane M reconcile hooks. Requires the caller's open registry (open-once seam).
//
// Handle resolution is REGISTRY-DRIVEN, not identity-driven: when no hint is
// given, the handle comes from `federation_state` (the SoT). This (a) avoids a
// `getHandleFromIdentity()` → potential `gh api` network call on EVERY vault
// mutation, and (b) makes the no-pod case a single cheap query that short-
// circuits before any IO — a vault-init with no pod resolves zero rows and
// returns immediately.
export async function regeneratePodManifestNonFatal(
  db: Client,
  opts: {
    handle?: string | undefined;
    nowIso?: string | undefined;
    // Forwarded to derivePodManifestDoc. FALSE on the sync-reconstitution path so
    // a sync is a pure re-fold, never a ledger-event author (see DerivePodManifestOptions).
    reconcile?: boolean | undefined;
  } = {},
): Promise<void> {
  try {
    let handle = opts.handle;
    if (handle === undefined || handle.length === 0) {
      const states = await listFederationStates(db);
      // 0 rows → no pod forged yet (skip). >1 → ambiguous multi-handle (deferred
      // per federation-paths single-pod assumption); skip rather than guess.
      if (states.length !== 1) return;
      handle = states[0]!.handle;
    }
    if (handle.length === 0) return;
    await regeneratePodManifestFlow(db, {
      handle,
      ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
      ...(opts.reconcile !== undefined ? { reconcile: opts.reconcile } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`pod manifest regen skipped non-fatally — ${msg}`);
  }
}
