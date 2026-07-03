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

// Phase E (0.10.0 frontmatter-contract lane) — UNIT 1: per-figment keyword
// extractor (Patternology-style per-figment tags).
//
// SEPARABILITY (plan Phase E, Risk Register): the per-figment extractor is NOT
// heavier than the vault-level aggregation — it REUSES the already-shipped,
// proven `extractKeyphraseTokens` (util/keyphrase-extract.ts, the YAKE-flavored
// deterministic scorer the index build + query-side boost both consume). No new
// walk, no new cache, no model. So Unit 1 ships BUILT (not degraded to the empty
// stub). If a future change made this materially heavier, the honest fallback is
// `suggestFigmentTags → []` (= today's empty-tags stub) so A–D + F stay
// unblocked — see the `maxTags <= 0` guard below.
//
// WHY a wrapper and not extractKeyphraseTokens directly: keyphrase extraction
// returns a SPLIT token set (phrases exploded into member words, lexically
// sorted) tuned for the FTS boost — a good retrieval signal but a poor *tag*
// list (single-char-adjacent fragments, no relevance cap, no length ceiling).
// This wrapper adapts that same signal into a small, deduped, deterministically-
// ordered TAG list suitable for the frontmatter `tags:` field / a capture
// suggested-tags surface:
//   - filtered to tag-shaped tokens (>= MIN_TAG_LEN chars, content words),
//   - deduped (first-seen wins), then
//   - ordered by a LENGTH-BASED approximation of specificity (longer token
//     first, lexical tiebreak) — NOT the extractor's keyphrase score order.
//     extractKeyphraseTokens returns a LEXICALLY-sorted, phrase-split set (it
//     does not preserve score order — the FTS cache doesn't need it to), so we
//     cannot recover the true relevance ranking here without re-scoring. Longer
//     tokens are a cheap, byte-stable proxy for specificity ("libsql" over
//     "edge"); this is an APPROXIMATION, not a true strongest-first sort. See
//     the sort in suggestFigmentTags below.
//   - bounded to `maxTags` (default DEFAULT_MAX_FIGMENT_TAGS).
//
// DETERMINISM: inherits extractKeyphraseTokens' determinism contract — NO LLM,
// NO Date.now(), NO random. Same (title, body) → byte-identical tag list. Pure +
// synchronous. This is the MODEL-FREE half of Phase E enrichment (topic-classify
// is the optional model half).
//
// PROVENANCE (Risk Register — "machine fields provenance-stamped"): these are
// SUGGESTED tags. The caller (capture surface / backfill) decides whether to
// write them, and when it does it stamps automator provenance via the same
// @STAMP hook the metadata-filler uses — this pure function never writes.

import {
  DEFAULT_KEYPHRASE_TOP_K,
  extractKeyphraseTokens,
  isContentWord,
} from "../util/keyphrase-extract.js";

/** Default number of suggested tags returned (small, human-scannable list). */
export const DEFAULT_MAX_FIGMENT_TAGS = 5;

/** Minimum characters for a token to be tag-shaped (drops 2-char fragments). */
export const MIN_TAG_LEN = 3;

export interface SuggestFigmentTagsOptions {
  /** Cap on the returned list. Default DEFAULT_MAX_FIGMENT_TAGS. `<= 0` → the
   *  honest empty-stub degrade path (returns `[]`), per the plan's separability
   *  clause. */
  maxTags?: number;
  /** Candidate pool size handed to the underlying keyphrase extractor. Larger =
   *  more headroom to fill `maxTags` after tag-shape filtering. Default
   *  DEFAULT_KEYPHRASE_TOP_K. */
  topK?: number;
}

/**
 * Suggest a small, ranked, deduped tag list for one figment from its title +
 * body. Pure + deterministic + model-free — reuses `extractKeyphraseTokens`.
 *
 * The returned list is:
 *   - filtered to tag-shaped content tokens (>= MIN_TAG_LEN chars),
 *   - deduped, then
 *   - ordered by a LENGTH-BASED specificity approximation (longer token first,
 *     lexical tiebreak) — NOT the extractor's keyphrase score order, which is
 *     not recoverable from its lexically-sorted output (see the block comment),
 *   - and capped at `maxTags`.
 *
 * Returns `[]` when there is no usable signal (empty doc, all-stopword body) OR
 * when `maxTags <= 0` (the explicit degrade-to-stub path). Never throws.
 */
export function suggestFigmentTags(
  title: string,
  body: string,
  opts: SuggestFigmentTagsOptions = {},
): string[] {
  const maxTags = opts.maxTags ?? DEFAULT_MAX_FIGMENT_TAGS;
  // Separability degrade path: a caller can force the empty-tags stub (= today's
  // behavior) without a code fork by passing maxTags <= 0.
  if (maxTags <= 0) return [];

  const topK = opts.topK ?? DEFAULT_KEYPHRASE_TOP_K;

  // extractKeyphraseTokens returns a LEXICALLY-sorted, phrase-split token set —
  // it does NOT preserve score order (the FTS cache doesn't need it to), and the
  // true keyphrase score is NOT recoverable from its output. So we CANNOT sort
  // strongest-first here without re-scoring. Instead we lean on set MEMBERSHIP as
  // the aboutness signal (the extractor already dropped sub-threshold noise, so
  // any returned member is a real signal) and order by token LENGTH as a cheap,
  // byte-stable specificity proxy (longer ≈ more specific). This is an
  // APPROXIMATION of relevance, not a true score ranking — see the block comment.
  // We ask for a generous candidate pool (topK) so tag-shape filtering still has
  // enough members to fill maxTags.
  const tokens = extractKeyphraseTokens(title, body, topK);

  const seen = new Set<string>();
  const shaped: string[] = [];
  for (const t of tokens) {
    const tag = t.trim().toLowerCase();
    if (tag.length < MIN_TAG_LEN) continue; // drop 2-char fragments
    if (!isContentWord(tag)) continue; // drop stopwords / pure-numeric
    if (seen.has(tag)) continue;
    seen.add(tag);
    shaped.push(tag);
  }

  // Deterministic ordering: longer (more specific) tokens first, then lexical —
  // byte-stable regardless of the extractor's internal Set iteration order.
  shaped.sort((a, b) => (b.length !== a.length ? b.length - a.length : a < b ? -1 : a > b ? 1 : 0));

  return shaped.slice(0, maxTags);
}
