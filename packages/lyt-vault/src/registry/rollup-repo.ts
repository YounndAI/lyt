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

// v1.E.2 — rollup cache repo. CRUD over the `rollup` table (per
// vault-db-migrations.ts:lytMigration002Rollup). Mirrors the shape of
// `lanes-repo.ts` (per-keyword row, deterministic ordering) but with a
// composite PK that includes `source_path` so a single ancestor can
// carry the same keyword via multiple descendant chains without row
// collision.
//
// Posture: rollup is a cache, NOT a YON SoT. Rebuild flows UPSERT rows
// (refresh last_seen on every rebuild); rows whose source descendant
// becomes disconnected age naturally past ROLLUP_DISCONNECTED_DAYS and
// surface via `lyt vault list --include-tombstones`. NEVER auto-delete
// (per the ratified default) — handler-driven `lyt repair` (v1.C.4.1, deferred) owns
// destructive cleanup.

import type { Client } from "@libsql/client";

export interface RollupRow {
  targetVaultRid: string;
  keyword: string;
  weight: number;
  lastSeen: string;
  sourcePath: string;
}

export interface UpsertRollupArgs {
  targetVaultRid: string;
  keyword: string;
  weight: number;
  lastSeen: string;
  sourcePath: string;
}

// INSERT-or-UPDATE per composite PK. A rebuild that re-encounters the
// same (target, keyword, source_path) refreshes weight + last_seen so
// active rows stay current; stale rows (descendant no longer in the
// walk) keep their old last_seen and age past the tombstone threshold.
export async function upsertRollup(db: Client, args: UpsertRollupArgs): Promise<void> {
  await db.execute({
    sql: `INSERT INTO rollup (target_vault_rid, keyword, weight, last_seen, source_path)
 VALUES (?, ?, ?, ?, ?)
 ON CONFLICT(target_vault_rid, keyword, source_path) DO UPDATE SET
 weight = excluded.weight,
            last_seen = excluded.last_seen`,
    args: [args.targetVaultRid, args.keyword, args.weight, args.lastSeen, args.sourcePath],
  });
}

// Lock 0.3 deterministic emit: rows ordered by
// (target_vault_rid, keyword, source_path) ASC. Used by tests + the
// list flag to produce byte-stable output.
export async function listRollupByTarget(db: Client, targetVaultRid: string): Promise<RollupRow[]> {
  const r = await db.execute({
    sql: `SELECT target_vault_rid, keyword, weight, last_seen, source_path
 FROM rollup
 WHERE target_vault_rid = ?
          ORDER BY keyword ASC, source_path ASC`,
    args: [targetVaultRid],
  });
  return r.rows.map(rowToRollup);
}

export async function listAllRollup(db: Client): Promise<RollupRow[]> {
  const r = await db.execute(
    `SELECT target_vault_rid, keyword, weight, last_seen, source_path
 FROM rollup
     ORDER BY target_vault_rid ASC, keyword ASC, source_path ASC`,
  );
  return r.rows.map(rowToRollup);
}

// Count of rollup rows for `targetVaultRid` whose `last_seen` is older
// than `thresholdIso` (caller computes ISO from now-thresholdDays).
// Drives the per-vault tombstone aggregate in `lyt vault list
// --include-tombstones`.
export async function countTombstonedRollupForTarget(
  db: Client,
  targetVaultRid: string,
  thresholdIso: string,
): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM rollup
          WHERE target_vault_rid = ? AND last_seen < ?`,
    args: [targetVaultRid, thresholdIso],
  });
  if (r.rows.length === 0) return 0;
  return Number(r.rows[0]!["n"] ?? 0);
}

// Latest `last_seen` across tombstoned rows for `targetVaultRid`, or
// null when none exist. ISO 8601 TEXT column → string sort is correct.
export async function latestTombstoneSeenForTarget(
  db: Client,
  targetVaultRid: string,
  thresholdIso: string,
): Promise<string | null> {
  const r = await db.execute({
    sql: `SELECT MAX(last_seen) AS latest FROM rollup
          WHERE target_vault_rid = ? AND last_seen < ?`,
    args: [targetVaultRid, thresholdIso],
  });
  if (r.rows.length === 0) return null;
  const latest = r.rows[0]!["latest"];
  return latest == null ? null : String(latest);
}

// Whole-table truncate. Not used by the rebuild flow (which UPSERTs)
// but exposed for test fixtures + future maintenance verbs.
export async function deleteAllRollup(db: Client): Promise<number> {
  const r = await db.execute("DELETE FROM rollup");
  return Number(r.rowsAffected);
}

// Targeted truncate: drop every rollup row for the given target vault.
// Reserved for future repair verb; rebuild does NOT call this (UPSERT
// posture preserves soft-tombstones per the ratified default).
export async function deleteAllRollupForTarget(
  db: Client,
  targetVaultRid: string,
): Promise<number> {
  const r = await db.execute({
    sql: "DELETE FROM rollup WHERE target_vault_rid = ?",
    args: [targetVaultRid],
  });
  return Number(r.rowsAffected);
}

function rowToRollup(row: unknown): RollupRow {
  const r = row as Record<string, unknown>;
  return {
    targetVaultRid: String(r["target_vault_rid"]),
    keyword: String(r["keyword"]),
    weight: Number(r["weight"]),
    lastSeen: String(r["last_seen"]),
    sourcePath: String(r["source_path"]),
  };
}
