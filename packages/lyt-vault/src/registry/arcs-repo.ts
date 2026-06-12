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

// v1.D.2b arcs search-layer cache repo. Cache over the arcs.yon SoT
// (Lock 0.2). Same shape as `lanes-repo.ts`: `db: Client` first arg,
// typed row helper, BLOB-PK at the column level.
//
// Arc rid encoding: in v1.D.2a we materialise the rid in BLOB columns
// as the first 16 bytes of `sha256("arc:" + slug)`. The slug is the
// canonical stable identifier; storing it as BLOB preserves the table
// shape for v2's evolution to real UUIDv7 arc rids.
// `arcSlugToRidBytes` is the single source-of-truth for that encoding;
// tests + flows both consume it. Deterministic per slug — re-running
// rebuild-arcs produces identical inserts.
//
// `arc_members.figment_rid` is TEXT (vault-relative posix path) because
// figments do not have UUIDv7 rids in v1 (v1.D.1 D4 lesson — the rid
// system for individual notes lands in v1.5 alongside @TASK / @MARK).
// Both YON shape and cache type evolve together when v1.5 ships.
//
// Schema rationale (kept here rather than as inline `--` SQL comments
// in vault-db-migrations.ts per v1.D.1 retro Surprise 1 —
// splitSqlStatements is a naive split-on-`;` that breaks on
// `--` comment runs containing semicolons):
//
// arcs — one row per @ARC record in arcs.yon
// arc_members — one row per @ARC_MEMBER; PK (arc_rid, position)
// enforces position monotonicity within an arc at
// the DB layer (a second INSERT at the same
// (arc, position) tuple is rejected by SQLite —
// a useful defense-in-depth on top of the
// ArcPositionCollisionError thrown by the build
// flow before SQL ever runs).
// idx_arc_members_figment
// — supports the "what arcs is this figment in?"
// lookup pattern (master-plan §v1.D.2b:773
// "Queryable by figment-membership").

import { createHash } from "node:crypto";

import type { Client } from "@libsql/client";

export interface ArcRow {
  rid: Uint8Array;
  name: string;
  category: string;
  lastTouched: string;
}

export interface ArcMemberRow {
  arcRid: Uint8Array;
  figmentPath: string;
  position: number;
}

// Encode an arc slug as 16-byte BLOB shape. Algorithm + properties
// match `laneSlugToRidBytes` from v1.D.1b: collision-resistant for any
// realistic vault arc count; the slug is stored separately as TEXT in
// the `name` field so the human-readable label round-trips (the rid
// bytes are sha256-derived and cannot be inverted back to the slug —
// callers needing the slug consult arcs.yon, not the cache).
export function arcSlugToRidBytes(slug: string): Uint8Array {
  const hash = createHash("sha256");
  hash.update(`arc:${slug}`, "utf8");
  const digest = hash.digest();
  return new Uint8Array(digest.subarray(0, 16));
}

export interface InsertArcArgs {
  ridSlug: string;
  name: string;
  category: string;
  lastTouched: string;
}

export async function insertArc(db: Client, args: InsertArcArgs): Promise<Uint8Array> {
  const rid = arcSlugToRidBytes(args.ridSlug);
  await db.execute({
    sql: "INSERT INTO arcs (rid, name, category, last_touched) " + "VALUES (?, ?, ?, ?)",
    args: [rid, args.name, args.category, args.lastTouched],
  });
  return rid;
}

export async function insertArcMember(
  db: Client,
  args: { arcRid: Uint8Array; figmentPath: string; position: number },
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO arc_members (arc_rid, figment_rid, position) VALUES (?, ?, ?)",
    args: [args.arcRid, args.figmentPath, args.position],
  });
}

// Whole-table truncate — invoked by `upsertArcsCache` and
// `rebuildArcsFlow` integration. arc_members rows cascade via
// FK ON DELETE CASCADE.
export async function deleteAllArcs(db: Client): Promise<number> {
  const res = await db.execute("DELETE FROM arcs");
  return Number(res.rowsAffected);
}

export async function getArcByRid(db: Client, rid: Uint8Array): Promise<ArcRow | null> {
  const rows = await db.execute({
    sql: "SELECT rid, name, category, last_touched FROM arcs WHERE rid = ?",
    args: [rid],
  });
  const row = rows.rows[0];
  if (row === undefined) return null;
  return rowToArc(row);
}

export async function getArcByName(db: Client, name: string): Promise<ArcRow | null> {
  const rows = await db.execute({
    sql: "SELECT rid, name, category, last_touched FROM arcs WHERE name = ? LIMIT 1",
    args: [name],
  });
  const row = rows.rows[0];
  if (row === undefined) return null;
  return rowToArc(row);
}

export async function listArcs(db: Client): Promise<ArcRow[]> {
  const rows = await db.execute(
    "SELECT rid, name, category, last_touched FROM arcs ORDER BY name ASC",
  );
  return rows.rows.map(rowToArc);
}

// Position-ordered ASC per master-plan §v1.D.2b:773 acceptance
// "Position-ordered return when listing members of an arc".
export async function listMembersByArc(db: Client, arcRid: Uint8Array): Promise<ArcMemberRow[]> {
  const rows = await db.execute({
    sql:
      "SELECT arc_rid, figment_rid, position FROM arc_members " +
      "WHERE arc_rid = ? ORDER BY position ASC",
    args: [arcRid],
  });
  return rows.rows.map(rowToArcMember);
}

// Membership-by-figment lookup — supports cross-arc queries: "which
// arcs does this figment participate in?" Used by the v1.D.3 tiered-
// cascade search to amplify a figment-hit into its arc neighbourhood.
export async function listMembershipByFigment(
  db: Client,
  figmentPath: string,
): Promise<ArcMemberRow[]> {
  const rows = await db.execute({
    sql:
      "SELECT arc_rid, figment_rid, position FROM arc_members " +
      "WHERE figment_rid = ? ORDER BY arc_rid ASC, position ASC",
    args: [figmentPath],
  });
  return rows.rows.map(rowToArcMember);
}

// ---------------------------------------------------------------------------
// Row → typed projection
// ---------------------------------------------------------------------------

function rowToArc(row: Record<string, unknown>): ArcRow {
  return {
    rid: toBytes(row["rid"]),
    name: row["name"] as string,
    category: row["category"] as string,
    lastTouched: row["last_touched"] as string,
  };
}

function rowToArcMember(row: Record<string, unknown>): ArcMemberRow {
  return {
    arcRid: toBytes(row["arc_rid"]),
    figmentPath: row["figment_rid"] as string,
    position: Number(row["position"] as number | bigint),
  };
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new Error(`arcs-repo: expected BLOB column, got ${typeof raw}`);
}
