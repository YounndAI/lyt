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

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { getMeshByName, getMeshByRid, insertMesh, type MeshRow } from "../../registry/meshes-repo.js";
import {
  deleteAllAliases,
  insertAliasRow,
} from "../../registry/aliases-repo.js";
import {
  addSubscription,
  deleteAllSubscriptions,
} from "../../registry/mesh-subscriptions-repo.js";
import {
  deleteAllMeshEdges,
  getVaultByRid,
  insertMeshEdge,
  listVaults,
} from "../../registry/repo.js";
import { canonicalizeCoordinate, gitUrlToCoordinate } from "../../registry/vault-addressing.js";
import { hexToUuid7Bytes, newUuidv7Bytes } from "../../util/uuid7.js";
import {
  liveAliases,
  type LiveAlias,
} from "../../yon/alias-ledger-read.js";
import {
  liveMeshEdges,
  type LiveMeshEdge,
} from "../../yon/mesh-edge-ledger-read.js";
import {
  liveSubscriptions,
  type LiveSubscription,
} from "../../yon/subscription-ledger-read.js";
import { regeneratePodManifestNonFatal } from "./regenerate.js";

// Fed-v2 Layer-1 (Phase D1b) — RECONSTITUTION. The per-writer append-only
// ledger shards under `<podRoot>/ledger/` are the git SoT; `registry.db` is a
// DERIVED, LOCAL cache. This flow rebuilds the cache from the ledger on sync:
//
//   walkLedger(ledger/subscriptions/) across all writer shards
//     → OR-Set add-wins fold (REUSED — subscription-ledger-read.foldSubscriptions,
//       the SHIPPED Phase-C convergence unit; NO fold logic re-implemented here)
//     → DELETE+reINSERT into `mesh_subscriptions` under a single registry txn
//       (idempotent FULL-REPLACE — correct for a mutable set with deletes, where
//       upsert-only cannot express removal; mirrors rebuild-mesh-registry's
//       per-mesh DELETE+reINSERT, widened to the whole subscription cache)
//     → regenerate `pod.yon` (flows/federation/regenerate — pod.yon stays a
//       derived render downstream of the cache).
//
// Mirrors the `flows/sync-post-pull-ledger.ts` reconstitution precedent (walk
// the YON ledger → reconcile the libSQL cache), but where that flow UPSERTS
// append-only audit/provenance records, this one FULL-REPLACES a mutable set.
//
// IDEMPOTENCE (D1b success criterion): running this twice over the same ledger
// yields a byte-identical cache (the fold is a pure deterministic function of
// the shard set; DELETE+reINSERT discards any prior cache state) and a
// byte-identical `pod.yon` (regenerate is deterministic given the same
// registry + a pinned nowIso).
//
// HOMING (derived LOCALLY, never stored in the git-synced ledger): a live
// subscription's `mesh_subscriptions.mesh_rid` is the rid of the reserved
// OWNER-BUCKET mesh derived from `entry_mode` + the coordinate's owner.
//
// Fed-v2 Layer-1 (Phase ) — OWNER-GROUPED homing. The bucket mesh name is now
// owner-scoped: `subscriptions/{owner}` for entry_mode=subscribe, `shared/{owner}`
// for shared, where `{owner}` is the OWNER segment of the subscribed vault's
// origin coordinate (`lyt:vault:<host>/<owner>/<repo>`). The display projection
// (vault-addressing.computeDisplayNameSync) then renders a bucket-homed external
// as `{bucket}/{owner}/{leaf}` (e.g. `subscriptions/ownerA/docs`) — the seam
// that was reserved in Phase B. (D1b homed every live subscription into a SINGLE
// flat bucket mesh per entry_mode; refines that to one bucket mesh per owner
// so two owners' subscriptions no longer share a mesh.)
//
// The bucket mesh is created locally on first reconstitution if absent, via
// insertMesh DIRECTLY — NOT through validateMeshName — so the reserved-mesh GUARD
// (Phase, util/identity.ts) blocks USER occupation of the reserved namespace
// WITHOUT blocking this system path. Home paths / collision suffixes stay
// machine-local (design §2). The names→rid index (vault-addressing resolver) is
// the resolution SoT; this flow only ensures the homing mesh_rid FK is satisfiable.

// Reserved bucket-mesh namespace PREFIXES (design §2 plan ). The realized
// bucket mesh name is `<prefix>/<owner>`. These prefixes are the leading mesh
// segment guarded by RESERVED_MESH_NAMES (util/identity.ts).
export const SUBSCRIPTION_BUCKET_MESH = "subscriptions";
export const SHARED_BUCKET_MESH = "shared";

export interface RebuildFederationCacheArgs {
  // Open-once seam (vindicated repeatedly across this codebase): callers may
  // pass an already-open registry; the flow opens its own only when omitted.
  registryDb?: Client | undefined;
  // Test seam — override the pod root the ledger shards are read from
  // (defaults to getFederationRoot() inside liveSubscriptions()).
  podRoot?: string | undefined;
  // Deterministic stamp seam for the downstream pod.yon regen — tests pin this
  // so the regenerated manifest is byte-stable across reconstitution runs.
  nowIso?: string | undefined;
  // Pod handle for the pod.yon regen. When omitted the regen resolves it from
  // federation_state (the single-pod default), and is a no-op if none exists.
  handle?: string | undefined;
}

export interface RebuildFederationCacheResult {
  // Live subscriptions reconstituted into the cache.
  subscriptionsReconstituted: number;
  // Live subscriptions skipped because their coordinate resolved to no locally
  // registered vault (cannot satisfy the NOT-NULL external_vault_rid FK). The
  // ledger is the SoT, so these survive in the ledger and reconstitute once the
  // vault is present locally; they are never silently dropped from the SoT.
  subscriptionsSkippedUnresolved: number;
  // Reserved bucket meshes created during this reconstitution (0 on steady state).
  bucketMeshesCreated: number;
  // ----- ALIAS HALF — Phase E (E2a, IMPLEMENTED) -----
  // The alias fold (`ledger/aliases/` → `vault_aliases`) folds in HERE at Phase
  // E, on the SAME idempotent full-replace rail as subscriptions: walk the alias
  // shards → an alias OR-Set fold (the alias-ledger-read unit, built in E1) →
  // DELETE+reINSERT into `vault_aliases` INSIDE the SAME txn opened below, BEFORE
  // COMMIT. Set to the count of live aliases reconstituted into the cache.
  aliasesReconstituted: number;
  // Live aliases skipped because their `target_rid` resolved to no locally
  // registered vault (cannot satisfy the NOT-NULL vault_aliases.vault_rid FK).
  // The ledger is the SoT, so these survive in the ledger and reconstitute once
  // the target vault is present locally; they are never dropped from the SoT.
  // (Alias analog of `subscriptionsSkippedUnresolved`.)
  aliasesSkippedUnresolved: number;
  // RETAINED FOR API STABILITY, ALWAYS 0 (Slice 1a). The alias fold is now a
  // name-keyed HLC-LWW register that yields ≤1 live record per name BY
  // CONSTRUCTION — a cross-writer re-point is resolved by the max-(hlc, writerId)
  // merge key in the fold, so there is never >1 live record sharing a `name` to
  // collapse here. The old reconstitution-time name-collapse (greatest-target_rid
  // tiebreak) is GONE; this field stays in the result shape (= 0) so existing
  // callers/metrics do not break.
  aliasNameCollisionsResolved: number;
  // ----- MESH-EDGE HALF — Slice 2a -----
  // The mesh-edge fold (`ledger/mesh-edges/` → `mesh_edges`) folds in HERE on
  // the SAME idempotent full-replace rail: walk the edge shards → the OR-Set
  // add-wins fold (mesh-edge-ledger-read.foldMeshEdges) → DELETE+reINSERT into
  // `mesh_edges` INSIDE the SAME txn, BEFORE COMMIT. Count of live edges
  // reconstituted into the cache.
  meshEdgesReconstituted: number;
  // Live edges skipped because their ref_vault or home_vault resolved to no
  // locally registered vault (or the home vault has no home mesh to DERIVE
  // home_mesh from). The ledger is the SoT, so these survive in the ledger and
  // reconstitute once the vaults are present locally; never silently dropped.
  meshEdgesSkippedUnresolved: number;
  durationMs: number;
}

export async function rebuildFederationCacheFlow(
  args: RebuildFederationCacheArgs = {},
): Promise<RebuildFederationCacheResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // 1. Fold the ledger shards → the converged live subscription set. REUSES
    //    the shipped Phase-C OR-Set add-wins fold (liveSubscriptions →
    //    readAllSubscriptionRecords + foldSubscriptions). No fold here.
    const live: LiveSubscription[] = liveSubscriptions(args.podRoot);

    // 2. Resolve each live coordinate → a cache row. Coordinate → local vault
    //    (the external_vault_rid); entry_mode + owner → the bucket mesh rid (the
    //    homing mesh_rid). Resolved OUTSIDE the txn (reads only) so the txn
    //    window is the minimal DELETE+reINSERT. Fed-v2 Layer-1 (Phase D1c): the
    //    cache row no longer carries external_mesh_* — those columns were dropped
    //    (migration 005). We STILL resolve the subscribed vault's home mesh
    //    below, but only to satisfy the skip-not-fail posture (a coordinate whose
    //    vault has no resolvable home mesh is left in the ledger SoT, not homed).
    const coordToVault = await buildCoordinateIndex(db);

    interface CacheRow {
      meshRid: Uint8Array;
      externalVaultRid: Uint8Array;
    }
    const rows: CacheRow[] = [];
    let skippedUnresolved = 0;
    let bucketMeshesCreated = 0;
    // Cache bucket-mesh lookups within this run so repeated entry_modes don't
    // re-query/re-create.
    const bucketCache = new Map<string, MeshRow>();

    for (const sub of live) {
      // read-side canonicalization: the index keys are built from each local
      // vault's gitUrl via the now-canonicalizing gitUrlToCoordinate (lowercased
      // host + known-forge owner/repo). The ledger's stored coordinate may have
      // been written under a DIFFERENT casing (an older non-canonical write, or
      // a peer's mixed-case origin spelling), so it MUST be run through the SAME
      // canonicalizer before the lookup — otherwise two spellings of the same
      // origin compare unequal and the subscription is wrongly skipped. Falls
      // back to the raw value if the coordinate is unparseable (defensive).
      const resolved = coordToVault.get(canonicalizeCoordinate(sub.coordinate));
      if (resolved === undefined || resolved.homeMeshRid === null) {
        // Coordinate names a vault not locally registered (or with no home
        // mesh) — cannot satisfy the NOT-NULL external_vault_rid / external_mesh
        // FKs. Leave it in the ledger SoT; it reconstitutes once present.
        skippedUnresolved += 1;
        continue;
      }
      // Confirm the subscribed vault's home mesh is still locally registered.
      // Phase D1c: its rid/name no longer feed the cache row (external_mesh_*
      // dropped), but an unresolvable home mesh keeps the skip-not-fail posture
      // — leave the coordinate in the ledger SoT rather than home a dangling row.
      const homeMesh = await getMeshByRid(db, resolved.homeMeshRid);
      if (homeMesh === null) {
        skippedUnresolved += 1;
        continue;
      }
      // fix-pass — derive the owner from the CANONICALIZED coordinate (the
      // resolve lookup above already canonicalizes via the shared canonicalizeCoordinate).
      // On the RAW coordinate, a legacy/peer mixed-case spelling
      // (github.com/Owner/repo) would home into a different bucket mesh
      // (subscriptions/Owner) than a post-fix canonical record (subscriptions/owner),
      // splitting one upstream owner across two buckets — the exact split bug 6
      // exists to prevent, leaked onto the homing path.
      const owner = coordinateOwner(canonicalizeCoordinate(sub.coordinate));
      if (owner === null) {
        // A live coordinate whose owner segment cannot be parsed cannot be
        // owner-homed. Leave it in the ledger SoT (skip-not-fail) rather than
        // home it into a malformed bucket name.
        skippedUnresolved += 1;
        continue;
      }
      const bucketName = bucketMeshName(sub.entryMode, owner);
      let bucket = bucketCache.get(bucketName);
      if (bucket === undefined) {
        const ensured = await ensureBucketMesh(db, bucketName);
        bucket = ensured.mesh;
        if (ensured.created) bucketMeshesCreated += 1;
        bucketCache.set(bucketName, bucket);
      }
      rows.push({
        meshRid: bucket.rid,
        externalVaultRid: resolved.rid,
      });
    }

    // 2b. ALIAS HALF (Phase E / E2a). Fold the alias ledger shards → the
    //    converged live alias set (REUSES the shipped E1 OR-Set add-wins fold —
    //    alias-ledger-read.liveAliases → readAllAliasRecords + foldAliases; no
    //    fold here). Resolve each live alias's `target_rid` (hex) → a local
    //    vault rid (the NOT-NULL vault_aliases.vault_rid FK). Resolved OUTSIDE
    //    the txn (reads only). Skip-not-fail, mirroring the subscription side: a
    //    live alias whose target is not locally registered (or whose stored rid
    //    is not valid hex) is left in the ledger SoT, not homed.
    // Slice 1a: liveAliases() now returns a NAME-KEYED HLC-LWW register fold —
    // ≤1 live record per name BY CONSTRUCTION (a cross-writer re-point is
    // resolved by the max-(hlc, writerId) merge key inside the fold). So the old
    // reconstitution-time name-collapse (greatest-target_rid tiebreak) is GONE:
    // one insertAliasRow per live name, no collision to resolve. `vault_aliases.alias`
    // (single-column PK) can never be hit twice because the fold already
    // guarantees name-uniqueness.
    const liveAlias: LiveAlias[] = liveAliases(args.podRoot);

    interface AliasRow {
      alias: string;
      vaultRid: Uint8Array;
      kind: string;
    }
    const aliasRows: AliasRow[] = [];
    let aliasesSkippedUnresolved = 0;
    for (const al of liveAlias) {
      let targetBytes: Uint8Array;
      try {
        targetBytes = hexToUuid7Bytes(al.targetRid);
      } catch {
        // Stored target_rid is not valid UUIDv7 hex — cannot resolve to a vault
        // row. Leave it in the ledger SoT (skip-not-fail).
        aliasesSkippedUnresolved += 1;
        continue;
      }
      const targetVault = await getVaultByRid(db, targetBytes);
      if (targetVault === null) {
        // target_rid names a vault not locally registered — cannot satisfy the
        // NOT-NULL vault_aliases.vault_rid FK. Leave it in the ledger SoT; it
        // reconstitutes once the target vault is present locally.
        aliasesSkippedUnresolved += 1;
        continue;
      }
      aliasRows.push({ alias: al.name, vaultRid: targetVault.rid, kind: al.kind });
    }

    // 2c. MESH-EDGE HALF (Slice 2a). Fold the mesh-edge ledger shards → the
    //    converged live edge set (REUSES the OR-Set add-wins fold —
    //    mesh-edge-ledger-read.liveMeshEdges → readAllMeshEdgeRecords +
    //    foldMeshEdges; no fold here). For each live edge resolve ref_vault +
    //    home_vault locally; DERIVE home_mesh from the live home vault's
    //    home_mesh_rid — NOT the ledger record's stored home_mesh value (a move
    //    can stale it; deriving is what re-homes a branch-mode move automatically
    //    on rebuild). This mirrors the subscription side's `resolved.homeMeshRid`
    //    derivation (the `homeMesh` resolve at the subscription loop above).
    //    Skip-not-fail: a live edge whose ref/home vault is not locally
    //    registered (or whose home vault has no home mesh) is left in the ledger
    //    SoT, not homed. Resolved OUTSIDE the txn (reads only).
    const liveEdges: LiveMeshEdge[] = liveMeshEdges(args.podRoot);

    interface EdgeRow {
      refMeshRid: Uint8Array;
      refVaultRid: Uint8Array;
      homeMeshRid: Uint8Array;
      homeVaultRid: Uint8Array;
    }
    const edgeRows: EdgeRow[] = [];
    let meshEdgesSkippedUnresolved = 0;
    for (const edge of liveEdges) {
      let refVaultBytes: Uint8Array;
      let homeVaultBytes: Uint8Array;
      try {
        // FU-1: ref_mesh is no longer trusted from the ledger record — it is
        // DERIVED from the live ref vault's home mesh below. Only the 2 identity
        // rids (ref_vault, home_vault) are read from the edge here.
        refVaultBytes = hexToUuid7Bytes(edge.refVaultRid);
        homeVaultBytes = hexToUuid7Bytes(edge.homeVaultRid);
      } catch {
        // A stored rid is not valid UUIDv7 — cannot resolve. Leave in ledger SoT.
        meshEdgesSkippedUnresolved += 1;
        continue;
      }
      const refVault = await getVaultByRid(db, refVaultBytes);
      if (refVault === null) {
        // ref_vault (the parent) not locally registered — cannot satisfy the
        // mesh_edges FK. Leave it in the ledger SoT; reconstitutes once present.
        meshEdgesSkippedUnresolved += 1;
        continue;
      }
      if (refVault.homeMeshRid === null) {
        // ref_vault has no home mesh to DERIVE ref_mesh from (FU-1). Skip-not-fail,
        // mirroring the home_vault home-mesh guard below.
        meshEdgesSkippedUnresolved += 1;
        continue;
      }
      const homeVault = await getVaultByRid(db, homeVaultBytes);
      if (homeVault === null || homeVault.homeMeshRid === null) {
        // home_vault (the child) not locally registered, OR has no home mesh to
        // DERIVE home_mesh from. Skip-not-fail.
        meshEdgesSkippedUnresolved += 1;
        continue;
      }
      // DERIVE both ref_mesh AND home_mesh from the LIVE vaults — load-bearing:
      // this is why a branch-mode move (which only moves a vault's @MESH_HOME
      // membership and re-homes vaults.home_mesh_rid) re-homes the edge
      // automatically on rebuild, with NO edge ledger write. We do NOT trust
      // edge.refMeshRid / edge.homeMeshRid (FU-1: ref_mesh DERIVED, mirroring
      // home_mesh).
      edgeRows.push({
        refMeshRid: refVault.homeMeshRid,
        refVaultRid: refVaultBytes,
        homeMeshRid: homeVault.homeMeshRid,
        homeVaultRid: homeVaultBytes,
      });
    }

    // 3. DELETE+reINSERT under a single txn — idempotent full-replace. (Same
    //    explicit BEGIN/COMMIT/ROLLBACK shape as rebuild-mesh-registry; the
    //    libSQL runner has no implicit wrapping txn.)
    //    [Phase E / E2a] the alias DELETE+reINSERT lands in THIS SAME txn,
    //    alongside the subscription full-replace, BEFORE COMMIT — so a failure
    //    on either half rolls BOTH back (one atomic reconstitution).
    await db.execute("BEGIN");
    try {
      await deleteAllSubscriptions(db);
      for (const r of rows) {
        await addSubscription(db, {
          meshRid: r.meshRid,
          externalVaultRid: r.externalVaultRid,
        });
      }
      // Alias full-replace in the SAME txn (Phase E / E2a). The reconstituted
      // created_at is pinned to nowIso when supplied (tests pin it for
      // byte-stability), else now — it is audit-only and excluded from the
      // alias fold's identity/sort/merge, so its value never affects liveness.
      await deleteAllAliases(db);
      const aliasCreatedAt = args.nowIso ?? new Date().toISOString();
      for (const a of aliasRows) {
        await insertAliasRow(db, {
          alias: a.alias,
          vaultRid: a.vaultRid,
          kind: a.kind,
          createdAt: aliasCreatedAt,
        });
      }
      // Mesh-edge full-replace in the SAME txn (Slice 2a; FU-1 PK narrowing).
      // insertMeshEdge is INSERT OR IGNORE on the narrowed PK (ref_vault, kind,
      // home_vault) — ref_mesh is now DERIVED from the live ref vault's home
      // mesh, so two live edges sharing (ref_vault, home_vault) DERIVE to the
      // SAME ref_mesh AND home_mesh and collapse to one cache row (correct; the
      // cache PK no longer carries ref_mesh, so there is no home-mesh-distinct
      // case left to split).
      await deleteAllMeshEdges(db);
      for (const e of edgeRows) {
        await insertMeshEdge(db, {
          refMeshRid: e.refMeshRid,
          refVaultRid: e.refVaultRid,
          homeMeshRid: e.homeMeshRid,
          homeVaultRid: e.homeVaultRid,
          kind: "parent",
        });
      }
      await db.execute("COMMIT");
    } catch (txErr) {
      try {
        await db.execute("ROLLBACK");
      } catch {
        // best-effort
      }
      throw txErr;
    }

    // 4. Regenerate pod.yon downstream of the cache. Non-fatal + skip-if-no-pod
    //    (same posture as the lifecycle regen hooks): a missing federation_state
    //    is a no-op, never an error.
    await regeneratePodManifestNonFatal(db, {
      ...(args.handle !== undefined ? { handle: args.handle } : {}),
      ...(args.nowIso !== undefined ? { nowIso: args.nowIso } : {}),
    });

    return {
      subscriptionsReconstituted: rows.length,
      subscriptionsSkippedUnresolved: skippedUnresolved,
      bucketMeshesCreated,
      aliasesReconstituted: aliasRows.length,
      aliasesSkippedUnresolved,
      // Always 0 (Slice 1a) — the register fold guarantees ≤1 live record per
      // name, so there is never a cross-writer name-collision to resolve here.
      aliasNameCollisionsResolved: 0,
      meshEdgesReconstituted: edgeRows.length,
      meshEdgesSkippedUnresolved,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

interface ResolvedVaultLite {
  rid: Uint8Array;
  homeMeshRid: Uint8Array | null;
}

// coordinate (`lyt:vault:` typed id) → the local vault carrying that origin,
// matching resolveVault's coordinate branch (status-AGNOSTIC: a tombstoned vault
// still resolves by its coordinate). The ledger record stores the FULL typed id
// (`lyt:vault:<coord>`).
//
// Defect 3 (drift-kill): the private `canonicalizeLedgerCoordinate` that used to
// live here DUPLICATED canonicalization and could drift from the live fold's
// rule. It is GONE — both the index keys (built here) and the per-record lookup
// (the fold's `sub.coordinate` at the call site) now run through the SINGLE
// shared `canonicalizeCoordinate` export, so there is exactly ONE canonicalization
// rule feeding both the live fold and the reconstituted cache. The shared export
// emits the `lyt:vault:`-typed form for any valid coordinate, so the index key is
// the typed form and matches the fold's typed coordinate.
async function buildCoordinateIndex(db: Client): Promise<Map<string, ResolvedVaultLite>> {
  const out = new Map<string, ResolvedVaultLite>();
  for (const v of await listVaults(db)) {
    if (v.gitUrl === null) continue;
    const coord = gitUrlToCoordinate(v.gitUrl);
    if (coord === null) continue;
    // Run the bare gitUrl-derived coordinate through the SAME shared
    // canonicalizer the fold + lookup use, so the index key can never drift from
    // the lookup key. `canonicalizeCoordinate` re-wraps the bare coordinate in
    // the `lyt:vault:` typed prefix (the form the fold emits).
    const typed = canonicalizeCoordinate(coord);
    // First write wins (matches resolveVault's "first coordinate match wins").
    if (!out.has(typed)) out.set(typed, { rid: v.rid, homeMeshRid: v.homeMeshRid });
  }
  return out;
}

// (entry_mode, owner) → reserved OWNER-BUCKET mesh name (Phase ). `subscribe`
// → `subscriptions/{owner}`; `shared` → `shared/{owner}`. Any other entry_mode
// defaults to the subscriptions prefix (defensive — the write path only ever
// emits subscribe|shared). The `{owner}` segment is the coordinate owner, so two
// distinct upstream owners home into distinct bucket meshes.
function bucketMeshName(entryMode: string, owner: string): string {
  const prefix = entryMode === "shared" ? SHARED_BUCKET_MESH : SUBSCRIPTION_BUCKET_MESH;
  return `${prefix}/${owner}`;
}

// Extract the OWNER segment from a subscription coordinate. The ledger stores
// the typed id `lyt:vault:<host>/<owner>/<repo>`; the owner is the second
// path segment after the `lyt:vault:` type prefix. Returns null when the shape
// is unparseable (defensive — the subscribe path only writes well-formed
// coordinates derived from gitUrlToCoordinate).
function coordinateOwner(coordinate: string): string | null {
  const TYPED_PREFIX = "lyt:vault:";
  const bare = coordinate.startsWith(TYPED_PREFIX)
    ? coordinate.slice(TYPED_PREFIX.length)
    : coordinate;
  const segs = bare.split("/").filter((s) => s.length > 0);
  // host / owner / repo — owner is index 1.
  if (segs.length < 3) return null;
  const owner = segs[1]!;
  return owner.length > 0 ? owner : null;
}

// Resolve the reserved bucket mesh by name, creating it locally if absent. The
// bucket mesh is LOCAL homing scaffolding (the homing mesh_rid FK target) — it
// is derived, not part of the git-synced ledger SoT.
async function ensureBucketMesh(
  db: Client,
  name: string,
): Promise<{ mesh: MeshRow; created: boolean }> {
  const existing = await getMeshByName(db, name);
  if (existing !== null) return { mesh: existing, created: false };
  await insertMesh(db, { rid: newUuidv7Bytes(), name, pushTarget: null, pushKind: null });
  const created = await getMeshByName(db, name);
  if (created === null) {
    throw new Error(
      `rebuildFederationCacheFlow: bucket mesh ${JSON.stringify(name)} insert succeeded ` +
        `but re-lookup returned null (defensive).`,
    );
  }
  return { mesh: created, created: true };
}
