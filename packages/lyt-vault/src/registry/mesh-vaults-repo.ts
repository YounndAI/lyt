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

// v1.A.1 — mesh_vaults table is shipped empty. v1.B.1 populates via
// `lyt mesh init` (home rows) and `lyt vault clone --to-mesh` (subscribed
// rows). The composite PK (mesh_rid, vault_rid) plus partial unique index
// `idx_mesh_vaults_home_per_vault` (one home mesh per vault) enforce the
// invariants at the SQL layer.

export type MeshVaultRole = "home" | "subscribed";

export interface MeshVaultRow {
  meshRid: Uint8Array;
  meshRidHex: string;
  vaultRid: Uint8Array;
  vaultRidHex: string;
  role: MeshVaultRole;
}

function bytesOrThrow(raw: unknown, column: string): Uint8Array {
  if (!isUuidv7Bytes(raw)) {
    throw new Error(`mesh_vaults.${column} is not a valid UUIDv7 blob.`);
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

function rowToMeshVault(row: Record<string, unknown>): MeshVaultRow {
  const meshRid = bytesOrThrow(row["mesh_rid"], "mesh_rid");
  const vaultRid = bytesOrThrow(row["vault_rid"], "vault_rid");
  const roleRaw = String(row["role"]);
  if (roleRaw !== "home" && roleRaw !== "subscribed") {
    throw new Error(`mesh_vaults.role unexpected value: ${JSON.stringify(roleRaw)}`);
  }
  return {
    meshRid,
    meshRidHex: uuid7BytesToHex(meshRid),
    vaultRid,
    vaultRidHex: uuid7BytesToHex(vaultRid),
    role: roleRaw,
  };
}

export async function addVaultToMesh(
  db: Client,
  meshRid: Uint8Array,
  vaultRid: Uint8Array,
  role: MeshVaultRole,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO mesh_vaults (mesh_rid, vault_rid, role) VALUES (?, ?, ?)
          ON CONFLICT(mesh_rid, vault_rid) DO UPDATE SET role = excluded.role`,
    args: [meshRid, vaultRid, role],
  });
}

export async function listVaultsInMesh(db: Client, meshRid: Uint8Array): Promise<MeshVaultRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM mesh_vaults WHERE mesh_rid = ? ORDER BY role ASC, vault_rid ASC",
    args: [meshRid],
  });
  return r.rows.map((row) => rowToMeshVault(row as unknown as Record<string, unknown>));
}

export async function listMeshesForVault(
  db: Client,
  vaultRid: Uint8Array,
): Promise<MeshVaultRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM mesh_vaults WHERE vault_rid = ? ORDER BY role ASC, mesh_rid ASC",
    args: [vaultRid],
  });
  return r.rows.map((row) => rowToMeshVault(row as unknown as Record<string, unknown>));
}

export async function removeVaultFromMesh(
  db: Client,
  meshRid: Uint8Array,
  vaultRid: Uint8Array,
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM mesh_vaults WHERE mesh_rid = ? AND vault_rid = ?",
    args: [meshRid, vaultRid],
  });
}

// v1.B.2 — wipe every mesh_vaults row for a given mesh. Used by
// `lyt mesh rebuild-registry` inside its per-mesh transaction before
// re-INSERTing the @MESH_HOME rows parsed from disk mesh.yon.
export async function deleteAllVaultsByMesh(db: Client, meshRid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "DELETE FROM mesh_vaults WHERE mesh_rid = ?",
    args: [meshRid],
  });
}
