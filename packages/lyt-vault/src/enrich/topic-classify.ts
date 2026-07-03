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

// Phase E (0.10.0 frontmatter-contract lane) — UNIT 2: embedding topic-classify.
//
// Ranks / assigns a figment's `topic` field against the vault's EXISTING topic
// labels by SEMANTIC SIMILARITY (BGE-small dense embeddings, cosine), NOT text
// generation. This UPGRADES the C10 capture topic picker: instead of ranking
// existing topics purely by figment-count frequency (listDistinctTopics), the
// picker can surface the topic MOST SEMANTICALLY RELATED to the figment being
// captured, recommended-first.
//
// MODEL BOUNDARY (plan Phase E + Risk Register — the mandatory-gate substrate):
//   - This is the ONLY new unit that touches the optional model. It REUSES the
//     already-shipped BGE-small wiring verbatim — `loadEmbedder` (util/
//     embeddings.ts), `Embedder.embedQuery` / `embedPassages`, and `cosine`. NO
//     new model, NO new dependency, NO new fetch path: the same fastembed
//     optionalDependency + `<lyt-home>/.embeddings-cache` the search cascade uses.
//   - It MUST degrade to a BLANK topic when the model is absent. `classifyTopic`
//     takes a pre-loaded `Embedder | null`; a null embedder (the model-absent
//     case) returns `{ topic: null, ranked: [], modelUsed: false }` — never a
//     guessed topic, never a throw. The CALLER owns the load decision (and the
//     read-never-fetches guard via modelCachePresent()); this module never loads
//     the model itself, so it can never trigger a fetch.
//   - LOW-CONFIDENCE → BLANK (Risk Register: "topic blank when low-confidence").
//     A best cosine below `minConfidence` (default TOPIC_MIN_CONFIDENCE) yields
//     `topic: null` even when the model ran — a weak semantic match is NOT a
//     confident assignment; blank-and-prompt beats a wrong queryable topic (the
//     same posture as the C10 picker's "no silent modal-topic default").
//
// PURPOSE is NEVER touched here (Risk Register / IP: purpose is never auto-filled
// by any automated path). This unit only ever proposes a `topic`.
//
// DETERMINISM: BGE int8 ONNX inference is deterministic for a fixed input on a
// fixed model (util/embeddings.ts header), and cosine + the tiebreak here are
// pure — so the same (figment text, label set, embedder) yields the same
// ranking across runs. No Date.now / random on this path.

import type { Embedder } from "../util/embeddings.js";
import { cosine } from "../util/embeddings.js";

/**
 * Minimum best-cosine for a confident topic assignment. Below this, the ranked
 * list is still returned (for a picker to show as candidates) but `topic` is
 * left null (blank-when-low-confidence). BGE-small cosine of two unit vectors is
 * in [-1, 1]; loosely-related short labels land ~0.3–0.5, on-topic ~0.6+. 0.5 is
 * a conservative floor: a clear semantic match assigns, a vague one stays blank.
 */
export const TOPIC_MIN_CONFIDENCE = 0.5;

/** One existing topic label scored against the figment. */
export interface RankedTopic {
  /** The existing topic label (as authored, verbatim). */
  topic: string;
  /** Cosine similarity of the figment embedding vs this label's embedding. */
  score: number;
}

export interface ClassifyTopicResult {
  /** The recommended topic — the top-ranked label IFF its score >=
   *  minConfidence; otherwise null (blank / low-confidence / no labels / no
   *  model). NEVER a fabricated topic. */
  topic: string | null;
  /** Every candidate label, score DESC then label ASC. Empty when the model was
   *  absent or no labels were supplied. Lets a picker show ranked candidates
   *  even when no single one cleared the confidence floor. */
  ranked: RankedTopic[];
  /** True iff the embedding model actually ran (an embedder was supplied). False
   *  = degraded path (blank topic, empty ranking). */
  modelUsed: boolean;
}

export interface ClassifyTopicOptions {
  /** Confidence floor for a non-null `topic`. Default TOPIC_MIN_CONFIDENCE. */
  minConfidence?: number;
  /**
   * Phase E fix-pass (release review FIX 3 — perf) — PRE-COMPUTED label embeddings,
   * one unit vector per `existingTopics` entry, in the SAME order. The vault's
   * topic label set is RUN-CONSTANT, so a whole-vault backfill can embed the
   * labels ONCE and pass them here, embedding only the (per-figment) figment text
   * on each call — instead of re-embedding the full label set N times.
   *
   * When supplied it MUST align with `existingTopics` AFTER this function's
   * blank-drop + case-insensitive de-dupe: pass the vectors for the SAME
   * already-normalized label list you pass as `existingTopics` (see
   * `precomputeTopicLabelVectors`, which returns both together). A length
   * mismatch is treated as a shape error → degrade to blank (never mis-index).
   * Behavior is otherwise IDENTICAL to the un-precomputed path (same cosine,
   * same ordering, same floor) — this is purely fewer embeds.
   */
  labelVectors?: readonly Float32Array[];
}

/**
 * Rank the vault's existing topic labels by semantic similarity to a figment's
 * text and (when a label clears the confidence floor) recommend one.
 *
 * @param figmentText the figment's representative text — typically `title +
 *   "\n" + body`. Embedded once as a passage.
 * @param existingTopics the vault's distinct existing topic labels (e.g. from
 *   listDistinctTopics, already frequency-ranked). Blank/whitespace labels are
 *   ignored. Duplicate labels are de-duped (first occurrence wins).
 * @param embedder a LOADED embedder, or `null` when the model is absent. When
 *   null, this returns the degraded blank result WITHOUT throwing (the caller is
 *   responsible for the read-never-fetches load gate).
 * @returns `{ topic, ranked, modelUsed }`. Never throws — any embed failure
 *   degrades to the blank result (topic null, empty ranking).
 */
export async function classifyTopic(
  figmentText: string,
  existingTopics: readonly string[],
  embedder: Embedder | null,
  opts: ClassifyTopicOptions = {},
): Promise<ClassifyTopicResult> {
  const minConfidence = opts.minConfidence ?? TOPIC_MIN_CONFIDENCE;

  // Model-absent degrade — the caller passed no embedder (fastembed missing /
  // model not cached / read-path gate refused the load). Blank topic, no ranking.
  if (embedder === null) {
    return { topic: null, ranked: [], modelUsed: false };
  }

  const precomputed = opts.labelVectors;
  // Normalize + de-dupe labels (drop blanks; keep authored casing on first-seen).
  // FIX 3: when precomputed vectors are supplied we must NOT re-normalize, or the
  // labels could fall out of alignment with the caller's vector order. Instead we
  // trust the caller's already-normalized list (produced by
  // precomputeTopicLabelVectors) and only shape-check the length.
  let labels: string[];
  if (precomputed !== undefined) {
    labels = [...existingTopics].map((t) => t.trim());
  } else {
    labels = [];
    const seen = new Set<string>();
    for (const raw of existingTopics) {
      const t = raw.trim();
      if (t.length === 0) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(t);
    }
  }

  const text = figmentText.trim();
  // Nothing to rank against, or no figment text to embed → blank (but the model
  // was available, so modelUsed stays true — this is a no-signal, not a no-model,
  // case; the distinction matters to a caller deciding whether to re-offer setup).
  if (labels.length === 0 || text.length === 0) {
    return { topic: null, ranked: [], modelUsed: true };
  }

  let figmentVec: Float32Array | undefined;
  let labelVecs: Float32Array[] | readonly Float32Array[];
  try {
    if (precomputed !== undefined) {
      // FIX 3 — labels already embedded ONCE for the whole run. Embed ONLY the
      // per-figment text; reuse the precomputed label vectors verbatim.
      if (precomputed.length !== labels.length) {
        // Caller passed a mis-aligned pair → degrade rather than mis-index.
        return { topic: null, ranked: [], modelUsed: true };
      }
      const one = await embedder.embedPassages([text]);
      figmentVec = one[0];
      labelVecs = precomputed;
    } else {
      // Embed the figment as a passage and each label as a passage too, so both
      // sides use the SAME "passage: " prefix (a symmetric comparison; we are not
      // running a query→passage retrieval here, we are comparing two documents).
      // One batched embedPassages call over [figment, ...labels] keeps it to a
      // single model invocation.
      const all = await embedder.embedPassages([text, ...labels]);
      figmentVec = all[0];
      labelVecs = all.slice(1);
    }
    if (figmentVec === undefined || labelVecs.length !== labels.length) {
      // Shape mismatch (should not happen) → degrade rather than mis-index.
      return { topic: null, ranked: [], modelUsed: true };
    }
  } catch {
    // Any embed failure → blank, no ranking. Never throw on the enrichment path.
    return { topic: null, ranked: [], modelUsed: true };
  }

  const ranked: RankedTopic[] = labels.map((topic, i) => ({
    topic,
    score: cosine(figmentVec, labelVecs[i]!),
  }));
  // Deterministic ordering: score DESC, then label ASC on ties.
  ranked.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0,
  );

  const best = ranked[0]!;
  const topic = best.score >= minConfidence ? best.topic : null;
  return { topic, ranked, modelUsed: true };
}

// ---------------------------------------------------------------------------
// Phase E fix-pass (release review FIX 3 — perf) — pre-embed the vault's existing
// topic labels ONCE for a whole-vault backfill.
//
// The label set is RUN-CONSTANT (it is the vault's distinct existing topics), so
// re-embedding it on every per-figment classifyTopic call is N×L wasted embeds
// for an N-figment vault with L labels. This helper embeds the (normalized) label
// set a SINGLE time and returns the normalized `labels` alongside their aligned
// `vectors`, ready to hand straight to `classifyTopic(text, labels, embedder,
// { labelVectors: vectors })`.
//
// The normalization here (blank-drop + case-insensitive de-dupe, authored casing
// on first-seen) is BYTE-IDENTICAL to classifyTopic's own un-precomputed path, so
// the ranking is unchanged. Returns `{ labels: [], vectors: [] }` on an empty
// label set or any embed failure (the caller then simply gets the blank degrade
// from classifyTopic). Never throws — same enrichment-path contract.
// ---------------------------------------------------------------------------
export async function precomputeTopicLabelVectors(
  existingTopics: readonly string[],
  embedder: Embedder | null,
): Promise<{ labels: string[]; vectors: Float32Array[] }> {
  if (embedder === null) return { labels: [], vectors: [] };
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const raw of existingTopics) {
    const t = raw.trim();
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(t);
  }
  if (labels.length === 0) return { labels: [], vectors: [] };
  try {
    const vectors = await embedder.embedPassages(labels);
    if (vectors.length !== labels.length) return { labels: [], vectors: [] };
    return { labels, vectors };
  } catch {
    return { labels: [], vectors: [] };
  }
}
