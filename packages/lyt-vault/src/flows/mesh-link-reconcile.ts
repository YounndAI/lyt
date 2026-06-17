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

import { addVaultToMesh, listVaultsInMesh } from "../registry/mesh-vaults-repo.js";
import { listMeshes, updateMeshMainVault, type MeshRow } from "../registry/meshes-repo.js";
import { listVaults, type VaultRow } from "../registry/repo.js";
import { ridsEqual } from "../util/uuid7.js";

// V-B-4 / V-B-8a / V-B-8b fix-pass (2026-06-09) — shared mesh-link reconciler.
//
// THE DRIFT (Lane V Track B, V-B-4): a multi-machine `lyt init --auto` adopt
// recovers each vault from pod.yon and sets the *vault-side* `vaults.home_mesh_rid`
// (registerVaultFromYon, from the vault.yon @VAULT_HOME_MESH record) — but never
// writes the *mesh-side* links:
// - no `mesh_vaults (mesh_rid, vault_rid, role='home')` row, and
// - `meshes.main_vault_rid` stays NULL.
// Writability (flows/writability.ts), `lyt mesh info`, and `lyt mesh list`
// home_vaults all derive SOLELY from the mesh-side links. So the adopted pod
// lands `writable: unknown / orphan-vault` (push blocked), `mesh info` hard-fails
// ("no main_vault_rid"), and `mesh list` shows empty home_vaults — an
// unrecoverable, read-only pod.
//
// THE FIX (one primitive, three call sites — coupled-logic directive): the
// vault-side `home_mesh_rid` + the `<mesh>/main` naming convention are
// authoritative; this module DERIVES the mesh-side links from them. Used by:
// - flows/adopt-and-prime.ts (V-B-4) — reconcile inline after acquisition so
// an adopt never lands the drift.
// - flows/repair.ts (V-B-8a) — a `mesh-link-drift` finding class:
// detect under --dry-run, fix under --apply (no `--mesh` needed — the
// vault already knows its home mesh, unlike a NULL-home orphan).
// - flows/rebuild-mesh-registry.ts (V-B-8b) — resolveMainVaultPathByConvention
// breaks the circular path-resolution (rebuild needed `main_vault` to find
// the very mesh.yon it would rebuild `main_vault` from).
//
// Idempotent on a well-formed registry: addVaultToMesh upserts on the
// (mesh_rid, vault_rid) PK; updateMeshMainVault is only written when currently
// NULL; a candidate already holding its home row is skipped (so outcomes report
// only genuine changes). The ONE exception is a CORRUPT registry where a vault's
// `home` row already lives in a DIFFERENT mesh than its home_mesh_rid points at:
// re-inserting the home row then trips the `idx_mesh_vaults_home_per_vault`
// (one-home-mesh-per-vault) partial unique index and THROWS — the ON CONFLICT on
// the (mesh,vault) PK doesn't catch a different-mesh collision. This tool IS the
// corruption-repair surface, so it must survive ingesting that state:
// reconcileMeshLinks isolates the throw PER-MESH (one bad mesh can't abort
// healing the others), and repair surfaces it as a per-finding error.

// The `<mesh>/main` naming convention (lyt-naming-convention.md): the main vault
// of mesh `M` is the registered vault named `M/main`. The main vault is also where
// `.lyt/mesh.yon` (the mesh SoT) lives on disk.
export function mainVaultNameForMesh(meshName: string): string {
  return `${meshName}/main`;
}

// Active vaults whose vault-side `home_mesh_rid` points at this mesh. These are
// the rows that SHOULD have a `home` mesh_vaults link.
function homeCandidates(vaults: readonly VaultRow[], mesh: MeshRow): VaultRow[] {
  return vaults.filter(
    (v) => v.status === "active" && v.homeMeshRid !== null && ridsEqual(v.homeMeshRid, mesh.rid),
  );
}

function homeVaultRidHexSet(homeRows: { role: string; vaultRidHex: string }[]): Set<string> {
  const s = new Set<string>();
  for (const r of homeRows) if (r.role === "home") s.add(r.vaultRidHex);
  return s;
}

// One drifted mesh: which home rows are missing + whether main_vault needs setting.
export interface MeshLinkDriftItem {
  meshName: string;
  meshRidHex: string;
  // Active home-candidate vaults (home_mesh_rid == this mesh) lacking a `home`
  // mesh_vaults row.
  missingHomeVaultNames: string[];
  // The `<mesh>/main` vault name when `meshes.main_vault_rid` is NULL but that
  // vault is a registered home candidate; null when main_vault is already set or
  // no `<mesh>/main` candidate exists.
  missingMainVaultName: string | null;
}

// Result of reconciling one mesh — reports only genuine changes (idempotent
// no-ops are not listed).
export interface MeshLinkReconcileOutcome {
  meshName: string;
  meshRidHex: string;
  homeRowsAdded: string[];
  mainVaultSet: string | null;
  // Set when reconciling THIS mesh threw (e.g. a corrupt cross-mesh `home` row
  // tripping the one-home-per-vault index). Per-mesh isolation: the error is
  // captured here rather than aborting the whole reconcileMeshLinks pass.
  error?: string;
}

interface VaultSnapshotOpt {
  // Caller-supplied vault snapshot (avoids re-querying listVaults per mesh in
  // the all-meshes loops). When omitted, the function queries once itself.
  vaults?: readonly VaultRow[];
}

// V-B-8b — resolve the main vault path from the vault-side home_mesh_rid + the
// `<mesh>/main` convention, WITHOUT depending on meshes.main_vault_rid or any
// mesh_vaults row. Prefers the `<mesh>/main` candidate (where mesh.yon lives);
// falls back to the first home candidate. Returns null when the mesh has no
// registered home-candidate vaults.
export async function resolveMainVaultPathByConvention(
  db: Client,
  mesh: MeshRow,
  opts: VaultSnapshotOpt = {},
): Promise<string | null> {
  const vaults = opts.vaults ?? (await listVaults(db));
  const candidates = homeCandidates(vaults, mesh);
  if (candidates.length === 0) return null;
  const byConvention = candidates.find((v) => v.name === mainVaultNameForMesh(mesh.name));
  const chosen = byConvention ?? candidates[0];
  return chosen?.path ?? null;
}

export async function detectMeshLinkDriftForMesh(
  db: Client,
  mesh: MeshRow,
  opts: VaultSnapshotOpt = {},
): Promise<MeshLinkDriftItem | null> {
  const vaults = opts.vaults ?? (await listVaults(db));
  const homeRows = await listVaultsInMesh(db, mesh.rid);
  const present = homeVaultRidHexSet(homeRows);
  const candidates = homeCandidates(vaults, mesh);

  const missingHomeVaultNames = candidates
    .filter((v) => !present.has(v.ridHex))
    .map((v) => v.name)
    .sort();

  let missingMainVaultName: string | null = null;
  if (mesh.mainVaultRid === null) {
    const main = candidates.find((v) => v.name === mainVaultNameForMesh(mesh.name));
    if (main !== undefined) missingMainVaultName = main.name;
  }

  if (missingHomeVaultNames.length === 0 && missingMainVaultName === null) {
    return null;
  }
  return {
    meshName: mesh.name,
    meshRidHex: mesh.ridHex,
    missingHomeVaultNames,
    missingMainVaultName,
  };
}

// Detect drift across every registered mesh (one item per drifted mesh).
export async function detectMeshLinkDrift(db: Client): Promise<MeshLinkDriftItem[]> {
  const meshes = await listMeshes(db);
  const vaults = await listVaults(db);
  const out: MeshLinkDriftItem[] = [];
  for (const mesh of meshes) {
    const item = await detectMeshLinkDriftForMesh(db, mesh, { vaults });
    if (item !== null) out.push(item);
  }
  return out;
}

export async function reconcileOneMesh(
  db: Client,
  mesh: MeshRow,
  opts: VaultSnapshotOpt = {},
): Promise<MeshLinkReconcileOutcome> {
  const vaults = opts.vaults ?? (await listVaults(db));
  const homeRows = await listVaultsInMesh(db, mesh.rid);
  const present = homeVaultRidHexSet(homeRows);
  const candidates = homeCandidates(vaults, mesh);

  // No surrounding transaction (unlike repair.ts applyReattachOrphan): every op
  // here is purely ADDITIVE + idempotent, so a partial failure leaves forward
  // progress, not corruption — a re-run skips the rows already added (the
  // `present` check) and re-attempts the still-NULL main_vault. Do NOT copy this
  // no-tx shape into a non-idempotent mutation.
  const homeRowsAdded: string[] = [];
  for (const v of candidates) {
    if (present.has(v.ridHex)) continue;
    await addVaultToMesh(db, mesh.rid, v.rid, "home");
    homeRowsAdded.push(v.name);
  }

  let mainVaultSet: string | null = null;
  if (mesh.mainVaultRid === null) {
    const main = candidates.find((v) => v.name === mainVaultNameForMesh(mesh.name));
    if (main !== undefined) {
      await updateMeshMainVault(db, mesh.rid, main.rid);
      mainVaultSet = main.name;
    }
  }

  return {
    meshName: mesh.name,
    meshRidHex: mesh.ridHex,
    homeRowsAdded,
    mainVaultSet,
  };
}

// Reconcile every registered mesh's links. Idempotent + safe to run on every
// adopt (a non-drifted pod yields all-empty outcomes).
export async function reconcileMeshLinks(db: Client): Promise<MeshLinkReconcileOutcome[]> {
  const meshes = await listMeshes(db);
  const vaults = await listVaults(db);
  const out: MeshLinkReconcileOutcome[] = [];
  for (const mesh of meshes) {
    try {
      out.push(await reconcileOneMesh(db, mesh, { vaults }));
    } catch (err) {
      // Per-mesh isolation: a corrupt mesh (e.g. a cross-mesh `home` row
      // tripping the one-home-per-vault index) must NOT abort healing the other
      // meshes. Capture the error into the outcome and continue the pass.
      out.push({
        meshName: mesh.name,
        meshRidHex: mesh.ridHex,
        homeRowsAdded: [],
        mainVaultSet: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
