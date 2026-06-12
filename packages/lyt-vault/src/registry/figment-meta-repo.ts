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

// Lane V Phase 0 (0.4) — figment_meta cache repo (per-figment temporal truth).
//
// Stores each figment's FRONTMATTER authored time (created / modified), parsed
// at index time. The primer reads this for "recent activity" (V-F16) and for
// keyword-decay recency (V-F9) — both must reflect when the user authored the
// note, NOT filesystem mtime or cache build-time. Posture (Lock 0.2): a derived
// cache over the markdown SoT, rebuilt by the same full-walk as figment_fts.
//
// `figment_rid` is the vault-relative POSIX path (same key shape as
// figment_fts.figment_rid). created_iso/modified_iso are normalized ISO-8601
// strings (lexical sort == chronological) or NULL when the frontmatter lacks /
// malforms the field.

import type { Client, ResultSet } from "@libsql/client";

export interface FigmentMeta {
  figmentPath: string;
  createdIso: string | null;
  modifiedIso: string | null;
  // V-C-1 SC3 option-b — the figment's frontmatter `topic` (semantic category;
  // null/blank → null) + `tags` (the SAME list extractFrontmatterTags folds into
  // the FTS body, so there is no parse drift between the two). The primer reads
  // these to build a "Top keywords" fallback when no lane formed. Stored topic =
  // trimmed-or-null; stored tags = a JSON array string (or null when empty).
  topic: string | null;
  tags: string[];
}

// Idempotent insert-or-replace by path (PK figment_rid). Mirrors the
// delete-then-insert idempotency of the FTS/edge upserts; INSERT OR REPLACE is
// safe here because figment_rid is a real PRIMARY KEY (unlike the FTS rid).
//
// topic is stored trimmed-or-NULL (a blank topic is no signal, not the empty
// string). tags are stored as a JSON array string — the ONE stable round-trip
// encoding (loadKeywordSignals JSON.parses exactly what this JSON.stringifies),
// chosen over a delimiter join because JSON survives a tag that itself contains
// a comma/space. An empty tag list stores NULL (no signal).
export async function upsertFigmentMeta(db: Client, meta: FigmentMeta): Promise<void> {
  const topic = meta.topic !== null && meta.topic.trim().length > 0 ? meta.topic.trim() : null;
  const tagsJson = meta.tags.length > 0 ? JSON.stringify(meta.tags) : null;
  await db.execute({
    sql: "INSERT OR REPLACE INTO figment_meta (figment_rid, created_iso, modified_iso, topic, tags) VALUES (?, ?, ?, ?, ?)",
    args: [meta.figmentPath, meta.createdIso, meta.modifiedIso, topic, tagsJson],
  });
}

// Whole-table truncate — invoked by `upsertFtsCache` (full-walk rebuild)
// alongside deleteAllFts / deleteAllEdges.
export async function deleteAllMeta(db: Client): Promise<number> {
  const res = await db.execute("DELETE FROM figment_meta");
  return Number(res.rowsAffected);
}

export async function deleteMetaByPath(db: Client, figmentPath: string): Promise<number> {
  const res = await db.execute({
    sql: "DELETE FROM figment_meta WHERE figment_rid = ?",
    args: [figmentPath],
  });
  return Number(res.rowsAffected);
}

export async function countMeta(db: Client): Promise<number> {
  const res = await db.execute("SELECT COUNT(*) AS n FROM figment_meta");
  const row = res.rows[0];
  if (row === undefined) return 0;
  return Number(row["n"] as number | bigint);
}

// All rows as a path → modified_iso map. The primer loads this once per vault
// to (a) compute per-lane authored recency for decay (V-F9), joined against
// lane_members. Rows with a NULL modified_iso are omitted (no authored-time
// signal). Cheap for v1 vault sizes (<1000 figments).
export async function loadModifiedByPath(db: Client): Promise<Map<string, string>> {
  const res = await db.execute(
    "SELECT figment_rid, modified_iso FROM figment_meta WHERE modified_iso IS NOT NULL",
  );
  const map = new Map<string, string>();
  for (const row of res.rows) {
    map.set(row["figment_rid"] as string, row["modified_iso"] as string);
  }
  return map;
}

// ---------------------------------------------------------------------------
// V-C-1 SC3 option-b — primer keyword FALLBACK source.
//
// The primer's "Top keywords" normally derive from LANES (a cross-figment tag
// cluster: ≥2 figments must share a tag). A single/untagged capture forms no
// lane → empty keywords → the first-capture demo looked broken. When the
// lane-derived list is empty, the primer falls back to this aggregate over each
// figment's frontmatter `topic` + `tags` (now stored in figment_meta), so even
// one figment's semantic signal surfaces.
//
// Per-figment dedup: a figment contributes each distinct keyword ONCE (so a word
// that is both its topic AND a tag counts as one figment, not two), with
// `fromTopic` flagged when the topic produced it. Topic is the stronger signal —
// it ranks ahead of a tag-only keyword on a count tie.
//
// Last-resort (the "any capture surfaces something" guarantee): a figment with
// NEITHER topic NOR tags contributes a single keyword derived from its slug
// (filename, date prefix + `.md` stripped). The bare `lyt capture` quick-path
// can't reach this case — `topic` is a MANDATORY frontmatter field there
// (validateMandatoryFrontmatterTokens) — so the slug fallback only covers
// adopted / hand-written external figments that lack a topic. Honesty is
// preserved: a vault with 0 figments yields 0 signals → the primer keeps its
// honest empty placeholder (the fallback fires only when figments exist).
// ---------------------------------------------------------------------------

export interface KeywordSignal {
  // Case-folded keyword (a topic, a tag, or a slug last-resort).
  keyword: string;
  // Number of figments contributing this keyword (deduped per figment).
  figmentCount: number;
  // True when at least one contributing figment supplied this as its `topic`.
  fromTopic: boolean;
  // Most-recent authored time (modified, else created) across contributing
  // figments — the primer's "Last seen" column for the fallback; null when no
  // contributing figment carried a parseable date.
  lastSeenIso: string | null;
}

interface KwSignalAcc {
  figmentCount: number;
  fromTopic: boolean;
  lastSeenIso: string | null;
}

// Decode the JSON-array tags column written by upsertFigmentMeta. Tolerant: a
// null/empty/malformed value yields [] (a malformed cache row must not break the
// primer — resilience is a core objective).
function decodeTags(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

// Slug last-resort keyword from a vault-relative figment path: basename, with
// a leading `YYYY-MM-DD-` date prefix and the `.md` extension stripped, folded
// to lowercase. Returns null when nothing usable remains.
//
// release review: a date-ONLY filename (`2026-06-10.md`, a daily note) has no
// trailing dash after the date, so the prefix-strip leaves the bare date — which
// would surface as a junk "keyword". Reject a stem that is itself a pure
// `YYYY-MM-DD` (return null → no signal) so daily notes don't pollute the
// fallback with date fragments. (Only reachable for a no-topic-no-tags figment.)
function slugKeyword(figmentRid: string): string | null {
  const base = figmentRid.split("/").pop() ?? figmentRid;
  const stem = base
    .replace(/\.md$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .trim()
    .toLowerCase();
  if (stem.length === 0) return null;
  // Committed-state release review C3-M2: reject a stem composed ONLY of
  // date/time/numeric punctuation (`2026-06-10`, `2026-06-10t14-30-00`,
  // `12345`, `2026-06-10.5`) — those surface as junk "keywords". Keyed on the
  // char-class (not a date regex) so it also catches numeric + time variants
  // while leaving any stem with a real word char (latin OR non-latin) intact.
  if (/^[\dt:.\-]+$/i.test(stem)) return null;
  return stem;
}

// Aggregate frontmatter topic/tags across all figments into a deterministically
// ranked keyword list. Sort: figmentCount DESC, then topic-ahead-on-ties, then
// keyword ASC. Cheap for v1 vault sizes (<1000 figments) — one table scan.
export async function loadKeywordSignals(db: Client): Promise<KeywordSignal[]> {
  // release review: degrade, don't crash. If a stale/hand-reset DB is at the
  // pre-v5 schema (no topic/tags columns), the SELECT throws "no such column" —
  // treat that as "no fallback signal" ([]), consistent with this file's
  // never-throw posture (the primer then shows its honest empty placeholder
  // instead of erroring). Any other error still propagates (a real fault).
  let res: ResultSet;
  try {
    res = await db.execute(
      "SELECT figment_rid, created_iso, modified_iso, topic, tags FROM figment_meta",
    );
  } catch (err) {
    if (/no such column/i.test(err instanceof Error ? err.message : String(err))) {
      return [];
    }
    throw err;
  }
  const acc = new Map<string, KwSignalAcc>();
  for (const row of res.rows) {
    const figmentRid = row["figment_rid"] as string;
    const topicRaw = row["topic"] as string | null;
    const modified =
      (row["modified_iso"] as string | null) ?? (row["created_iso"] as string | null) ?? null;

    // Per-figment keyword set (deduped) + which one came from the topic.
    const kws = new Set<string>();
    let topicKw: string | null = null;
    if (topicRaw !== null && topicRaw.trim().length > 0) {
      topicKw = topicRaw.trim().toLowerCase();
      kws.add(topicKw);
    }
    for (const tag of decodeTags(row["tags"])) {
      const t = tag.trim().toLowerCase();
      if (t.length > 0) kws.add(t);
    }
    if (kws.size === 0) {
      const slugKw = slugKeyword(figmentRid);
      if (slugKw !== null) kws.add(slugKw);
    }

    for (const kw of kws) {
      const cur = acc.get(kw);
      const isTopic = kw === topicKw;
      if (cur === undefined) {
        acc.set(kw, { figmentCount: 1, fromTopic: isTopic, lastSeenIso: modified });
      } else {
        cur.figmentCount += 1;
        cur.fromTopic = cur.fromTopic || isTopic;
        if (modified !== null && (cur.lastSeenIso === null || modified > cur.lastSeenIso)) {
          cur.lastSeenIso = modified;
        }
      }
    }
  }

  const out: KeywordSignal[] = [];
  for (const [keyword, a] of acc) {
    out.push({
      keyword,
      figmentCount: a.figmentCount,
      fromTopic: a.fromTopic,
      lastSeenIso: a.lastSeenIso,
    });
  }
  out.sort((a, b) => {
    if (a.figmentCount !== b.figmentCount) return b.figmentCount - a.figmentCount;
    if (a.fromTopic !== b.fromTopic) return a.fromTopic ? -1 : 1;
    return a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0;
  });
  return out;
}

export interface RecentFigmentRow {
  figmentPath: string;
  modifiedIso: string;
}

// Figments whose frontmatter modified time is at/after `cutoffIso`, newest
// first — the primer's "recent activity" source (V-F16). ISO-8601 strings sort
// lexically == chronologically.
export async function listRecentFigments(
  db: Client,
  cutoffIso: string,
  limit: number,
): Promise<RecentFigmentRow[]> {
  const res = await db.execute({
    sql:
      "SELECT figment_rid, modified_iso FROM figment_meta" +
      " WHERE modified_iso IS NOT NULL AND modified_iso >= ?" +
      " ORDER BY modified_iso DESC, figment_rid ASC LIMIT ?",
    args: [cutoffIso, Math.max(1, Math.floor(limit))],
  });
  return res.rows.map((row) => ({
    figmentPath: row["figment_rid"] as string,
    modifiedIso: row["modified_iso"] as string,
  }));
}
