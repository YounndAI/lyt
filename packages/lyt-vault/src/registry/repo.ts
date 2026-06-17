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
import { canonicalizeVaultPath } from "../util/paths.js";

export type VaultStatus = "active" | "disconnected" | "missing" | "tombstoned" | "access_lost";

// v1.A.1b — vaults.rid + memscope_rid + parent_vault + home_mesh_rid are
// all BLOB UUIDv7 in libSQL. Typed surface here exposes BOTH the raw 16-byte
// Uint8Array (for SQL args + byte equality via ridsEqual) AND a `*Hex`
// convenience for rendering, Map<string,X> keys, and CLI surfaces.
//
// `rowToVault` validates rid bytes at the row → typed boundary, mirroring
// the precedent in `federation-state.ts:rowToState`. A row that fails the
// boundary check throws — the offending row reaches no caller in an
// invalid state.
export interface VaultRow {
  rid: Uint8Array;
  ridHex: string;
  name: string;
  path: string;
  memscopeRid: Uint8Array | null;
  memscopeRidHex: string | null;
  parentVault: Uint8Array | null;
  parentVaultHex: string | null;
  homeMeshRid: Uint8Array | null;
  homeMeshRidHex: string | null;
  tierHint: string | null;
  status: VaultStatus;
  gitUrl: string | null;
  createdAt: string | null;
  registeredAt: string;
  lastVerifiedAt: string | null;
  verifyFailCount: number;
}

// v1.A.1b — mesh_edges upgraded to the cross-mesh shape per
// federation-design v2 §7. Old single-mesh (source_vault_rid, edge_type,
// target_vault_rid) triple is gone; rows now carry the referencing mesh +
// vault (the side recording the edge) plus the home mesh + vault (the side
// being referenced). kind narrows to 'parent' in v1.A.1b; v1.C.1 widens.
export interface MeshEdgeRow {
  refMeshRid: Uint8Array;
  refMeshRidHex: string;
  refVaultRid: Uint8Array;
  refVaultRidHex: string;
  homeMeshRid: Uint8Array;
  homeMeshRidHex: string;
  homeVaultRid: Uint8Array;
  homeVaultRidHex: string;
  kind: "parent";
}

export interface InsertVaultArgs {
  rid: Uint8Array;
  name: string;
  path: string;
  memscopeRid?: Uint8Array | null;
  parentVault?: Uint8Array | null;
  homeMeshRid?: Uint8Array | null;
  tierHint?: string | null;
  status?: VaultStatus;
  gitUrl?: string | null;
  createdAt?: string | null;
}

export interface InsertMeshEdgeArgs {
  refMeshRid: Uint8Array;
  refVaultRid: Uint8Array;
  homeMeshRid: Uint8Array;
  homeVaultRid: Uint8Array;
  kind?: "parent";
}

function toBytesOrNull(raw: unknown, column: string, contextName: string): Uint8Array | null {
  if (raw == null) return null;
  if (!isUuidv7Bytes(raw)) {
    throw new Error(`vaults.${column} for ${contextName} is not a valid UUIDv7 blob.`);
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

function bytesOrThrow(raw: unknown, column: string, contextName: string): Uint8Array {
  if (!isUuidv7Bytes(raw)) {
    throw new Error(`mesh_edges.${column} for ${contextName} is not a valid UUIDv7 blob.`);
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

function rowToVault(row: Record<string, unknown>): VaultRow {
  const ridRaw = row["rid"];
  const nameStr = row["name"] == null ? "<unknown>" : String(row["name"]);
  if (!isUuidv7Bytes(ridRaw)) {
    throw new Error(`vaults.rid for name ${JSON.stringify(nameStr)} is not a valid UUIDv7 blob.`);
  }
  const rid = ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
  const memscope = toBytesOrNull(row["memscope_rid"], "memscope_rid", nameStr);
  const parent = toBytesOrNull(row["parent_vault"], "parent_vault", nameStr);
  const homeMesh = toBytesOrNull(row["home_mesh_rid"], "home_mesh_rid", nameStr);
  return {
    rid,
    ridHex: uuid7BytesToHex(rid),
    name: nameStr,
    path: String(row["path"]),
    memscopeRid: memscope,
    memscopeRidHex: memscope ? uuid7BytesToHex(memscope) : null,
    parentVault: parent,
    parentVaultHex: parent ? uuid7BytesToHex(parent) : null,
    homeMeshRid: homeMesh,
    homeMeshRidHex: homeMesh ? uuid7BytesToHex(homeMesh) : null,
    tierHint: row["tier_hint"] == null ? null : String(row["tier_hint"]),
    status: String(row["status"]) as VaultStatus,
    gitUrl: row["git_url"] == null ? null : String(row["git_url"]),
    createdAt: row["created_at"] == null ? null : String(row["created_at"]),
    registeredAt: String(row["registered_at"]),
    lastVerifiedAt: row["last_verified_at"] == null ? null : String(row["last_verified_at"]),
    verifyFailCount: Number(row["verify_fail_count"] ?? 0),
  };
}

function rowToMeshEdge(row: Record<string, unknown>): MeshEdgeRow {
  const refMesh = bytesOrThrow(row["ref_mesh_rid"], "ref_mesh_rid", "row");
  const refVault = bytesOrThrow(row["ref_vault_rid"], "ref_vault_rid", "row");
  const homeMesh = bytesOrThrow(row["home_mesh_rid"], "home_mesh_rid", "row");
  const homeVault = bytesOrThrow(row["home_vault_rid"], "home_vault_rid", "row");
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

export async function insertVault(db: Client, args: InsertVaultArgs): Promise<void> {
  if (!isUuidv7Bytes(args.rid)) {
    throw new Error("insertVault: rid must be a 16-byte UUIDv7 BLOB.");
  }
  await db.execute({
    sql: `INSERT INTO vaults
 (rid, name, path, memscope_rid, parent_vault, home_mesh_rid, tier_hint, status, git_url, created_at, registered_at, last_verified_at, verify_fail_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    args: [
      args.rid,
      args.name,
      canonicalizeVaultPath(args.path),
      args.memscopeRid ?? null,
      args.parentVault ?? null,
      args.homeMeshRid ?? null,
      args.tierHint ?? null,
      args.status ?? "active",
      args.gitUrl ?? null,
      args.createdAt ?? null,
      new Date().toISOString(),
    ],
  });
}

export async function upsertVault(db: Client, args: InsertVaultArgs): Promise<void> {
  if (!isUuidv7Bytes(args.rid)) {
    throw new Error("upsertVault: rid must be a 16-byte UUIDv7 BLOB.");
  }
  await db.execute({
    sql: `INSERT INTO vaults
 (rid, name, path, memscope_rid, parent_vault, home_mesh_rid, tier_hint, status, git_url, created_at, registered_at, last_verified_at, verify_fail_count)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
 ON CONFLICT(rid) DO UPDATE SET
 name=excluded.name,
 path=excluded.path,
 memscope_rid=excluded.memscope_rid,
 parent_vault=excluded.parent_vault,
 home_mesh_rid=excluded.home_mesh_rid,
 tier_hint=excluded.tier_hint,
 status=excluded.status,
 git_url=excluded.git_url,
        created_at=excluded.created_at`,
    args: [
      args.rid,
      args.name,
      canonicalizeVaultPath(args.path),
      args.memscopeRid ?? null,
      args.parentVault ?? null,
      args.homeMeshRid ?? null,
      args.tierHint ?? null,
      args.status ?? "active",
      args.gitUrl ?? null,
      args.createdAt ?? null,
      new Date().toISOString(),
    ],
  });
}

// 0.9.4 (G — the single resolver chokepoint). `getVaultByName` is the
// historic name-lookup surface every verb routes through; it now delegates to
// the addressing chokepoint (`resolveVault`) so the WHOLE verb fleet gains the
// `{mesh}/{vault}` · bare-leaf · alias · origin-coordinate grammar from one
// edit. The raw exact-string SQL match lives in `getVaultByExactName` for the
// rare caller that genuinely needs a literal `name =` probe (e.g. a rename
// collision check that must not auto-resolve a leaf). The chokepoint THROWS
// `AmbiguousVaultLeafError` on a colliding bare leaf — never tiebreaks.
export async function getVaultByName(db: Client, name: string): Promise<VaultRow | null> {
  // Lazy import breaks the repo.ts ↔ vault-addressing.ts cycle (the addressing
  // module imports getVaultByRid from here).
  const { resolveVault } = await import("./vault-addressing.js");
  return resolveVault(db, name);
}

// Literal `name = ?` probe — NO leaf/alias/coordinate resolution. Used by
// collision checks (rename/init) where "is this EXACT name taken?" must not be
// softened into "does this leaf resolve to something?".
export async function getVaultByExactName(db: Client, name: string): Promise<VaultRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM vaults WHERE name = ?",
    args: [name],
  });
  if (r.rows.length === 0) return null;
  return rowToVault(r.rows[0] as unknown as Record<string, unknown>);
}

export async function getVaultByRid(db: Client, rid: Uint8Array): Promise<VaultRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM vaults WHERE rid = ?",
    args: [rid],
  });
  if (r.rows.length === 0) return null;
  return rowToVault(r.rows[0] as unknown as Record<string, unknown>);
}

export async function getVaultByPath(db: Client, path: string): Promise<VaultRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM vaults WHERE path = ?",
    args: [canonicalizeVaultPath(path)],
  });
  if (r.rows.length === 0) return null;
  return rowToVault(r.rows[0] as unknown as Record<string, unknown>);
}

export async function listVaults(db: Client): Promise<VaultRow[]> {
  const r = await db.execute("SELECT * FROM vaults ORDER BY name ASC");
  return r.rows.map((row) => rowToVault(row as unknown as Record<string, unknown>));
}

export async function updateVaultStatus(
  db: Client,
  rid: Uint8Array,
  status: VaultStatus,
): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET status = ? WHERE rid = ?",
    args: [status, rid],
  });
}

export async function updateVaultPath(db: Client, rid: Uint8Array, path: string): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET path = ? WHERE rid = ?",
    args: [canonicalizeVaultPath(path), rid],
  });
}

// V-A-10 self-heal — reconcile a vault's git remote into the registry. A
// local-first init inserts the vault with git_url=null (no remote yet);
// publish/sync wire the `origin` on disk but don't write it back, so writable
// derivation would stay "no-remote" forever. deriveVaultWritable reads the live
// origin and calls this to heal the cache (best-effort; never blocks a verdict).
export async function setVaultGitUrl(db: Client, rid: Uint8Array, gitUrl: string): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET git_url = ? WHERE rid = ?",
    args: [gitUrl, rid],
  });
}

export async function markVaultMissing(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: `UPDATE vaults
          SET status = 'missing',
 verify_fail_count = verify_fail_count + 1,
 last_verified_at = ?
          WHERE rid = ?`,
    args: [new Date().toISOString(), rid],
  });
}

export async function markVaultActive(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: `UPDATE vaults
          SET status = 'active',
 verify_fail_count = 0,
 last_verified_at = ?
          WHERE rid = ?`,
    args: [new Date().toISOString(), rid],
  });
}

export async function tombstoneVault(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET status = 'tombstoned' WHERE rid = ?",
    args: [rid],
  });
}

// v1.B.1 — set `vaults.home_mesh_rid` after `lyt mesh init` lands a row in
// `meshes`. The FK to meshes(rid) is enforced (ON DELETE SET NULL) and was
// shipped empty in v1.A.1b; this helper is the canonical assignment surface.
export async function setVaultHomeMesh(
  db: Client,
  vaultRid: Uint8Array,
  meshRid: Uint8Array | null,
): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET home_mesh_rid = ? WHERE rid = ?",
    args: [meshRid ?? null, vaultRid],
  });
}

export async function updateLastVerified(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET last_verified_at = ? WHERE rid = ?",
    args: [new Date().toISOString(), rid],
  });
}

export async function bumpVerifyFailCount(db: Client, rid: Uint8Array): Promise<number> {
  await db.execute({
    sql: `UPDATE vaults
 SET verify_fail_count = verify_fail_count + 1,
 last_verified_at = ?
          WHERE rid = ?`,
    args: [new Date().toISOString(), rid],
  });
  const r = await db.execute({
    sql: "SELECT verify_fail_count FROM vaults WHERE rid = ?",
    args: [rid],
  });
  if (r.rows.length === 0) return 0;
  return Number(r.rows[0]!["verify_fail_count"] ?? 0);
}

export async function deleteVault(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "DELETE FROM vaults WHERE rid = ?",
    args: [rid],
  });
}

export async function deleteAllVaults(db: Client): Promise<void> {
  // CASCADE on mesh_edges + mesh_vaults FKs cleans those up automatically;
  // explicit DELETE FROM mesh_edges is retained for the (rare) case where
  // a row's home FKs point at a vault row already drained by the cascade.
  await db.execute("DELETE FROM vaults");
  await db.execute("DELETE FROM mesh_edges");
}

export async function insertMeshEdge(db: Client, edge: InsertMeshEdgeArgs): Promise<void> {
  if (!isUuidv7Bytes(edge.refMeshRid)) {
    throw new Error("insertMeshEdge: refMeshRid must be a 16-byte UUIDv7 BLOB.");
  }
  if (!isUuidv7Bytes(edge.refVaultRid)) {
    throw new Error("insertMeshEdge: refVaultRid must be a 16-byte UUIDv7 BLOB.");
  }
  if (!isUuidv7Bytes(edge.homeMeshRid)) {
    throw new Error("insertMeshEdge: homeMeshRid must be a 16-byte UUIDv7 BLOB.");
  }
  if (!isUuidv7Bytes(edge.homeVaultRid)) {
    throw new Error("insertMeshEdge: homeVaultRid must be a 16-byte UUIDv7 BLOB.");
  }
  await db.execute({
    sql: `INSERT OR IGNORE INTO mesh_edges
 (ref_mesh_rid, ref_vault_rid, home_mesh_rid, home_vault_rid, kind)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      edge.refMeshRid,
      edge.refVaultRid,
      edge.homeMeshRid,
      edge.homeVaultRid,
      edge.kind ?? "parent",
    ],
  });
}

export async function listMeshEdgesByRefVault(
  db: Client,
  refVaultRid: Uint8Array,
): Promise<MeshEdgeRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM mesh_edges WHERE ref_vault_rid = ?",
    args: [refVaultRid],
  });
  return r.rows.map((row) => rowToMeshEdge(row as unknown as Record<string, unknown>));
}

export async function listMeshEdgesByHomeVault(
  db: Client,
  homeVaultRid: Uint8Array,
): Promise<MeshEdgeRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM mesh_edges WHERE home_vault_rid = ?",
    args: [homeVaultRid],
  });
  return r.rows.map((row) => rowToMeshEdge(row as unknown as Record<string, unknown>));
}
