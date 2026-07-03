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

// Phase E (0.10.0 frontmatter-contract lane) — UNIT 2 wiring: the C10 topic
// picker's SEMANTIC upgrade.
//
// The C10 capture topic picker (packages/lyt/src/commands/capture.ts) surfaces
// the vault's existing topics recommended-first. In Phase B/C10 that ranking was
// FREQUENCY only (listVaultTopicsFlow → listDistinctTopics, figmentCount DESC).
// Phase E upgrades it: when the local embedding model is present AND the caller
// supplies the figment's text, re-rank those SAME topics by semantic similarity
// to the figment (classifyTopic) so the most on-topic existing label leads.
//
// MODEL BOUNDARY (degrade-graceful, read-never-fetches):
//   - When no figment text is given, OR the model is not cached
//     (modelCachePresent() false / no memoized embedder), this returns the plain
//     FREQUENCY order verbatim (listVaultTopicsFlow) — byte-identical to C10
//     today. NO fetch is triggered (loadEmbedder is called with NO opts on the
//     read path, so fetchAllowed=false → model-absent resolves unavailable with
//     ZERO network; and we gate on modelCachePresent()/embedderMemoized() BEFORE
//     even calling it, exactly like search-cascade's dense arm).
//   - When the model runs, the semantic score only REORDERS the existing topic
//     set; it never invents a topic and never drops one (every existing topic
//     stays in the list — semantically-unrelated ones fall to the back but remain
//     selectable). `recommendedTopic` carries classifyTopic's confidence-gated
//     pick (null when below the floor).
//
// This flow is the ONLY place that turns the model on for topic ranking; it is
// invoked from the interactive picker, and its degrade path means a Codex /
// non-TTY / model-absent capture is completely unaffected.

import { listVaultTopicsFlow } from "./list-vault-topics.js";
import type { TopicCount } from "../registry/figment-meta-repo.js";
import {
  embedderMemoized,
  loadEmbedder,
  modelCachePresent,
} from "../util/embeddings.js";
import { classifyTopic } from "../enrich/topic-classify.js";

export interface RankVaultTopicsArgs {
  vaultName: string;
  /** The figment's representative text (title + body). When omitted/blank, the
   *  flow returns the plain frequency order (no model use). */
  figmentText?: string;
}

export interface RankVaultTopicsResult {
  /** The vault's existing topics, semantically re-ranked when the model ran,
   *  else frequency-ranked (recommended-first either way). */
  topics: TopicCount[];
  /** True iff the embedding model actually re-ranked the list. False = the plain
   *  frequency order was returned (no text, model absent, or embed failed). */
  semanticallyRanked: boolean;
  /** classifyTopic's confidence-gated recommendation (an existing topic that
   *  clears the similarity floor), or null. Null whenever `semanticallyRanked`
   *  is false. */
  recommendedTopic: string | null;
}

/**
 * Resolve a vault's existing topics and — when the model is present + figment
 * text is supplied — re-rank them by semantic similarity to the figment. Always
 * returns the full existing-topic set; degrades to the frequency order on the
 * model-absent / no-text / failure paths. Never throws on the enrichment path
 * (a topic lookup failure propagates from listVaultTopicsFlow as before — the
 * CLI already wraps that in a try/catch and degrades to free-text).
 */
export async function rankVaultTopicsFlow(
  args: RankVaultTopicsArgs,
): Promise<RankVaultTopicsResult> {
  const topics = await listVaultTopicsFlow({ vaultName: args.vaultName });
  const text = (args.figmentText ?? "").trim();

  // Degrade #1 — nothing to rank, or no figment text to rank against.
  if (topics.length === 0 || text.length === 0) {
    return { topics, semanticallyRanked: false, recommendedTopic: null };
  }

  // Degrade #2 — read-never-fetches gate: only touch the model when it is already
  // cached on disk OR a live embedder is memoized in-process. This mirrors the
  // search-cascade dense-arm guard exactly, so a fresh/base pod never fetches on
  // a capture. (loadEmbedder below is called with NO opts → fetchAllowed=false,
  // a second belt-and-suspenders no-network guarantee.)
  if (!modelCachePresent() && !embedderMemoized()) {
    return { topics, semanticallyRanked: false, recommendedTopic: null };
  }

  const load = await loadEmbedder();
  if (!load.available) {
    return { topics, semanticallyRanked: false, recommendedTopic: null };
  }

  const labels = topics.map((t) => t.topic);
  const result = await classifyTopic(text, labels, load.embedder);
  if (!result.modelUsed || result.ranked.length === 0) {
    // Embed failed / no-signal → keep the frequency order.
    return { topics, semanticallyRanked: false, recommendedTopic: null };
  }

  // Reorder the ORIGINAL TopicCount rows (preserving their figmentCount) by the
  // semantic ranking. Every existing topic stays present: rank order is
  // score DESC (classifyTopic already sorted), and any topic missing from the
  // ranked set (shouldn't happen) falls to the back in its frequency order.
  const orderIndex = new Map<string, number>();
  result.ranked.forEach((r, i) => orderIndex.set(r.topic, i));
  const reranked = [...topics].sort((a, b) => {
    const ia = orderIndex.get(a.topic);
    const ib = orderIndex.get(b.topic);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return 0; // both unranked → preserve incoming (frequency) order
  });

  return {
    topics: reranked,
    semanticallyRanked: true,
    recommendedTopic: result.topic,
  };
}
