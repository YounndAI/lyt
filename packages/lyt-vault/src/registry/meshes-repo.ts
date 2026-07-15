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
import { isValidGhHandle } from "../util/identity.js";

// v1.A.1 — meshes table is shipped as an empty container. v1.B.1 will
// populate it via `lyt mesh init`. This module exists so v1.B.1 imports a
// stable shape instead of inventing one mid-phase.

export type MeshPushKind = "handle" | "org";

export interface MeshRow {
  rid: Uint8Array;
  ridHex: string;
  name: string;
  pushTarget: string | null;
  pushKind: MeshPushKind | null;
  mainVaultRid: Uint8Array | null;
  mainVaultRidHex: string | null;
  createdAt: string;
  // MA (Inc-2 Phase B slice 2) — mesh PROVENANCE: true only when THIS pod
  // created the mesh (`lyt mesh init`); false for a FOREIGN-JOINED mesh (`lyt
  // mesh join`) and every other insert path (fail-closed). The origin-hijack
  // gate: a mesh's org `push_target` may be used as the repo owner for the
  // user's OWN vaults ONLY when own_created — a joined mesh's push_target
  // (untrusted, from a foreign mesh.yon) must never own the user's repos.
  ownCreated: boolean;
}

export interface InsertMeshArgs {
  rid: Uint8Array;
  name: string;
  pushTarget?: string | null;
  pushKind?: MeshPushKind | null;
  mainVaultRid?: Uint8Array | null;
  createdAt?: string;
  // MA — provenance. Omitted → FAIL-CLOSED false (NOT own-created). Only
  // `lyt mesh init` passes true; `lyt mesh join` + foreign/bucket/reconstitution
  // inserts leave it false so a joined org mesh's push_target can never be
  // trusted as the owner of the user's own vaults.
  ownCreated?: boolean;
}

function toBytesOrNull(raw: unknown, column: string): Uint8Array | null {
  if (raw == null) return null;
  if (!isUuidv7Bytes(raw)) {
    throw new Error(`meshes.${column} is not a valid UUIDv7 blob.`);
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

function rowToMesh(row: Record<string, unknown>): MeshRow {
  const ridRaw = row["rid"];
  if (!isUuidv7Bytes(ridRaw)) {
    throw new Error(
      `meshes.rid for name ${JSON.stringify(String(row["name"]))} is not a valid UUIDv7 blob.`,
    );
  }
  const rid = ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
  const main = toBytesOrNull(row["main_vault_rid"], "main_vault_rid");
  const pushKindRaw = row["push_kind"];
  const pushKind: MeshPushKind | null =
    pushKindRaw === "handle" || pushKindRaw === "org" ? pushKindRaw : null;
  return {
    rid,
    ridHex: uuid7BytesToHex(rid),
    name: String(row["name"]),
    pushTarget: row["push_target"] == null ? null : String(row["push_target"]),
    pushKind,
    mainVaultRid: main,
    mainVaultRidHex: main ? uuid7BytesToHex(main) : null,
    createdAt: String(row["created_at"]),
    // MA — back-compat reader: a pre-migration-010 row (no column) reads as
    // NOT own-created (fail-closed). Stored as INTEGER 0/1.
    ownCreated: Number(row["own_created"] ?? 0) === 1,
  };
}

export async function insertMesh(db: Client, args: InsertMeshArgs): Promise<void> {
  if (!isUuidv7Bytes(args.rid)) {
    throw new Error("insertMesh: rid must be a 16-byte UUIDv7 BLOB.");
  }
  // MA (deferred pure-hardening) — `push_target` feeds resolveRemoteUrl → a
  // `git remote add`/`gh repo create` spawn AND (via deriveVaultRepoOwner) the
  // repo owner. When it arrives from an [lyt.untrusted] foreign mesh.yon it may
  // be a `-`/`/`/metachar value; NEUTRALIZE a non-handle push_target at store
  // time (null it + its push_kind) so it can never reach a spawn or owner
  // derivation. A valid handle is byte-unchanged (no behavior fork). The pair is
  // nulled together to keep push_target/push_kind consistent.
  let pushTarget = args.pushTarget ?? null;
  let pushKind = args.pushKind ?? null;
  if (pushTarget !== null && !isValidGhHandle(pushTarget)) {
    // eslint-disable-next-line no-console
    console.warn(
      `insertMesh: refusing to store invalid push_target ${JSON.stringify(pushTarget)} for ` +
        `mesh ${JSON.stringify(args.name)}; nulling it (repo-owner derivation falls back to the ` +
        `federation handle).`,
    );
    pushTarget = null;
    pushKind = null;
  }
  await db.execute({
    sql: `INSERT INTO meshes (rid, name, push_target, push_kind, main_vault_rid, created_at, own_created)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      args.rid,
      args.name,
      pushTarget,
      pushKind,
      args.mainVaultRid ?? null,
      args.createdAt ?? new Date().toISOString(),
      args.ownCreated === true ? 1 : 0,
    ],
  });
}

export async function getMeshByRid(db: Client, rid: Uint8Array): Promise<MeshRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM meshes WHERE rid = ?",
    args: [rid],
  });
  if (r.rows.length === 0) return null;
  return rowToMesh(r.rows[0] as unknown as Record<string, unknown>);
}

export async function getMeshByName(db: Client, name: string): Promise<MeshRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM meshes WHERE name = ?",
    args: [name],
  });
  if (r.rows.length === 0) return null;
  return rowToMesh(r.rows[0] as unknown as Record<string, unknown>);
}

export async function listMeshes(db: Client): Promise<MeshRow[]> {
  const r = await db.execute("SELECT * FROM meshes ORDER BY name ASC");
  return r.rows.map((row) => rowToMesh(row as unknown as Record<string, unknown>));
}

export async function updateMeshMainVault(
  db: Client,
  rid: Uint8Array,
  mainVaultRid: Uint8Array | null,
): Promise<void> {
  await db.execute({
    sql: "UPDATE meshes SET main_vault_rid = ? WHERE rid = ?",
    args: [mainVaultRid ?? null, rid],
  });
}

export async function deleteMesh(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "DELETE FROM meshes WHERE rid = ?",
    args: [rid],
  });
}
