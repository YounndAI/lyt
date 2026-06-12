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

// v1.D.1b lanes search-layer cache repo. Cache over the lanes.yon SoT
// (Lock 0.2). Same shape as `leases-repo.ts`: `db: Client` first arg,
// typed row helper, BLOB-PK at the column level.
//
// Lane rid encoding: in v1.D.1a we materialise the rid in BLOB columns
// as `Buffer.from("lane:<slug>", "utf8")` — the slug is the canonical
// stable identifier; storing it as BLOB preserves the table shape for
// v2's evolution to real UUIDv7 lane rids. `laneSlugToRidBytes` is the
// single source-of-truth for that encoding; tests + flows both consume
// it. lane_members.figment_rid is TEXT (vault-relative posix path)
// because figments do not have UUIDv7 rids in v1.

import type { Client } from "@libsql/client";

export interface LaneRow {
  rid: Uint8Array;
  ridSlug: string;
  name: string;
  sourceKeywords: readonly string[];
  memCount: number;
  lastBuilt: string;
}

export interface LaneMemberRow {
  laneRid: Uint8Array;
  laneRidSlug: string;
  figmentPath: string;
}

// Encode a lane slug as 16-byte BLOB shape. Truncation/padding posture:
// any UTF-8 encoding of `lane:<slug>` is hashed to 16 bytes via sha256
// → first 16 bytes; collision-resistant for any realistic vault lane
// count. The slug itself is stored as TEXT in the `name` field so the
// human-readable label round-trips. The rid bytes are deterministic per
// slug — re-running rebuild-lanes produces identical inserts.
import { createHash } from "node:crypto";

export function laneSlugToRidBytes(slug: string): Uint8Array {
  const hash = createHash("sha256");
  hash.update(`lane:${slug}`, "utf8");
  const digest = hash.digest();
  return new Uint8Array(digest.subarray(0, 16));
}

export interface InsertLaneArgs {
  ridSlug: string;
  name: string;
  sourceKeywords: readonly string[];
  memCount: number;
  lastBuilt: string;
}

export async function insertLane(db: Client, args: InsertLaneArgs): Promise<Uint8Array> {
  const rid = laneSlugToRidBytes(args.ridSlug);
  await db.execute({
    sql:
      "INSERT INTO lanes (rid, name, source_keywords, mem_count, last_built) " +
      "VALUES (?, ?, ?, ?, ?)",
    args: [rid, args.name, JSON.stringify(args.sourceKeywords), args.memCount, args.lastBuilt],
  });
  return rid;
}

export async function insertLaneMember(
  db: Client,
  args: { laneRid: Uint8Array; figmentPath: string },
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO lane_members (lane_rid, figment_rid) VALUES (?, ?)",
    args: [args.laneRid, args.figmentPath],
  });
}

// Whole-table truncate — invoked by `upsertLanesCache` and
// `rebuildLanesFlow` integration. lane_members rows cascade via
// FK ON DELETE CASCADE.
export async function deleteAllLanes(db: Client): Promise<number> {
  const res = await db.execute("DELETE FROM lanes");
  return Number(res.rowsAffected);
}

export async function getLaneByRid(db: Client, rid: Uint8Array): Promise<LaneRow | null> {
  const rows = await db.execute({
    sql: "SELECT rid, name, source_keywords, mem_count, last_built FROM lanes WHERE rid = ?",
    args: [rid],
  });
  const row = rows.rows[0];
  if (row === undefined) return null;
  return rowToLane(row);
}

export async function getLaneByName(db: Client, name: string): Promise<LaneRow | null> {
  const rows = await db.execute({
    sql: "SELECT rid, name, source_keywords, mem_count, last_built FROM lanes WHERE name = ? LIMIT 1",
    args: [name],
  });
  const row = rows.rows[0];
  if (row === undefined) return null;
  return rowToLane(row);
}

export async function listLanes(db: Client): Promise<LaneRow[]> {
  const rows = await db.execute(
    "SELECT rid, name, source_keywords, mem_count, last_built FROM lanes ORDER BY name ASC",
  );
  return rows.rows.map(rowToLane);
}

export async function listMembersByLane(db: Client, laneRid: Uint8Array): Promise<LaneMemberRow[]> {
  const rows = await db.execute({
    sql: "SELECT lane_rid, figment_rid FROM lane_members WHERE lane_rid = ? ORDER BY figment_rid ASC",
    args: [laneRid],
  });
  return rows.rows.map((r) => ({
    laneRid: toBytes(r["lane_rid"]),
    laneRidSlug: ridBytesToProbeSlugUnknown(),
    figmentPath: r["figment_rid"] as string,
  }));
}

// ---------------------------------------------------------------------------
// Row → typed projection
// ---------------------------------------------------------------------------

function rowToLane(row: Record<string, unknown>): LaneRow {
  const rid = toBytes(row["rid"]);
  return {
    rid,
    // The slug is not round-trippable from the BLOB rid (sha256-derived);
    // callers needing the slug should resolve via `name` (which IS the
    // original tag string verbatim for v1.D.1a single-keyword lanes) and
    // re-slugify via `slugifyTag` from the flow module if needed.
    ridSlug: ridBytesToProbeSlugUnknown(),
    name: row["name"] as string,
    sourceKeywords: parseStringArray(row["source_keywords"] as string),
    memCount: Number(row["mem_count"] as number | bigint),
    lastBuilt: row["last_built"] as string,
  };
}

// Sentinel return value for the ridSlug field in projections — the BLOB
// rid is sha256-derived and cannot be inverted back to the source slug.
// Callers that need the slug should consult the YON SoT (lanes.yon)
// rather than the cache. This keeps the cache row shape honest about
// what it can and can't surface.
function ridBytesToProbeSlugUnknown(): string {
  return "";
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new Error(`lanes-repo: expected BLOB column, got ${typeof raw}`);
}
