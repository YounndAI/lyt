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

// Lane V Phase 0 (0.3) — figment_edges cache repo.
//
// Stores parsed figment→figment links (currently `[[wikilink]]` / `![[embed]]`
// targets). These are pulled OUT of the FTS body during the same extraction
// pass (see upsert-fts-cache.ts `extractFtsBody`) so a link target no longer
// FTS-matches as prose (Qmsg-2 link-bleed). Posture (Lock 0.2): a derived
// cache over the markdown SoT, rebuilt by the same full-walk as figment_fts.
//
// `source_rid` is the vault-relative POSIX path (same key shape as
// figment_fts.figment_rid — figments have no UUIDv7 rid in v1). Mirrors
// fts-repo.ts: a whole-table truncate for the full-walk rebuild, a
// delete-by-path + atomic replace for the per-write reconcile path.

import type { Client } from "@libsql/client";

export type FigmentEdgeKind = "wikilink" | "embed";

export interface FigmentEdge {
  target: string;
  kind: FigmentEdgeKind;
}

// Whole-table truncate — invoked by `upsertFtsCache` (full-walk rebuild)
// alongside `deleteAllFts`, so the edge cache reflects the SoT verbatim.
export async function deleteAllEdges(db: Client): Promise<number> {
  const res = await db.execute("DELETE FROM figment_edges");
  return Number(res.rowsAffected);
}

// Delete-by-source primitive — the per-write reconcile path removes one
// figment's edges (on delete, or as the first half of an idempotent replace).
export async function deleteEdgesByPath(db: Client, sourceRid: string): Promise<number> {
  const res = await db.execute({
    sql: "DELETE FROM figment_edges WHERE source_rid = ?",
    args: [sourceRid],
  });
  return Number(res.rowsAffected);
}

// Idempotent replace — atomically clears one figment's existing edges and
// re-inserts the given set in a single write batch (mirrors fts-repo
// `upsertFtsDocByPath`, so a per-write replace and a full-walk re-index can't
// observe a torn edge set for the same source). `INSERT OR IGNORE` lets the
// composite PK absorb duplicate (target, kind) pairs from a doc that links the
// same target twice. An empty `edges` array is a pure clear.
export async function replaceEdgesForFigment(
  db: Client,
  sourceRid: string,
  edges: readonly FigmentEdge[],
): Promise<void> {
  const stmts = [{ sql: "DELETE FROM figment_edges WHERE source_rid = ?", args: [sourceRid] }];
  for (const e of edges) {
    stmts.push({
      sql: "INSERT OR IGNORE INTO figment_edges (source_rid, target, kind) VALUES (?, ?, ?)",
      args: [sourceRid, e.target, e.kind],
    });
  }
  await db.batch(stmts, "write");
}

export async function countEdges(db: Client): Promise<number> {
  const res = await db.execute("SELECT COUNT(*) AS n FROM figment_edges");
  const row = res.rows[0];
  if (row === undefined) return 0;
  return Number(row["n"] as number | bigint);
}
