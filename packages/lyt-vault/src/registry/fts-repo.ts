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

// v1.D.3 figment FTS5 search-layer cache repo. Cache over the markdown
// SoT (the figment files themselves under `<vault>/notes/**/*.md`;
// FTS5 holds derived state — Lock 0.2 in the same shape as
// lanes-repo.ts / arcs-repo.ts).
//
// figment_rid column: TEXT (vault-relative POSIX path) — figments do
// not have UUIDv7 rids in v1 (v1.D.1 D4 + v1.D.2a inherits — the rid
// system for individual notes lands in v1.5 alongside @TASK / @MARK).
// The column is `UNINDEXED` because we don't search on the path, only
// on the body text; the path is the lookup key we project back to
// callers.
//
// Content storage (OD-3 default = default mode): the `body` column
// lives inside FTS5's shadow `figment_fts_content` table. This is the
// simplest mode — `snippet()` / `highlight()` work directly without
// re-reading from disk, and storage overhead for v1 vault sizes
// (typically <1000 figments; <5MB markdown per vault) is negligible.
// Alternatives `contentless=1` (requires re-reading disk for snippet
// generation, complicates the flow) and `content=figment_docs`
// (external content with trigger sync) deferred.
//
// Tier-2 scoring (OD-4 interpretation of master-plan §v1.D.3:782
// "raw hit count, not Jaccard"): we use FTS5's native BM25 `rank`
// column for ordering within tier-2 hits (lower rank = better match;
// BM25 IS a hit-count-derived score, not a set-similarity coefficient
// like Jaccard, so this satisfies the spec). The cascade engine emits
// confidence=0.7 uniform for all tier-2 hits — ordering comes from
// the `rank ASC` sort. Per-hit confidence variability within tier-2
// is a v1.D.3d candidate; v1 ships uniform confidence to keep the
// API stable.
//
// Schema rationale (kept here rather than as inline `--` SQL comments
// in vault-db-migrations.ts per v1.D.1 retro Surprise 1 —
// splitSqlStatements is a naive split-on-`;` that breaks on `--`
// comment runs containing semicolons):
//
// figment_fts — FTS5 virtual table; one row per figment.
// Tokenizer: porter unicode61 (Porter stemming
// + unicode-aware case folding). MATCH queries
// match on `body`; `figment_rid` is UNINDEXED.
// figment_fts_* — auto-created FTS5 shadow tables (content,
// data, idx, config, docsize). Enumerated in
// LYT_DB_TABLES for forward-compat with any
// future LYT_DB_TABLES consumer that probes
// whole-DB content (e.g. backup checksums).

import type { Client } from "@libsql/client";

export interface FtsHitRow {
  figmentPath: string;
  rawHits: number; // FTS5 rank-derived; lower input rank → larger rawHits
  snippet: string;
}

export interface InsertFtsDocArgs {
  figmentPath: string;
  body: string;
}

export async function insertFtsDoc(db: Client, args: InsertFtsDocArgs): Promise<void> {
  await db.execute({
    sql: "INSERT INTO figment_fts (figment_rid, body) VALUES (?, ?)",
    args: [args.figmentPath, args.body],
  });
}

// Whole-table truncate — invoked by `upsertFtsCache` and the manual
// `lyt vault rebuild-fts` verb. FTS5 supports DELETE without WHERE.
export async function deleteAllFts(db: Client): Promise<number> {
  const res = await db.execute("DELETE FROM figment_fts");
  return Number(res.rowsAffected);
}

// Lane M Wave 0 (P0-a) — delete-by-path primitive. The per-write
// reconcile path needs to remove a single figment's row (on delete or
// as the first half of an idempotent upsert) without truncating the
// whole table. `figment_rid` is the vault-relative POSIX path key (see
// the module header). Returns the number of rows removed (0 when the
// path was never indexed; >1 only if a pre-Lane-M bare-INSERT duplicated
// the path — this delete heals those duplicates).
export async function deleteFtsByPath(db: Client, figmentPath: string): Promise<number> {
  const res = await db.execute({
    sql: "DELETE FROM figment_fts WHERE figment_rid = ?",
    args: [figmentPath],
  });
  return Number(res.rowsAffected);
}

// Lane M Wave 0 (P0-a) — idempotent upsert-by-path. FTS5 has no native
// UPSERT (no UNIQUE constraint on the UNINDEXED rid column), so we
// delete-then-insert: any existing row(s) for the path are removed
// first, then exactly one fresh row is inserted. This fixes the
// bare-INSERT duplication bug (re-capturing the same path previously
// appended a second row).
//
// M1 (Lane M Wave 0 v2.1) — the DELETE + INSERT now run in a single
// atomic `batch` (implicit write transaction). Previously the two
// statements were unwrapped, so an interleave with the debounced
// full-walk reconcile (`upsertFtsCache`, which DELETEs the whole table
// then bulk-INSERTs) could observe a torn state: the per-event DELETE
// commits, the full-walk truncate lands, then this INSERT re-adds a row
// the full-walk had just cleared — or the full-walk reads between our
// DELETE and INSERT and misses the row. Wrapping makes THIS writer's
// delete+insert indivisible. (The broader full-walk-vs-incremental
// interleave is further narrowed by the per-vault reconcile serialization
// in sync-watch.ts and fully dissolves in Wave 1 when the full-walk
// demotes to startup + `lyt reindex`.)
export async function upsertFtsDocByPath(db: Client, args: InsertFtsDocArgs): Promise<void> {
  await db.batch(
    [
      {
        sql: "DELETE FROM figment_fts WHERE figment_rid = ?",
        args: [args.figmentPath],
      },
      {
        sql: "INSERT INTO figment_fts (figment_rid, body) VALUES (?, ?)",
        args: [args.figmentPath, args.body],
      },
    ],
    "write",
  );
}

export async function countFtsDocs(db: Client): Promise<number> {
  const res = await db.execute("SELECT COUNT(*) AS n FROM figment_fts");
  const row = res.rows[0];
  if (row === undefined) return 0;
  return Number(row["n"] as number | bigint);
}

// Tier-2 search entry point. Returns at most `limit` hits ordered by
// FTS5 native rank ASC (lower = better BM25 score). Each hit includes
// a 32-character snippet with `<mark>`/`</mark>` highlights around the
// matched terms via FTS5's built-in `snippet()` function.
//
// The `rawHits` field projects the FTS5 rank: callers can use it for
// debugging / tracing but the cascade engine emits a fixed confidence
// per hit (0.7 within tier-2; ordering preserved by the array order).
//
// Empty query returns []. FTS5 MATCH against an empty string would
// raise SQLITE_ERROR — gating here keeps the flow shape clean.
export async function searchFts(db: Client, query: string, limit: number): Promise<FtsHitRow[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0 || limit <= 0) return [];
  const safeLimit = Math.max(1, Math.floor(limit));
  const escaped = escapeFtsMatch(trimmed);
  const res = await db.execute({
    sql:
      "SELECT figment_rid, snippet(figment_fts, 1, '<mark>', '</mark>', '…', 32) AS snip, " +
      "rank AS rk FROM figment_fts WHERE figment_fts MATCH ? ORDER BY rank LIMIT ?",
    args: [escaped, safeLimit],
  });
  return res.rows.map((r) => ({
    figmentPath: r["figment_rid"] as string,
    // FTS5 rank is negative for BM25; smaller is better. Project to a
    // monotonically-increasing positive `rawHits` proxy (caller uses
    // ordering, not the absolute number).
    rawHits: rankToRawHits(r["rk"] as number | null),
    snippet: (r["snip"] as string | null) ?? "",
  }));
}

function rankToRawHits(rank: number | null): number {
  if (rank === null || Number.isNaN(rank)) return 0;
  // FTS5 BM25 rank is negative; absolute value scales with match
  // strength. The cascade engine doesn't use the absolute number for
  // confidence (uniform 0.7), only ordering — `rawHits` is exposed
  // here for trace + tests.
  return Math.abs(rank);
}

// Escape FTS5 MATCH user input by tokenizing on whitespace and
// wrapping EACH token in double-quotes (FTS5 phrase-of-one). FTS5
// treats space-separated terms as implicit AND, so this preserves
// token-AND search semantics (the v1 default — every token must
// appear in the doc) while quoting each individual token to neutralise
// any embedded special characters (`:`, `NEAR`, `(`, `)`, `^`,
// column-prefix operators) that would otherwise surface as FTS5
// syntax errors for innocuous user queries.
//
// Examples:
// "quick fox" → `"quick" "fox"` (both must appear; not adjacent)
// "test (function)" → `"test" "(function)"` (special-char tokens quoted)
// "a:b NEAR x" → `"a:b" "NEAR" "x"` (operators neutralised)
//
// Quote-aware tokenisation: internal double-quotes inside a token are
// doubled per FTS5 escape rules. Empty tokens (after whitespace split)
// are dropped.
function escapeFtsMatch(input: string): string {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}
