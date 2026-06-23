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
// not have UUIDv7 rids in v1 (v1.D.1 + v1.D.2a inherits — the rid
// system for individual notes lands in v1.5 alongside @TASK / @MARK).
// The column is `UNINDEXED` because we don't search on the path, only
// on the body text; the path is the lookup key we project back to
// callers.
//
// Content storage (default = default mode): the `body` column
// lives inside FTS5's shadow `figment_fts_content` table. This is the
// simplest mode — `snippet()` / `highlight()` work directly without
// re-reading from disk, and storage overhead for v1 vault sizes
// (typically <1000 figments; <5MB markdown per vault) is negligible.
// Alternatives `contentless=1` (requires re-reading disk for snippet
// generation, complicates the flow) and `content=figment_docs`
// (external content with trigger sync) deferred.
//
// Tier-2 scoring (interpretation of master-plan §v1.D.3:782
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
  const escaped = buildFtsMatchExpr(trimmed);
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

// C16 (0.9.x) — query-side stopword set. The FTS5 index uses the
// `porter unicode61` tokenizer, which does NOT strip stopwords at index time,
// so a raw natural-language question carries its function words into the MATCH.
// English function words + the question/instruction words that dominate NL
// queries ("how", "what", "should", …). Query-side only; never affects what is
// indexed. Non-English stopwords are intentionally NOT listed — they simply
// survive as keywords (OR-matched), which is harmless.
const FTS_QUERY_STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "with", "without", "and",
  "or", "but", "if", "so", "is", "are", "be", "been", "being", "do", "does", "did", "how",
  "why", "what", "when", "which", "who", "whom", "that", "this", "these",
  "those", "should", "would", "could", "can", "may", "might", "will", "i", "my",
  "me", "it", "its", "as", "at", "by", "from", "into", "over", "under", "out",
  "up", "down", "off", "about", "against", "between", "through", "during",
  "before", "after", "you", "your", "they", "them", "their", "our", "we", "us",
  "he", "she", "his", "her", "not", "no", "any", "some", "all", "more", "most",
  "just", "like", "really", "actually", "than", "need", "needs", "needing",
  "keep", "want", "get",
]);

// Quote a single term as an FTS5 phrase-of-one, doubling internal double-quotes
// per FTS5 escape rules so embedded special characters are inert.
function quoteFtsToken(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
}

// Build the FTS5 MATCH expression from raw user input as a stopword-stripped
// keyword-OR (C16).
//
// Why OR, not the prior token-AND: LYT feeds raw natural-language questions to
// FTS. The previous behaviour quoted EVERY token (stopwords included) and
// space-joined them — FTS5 implicit AND — so any multi-word question required
// all of its words (incl. "how"/"the"/"should") to co-occur in one figment,
// which mechanically returns ~0 (validated: 0% hit@5 on a 27-query
// vocab-mismatch benchmark on a real 2063-figment corpus). Stripping stopwords
// + short tokens and ORing the surviving content keywords — with BM25
// `ORDER BY rank` still ranking figments that match more / rarer keywords
// highest, so OR does NOT flood the result — recovers recall to ~52% hit@5 /
// ~70% hit@10 at zero new cost or substrate. `keyword-AND` was measured too and
// stayed at 0%; only `keyword-OR` recovers — hence OR.
//
// Unicode-aware: splits on non-(letter|number) via \p{L}\p{N} so Romanian / any
// non-ASCII vault content survives tokenisation (the validation prototype was
// ASCII-only; production must not drop accented terms). Special characters
// (`:`, `(`, `)`, `^`, `NEAR`, column operators) are removed during this split,
// so injection safety is preserved (strictly stronger than the prior quoting).
//
// Fallback: if no content keyword survives (e.g. an all-stopword query), fall
// back to the prior token-AND of all quoted tokens so odd inputs still match
// something rather than emitting an empty expression.
function buildFtsMatchExpr(input: string): string {
  const keywords = [
    ...new Set(
      input
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        // len > 1 keeps 2-char discriminators (AI / ML / UI / Go / DB / v1);
        // the stopword set — not a blanket length gate — is the precision
        // instrument for 1-2-char noise. (release review C16: len > 2 silently
        // dropped meaningful short tech tokens, over-broadening mixed queries.)
        .filter((t) => t.length > 1 && !FTS_QUERY_STOPWORDS.has(t)),
    ),
  ];
  if (keywords.length > 0) {
    return keywords.map(quoteFtsToken).join(" OR ");
  }
  // No content keyword survived — preserve the prior token-AND behaviour.
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map(quoteFtsToken).join(" ");
}
