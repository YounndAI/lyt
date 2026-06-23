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

// 0.9.4 (F — pod-local aliases). alias → vault rid. The alias keys on
// the rid (identity), so it survives rename + move. Resolved in the single
// addressing chokepoint (vault-addressing.resolveVault).

export interface AliasRow {
  alias: string;
  vaultRid: Uint8Array;
  vaultRidHex: string;
  createdAt: string;
}

function rowToAlias(row: Record<string, unknown>): AliasRow {
  const ridRaw = row["vault_rid"];
  if (!isUuidv7Bytes(ridRaw)) {
    throw new Error(
      `vault_aliases.vault_rid for alias ${JSON.stringify(String(row["alias"]))} is not a valid UUIDv7 blob.`,
    );
  }
  const rid = ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
  return {
    alias: String(row["alias"]),
    vaultRid: rid,
    vaultRidHex: uuid7BytesToHex(rid),
    createdAt: String(row["created_at"]),
  };
}

// Upsert an alias → rid binding. Re-pointing an existing alias is allowed
// (the handler re-aims the same name at a new vault).
export async function setAlias(
  db: Client,
  alias: string,
  vaultRid: Uint8Array,
  createdAt?: string,
): Promise<void> {
  if (!isUuidv7Bytes(vaultRid)) {
    throw new Error("setAlias: vaultRid must be a 16-byte UUIDv7 BLOB.");
  }
  await db.execute({
    sql: `INSERT INTO vault_aliases (alias, vault_rid, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(alias) DO UPDATE SET vault_rid = excluded.vault_rid`,
    args: [alias, vaultRid, createdAt ?? new Date().toISOString()],
  });
}

// Resolve an alias to its target vault rid, or null when the alias is unknown.
export async function getAliasTargetRid(db: Client, alias: string): Promise<Uint8Array | null> {
  const r = await db.execute({
    sql: "SELECT vault_rid FROM vault_aliases WHERE alias = ?",
    args: [alias],
  });
  if (r.rows.length === 0) return null;
  const ridRaw = (r.rows[0] as unknown as Record<string, unknown>)["vault_rid"];
  if (!isUuidv7Bytes(ridRaw)) return null;
  return ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
}

export async function getAlias(db: Client, alias: string): Promise<AliasRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM vault_aliases WHERE alias = ?",
    args: [alias],
  });
  if (r.rows.length === 0) return null;
  return rowToAlias(r.rows[0] as unknown as Record<string, unknown>);
}

export async function listAliases(db: Client): Promise<AliasRow[]> {
  const r = await db.execute("SELECT * FROM vault_aliases ORDER BY alias ASC");
  return r.rows.map((row) => rowToAlias(row as unknown as Record<string, unknown>));
}

export async function listAliasesForVault(db: Client, vaultRid: Uint8Array): Promise<AliasRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM vault_aliases WHERE vault_rid = ? ORDER BY alias ASC",
    args: [vaultRid],
  });
  return r.rows.map((row) => rowToAlias(row as unknown as Record<string, unknown>));
}

export async function deleteAlias(db: Client, alias: string): Promise<boolean> {
  const r = await db.execute({
    sql: "DELETE FROM vault_aliases WHERE alias = ?",
    args: [alias],
  });
  return r.rowsAffected > 0;
}

// Fed-v2 Layer-1 (Phase E / E2a) — wipe the ENTIRE vault_aliases cache. The
// DELETE half of the idempotent full-replace reconstitution driven by
// `rebuildFederationCacheFlow` (the alias analog of
// `deleteAllSubscriptions`). The ledger shards under `<podRoot>/ledger/aliases/`
// are the SoT; this table is a derived cache. The caller holds the
// reconstitution txn.
export async function deleteAllAliases(db: Client): Promise<void> {
  await db.execute("DELETE FROM vault_aliases");
}

// Fed-v2 Layer-1 (Phase E / E2a) — bulk reINSERT half of the full-replace
// reconstitution. A raw INSERT (NOT an upsert) because the caller has just
// DELETE'd the table inside the same txn, so no alias can collide — mirroring
// `addSubscription`'s role on the subscription rail. Carries `kind` (the
// fold-winning informational kind) so the reconstituted row matches the live
// alias shape. `createdAt` is supplied by the caller (the table's NOT-NULL
// column is satisfied; the alias ledger's add-wins fold itself ignores
// created_at for identity/sort/merge).
export async function insertAliasRow(
  db: Client,
  args: { alias: string; vaultRid: Uint8Array; kind: string; createdAt: string },
): Promise<void> {
  if (!isUuidv7Bytes(args.vaultRid)) {
    throw new Error("insertAliasRow: vaultRid must be a 16-byte UUIDv7 BLOB.");
  }
  await db.execute({
    sql: `INSERT INTO vault_aliases (alias, vault_rid, kind, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [args.alias, args.vaultRid, args.kind, args.createdAt],
  });
}
