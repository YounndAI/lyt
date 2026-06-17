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

import { isUuidv7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import {
  insertMeshEdge as insertMeshEdgeImpl,
  type InsertMeshEdgeArgs,
  type MeshEdgeRow,
} from "./repo.js";

// v1.B.2 — `mesh-edges-repo.ts` mirrors the `mesh-subscriptions-repo.ts`
// shape (CRUD per record class living in its own module). The empty
// container becomes a regenerable cache populated by
// `lyt mesh rebuild-registry`; v1.C.1 will add `lyt mesh add-edge` as
// the writer-side caller.
//
// `insertMeshEdge` is re-exported from `repo.ts` for backwards
// compatibility (it was added there by v1.A.1b alongside the empty
// container schema; pulling it forward to a dedicated repo module
// honours the default symmetry with `mesh-subscriptions-repo` +
// `mesh-vaults-repo` + `meshes-repo` without breaking the existing
// callers that import from `repo.js`).
//
// New helpers (the bits rebuild-mesh-registry actually needs):
// - listEdgesByRefMesh — fetch every edge owned by a mesh (the mesh
// whose mesh.yon records the @MESH_EDGE row)
// - deleteAllEdgesByRefMesh — wipe the mesh's edges before re-INSERTing
// from the parsed mesh.yon, inside a per-mesh transaction

export { insertMeshEdgeImpl as insertMeshEdge };
export type { InsertMeshEdgeArgs, MeshEdgeRow };

export async function listEdgesByRefMesh(
  db: Client,
  refMeshRid: Uint8Array,
): Promise<MeshEdgeRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM mesh_edges WHERE ref_mesh_rid = ? ORDER BY home_mesh_rid ASC, home_vault_rid ASC",
    args: [refMeshRid],
  });
  return r.rows.map((row) => rowToMeshEdge(row as unknown as Record<string, unknown>));
}

export async function deleteAllEdgesByRefMesh(db: Client, refMeshRid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "DELETE FROM mesh_edges WHERE ref_mesh_rid = ?",
    args: [refMeshRid],
  });
}

// v1.C.4 — single-row delete used by `lyt repair --apply` when an edge's
// ref/home vault no longer resolves OR home mesh's main vault is missing.
// Composite PK (ref_mesh_rid, ref_vault_rid, home_mesh_rid, home_vault_rid)
// per migrations.ts; mirrors removeSubscription's shape in
// mesh-subscriptions-repo.ts.
export async function removeMeshEdge(
  db: Client,
  refMeshRid: Uint8Array,
  refVaultRid: Uint8Array,
  homeMeshRid: Uint8Array,
  homeVaultRid: Uint8Array,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM mesh_edges
 WHERE ref_mesh_rid = ?
 AND ref_vault_rid = ?
 AND home_mesh_rid = ?
            AND home_vault_rid = ?`,
    args: [refMeshRid, refVaultRid, homeMeshRid, homeVaultRid],
  });
}

function bytesOrThrow(raw: unknown, column: string): Uint8Array {
  if (!isUuidv7Bytes(raw)) {
    throw new Error(`mesh_edges.${column} is not a valid UUIDv7 blob.`);
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

function rowToMeshEdge(row: Record<string, unknown>): MeshEdgeRow {
  const refMesh = bytesOrThrow(row["ref_mesh_rid"], "ref_mesh_rid");
  const refVault = bytesOrThrow(row["ref_vault_rid"], "ref_vault_rid");
  const homeMesh = bytesOrThrow(row["home_mesh_rid"], "home_mesh_rid");
  const homeVault = bytesOrThrow(row["home_vault_rid"], "home_vault_rid");
  const kindRaw = String(row["kind"]);
  if (kindRaw !== "parent") {
    throw new Error(`mesh_edges.kind unexpected value: ${JSON.stringify(kindRaw)}`);
  }
  return {
    refMeshRid: refMesh,
    refMeshRidHex: uuid7BytesToHex(refMesh),
    refVaultRid: refVault,
    refVaultRidHex: uuid7BytesToHex(refVault),
    homeMeshRid: homeMesh,
    homeMeshRidHex: uuid7BytesToHex(homeMesh),
    homeVaultRid: homeVault,
    homeVaultRidHex: uuid7BytesToHex(homeVault),
    kind: kindRaw,
  };
}
