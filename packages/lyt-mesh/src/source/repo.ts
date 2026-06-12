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

import { openRegistry, closeRegistry } from "@younndai/lyt-vault";

import { parseScope, serializeScope, type VaultSource, type VaultSourceRow } from "./types.js";

export interface AddSourceArgs {
  name: string;
  host: string;
  owner: string;
  scope: VaultSource["scope"];
}

function rowToVaultSource(row: Record<string, unknown>): VaultSourceRow {
  return {
    id: Number(row["id"]),
    name: String(row["name"]),
    host: String(row["host"]),
    owner: String(row["owner"]),
    scope: parseScope(String(row["scope"])),
    addedAt: String(row["added_at"]),
  };
}

export async function addSource(db: Client, args: AddSourceArgs): Promise<VaultSourceRow> {
  await db.execute({
    sql: `INSERT INTO vault_sources (name, host, owner, scope, added_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [args.name, args.host, args.owner, serializeScope(args.scope), new Date().toISOString()],
  });
  const got = await getSourceByName(db, args.name);
  if (!got) throw new Error(`Failed to read back source '${args.name}'.`);
  return got;
}

export async function listSources(db: Client): Promise<VaultSourceRow[]> {
  const r = await db.execute("SELECT * FROM vault_sources ORDER BY name ASC");
  return r.rows.map((row) => rowToVaultSource(row as unknown as Record<string, unknown>));
}

export async function getSourceByName(db: Client, name: string): Promise<VaultSourceRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM vault_sources WHERE name = ?",
    args: [name],
  });
  if (r.rows.length === 0) return null;
  return rowToVaultSource(r.rows[0] as unknown as Record<string, unknown>);
}

export async function removeSource(db: Client, name: string): Promise<boolean> {
  const existing = await getSourceByName(db, name);
  if (!existing) return false;
  await db.execute({
    sql: "DELETE FROM vault_sources WHERE name = ?",
    args: [name],
  });
  return true;
}

export async function withRegistry<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await openRegistry();
  try {
    return await fn(db);
  } finally {
    await closeRegistry(db);
  }
}
