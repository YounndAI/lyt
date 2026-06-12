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

// v1.D.1b `upsertLanesCache` — post-pull / post-rebuild lanes cache
// refresh. Walks `<vault>/.lyt/indexes/lanes.yon` SoT and reflects every
// @LANE + @LANE_MEMBER record into lyt.db's lanes + lane_members tables.
//
// Posture (Lock 0.2): SoT is the YON file; cache is regenerable. The
// upsert flow truncates the cache before re-inserting so deletions in
// the SoT (lanes that fell below threshold; renamed tags) propagate.
// Idempotent: a second call on the same SoT produces the same row set.
//
// Called from:
// 1. `rebuildLanesFlow` immediately after `writeLanesDoc` returns
// (atomic SoT + cache emission via the manual `lyt vault
// rebuild-lanes` verb OR the v1.D.1c lane-builder automator body).
// 2. `lyt-mesh/src/flows/sync.ts` post-pull hook, when
// `.lyt/indexes/lanes.yon` exists (best-effort; non-fatal on
// failure per existing `upsertLedgerCache` precedent).
//
// Open-once seam (v1.A.5 CR-B1): optional `lytDb?: Client`; when
// supplied, the caller owns lifecycle; when omitted, the flow opens +
// closes its own client.

import { existsSync, readFileSync } from "node:fs";

import type { Client } from "@libsql/client";

import { closeVaultDb, openLytDb } from "../registry/vault-db.js";
import { deleteAllLanes, insertLane, insertLaneMember } from "../registry/lanes-repo.js";
import { getLanesYonPath } from "../yon/lanes-write.js";
import { parseLanesFile } from "../yon/lanes-read.js";

export interface UpsertLanesCacheResult {
  vaultPath: string;
  // True when `.lyt/indexes/lanes.yon` existed and was processed.
  // False when the SoT file is missing — caller treats as a no-op.
  ran: boolean;
  lanesUpserted: number;
  membersUpserted: number;
  durationMs: number;
}

export interface UpsertLanesCacheOpts {
  // Open-once seam (v1.A.5 CR-B1 pattern). When supplied, the flow uses
  // the caller's lyt.db client and does NOT close it. When omitted, the
  // flow opens + closes its own.
  lytDb?: Client;
}

export async function upsertLanesCache(
  vaultPath: string,
  opts: UpsertLanesCacheOpts = {},
): Promise<UpsertLanesCacheResult> {
  const startedAt = Date.now();
  const lanesYonPath = getLanesYonPath(vaultPath);
  if (!existsSync(lanesYonPath)) {
    return {
      vaultPath,
      ran: false,
      lanesUpserted: 0,
      membersUpserted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const content = readFileSync(lanesYonPath, "utf8");
  const doc = parseLanesFile(content);

  const callerSupplied = opts.lytDb !== undefined;
  const db = opts.lytDb ?? (await openLytDb(vaultPath));
  let lanesUpserted = 0;
  let membersUpserted = 0;
  try {
    // Truncate first so the cache reflects the YON SoT verbatim — drops
    // any lane that the latest rebuild filtered out. Cascade FK drops
    // lane_members.
    await deleteAllLanes(db);

    // Materialise lane rid → bytes map so member inserts can reference
    // the freshly-inserted parents without re-deriving the hash twice.
    const slugToRid = new Map<string, Uint8Array>();
    for (const lane of doc.lanes) {
      const rid = await insertLane(db, {
        ridSlug: lane.ridSlug,
        name: lane.name,
        sourceKeywords: lane.sourceKeywords,
        memCount: lane.memCount,
        lastBuilt: lane.lastBuilt,
      });
      slugToRid.set(lane.ridSlug, rid);
      lanesUpserted += 1;
    }

    for (const member of doc.members) {
      const parentRid = slugToRid.get(member.laneRidSlug);
      if (parentRid === undefined) {
        // Orphan member (lane in SoT was filtered between author + read).
        // Skip rather than throw — the rebuild flow guarantees consistency
        // within a single doc but a torn read across processes could
        // surface this. Logged at the caller layer (sync's best-effort
        // hook) if needed.
        continue;
      }
      await insertLaneMember(db, {
        laneRid: parentRid,
        figmentPath: member.figmentPath,
      });
      membersUpserted += 1;
    }
  } finally {
    if (!callerSupplied) await closeVaultDb(db);
  }

  return {
    vaultPath,
    ran: true,
    lanesUpserted,
    membersUpserted,
    durationMs: Date.now() - startedAt,
  };
}
