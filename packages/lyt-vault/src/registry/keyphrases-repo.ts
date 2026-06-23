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

// feat/keyphrase-boost — keyphrases cache repo.
//
// Stores the deterministic per-figment keyphrase token set (see
// util/keyphrase-extract.ts) so the search cascade can add a
// β·keyphraseMatch(query, doc) boost to each result's blended score before the
// final sort. Posture (Lock 0.2): a derived cache over the markdown SoT,
// rebuilt by the same full-walk cadence as figment_fts / lanes.
//
// `figment_rid` is the vault-relative POSIX path (same key shape as
// figment_fts.figment_rid / figment_edges.source_rid — figments have no UUIDv7
// rid in v1). `term` is the RAW lowercase keyphrase token verbatim from the
// extractor (no further slug derivation — the key is the identity, which is why
// the tag→slug collision class cannot recur here). Composite PK
// (figment_rid, term) dedups repeated tokens. Mirrors figment-edges-repo.ts: a
// whole-table truncate for the full-walk rebuild, plus a delete-by-path +
// atomic replace primitive for a future per-write reconcile path.

import type { Client } from "@libsql/client";

// Whole-table truncate — invoked by `upsertKeyphrasesCache` (full-walk rebuild)
// so the keyphrase cache reflects the SoT verbatim (drops figments removed on
// disk between rebuilds).
export async function deleteAllKeyphrases(db: Client): Promise<number> {
  const res = await db.execute("DELETE FROM keyphrases");
  return Number(res.rowsAffected);
}

// Delete-by-figment primitive — a future per-write reconcile path removes one
// figment's keyphrases (on delete, or as the first half of an idempotent
// replace). Kept parallel to figment-edges-repo for the deferred incremental
// wave; unused by the full-walk path.
export async function deleteKeyphrasesByPath(db: Client, figmentRid: string): Promise<number> {
  const res = await db.execute({
    sql: "DELETE FROM keyphrases WHERE figment_rid = ?",
    args: [figmentRid],
  });
  return Number(res.rowsAffected);
}

// Idempotent replace — atomically clears one figment's existing keyphrases and
// re-inserts the given token set in a single write batch (mirrors
// figment-edges-repo `replaceEdgesForFigment`). `INSERT OR IGNORE` lets the
// composite PK absorb any duplicate token. An empty `terms` array is a pure
// clear. Used by the full-walk upsert (per-figment) and reserved for the
// deferred per-write reconcile path.
export async function replaceKeyphrasesForFigment(
  db: Client,
  figmentRid: string,
  terms: readonly string[],
): Promise<void> {
  const stmts = [{ sql: "DELETE FROM keyphrases WHERE figment_rid = ?", args: [figmentRid] }];
  for (const term of terms) {
    stmts.push({
      sql: "INSERT OR IGNORE INTO keyphrases (figment_rid, term) VALUES (?, ?)",
      args: [figmentRid, term],
    });
  }
  await db.batch(stmts, "write");
}

export async function countKeyphrases(db: Client): Promise<number> {
  const res = await db.execute("SELECT COUNT(*) AS n FROM keyphrases");
  const row = res.rows[0];
  if (row === undefined) return 0;
  return Number(row["n"] as number | bigint);
}

// Load the ENTIRE per-vault keyphrase cache as a Map<figment_rid, Set<term>>.
// The cascade calls this once per in-scope vault inside its gather, then matches
// every result's path against the map — one query per vault, not one per result.
export async function loadAllKeyphrases(db: Client): Promise<Map<string, Set<string>>> {
  const res = await db.execute("SELECT figment_rid, term FROM keyphrases");
  const out = new Map<string, Set<string>>();
  for (const r of res.rows) {
    const path = r["figment_rid"] as string;
    const term = r["term"] as string;
    let set = out.get(path);
    if (set === undefined) {
      set = new Set<string>();
      out.set(path, set);
    }
    set.add(term);
  }
  return out;
}
