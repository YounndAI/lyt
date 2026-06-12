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

// v1.A.1 — mesh_subscriptions table is shipped empty. v1.C.2 populates via
// `lyt mesh subscribe` (the v1.A.1 stub originally pointed at v1.C.1, which
// turned out to populate `mesh_edges` only; the actual populating phase for
// this table is v1.C.2). Composite PK (mesh_rid, external_vault_rid) means
// a single mesh can subscribe to the same external vault at most once.

export interface MeshSubscriptionRow {
  meshRid: Uint8Array;
  meshRidHex: string;
  externalVaultRid: Uint8Array;
  externalVaultRidHex: string;
  externalMeshRid: Uint8Array;
  externalMeshRidHex: string;
  externalMeshName: string;
}

export interface AddSubscriptionArgs {
  meshRid: Uint8Array;
  externalVaultRid: Uint8Array;
  externalMeshRid: Uint8Array;
  externalMeshName: string;
}

function bytesOrThrow(raw: unknown, column: string): Uint8Array {
  if (!isUuidv7Bytes(raw)) {
    throw new Error(`mesh_subscriptions.${column} is not a valid UUIDv7 blob.`);
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

function rowToSubscription(row: Record<string, unknown>): MeshSubscriptionRow {
  const meshRid = bytesOrThrow(row["mesh_rid"], "mesh_rid");
  const extVault = bytesOrThrow(row["external_vault_rid"], "external_vault_rid");
  const extMesh = bytesOrThrow(row["external_mesh_rid"], "external_mesh_rid");
  return {
    meshRid,
    meshRidHex: uuid7BytesToHex(meshRid),
    externalVaultRid: extVault,
    externalVaultRidHex: uuid7BytesToHex(extVault),
    externalMeshRid: extMesh,
    externalMeshRidHex: uuid7BytesToHex(extMesh),
    externalMeshName: String(row["external_mesh_name"]),
  };
}

export async function addSubscription(db: Client, args: AddSubscriptionArgs): Promise<void> {
  await db.execute({
    sql: `INSERT OR IGNORE INTO mesh_subscriptions
 (mesh_rid, external_vault_rid, external_mesh_rid, external_mesh_name)
          VALUES (?, ?, ?, ?)`,
    args: [args.meshRid, args.externalVaultRid, args.externalMeshRid, args.externalMeshName],
  });
}

export async function listSubscriptionsForMesh(
  db: Client,
  meshRid: Uint8Array,
): Promise<MeshSubscriptionRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM mesh_subscriptions WHERE mesh_rid = ? ORDER BY external_mesh_name ASC",
    args: [meshRid],
  });
  return r.rows.map((row) => rowToSubscription(row as unknown as Record<string, unknown>));
}

export async function removeSubscription(
  db: Client,
  meshRid: Uint8Array,
  externalVaultRid: Uint8Array,
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM mesh_subscriptions WHERE mesh_rid = ? AND external_vault_rid = ?",
    args: [meshRid, externalVaultRid],
  });
}

// v1.B.2 — wipe every mesh_subscriptions row owned by a mesh. Used by
// `lyt mesh rebuild-registry` inside its per-mesh transaction before
// re-INSERTing the @MESH_SUBSCRIPTION rows parsed from disk mesh.yon.
export async function deleteAllSubscriptionsByMesh(db: Client, meshRid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "DELETE FROM mesh_subscriptions WHERE mesh_rid = ?",
    args: [meshRid],
  });
}
