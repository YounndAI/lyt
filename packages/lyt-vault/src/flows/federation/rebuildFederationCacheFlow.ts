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
import { bucketMeshName } from "../../util/bucket-mesh.js";
import { slugifyHandle } from "../../util/federation-paths.js";
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
import {
  foldFedVaultWinners,
  readAllFedVaultRecords,
} from "../../yon/federation-vault-ledger-read.js";
import {
  foldFedMeshWinners,
  readAllFedMeshRecords,
} from "../../yon/federation-mesh-ledger-read.js";
import { getWriterId } from "../../util/writer-id.js";
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

// Reserved bucket-mesh namespace PREFIXES + the (entry_mode, owner) → bucket
// name rule now live in util/bucket-mesh.ts — the SINGLE source of truth shared
// with the LIVE receive path (flows/clone.ts + flows/subscribe.ts, Inc-2 Phase
// B). Re-exported here for back-compat with any importer of these symbols.
export {
  SUBSCRIPTION_BUCKET_MESH,
  SHARED_BUCKET_MESH,
} from "../../util/bucket-mesh.js";

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
  // ----- VAULT / MESH WRITE-BACK — R1 convergence (Inc-2 R1) -----
  // The @FED_VAULT / @FED_MESH folded winners written BACK into the LOCAL
  // registry `vaults` / `meshes` tables (name + resolvable home_mesh_rid for
  // vaults; name for meshes), so a machine that synced a foreign field-update
  // (e.g. a cross-machine rename) converges its registry to the ledger winner and
  // the next lifecycle reconcile sees no spurious diff (dissolves the clobber
  // flip-flop). Counts the rows actually mutated (0 on steady state / no drift).
  vaultsWrittenBack: number;
  meshesWrittenBack: number;
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
      //
      // fix-pass #4 — route the owner through the SAME slugifyHandle that
      // live/subscribe/repair use, so ALL owner derivations share ONE normalization.
      // canonicalizeCoordinate only lowercases the owner for KNOWN forges; a
      // non-GitHub-forge owner could otherwise reach the bucket name un-slugified
      // and split one upstream across two bucket meshes. No-op for GitHub owners
      // ([A-Za-z0-9-]: toLowerCase == slugify). A reserved/empty slug throws →
      // skip-not-fail (leave it in the ledger SoT).
      const rawOwner = coordinateOwner(canonicalizeCoordinate(sub.coordinate));
      let owner: string | null = null;
      if (rawOwner !== null) {
        try {
          owner = slugifyHandle(rawOwner);
        } catch {
          owner = null;
        }
      }
      if (owner === null) {
        // A live coordinate whose owner segment cannot be parsed/slugified cannot
        // be owner-homed. Leave it in the ledger SoT (skip-not-fail) rather than
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

    // 3b. VAULT / MESH WRITE-BACK (R1 convergence). The @FED_VAULT / @FED_MESH
    // folded winners are the git-synced SoT; the registry `vaults` /
    //    `meshes` tables are a REBUILDABLE LOCAL cache of them. Mirror the folded
    //    winner's ledger-owned VALUE fields back onto the LOCAL row (keyed by rid)
    //    so a machine that synced a FOREIGN field-update (a cross-machine rename /
    //    home-mesh move) converges its registry to the winner. Without this the
    //    next lifecycle reconcile would see registry(stale) != ledger(fresh) and
    //    re-author the stale value → the non-terminating cross-machine flip-flop
    //    (unbounded HLC). This is the SoT→cache reconvergence; the reconcile's
    //    origin-writer guard is the complementary anti-clobber backstop.
    //
    //    SCOPE (deliberate): a foreign-only ledger vault/mesh (no local rid) is
    //    NOT inserted — the registry cache holds only vaults PRESENT on THIS
    //    machine (each carries a machine-LOCAL `path` the ledger never conveys), so
    //    a full DELETE+reINSERT like the subscription/alias/edge caches would
    //    strand `path` and wipe local-only meshes (bucket meshes). We UPDATE the
    //    ledger-owned VALUE fields (vault: name + resolvable home_mesh_rid; mesh:
    //    name) on existing rows and never touch machine-local fields. `home_mesh_rid`
    //    is mirrored ONLY when the folded home mesh rid resolves to a LOCAL mesh
    //    (foreign mesh rids diverge per machine until mesh-rid convergence ships);
    //    the origin-writer guard covers the residual non-mirrorable field so it
    //    still cannot clobber.
    const writeBack = await writeBackRegistryFromLedger(db, args.podRoot);

    // 4. Regenerate pod.yon downstream of the cache. Non-fatal + skip-if-no-pod
    //    (same posture as the lifecycle regen hooks): a missing federation_state
    //    is a no-op, never an error.
    //    Inc-2 Phase 0 — reconcile:FALSE. This is the SYNC-RECONSTITUTION path:
    //    the registry cache above was just rebuilt FROM the ledger, so authoring
    //    registry→ledger events here would be circular AND (each machine's
    //    federation_state.fed_rid being independent) would write non-convergent
    //    per-writer @FED_VAULT/@FED_MESH shards that break the git union's
    //    byte-identity. A sync is a pure re-FOLD; new manifest events are authored
    //    only at lifecycle mutation time (init/delete).
    await regeneratePodManifestNonFatal(db, {
      reconcile: false,
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
      vaultsWrittenBack: writeBack.vaultsWrittenBack,
      meshesWrittenBack: writeBack.meshesWrittenBack,
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

// Extract the OWNER segment from a subscription coordinate. The ledger stores
// the typed id `lyt:vault:<host>/<owner>/<repo>`; the owner is the second
// path segment after the `lyt:vault:` type prefix. Returns null when the shape
// is unparseable (defensive — the subscribe path only writes well-formed
// coordinates derived from gitUrlToCoordinate).
// EXPORTED for reuse by flows/mesh-prune.ts's kind-aware ledger-backing guard,
// which must derive a live subscription's bucket mesh name the IDENTICAL way this
// flow homes it (coordinate → owner). Sharing this one extractor keeps the two
// paths' homing rule from drifting (audit-coupled-constant).
export function coordinateOwner(coordinate: string): string | null {
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

// R1 convergence — write the folded @FED_VAULT / @FED_MESH winners BACK into the
// LOCAL registry cache (see the step-3b comment at the call site for the full
// rationale + scope). Idempotent: a row already matching the winner is left
// untouched (no write, not counted). FK-safe: `home_mesh_rid` is mirrored only
// when the folded home mesh rid resolves to a locally-registered mesh (else the
// field is left as-is and the reconcile's origin-writer guard prevents a clobber).
async function writeBackRegistryFromLedger(
  db: Client,
  podRoot: string | undefined,
): Promise<{ vaultsWrittenBack: number; meshesWrittenBack: number }> {
  let vaultsWrittenBack = 0;
  let meshesWrittenBack = 0;

  // ---- VAULT rail ----
  // Iterate the winning RECORDS (not the value-only fold) so the null-home guard
  // below can read the winner's ORIGIN writerId. `active` winners only — a
  // tombstoned winner is not live and never writes back a name/home.
  const thisWriter = getWriterId();
  for (const lv of foldFedVaultWinners(readAllFedVaultRecords(podRoot)).values()) {
    if (lv.state !== "active") continue;
    let ridBytes: Uint8Array;
    try {
      ridBytes = hexToUuid7Bytes(lv.vaultRid);
    } catch {
      continue; // malformed rid in the ledger — cannot key a local row
    }
    const local = await getVaultByRid(db, ridBytes);
    if (local === null) continue; // foreign-only (not present locally) — leave in SoT

    // Resolve the ledger-owned home mesh rid to LOCAL bytes only when it names a
    // locally-registered mesh. `undefined` => do not touch home_mesh_rid.
    let homeMeshBytes: Uint8Array | null | undefined;
    let winnerHomeMeshHex: string | null = local.homeMeshRidHex; // default = no change
    if (lv.homeMeshRidHex === null) {
      // R2 — null-home clobber guard. A FOREIGN writer's winner that carries a
      // null `home_mesh_rid` must NOT wipe a valid LOCAL home: reconstitution
      // still derives `home_mesh_rid` from the writer's own mesh membership, and
      // a subscriber/peer that never homed the vault legitimately folds null,
      // which would silently strand this machine's homing. Mirror the reconcile's
      // origin-writer guard: only APPLY the null when THIS machine authored the
      // winner (or it is a legacy hlc-less record to heal forward). A foreign
      // hlc-bearing null → leave `home_mesh_rid` as-is (homeMeshBytes stays
      // `undefined`).
      const foreignAuthored = lv.hlc !== null && lv.writerId !== thisWriter;
      if (!foreignAuthored) {
        homeMeshBytes = null;
        winnerHomeMeshHex = null;
      }
    } else {
      try {
        const mb = hexToUuid7Bytes(lv.homeMeshRidHex);
        if ((await getMeshByRid(db, mb)) !== null) {
          homeMeshBytes = mb;
          winnerHomeMeshHex = lv.homeMeshRidHex;
        }
      } catch {
        // unparseable ledger home mesh rid — leave home_mesh_rid as-is
      }
    }

    const nameChanged = local.name !== lv.vaultName;
    const homeChanged =
      homeMeshBytes !== undefined && (local.homeMeshRidHex ?? null) !== (winnerHomeMeshHex ?? null);
    if (!nameChanged && !homeChanged) continue;

    if (homeMeshBytes === undefined) {
      await db.execute({ sql: "UPDATE vaults SET name = ? WHERE rid = ?", args: [lv.vaultName, ridBytes] });
    } else {
      await db.execute({
        sql: "UPDATE vaults SET name = ?, home_mesh_rid = ? WHERE rid = ?",
        args: [lv.vaultName, homeMeshBytes, ridBytes],
      });
    }
    vaultsWrittenBack += 1;
  }

  // ---- MESH rail — restore `name` AND `own_created` from the folded winner ----
  // #3 (0.12.1) — the write-back previously restored `name` ONLY, so a
  // reconstituted OWN mesh kept whatever own_created the local insert set
  // (fail-closed false on a fresh cache) and never healed back to `own` from the
  // ledger's `role`. Restore own_created = (role === "own"), carrying the SAME
  // origin-writer / foreign-authored guard the vault rail uses (R2): own_created
  // is TRUST-BEARING (it gates whether an org push_target may own the user's
  // repos), so only THIS writer's winner (or a legacy hlc-less record to heal
  // forward) may re-author it — a FOREIGN hlc-bearing winner must never clobber
  // this machine's ownership provenance. The display `name` keeps its prior
  // behavior (any local mesh's name follows the winner). M2's fail-closed `role`
  // fold backs this: a blank/garbled role folds to `join`, never `own`.
  for (const lm of foldFedMeshWinners(readAllFedMeshRecords(podRoot)).values()) {
    if (lm.state !== "active") continue;
    let ridBytes: Uint8Array;
    try {
      ridBytes = hexToUuid7Bytes(lm.meshRid);
    } catch {
      continue;
    }
    const local = await getMeshByRid(db, ridBytes);
    if (local === null) continue;

    const foreignAuthored = lm.hlc !== null && lm.writerId !== thisWriter;
    // R2-Interesting (legacy-role assumption) — the "heal forward" arm
    // (foreignAuthored=false) trusts `lm.role` for the own_created write. A
    // legacy hlc-LESS record that also lacks a `role` field folds to `join`
    // (M2 default), so heal-forward would set own_created=false on it. That
    // fails SAFE + LOUD, not silently: deriveVaultRepoOwner then declines the
    // org push_target (falls back to the handle) and a resulting clone-404
    // surfaces via G1's drop summary — never a silent hijack. Documented so a
    // future legacy-migration is aware the role field is assumed present here.
    const desiredOwnCreated = lm.role === "own";
    const ownChanged = !foreignAuthored && local.ownCreated !== desiredOwnCreated;
    const nameChanged = local.name !== lm.meshName;
    if (!nameChanged && !ownChanged) continue;

    if (ownChanged) {
      await db.execute({
        sql: "UPDATE meshes SET name = ?, own_created = ? WHERE rid = ?",
        args: [lm.meshName, desiredOwnCreated ? 1 : 0, ridBytes],
      });
    } else {
      await db.execute({
        sql: "UPDATE meshes SET name = ? WHERE rid = ?",
        args: [lm.meshName, ridBytes],
      });
    }
    meshesWrittenBack += 1;
  }

  return { vaultsWrittenBack, meshesWrittenBack };
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
