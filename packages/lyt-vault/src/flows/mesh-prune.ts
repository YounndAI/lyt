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

import { closeRegistry, openRegistry } from "../registry/client.js";
import { deleteMesh, getMeshByName, type MeshRow } from "../registry/meshes-repo.js";
import { listVaultsInMesh } from "../registry/mesh-vaults-repo.js";
import {
  getVaultByRid,
  listActiveVaultsByHomeMesh,
  listVaults,
  type VaultRow,
} from "../registry/repo.js";
import { canonicalizeCoordinate } from "../registry/vault-addressing.js";
import {
  bucketMeshName,
  entryModeForSource,
  isForeignBucketMeshName,
} from "../util/bucket-mesh.js";
import { slugifyHandle } from "../util/federation-paths.js";
import { hexToUuid7Bytes, ridsEqual } from "../util/uuid7.js";
import { liveFedMeshes } from "../yon/federation-mesh-ledger-read.js";
import {
  liveSubscriptions,
  type LiveSubscription,
} from "../yon/subscription-ledger-read.js";
import { coordinateOwner } from "./federation/rebuildFederationCacheFlow.js";
import { foreignVaultOwner } from "./repair-foreign-homing.js";

// Inc-2 Phase C (#6) — `lyt mesh prune <name>`.
//
// Removes an EMPTY / ORPHAN mesh from the registry — the lingering empty mesh
// rows a junction-safe pod cleanup leaves behind (dogfood finding #6). An empty
// mesh has NO live vaults referencing it (no home, no subscribed, no live main
// vault), so it serves no purpose but still trips the doctor
// `no main_vault_rid (structural invariant)` warn. Pruning it clears that warn.
//
// SAFETY posture (mirrors `vault abandon` — flows/abandon.ts):
//   - DESTRUCTIVE + fail-closed. Refuses without explicit confirmation. The CLI
//     wires `confirmed` from `--yes`; an agent/MCP dispatch would be handler-gated
//     upstream and this flow-layer `confirmed` check is retained as
//     defense-in-depth beneath that gate.
//   - REFUSES to prune a mesh that still has LIVE homed (or subscribed) vaults, or
//     a live main vault. The error names the offending vaults so the handler can
//     `lyt vault move` / `forget` them first.
//   - REGISTRY-ROW-ONLY: never removes an on-disk directory. Meshes do not own a
//     directory (vaults do), and an empty mesh has no main vault → nothing on disk
//     to touch. Because no directory is ever removed, no reparse-point (junction)
//     traversal occurs — the destructive-delete L0 disk hazard cannot arise here.
//     Any dangling mesh_vaults rows (rows whose vault_rid no longer resolves — the
//     FK cascade normally clears these on vault delete) are removed by the
//     `mesh_vaults.mesh_rid → meshes(rid) ON DELETE CASCADE` FK when deleteMesh
//     drops the mesh row; no filesystem path is read or removed.

export interface MeshPruneOptions {
  confirmed: boolean;
  registryPath?: string | undefined;
  // Test seam — override the pod root the durable ledger reads resolve under
  // (the @FED_MESH + subscription shards live at `<podRoot>/ledger/...`). Mirrors
  // rebuildFederationCacheFlow's podRoot seam. When omitted the ledger reads
  // default to getFederationRoot() (`<LYT_HOME>/pod`) — the SAME LYT_HOME the
  // registry.db resolves under, so production needs no explicit podRoot (the CLI
  // passes neither registryPath nor podRoot and both resolve via LYT_HOME).
  podRoot?: string | undefined;
}

export interface MeshPruneResult {
  meshName: string;
  meshRidHex: string;
  removed: boolean;
  // Count of dangling mesh_vaults rows swept alongside the mesh row (rows whose
  // vault_rid no longer resolves to a live vault). 0 for a clean empty mesh.
  removedMeshVaultRows: number;
}

export async function meshPruneFlow(
  name: string,
  opts: MeshPruneOptions,
): Promise<MeshPruneResult> {
  if (!opts.confirmed) {
    throw new Error(
      `Refusing to prune mesh '${name}' without explicit confirmation. CLI: pass --yes. ` +
        `This removes the mesh's registry row only — no files or directories are touched. ` +
        `Agent/MCP: this mutation is handler-gated; confirmation is required. This flow-layer ` +
        `refusal is retained as defense-in-depth beneath that gate.`,
    );
  }

  const db = await openRegistry(
    opts.registryPath !== undefined ? { path: opts.registryPath } : undefined,
  );
  try {
    const mesh = await getMeshByName(db, name);
    if (mesh === null) {
      throw new Error(`No mesh registered with name '${name}'.`);
    }

    // Enumerate the vaults that still reference this mesh, resolving each to a
    // LIVE vault row. A mesh_vaults row whose vault_rid no longer resolves is a
    // dangling reference (the vault was deleted) — it does NOT block the prune;
    // it IS the orphan state this verb cleans up.
    const memberships = await listVaultsInMesh(db, mesh.rid);
    const liveHome: string[] = [];
    const liveSubscribed: string[] = [];
    let danglingRows = 0;
    for (const mv of memberships) {
      const vault = await getVaultByRid(db, mv.vaultRid);
      if (vault === null) {
        danglingRows += 1;
        continue;
      }
      if (mv.role === "home") liveHome.push(vault.name);
      else liveSubscribed.push(vault.name);
    }

    // A live main vault is also a blocker (belt-and-suspenders: a well-formed
    // mesh keeps its main vault as a `home` membership too, but guard the
    // main_vault_rid path independently in case that row is missing).
    if (mesh.mainVaultRid !== null) {
      const main = await getVaultByRid(db, mesh.mainVaultRid);
      if (main !== null && !liveHome.includes(main.name)) {
        liveHome.push(main.name);
      }
    }

    if (liveHome.length > 0) {
      throw new Error(
        `Refusing to prune mesh '${name}': it still has ${liveHome.length} homed vault(s): ` +
          `${liveHome.join(", ")}. Move or remove them first (lyt vault move / lyt vault forget), ` +
          `then prune the empty mesh.`,
      );
    }
    if (liveSubscribed.length > 0) {
      throw new Error(
        `Refusing to prune mesh '${name}': it still has ${liveSubscribed.length} subscribed ` +
          `vault(s): ${liveSubscribed.join(", ")}. Unsubscribe them first, then prune the empty mesh.`,
      );
    }

    // HOME-POINTER GUARD (Inc-2 Phase C #6 — release review R2). The membership scan
    // above covers mesh_vaults ROWS, but a vault can also home to this mesh purely
    // via its `vaults.home_mesh_rid` pointer (the FK is `ON DELETE SET NULL`). An
    // ACTIVE vault pointing here with NO mesh_vaults row would be SILENTLY un-homed
    // by deleteMesh (home_mesh_rid → NULL). Refuse and name it — belt-and-suspenders
    // beside the main-vault guard above (a well-formed mesh keeps both the pointer
    // AND a `home` membership row in sync, but guard the pointer independently in
    // case the row is missing). Move/re-home them first (lyt vault move).
    const homedByPointer = await listActiveVaultsByHomeMesh(db, mesh.rid);
    if (homedByPointer.length > 0) {
      const names = homedByPointer.map((v) => v.name);
      throw new Error(
        `Refusing to prune mesh '${name}': ${names.length} active vault(s) still point at it via ` +
          `home_mesh_rid: ${names.join(", ")}. Move or re-home them first (lyt vault move) — ` +
          `deleting the mesh would silently un-home them (home_mesh_rid → NULL).`,
      );
    }

    // KIND-AWARE LEDGER-BACKING GUARD (Inc-2 Phase C #6 — cold-examine Option-A).
    //
    // The refusals above cover the CACHE state (live homed/subscribed vault ROWS).
    // But `deleteMesh` removes the registry CACHE row only, and the mesh cache is a
    // DERIVED rebuild of the DURABLE git-synced ledgers. If a mesh still has ledger
    // backing, a registry-row-only prune is silently UNDONE on the next
    // sync/rebuild/recover-pod ("looks-fixed-but-isn't"):
    //   - OWN mesh: pod.yon renders its `meshes` block from liveFedMeshes() (the
    //     @FED_MESH ledger fold — regenerate.ts), and recover-pod re-INSERTs each
    //     pod.yon mesh into the registry. A live @FED_MESH record therefore
    //     re-materializes a pruned own mesh.
    //   - BUCKET mesh (subscriptions/{owner}, shared/{owner}): rebuildFederation-
    //     CacheFlow re-creates it BY NAME (ensureBucketMesh) for any live
    //     subscription that folds into that bucket.
    // Only a PURE cache-orphan (no ledger backing) is safe to registry-only-delete.
    //
    // This is READ-only detection + a refusal branch. It NEVER writes a ledger —
    // durable removal (a @FED_MESH tombstone retraction / a subscription tombstone)
    // is the deferred Option B, explicitly OUT OF SCOPE here.
    const ledgerBacking = await detectLedgerBacking(db, mesh, opts.podRoot);
    if (ledgerBacking === "own") {
      throw new Error(
        `Refusing to prune mesh '${name}': it still has a live federation-ledger entry ` +
          `(@FED_MESH). Durable removal needs a ledger retraction (a mesh tombstone), tracked ` +
          `for a later 0.12.x lane. Pruning the cache row now would be undone on the next ` +
          `sync/rebuild/recover-pod.`,
      );
    }
    if (ledgerBacking === "bucket") {
      throw new Error(
        `Refusing to prune mesh '${name}': it is still backed by a live subscription or a ` +
          `registered foreign vault — unsubscribe it / 'lyt vault forget' the foreign vault(s) ` +
          `homed there first. Pruning the cache row now would be undone on the next ` +
          `sync/rebuild/reindex.`,
      );
    }

    // Empty/orphan → registry-row-only removal. The `mesh_vaults.mesh_rid` FK is
    // `ON DELETE CASCADE`, so deleteMesh alone removes any dangling mesh_vaults
    // rows (Inc-2 Phase C #6 release review R2 — the prior explicit
    // deleteAllVaultsByMesh sweep was redundant and opened a non-transactional
    // partial-failure window). danglingRows is still computed above for the
    // `removedMeshVaultRows` result field; CASCADE performs the actual removal.
    await deleteMesh(db, mesh.rid);

    return {
      meshName: mesh.name,
      meshRidHex: mesh.ridHex,
      removed: true,
      removedMeshVaultRows: danglingRows,
    };
  } finally {
    await closeRegistry(db);
  }
}

// Would `rebuildFederationCacheFlow` / recover-pod re-create this mesh from a
// DURABLE ledger? Kind-aware — a foreign bucket mesh is re-created from the live
// subscription fold; an own mesh from the @FED_MESH fold. Returns which backing
// makes the prune non-durable, or null for a pure cache-orphan (safe to prune).
//
// DURABLE-over-cache by design: both checks read the git-synced LEDGER folds
// (the same reads the rebuild consumes — liveSubscriptions / liveFedMeshes), NOT
// the registry cache proxies (mesh_subscriptions / meshes). The cache is exactly
// what prune mutates and can lag the ledger, so the ledger fold is the authority
// on whether a rebuild would resurrect this mesh.
async function detectLedgerBacking(
  db: Client,
  mesh: MeshRow,
  podRoot: string | undefined,
): Promise<"own" | "bucket" | null> {
  if (isForeignBucketMeshName(mesh.name)) {
    // BUCKET: ledger-backed iff EITHER re-creation path would re-mint THIS bucket:
    //
    //   (1) a LIVE subscription folds into THIS bucket name (the @SUBSCRIPTION
    //       fold — rebuildFederationCacheFlow's ensureBucketMesh). Re-derived the
    //       SAME way the rebuild homes it (coordinateOwner REUSED from the rebuild).
    //
    //   (2) a REGISTERED FOREIGN vault (source !== "own") derives to THIS bucket
    // name (Inc-2 Phase C #6 release review R1). repairForeignHomingFlow (wired
    //       into reindex, best-effort on sync) re-creates bucket meshes from the
    //       REGISTRY foreign-vault rows via insertMesh, NOT from any @SUBSCRIPTION
    //       record — it iterates listVaults().filter(source !== "own") and homes
    //       each into bucketMeshName(entryModeForSource(source), foreignVaultOwner).
    //       A `vault clone <url>` registers a foreign vault (source="subscribed")
    //       with NO @SUBSCRIPTION record, so the subscription-only check (1) misses
    //       it and prune would delete a bucket reindex/sync then resurrects. Mirror
    //       repair's derivation BYTE-FOR-BYTE: REUSE the exported foreignVaultOwner
    //       (which already slugifies) + bucketMeshName(entryModeForSource(source)),
    //       incl. repair's skip-not-fail cases (a null owner does not back a bucket).
    if (liveSubscriptions(podRoot).some((sub) => liveSubBucketName(sub) === mesh.name)) {
      return "bucket";
    }
    const foreignBacked = (await listVaults(db))
      .filter((v) => v.source !== "own")
      .some((v) => foreignVaultBucketName(v) === mesh.name);
    return foreignBacked ? "bucket" : null;
  }
  // OWN: ledger-backed iff a LIVE (active, add-wins) @FED_MESH record exists for
  // it — matched by rid (preferred; rid-stable across renames) then by name.
  const backed = liveFedMeshes(podRoot).some(
    (lm) => fedMeshRidMatches(lm.meshRid, mesh) || lm.meshName === mesh.name,
  );
  return backed ? "own" : null;
}

// The bucket mesh name a REGISTERED FOREIGN vault (source ∈ {shared,subscribed})
// homes into — mirroring repairForeignHomingFlow's resurrection derivation
// BYTE-FOR-BYTE (Inc-2 Phase C #6 release review R1). repair computes the bucket as
// `bucketMeshName(entryModeForSource(source), foreignVaultOwner(vault))`, where
// foreignVaultOwner (REUSED, exported from repair — not re-implemented) already
// slugifies the owner. Returns null on repair's SAME skip-not-fail case (a vault
// with no resolvable origin owner → foreignVaultOwner null → not homed into any
// bucket → does not back a prune). A vault repair would NOT resurrect that bucket,
// so this check does not spuriously block its prune. Callers pass only foreign
// vaults; the `as` narrows source to the two foreign tokens for entryModeForSource.
function foreignVaultBucketName(vault: VaultRow): string | null {
  const owner = foreignVaultOwner(vault);
  if (owner === null) return null;
  return bucketMeshName(entryModeForSource(vault.source as "shared" | "subscribed"), owner);
}

// The bucket mesh name a live subscription homes into, mirroring the rebuild's
// homing derivation byte-for-byte (canonicalize → owner → slugify → bucketName).
// Returns null on the SAME skip-not-fail cases the rebuild leaves un-homed (an
// unparseable owner or a reserved/empty slug), so a subscription the rebuild
// would NOT home into a bucket does not spuriously block a prune.
function liveSubBucketName(sub: LiveSubscription): string | null {
  const rawOwner = coordinateOwner(canonicalizeCoordinate(sub.coordinate));
  if (rawOwner === null) return null;
  let owner: string;
  try {
    owner = slugifyHandle(rawOwner);
  } catch {
    return null;
  }
  if (owner.length === 0) return null;
  return bucketMeshName(sub.entryMode, owner);
}

// rid match between a folded @FED_MESH record (hex) and a registry mesh row
// (bytes). Convert-and-compare (mirrors the rebuild write-back's rid keying) so a
// dashed/cased ledger hex still matches; a malformed ledger rid simply does not
// match (falls through to the name check in the caller).
function fedMeshRidMatches(ledgerMeshRidHex: string, mesh: MeshRow): boolean {
  try {
    return ridsEqual(hexToUuid7Bytes(ledgerMeshRidHex), mesh.rid);
  } catch {
    return false;
  }
}
