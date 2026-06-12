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

// v1.D.2b `upsertArcsCache` — post-pull / post-rebuild arcs cache
// refresh. Walks `<vault>/.lyt/indexes/arcs.yon` SoT and reflects every
// @ARC + @ARC_MEMBER record into lyt.db's arcs + arc_members tables.
//
// Posture (Lock 0.2): SoT is the YON file; cache is regenerable. The
// upsert flow truncates the cache before re-inserting so deletions in
// the SoT (arcs removed from frontmatter; tag renames; manual record
// removal) propagate. Idempotent: a second call on the same SoT
// produces the same row set.
//
// Called from:
// 1. `rebuildArcsFlow` immediately after `writeArcsDoc` returns
// (atomic SoT + cache emission via the manual `lyt vault
// rebuild-arcs` verb OR the v1.D.2c arc-builder automator body).
// 2. `lyt-mesh/src/flows/sync.ts` post-pull hook, when
// `.lyt/indexes/arcs.yon` exists (best-effort; non-fatal on
// failure per existing `upsertLedgerCache` / `upsertLanesCache`
// precedent).
//
// Open-once seam (v1.A.5 CR-B1): optional `lytDb?: Client`; when
// supplied, the caller owns lifecycle; when omitted, the flow opens +
// closes its own client.
//
// Position-collision propagation: the underlying SQLite PK on
// arc_members is (arc_rid, position). A torn read across processes
// where two distinct rows shared a position would fail at INSERT
// time. The rebuildArcsFlow already throws ArcPositionCollisionError
// before write-time when manual records collide, so the cache-side
// surfaces this only on pathological cross-process scenarios.

import { existsSync, readFileSync } from "node:fs";

import type { Client } from "@libsql/client";

import { closeVaultDb, openLytDb } from "../registry/vault-db.js";
import { deleteAllArcs, insertArc, insertArcMember } from "../registry/arcs-repo.js";
import { getArcsYonPath } from "../yon/arcs-write.js";
import { parseArcsFile } from "../yon/arcs-read.js";

export interface UpsertArcsCacheResult {
  vaultPath: string;
  // True when `.lyt/indexes/arcs.yon` existed and was processed.
  // False when the SoT file is missing — caller treats as a no-op.
  ran: boolean;
  arcsUpserted: number;
  membersUpserted: number;
  durationMs: number;
}

export interface UpsertArcsCacheOpts {
  // Open-once seam (v1.A.5 CR-B1 pattern). When supplied, the flow uses
  // the caller's lyt.db client and does NOT close it. When omitted, the
  // flow opens + closes its own.
  lytDb?: Client;
}

export async function upsertArcsCache(
  vaultPath: string,
  opts: UpsertArcsCacheOpts = {},
): Promise<UpsertArcsCacheResult> {
  const startedAt = Date.now();
  const arcsYonPath = getArcsYonPath(vaultPath);
  if (!existsSync(arcsYonPath)) {
    return {
      vaultPath,
      ran: false,
      arcsUpserted: 0,
      membersUpserted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const content = readFileSync(arcsYonPath, "utf8");
  const doc = parseArcsFile(content);

  const callerSupplied = opts.lytDb !== undefined;
  const db = opts.lytDb ?? (await openLytDb(vaultPath));
  let arcsUpserted = 0;
  let membersUpserted = 0;
  try {
    // Truncate first so the cache reflects the YON SoT verbatim — drops
    // any arc that disappeared between rebuilds. Cascade FK drops
    // arc_members.
    await deleteAllArcs(db);

    // Materialise arc rid → bytes map so member inserts can reference
    // the freshly-inserted parents without re-deriving the hash twice.
    const slugToRid = new Map<string, Uint8Array>();
    for (const arc of doc.arcs) {
      const rid = await insertArc(db, {
        ridSlug: arc.ridSlug,
        name: arc.name,
        category: arc.category,
        lastTouched: arc.lastTouched,
      });
      slugToRid.set(arc.ridSlug, rid);
      arcsUpserted += 1;
    }

    for (const member of doc.members) {
      const parentRid = slugToRid.get(member.arcRidSlug);
      if (parentRid === undefined) {
        // Orphan member (arc in SoT was filtered between author + read).
        // Skip rather than throw — the rebuild flow guarantees
        // consistency within a single doc; a torn read across processes
        // could surface this. Logged at the caller layer (sync's best-
        // effort hook) if needed.
        continue;
      }
      await insertArcMember(db, {
        arcRid: parentRid,
        figmentPath: member.figmentPath,
        position: member.position,
      });
      membersUpserted += 1;
    }
  } finally {
    if (!callerSupplied) await closeVaultDb(db);
  }

  return {
    vaultPath,
    ran: true,
    arcsUpserted,
    membersUpserted,
    durationMs: Date.now() - startedAt,
  };
}
