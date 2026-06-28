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

// v1.D.3a — `lyt search` cascade engine.
//
// 4-tier waterfall per master-plan §v1.D.3:787-792 + SAI synmapper
// inspiration (`sai-core/src/cortex/synmapper.ts:48`):
//
// Tier 0 arc-membership confidence 0.95
// Tier 1 lane-membership confidence 0.90
// Tier 2 FTS5 raw-count hit confidence 0.70
// Tier 3 edge-traversal 1hop confidence 0.50
//
// Gather-all-then-rank (Lane V fix-pass): within each in-scope vault every
// tier gathers up to a PER-TIER budget of `gatherCap = K·limit` candidates
// INDEPENDENTLY (tier-2 is never gated on tier-0/1's fill), THEN the soft-tier
// blend ranks the gathered union and truncates to `limit`. This replaces the
// old per-tier early-return (stop once `results.length >= limit`), which let a
// tier-0/1 flood starve the tier-2 body hits the blend must promote — the V-F5
// relevance inversion at scale. The global cap is enforced at the VAULT-loop
// boundary (bounding federation breadth / latency), not between tiers within a
// vault — a single global running budget consumed in tier order would re-open
// the very starvation it claims to fix (release review C1).
//
// Scope semantics:
// vault — single vault from registry (skip Tier 3 entirely —
// single-vault search has no edges to traverse)
// mesh — union of home_mesh_rid + mesh_vaults entries for
// the mesh, deduplicated by vault_rid (default)
// federation — every registered vault, ordered by name ASC
// (default scope per master-plan §v1.D.3:786)
//
// Tier 2 scoring (interpretation): we use FTS5 BM25 `rank`
// ordering inside `searchFts` (lower rank = better match; BM25 IS a
// hit-count-derived score, NOT a Jaccard set-similarity coefficient,
// so this satisfies §v1.D.3:782 "raw hit count, not Jaccard"). The
// cascade emits confidence=0.7 uniform within tier-2; the BM25 strength
// (`rawScore`) feeds the Lane V soft-tier blend + within-tier tiebreak
// rather than being discarded at the final sort.
//
// Tier 3 dedupe: a `seenFigment` set keyed by `${vaultName}::${path}`
// ensures a figment surfaced at a higher tier is never re-emitted at
// tier 3. At federation scope, every vault is searched directly at
// tiers 0-2 so tier 3 is effectively a no-op (all neighbors already
// surfaced); at mesh scope, tier 3 reaches OUT-OF-MESH related
// vaults; at vault scope, tier 3 is skipped per spec.
//
// Open-once seam (v1.A.5 CR-B1 + v1.D.1 + v1.D.2a vindication):
// optional `registryDb?: Client` — caller threads the registry
// client through, the engine opens + closes per-vault lyt.db handles
// inside the flow (default = per-vault open+close; connection
// pool deferred to v1.D.3d).
//
// Output (Lock 0.3 deterministic): SearchResult[] sorted by
// `(blendedScore DESC, tier ASC, rawScore DESC, vault_name ASC,
// figment_path ASC)`, truncated to `limit`. blendedScore derives
// deterministically from the index, so the same query against the same
// vault set → byte-identical JSON.

import { readFileSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";

import type { Client } from "@libsql/client";

import { isIndexable, walkVaultMarkdownFiles } from "../util/indexable.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { readIndexWatermark, writeIndexWatermark } from "../util/index-watermark.js";
import { readFrozenLock } from "../util/freeze-check.js";
import { rebuildVaultFlow } from "./rebuild-vault.js";
import { closeVaultDb, openLytDbActionable } from "../registry/vault-db.js";
import { getMeshByName, type MeshRow } from "../registry/meshes-repo.js";
import { listVaultsInMesh } from "../registry/mesh-vaults-repo.js";
import { listSubscriptionsForMesh } from "../registry/mesh-subscriptions-repo.js";
import {
  getVaultByName,
  getVaultByRid,
  listMeshEdgesByHomeVault,
  listMeshEdgesByRefVault,
  listVaults,
  type VaultRow,
} from "../registry/repo.js";
import { listArcs, listMembersByArc } from "../registry/arcs-repo.js";
import { listLanes, listMembersByLane } from "../registry/lanes-repo.js";
import { searchFts } from "../registry/fts-repo.js";
import { loadAllKeyphrases } from "../registry/keyphrases-repo.js";
import { keyphraseMatch, queryKeyphraseTokens } from "../util/keyphrase-extract.js";
import { loadAllEmbeddings } from "../registry/embeddings-repo.js";
import { cosine, loadEmbedder } from "../util/embeddings.js";
import { embeddingsEnabled } from "../util/config.js";

// Public confidence constants exposed for tests + future
// downstream consumers (e.g. primer-generator may want to weight
// search hits by tier; the source of truth is here, not duplicated
// in caller code).
export const SEARCH_CONFIDENCE_TIER_0 = 0.95;
export const SEARCH_CONFIDENCE_TIER_1 = 0.9;
export const SEARCH_CONFIDENCE_TIER_2 = 0.7;
export const SEARCH_CONFIDENCE_TIER_3 = 0.5;

const TIER_0 = 0;
const TIER_1 = 1;
const TIER_2 = 2;
const TIER_3 = 3;

const SNIPPET_LEN = 96;

// Lane V fix-pass (X1 soft-tier blend): blendedScore = confidence +
// SOFT_TIER_ALPHA·(rawScore / maxRaw). α caps the BM25 boost so a max-strength
// tier-2 body hit reaches ~tier-0 level (0.70 + 0.25 = 0.95) and can overtake a
// weak tier-1 tag-only hit (0.90) — fixing the V-F5 relevance inversion — while
// a tier-0 arc hit keeps primacy on the resulting tie (tier tiebreak). Selected
// empirically (Lane V Phase 1, ; the disciplined α-sweep confirmed 0.25 as
// the unique in-sample peak — held-out ≥ in-sample, no overfit).
//
// COUPLED INVARIANT (release review): the V-F5 fix only holds while
// α ≥ SEARCH_CONFIDENCE_TIER_1 − SEARCH_CONFIDENCE_TIER_2 (= 0.90 − 0.70 = 0.20),
// i.e. a max body hit must out-blend a tag-only hit. If the confidence
// constants change, α MUST move with them or a strong body hit silently stops
// overtaking a tag hit. Keep α and the tier-confidence gap in sync.
const SOFT_TIER_ALPHA = 0.25;

// Gather-all-then-rank cap (K): collect up to K·limit candidates across tiers
// and in-scope vaults before blending → ranking → truncating to `limit`. Bounds
// latency while preventing tier-0/1 volume from starving the tier-2 body hits
// the blend must promote (the per-tier early-return that caused V-F5 at scale).
// K=8 is the measured-start value (Lane V fix-pass decision); step down if p95
// over the ≥5k synthetic corpus exceeds budget.
const GATHER_CAP_FACTOR = 8;

// feat/keyphrase-boost — keyphrase-match rerank coefficient (β). After the
// soft-tier blend and BEFORE the final sort, each result gets
// blendedScore += KEYPHRASE_BETA · keyphraseMatch(queryTokens, docKeyphrases),
// where keyphraseMatch counts query content-tokens present in the doc's stored
// top-K keyphrase set (built deterministically at reindex time — see
// flows/rebuild-keyphrases.ts + util/keyphrase-extract.ts).
//
// β=0.2 is the PROVEN value: the .scratch/keyphrase-eval.mts prototype measured
// this exact post-hoc boost lifting the A2 oracle nDCG@5 0.296→0.452 (+53%, zero
// regressions). The boost is ADDITIVE on top of the soft-tier blend (it does not
// renormalize), matching the prototype's `blended + β·kpMatch` semantics exactly.
// A query/doc with zero keyphrase overlap gets +0 → arc/lane-only and no-overlap
// results are unaffected (the boost only promotes docs whose aboutness terms the
// query actually hits). The deeper gatherCap (8×limit) means buried target docs
// are in-set, so the production boost reproduces (or exceeds) the prototype's
// limit:30 gather lift.
export const KEYPHRASE_BETA = 0.2;

// feat/microrag-semantic — OPTIONAL dense-retrieval fusion constants. After the
// lexical cascade produces its blended-scored ranked list AND (when semantic is
// enabled + vectors are present) a dense cosine-ranked list, we fuse them with
// the PROVEN confidence-gated rank-preserve rule (.scratch/microrag-eval.mts:
// adaptRankpres-1.05-0.95 — the unique clean net win: oracle nDCG@5 0.437→0.60,
// hit-rate 11/18→15/18, ZERO regression on the protected lexical holds).
//
// The rule, keyed on the lexical TOP hit's blendedScore:
//   >= FUSION_BLEND_HI (1.05)  → keep lexical TOP-3 fixed at their ranks
//   >= FUSION_BLEND_MID (0.95) → keep lexical TOP-2 fixed
//   else                       → keepN = 0 (dense leads; full rank-preserve fill)
// then fill remaining slots from dense (docs lexical didn't surface), then any
// remaining lexical. This is the adaptive band; the threshold-free fallback
// (plain keep-3, measured clean at 0.542) is FUSION_KEEP_N_FALLBACK below.
//
// SINGLE TUNABLE SEAM (audit-coupled-constant): these three constants are the
// ONLY fusion knobs; the bench threads overrides via SearchCascadeArgs.fusion*
// without a rebuild. Keep them here, not duplicated at call-sites.
export const FUSION_BLEND_HI = 1.05;
export const FUSION_BLEND_MID = 0.95;
// Threshold-free fallback keepN (used only if FUSION_ADAPTIVE is false) —
// proven clean at 0.542. Structured as a seam per the brief.
export const FUSION_KEEP_N_FALLBACK = 3;
// Primary = the adaptive band (the 0.60 winner). Flip to false to use the
// threshold-free plain keep-3 fallback.
export const FUSION_ADAPTIVE = true;

// B1 — per-vault search fan-out concurrency cap. The vault loop runs each
// vault's Tier 0/1/2 work CONCURRENTLY (each vault opens its own lyt.db, so the
// opens overlap instead of stacking the ~440ms single-vault floor serially),
// but bounded so an arbitrarily large federation can't open thousands of DB
// handles at once. Cap 8 mirrors GATHER_CAP_FACTOR's measured-start posture;
// step down if file-handle / memory pressure shows up at federation scale.
//
// Determinism note: concurrency only changes the ORDER vaults FINISH, never the
// final result set. Each vault gathers into its OWN buffer + OWN local `seen`
// (dedup key is `${vaultName}::${path}`, so cross-vault collision is
// impossible); buffers are then merged in deterministic `targetVaults` order
// and `gatherCap` is applied AFTER the merge — so the capped result set and its
// order are identical to the old sequential path (V-F5 + Lock 0.3 preserved).
const VAULT_FANOUT_CONCURRENCY = 8;

export type SearchCascadeScope = "vault" | "mesh" | "federation";

export interface SearchResult {
  figment_path: string;
  vault_name: string;
  mesh_name: string | null;
  snippet: string;
  confidence: number;
  tier: number;
  // Lane V fix-pass (A1 within-tier ordering): abs(FTS5 BM25 rank) for tier-2/3
  // hits — higher = stronger match. Undefined for tier-0/1 (arc/lane membership
  // carries no BM25 signal → treated as 0 in the blend + tiebreak). Deterministic
  // from the index.
  rawScore?: number;
  // Lane V fix-pass (X1 soft-tier blend): confidence + α·(rawScore / maxRaw),
  // computed once after the gather (needs the global max). The PRIMARY sort key
  // — lets a strong tier-2 body hit overtake a weak tier-0/1 tag-only hit (V-F5).
  // Deterministic (maxRaw derives from the index).
  blendedScore?: number;
  // feat/keyphrase-boost — count of query content-tokens present in THIS doc's
  // stored keyphrase set (0 when none / cache absent). Computed per-vault during
  // the gather (the keyphrase cache is per-vault), folded into blendedScore as
  // +β·kpMatch before the final sort. Deterministic from the index. Internal —
  // not part of the public result contract.
  kpMatch?: number;
}

export interface SearchTrace {
  tiersRun: readonly number[];
  perTierHitCount: readonly number[];
  vaultsSearched: readonly string[];
  // V-C-1 Phase C (L3) — present ONLY when the empty-result self-heal fired:
  // an empty search detected stale (un-indexed) in-scope vault(s), reindexed
  // them, and re-queried before reporting. Absent on every normal search, so
  // the deterministic Lock 0.3 output of a healthy pod is byte-unchanged.
  selfHealed?: { reindexedVaults: readonly string[] };
  // feat/microrag-semantic — present + true ONLY when the dense-retrieval fusion
  // actually ran (semantic requested + enabled + vectors present + model
  // loaded). Absent on every lexical-only search, so the deterministic Lock 0.3
  // output of a base pod (and any semantic:false call) is byte-unchanged.
  semanticFused?: boolean;
}

export interface SearchCascadeArgs {
  query: string;
  scope?: SearchCascadeScope;
  scopeTarget?: string;
  limit?: number;
  // feat/agent-query-expansion — OPTIONAL agent-supplied query-expansion terms
  // (6–10 domain/synonym tokens a relevant note might use but the literal query
  // omits). They are folded into the KEYWORD/BM25 channel ONLY: the effective
  // FTS5 (tier-2/tier-3) MATCH text + the keyphrase-boost tokens are built from
  // `query` PLUS these terms, manufacturing the rare high-IDF tokens that build
  // the missing lexical handle so a buried target surfaces. Tiers 0/1
  // (arc/lane substring match) and `result.query` keep the ORIGINAL query
  // untouched. When empty/absent the effective FTS text === `query`, so the
  // deterministic Lock 0.3 output is byte-identical to today (every existing
  // test that doesn't pass expansionTerms is unaffected). Purely lexical — no
  // embeddings, no new index.
  expansionTerms?: readonly string[];
  // Open-once seam (v1.A.5 CR-B1).
  registryDb?: Client;
  // Lane V fix-pass — soft-tier blend coefficient (tuning seam). Defaults to
  // SOFT_TIER_ALPHA; threaded so the bench / α-sweep can probe alternative
  // values without a rebuild. Internal — NOT exposed as a CLI flag.
  softTierAlpha?: number;
  // feat/keyphrase-boost — keyphrase-match rerank coefficient (β). Defaults to
  // KEYPHRASE_BETA (0.2, the proven value); threaded so the bench / β-sweep can
  // probe alternatives without a rebuild. Internal — NOT a CLI flag.
  keyphraseBeta?: number;
  // feat/microrag-semantic + dense-retrieval fusion. DEFAULT-ON when
  // UNSPECIFIED: the flow resolves the default as `semantic ?? embeddingsEnabled()`,
  // so an omitted flag (the MCP `search` tool) inherits the pod's embeddings
  // posture. When active AND the embeddings arm is enabled (config/env,
  // default-ON) AND vectors are present AND the local model loads, the cascade
  // embeds the query, cosine-ranks the docs, and fuses dense into the lexical
  // ranking via the proven confidence-gated rule. When ANY precondition fails
  // (model absent, no vectors, fetch fails) it falls back to the lexical
  // ranking with NO error — the result is byte-identical to semantic:false
  // (ARC-D2). Set `semantic:false` (the `lyt search --no-semantic` opt-out) to
  // force the pure lexical cascade.
  semantic?: boolean;
  // Fusion tuning seams (bench / sweep) — default to the proven constants.
  fusionBlendHi?: number;
  fusionBlendMid?: number;
  // V-C-1 Phase C (L3) — empty-result self-heal. DEFAULT FALSE: the flow stays
  // deterministic for the Lane V retrieval harness, the latency bench, and every
  // test that calls it directly (they never set this). The `lyt search` CLI
  // turns it ON only for human runs (NOT under --json / --no-self-heal). When
  // true AND the search returns 0 results, any in-scope vault whose newest
  // figment-file mtime is past its index watermark (a non-Lyt write the L1/L2
  // paths can't catch) is reindexed once, then the query is re-run before
  // reporting "no matches".
  selfHeal?: boolean;
}

export interface SearchCascadeResult {
  query: string;
  scope: SearchCascadeScope;
  scopeTarget: string | null;
  limit: number;
  results: SearchResult[];
  trace: SearchTrace;
  durationMs: number;
}

export async function searchCascadeFlow(args: SearchCascadeArgs): Promise<SearchCascadeResult> {
  const startedAt = Date.now();
  const query = (args.query ?? "").trim();
  // feat/agent-query-expansion — the effective KEYWORD/BM25 query text: the
  // original query PLUS any agent-supplied expansion terms, space-joined. This
  // (NOT `query`) feeds tier-2/tier-3 FTS5 and the keyphrase-boost tokens, so
  // the rare high-IDF expansion tokens enter the lexical channel. Tiers 0/1 and
  // `result.query` keep the ORIGINAL `query`. When no usable term is supplied
  // `ftsQuery === query` EXACTLY (same string identity-by-value), so the
  // deterministic Lock 0.3 output is byte-identical to today. Terms are trimmed
  // and blanks dropped; an all-blank array collapses to `query`.
  const expansionTerms = (args.expansionTerms ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const ftsQuery = expansionTerms.length > 0 ? `${query} ${expansionTerms.join(" ")}` : query;
  const limit = Math.max(1, Math.floor(args.limit ?? 20));
  const scope: SearchCascadeScope = args.scope ?? "federation";
  // Lane V fix-pass — gather-all-then-rank. Collect candidates across ALL tiers
  // (and in-scope vaults) up to `gatherCap`, THEN blend → sort → truncate to
  // `limit`. The cap removes the per-tier early-return that let a tier-0/1 flood
  // starve the tier-2 body hits the soft-tier blend must promote (V-F5 at
  // scale). On small corpora (matches << gatherCap) every tier runs, so the
  // blend sees the full candidate set.
  const gatherCap = limit * GATHER_CAP_FACTOR;
  const softTierAlpha = args.softTierAlpha ?? SOFT_TIER_ALPHA;
  // feat/keyphrase-boost — tokenize the query ONCE with the SAME tokenizer the
  // keyphrase index used, so a query token can only match a stored keyphrase
  // token when they tokenize identically. Empty for an all-stopword query → the
  // boost is a no-op (matches nothing), so such queries rank exactly as before.
  // feat/agent-query-expansion — keyphrase-boost tokens come from the EFFECTIVE
  // query (original + expansion), so expansion terms can also light up a doc's
  // stored keyphrase set. When no expansion is supplied `ftsQuery === query`, so
  // this is identical to the prior `queryKeyphraseTokens(query)`.
  const keyphraseQueryTokens = queryKeyphraseTokens(ftsQuery);
  const keyphraseBeta = args.keyphraseBeta ?? KEYPHRASE_BETA;

  // feat/microrag-semantic + is the dense arm requested AND globally
  // enabled? The semantic DEFAULT now lives HERE (in the flow), not at the CLI
  // call-site: `semantic ?? embeddingsEnabled()`. So an UNSPECIFIED `semantic`
  // (the MCP `search` tool, which never passes it) inherits the pod's embeddings
  // posture by default — CLI and agent paths are now consistent (both get
  // semantic-by-default when embeddings are on). An EXPLICIT `semantic:false`
  // (the CLI `--no-semantic` opt-out, or any test) still forces it OFF; an
  // explicit `semantic:true` still forces it ON. The pod-level embeddings toggle
  // (config/env, default-ON) is the second gate either way. Even when active,
  // the arm degrades to a clean lexical fallback if the model can't load or no
  // vectors exist (handled after the lexical sort) — byte-identical to
  // semantic:false (ARC-D2 preserved). Collecting vectors only when active keeps
  // the base path's per-vault work byte-unchanged.
  // fix-pass — simplified from `(args.semantic ?? embeddingsEnabled()) &&
  // embeddingsEnabled()`: when `semantic` is unspecified the default IS the
  // pod's embeddings posture, so `?? true` then re-AND with embeddingsEnabled()
  // is equivalent and calls the resolver once. Explicit true/false still wins
  // the `??`; the embeddingsEnabled() gate is the final authority either way.
  const semanticActive = (args.semantic ?? true) && embeddingsEnabled();
  const fusionBlendHi = args.fusionBlendHi ?? FUSION_BLEND_HI;
  const fusionBlendMid = args.fusionBlendMid ?? FUSION_BLEND_MID;
  // Accumulated pod-wide doc vectors, filled per-vault during the gather ONLY
  // when semanticActive. Keyed by `${vaultName}::${path}` (the cascade dedup +
  // SearchResult identity). We keep the per-doc metadata (vault/mesh/path) so a
  // dense-ONLY hit (a doc the lexical cascade never gathered, e.g. a semantic
  // match with no lexical overlap — the prototype's recall recovery) can be
  // MATERIALIZED into a SearchResult during fusion. This is the load-bearing
  // detail: dense retrieval ranks over the WHOLE in-scope corpus, not just the
  // lexical gather, so it can pull in docs lexical missed (Q14/Q15-class).
  interface DenseDoc {
    key: string;
    figmentPath: string;
    vaultName: string;
    meshName: string | null;
    vector: Float32Array;
  }
  const denseDocs: DenseDoc[] = [];

  if (query.length === 0) {
    return {
      query: "",
      scope,
      scopeTarget: args.scopeTarget ?? null,
      limit,
      results: [],
      trace: {
        tiersRun: [],
        perTierHitCount: [],
        vaultsSearched: [],
      },
      durationMs: Date.now() - startedAt,
    };
  }

  const callerSuppliedRegistry = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());

  // Track per-tier hit counts across all vaults for trace.
  const perTierHits = [0, 0, 0, 0];
  const tiersRunSet = new Set<number>();
  // Dedupe set — keyed by `${vaultName}::${figmentPath}` so the
  // same figment can't surface twice via different tiers.
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  const vaultsSearched: string[] = [];
  // V-C-1 Phase C (L3) — captured for the empty-result self-heal AFTER the
  // registry has closed (the heal walks the FS + reindexes; it does not need
  // the cascade's open registry handle).
  let healTargets: readonly VaultRow[] = [];

  try {
    const targetVaults = await resolveScopeVaults(registryDb, scope, args.scopeTarget);
    healTargets = targetVaults;
    // mesh-name lookup keyed by vault_rid hex for output enrichment.
    const meshNameByVaultHex = await resolveMeshNamesForVaults(registryDb, targetVaults);

    // searchedVaultHexes tracks which vaults have already had their
    // lytDb opened in this cascade — used by Tier 3 to avoid
    // re-searching a vault that the primary loop already covered.
    const searchedVaultHexes = new Set<string>(targetVaults.map((v) => v.ridHex));
    // Tier-3 candidate set: { vaultRow, query }. Built across the
    // primary vault loop; flushed after the loop completes.
    const tier3Candidates: VaultRow[] = [];

    // B1 — parallel per-vault gather (bounded). Each vault's Tier 0/1/2 work runs
    // CONCURRENTLY (its own lyt.db handle, its own LOCAL `seen` set + LOCAL hit
    // buffer — the dedup key `${vaultName}::${path}` makes cross-vault collision
    // impossible, so per-vault `seen` is safe). We gather every in-scope vault's
    // buffer, THEN merge in deterministic `targetVaults` order and apply
    // `gatherCap` AFTER the merge. This keeps the capped result set + order
    // byte-identical to the old sequential path (the early-break was a latency
    // optimization, not a semantic boundary; gather-then-cap is a superset
    // truncated identically) while overlapping the per-vault open cost. V-F5
    // (per-tier independent budget within a vault) is preserved — each tier below
    // still gets `gatherCap` independently, tier-2 never gated on tier-0/1.
    interface VaultGather {
      name: string;
      hits: SearchResult[];
      perTier: [number, number, number];
      neighbors: VaultRow[];
    }

    const gatherOneVault = async (vault: VaultRow): Promise<VaultGather> => {
      const meshName = meshNameByVaultHex.get(vault.ridHex) ?? null;
      // Per-vault LOCAL dedup set — never shared across the concurrent vaults
      // (would race), and safe because the key embeds the vault name.
      const localSeen = new Set<string>();
      const hits: SearchResult[] = [];
      const perTier: [number, number, number] = [0, 0, 0];

      // a corrupt lyt.db surfaces as CorruptLytDbError (remedy: `lyt
      // reindex`), never as a raw SQLITE_NOTADB/SQLITE_CORRUPT — the corrupt-
      // open path predated the stale self-heal wiring below and died raw.
      const lytDb = await openLytDbActionable(vault.path, vault.name);
      try {
        // Each tier gathers up to a per-tier budget (gatherCap) INDEPENDENTLY
        // within this vault — tier-2 is NEVER gated on how much tier-0/1 already
        // collected. A single shared running budget consumed in tier order would
        // let a tier-0/1 flood (a popular arc/lane) fill the cap before tier-2
        // runs, starving the body hits the soft-tier blend exists to promote and
        // re-opening V-F5 at scale (release review C1). The blend ranks the gathered
        // union afterward; the global cap is enforced at the merge boundary
        // (and the final slice), not between tiers within a vault.
        // --- Tier 0: arc-membership -----------------------------
        const arcHits = await runTier0Arcs({
          lytDb,
          query,
          vault,
          meshName,
          seen: localSeen,
          remaining: gatherCap,
        });
        for (const hit of arcHits) hits.push(hit);
        perTier[TIER_0] += arcHits.length;
        // --- Tier 1: lane-membership ----------------------------
        const laneHits = await runTier1Lanes({
          lytDb,
          query,
          vault,
          meshName,
          seen: localSeen,
          remaining: gatherCap,
        });
        for (const hit of laneHits) hits.push(hit);
        perTier[TIER_1] += laneHits.length;
        // --- Tier 2: FTS5 raw-count (ALWAYS runs — never tier-0/1-starved) ---
        // feat/agent-query-expansion — tier-2 BM25 is the channel that consumes
        // expansion: it MATCHes against `ftsQuery` (original + expansion terms),
        // not the bare `query`. Tiers 0/1 above keep `query` (their arc/lane
        // substring match would break on a multi-term blob).
        const ftsHits = await runTier2Fts({
          lytDb,
          query: ftsQuery,
          vault,
          meshName,
          seen: localSeen,
          remaining: gatherCap,
        });
        for (const hit of ftsHits) hits.push(hit);
        perTier[TIER_2] += ftsHits.length;

        // feat/keyphrase-boost — attach the per-doc keyphrase-match count to
        // every gathered hit from THIS vault. The keyphrase cache is per-vault
        // (lyt.db), so we load it once here (one query) and look up each hit's
        // path. kpMatch counts query content-tokens present in the doc's stored
        // top-K keyphrase set; it's folded into blendedScore as +β·kpMatch AFTER
        // the soft-tier blend, before the final sort. A vault with no keyphrase
        // cache (older pod not yet reindexed) yields an empty map → kpMatch=0 →
        // the boost is a no-op there (graceful degradation, not an error).
        if (keyphraseQueryTokens.length > 0) {
          const kpByPath = await loadAllKeyphrases(lytDb);
          for (const hit of hits) {
            const kp = kpByPath.get(hit.figment_path);
            hit.kpMatch = kp === undefined ? 0 : keyphraseMatch(keyphraseQueryTokens, kp);
          }
        }

        // feat/microrag-semantic — when the dense arm is active, load THIS
        // vault's full embedding cache (one query, while its lyt.db is open) and
        // stash every vector keyed by `${vaultName}::${path}`. A vault with no
        // embeddings cache (base pod / never built) yields an empty array →
        // contributes nothing → the fusion sees fewer dense candidates but never
        // errors (graceful degradation). The dense ranking + fusion runs AFTER
        // the gather (needs the query vector + the lexical ranking).
        if (semanticActive) {
          const rows = await loadAllEmbeddings(lytDb);
          for (const r of rows) {
            denseDocs.push({
              key: `${vault.name}::${r.figmentRid}`,
              figmentPath: r.figmentRid,
              vaultName: vault.name,
              meshName,
              vector: r.vector,
            });
          }
        }
      } finally {
        // B2 — every handle closed on ALL paths (success + error), preserving the
        // try/finally guarantee the old per-iteration block held.
        await closeVaultDb(lytDb);
      }

      // Tier 3 neighbor resolution reads the SHARED registry (not the per-vault
      // lyt.db) and mutates `searchedVaultHexes` — race-prone under concurrency.
      // So we only COLLECT raw neighbor candidates here (read-only registry
      // queries are safe to run concurrently) and dedupe + queue them
      // sequentially AFTER the gather, in deterministic order.
      let neighbors: VaultRow[] = [];
      if (scope !== "vault") {
        neighbors = await resolveTier3Neighbors(registryDb, vault, searchedVaultHexes);
      }
      return { name: vault.name, hits, perTier, neighbors };
    };

    // Bounded-concurrency map: at most VAULT_FANOUT_CONCURRENCY vaults open at
    // once. Results land back in `targetVaults` index order (NOT completion
    // order) so the downstream merge is deterministic.
    const gathered = await mapWithConcurrency(
      targetVaults,
      VAULT_FANOUT_CONCURRENCY,
      gatherOneVault,
    );

    // --- Deterministic merge in targetVaults order, then apply gatherCap ------
    // Tiers 0/1/2 always RAN for every vault (gather), so mark them once any
    // vault was searched — matching the old loop's tier-run trace.
    if (targetVaults.length > 0) {
      tiersRunSet.add(TIER_0);
      tiersRunSet.add(TIER_1);
      tiersRunSet.add(TIER_2);
    }
    for (const g of gathered) {
      // The old sequential loop applied `gatherCap` ONLY at the vault boundary
      // (`if (results.length >= gatherCap) break` before opening the next
      // vault) — never mid-vault. A single vault therefore pushed its FULL
      // tier-0+1+2 buffer (which can exceed gatherCap; each tier is
      // independently capped at gatherCap, so a flooded lane + a body hit both
      // land) and the blend ranked the union afterward. Replicate exactly:
      // stop CONSUMING further vaults once the cap is met, but never truncate a
      // vault's buffer mid-stream (that would drop the tier-2 body hit a flooded
      // tier-1 lane pushed past the cap — re-opening V-F5 / the C1 starvation).
      if (results.length >= gatherCap) {
        // Already at cap from prior vaults — this and later vaults' Tier 0/1/2
        // still RAN (gather is unconditional for the trace + V-F5), but their
        // hits are not merged. Tier-3 neighbors are likewise not queued (the old
        // loop gated neighbor collection on `results.length < gatherCap`).
        continue;
      }
      vaultsSearched.push(g.name);
      perTierHits[TIER_0]! += g.perTier[TIER_0];
      perTierHits[TIER_1]! += g.perTier[TIER_1];
      perTierHits[TIER_2]! += g.perTier[TIER_2];
      for (const hit of g.hits) results.push(hit);
      // Queue this vault's Tier-3 neighbor candidates (skip at scope=vault).
      // Dedupe against searchedVaultHexes SEQUENTIALLY here so the same neighbor
      // reached via two vaults is queued once, in deterministic order.
      if (scope !== "vault") {
        for (const n of g.neighbors) {
          if (searchedVaultHexes.has(n.ridHex)) continue;
          searchedVaultHexes.add(n.ridHex);
          tier3Candidates.push(n);
        }
      }
    }

    // Seed the shared `seen` set from the merged primary results so Tier 3
    // never re-emits a figment already surfaced at a higher tier. (The primary
    // gather used per-vault LOCAL `seen` sets for race-free concurrency; this
    // reconstitutes the single dedup view Tier 3 expects — keyed identically by
    // `${vaultName}::${path}`.)
    for (const r of results) seen.add(`${r.vault_name}::${r.figment_path}`);

    // --- Tier 3 flush (after every primary vault searched) ------
    if (scope !== "vault" && tier3Candidates.length > 0 && results.length < gatherCap) {
      tiersRunSet.add(TIER_3);
      // Deterministic order across neighbor vaults.
      tier3Candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const neighbor of tier3Candidates) {
        if (results.length >= gatherCap) break;
        vaultsSearched.push(neighbor.name);
        const meshName = meshNameByVaultHex.get(neighbor.ridHex) ?? null;
        const lytDb = await openLytDbActionable(neighbor.path, neighbor.name);
        try {
          const ftsHits = await runTier3EdgeFts({
            lytDb,
            // feat/agent-query-expansion — tier-3 is also a BM25/FTS channel, so
            // it consumes the expanded `ftsQuery` (== `query` when no expansion).
            query: ftsQuery,
            vault: neighbor,
            meshName,
            seen,
            remaining: gatherCap - results.length,
          });
          // feat/keyphrase-boost — same per-doc keyphrase attachment for tier-3
          // neighbor hits (their keyphrase cache lives in the neighbor's lyt.db,
          // already open here). At federation scope tier-3 is a no-op so this
          // rarely runs; at mesh scope it keeps out-of-mesh hits boostable too.
          if (keyphraseQueryTokens.length > 0 && ftsHits.length > 0) {
            const kpByPath = await loadAllKeyphrases(lytDb);
            for (const hit of ftsHits) {
              const kp = kpByPath.get(hit.figment_path);
              hit.kpMatch = kp === undefined ? 0 : keyphraseMatch(keyphraseQueryTokens, kp);
            }
          }
          for (const hit of ftsHits) results.push(hit);
          perTierHits[TIER_3]! += ftsHits.length;
        } finally {
          await closeVaultDb(lytDb);
        }
      }
    }
  } finally {
    if (!callerSuppliedRegistry) await closeRegistry(registryDb);
  }

  // --- Soft-tier blend (X1): tier = boost, not gate ------------------
  // blendedScore = confidence + α·(rawScore / maxRaw), min-max normalized
  // (min=0) over the gathered set. A strong tier-2 body hit (max BM25) reaches
  // ~tier-0 level and can overtake a weak tier-0/1 tag-only hit, fixing the V-F5
  // relevance inversion. α caps the boost so a tier-0 arc hit keeps primacy on
  // the resulting tie (tier tiebreak). Deterministic: maxRaw derives from the
  // index. maxRaw==0 (no BM25 hits) → blendedScore == confidence, so arc/lane-
  // only queries are unaffected.
  const maxRaw = results.reduce((m, r) => Math.max(m, r.rawScore ?? 0), 0);
  for (const r of results) {
    const norm = maxRaw > 0 ? (r.rawScore ?? 0) / maxRaw : 0;
    // feat/keyphrase-boost — ADDITIVE keyphrase-match boost on top of the
    // soft-tier blend, exactly matching the proven prototype's
    // `blended + β·kpMatch` semantics (β=0.2 → +53% oracle nDCG@5, zero
    // regressions). kpMatch (set during the per-vault gather) is the count of
    // query content-tokens present in this doc's stored top-K keyphrase set; a
    // doc the query doesn't hit gets +0, so arc/lane-only and no-overlap results
    // are unchanged. Deterministic: kpMatch derives from the index. This raises
    // the PRIMARY sort key (blendedScore), so a buried body hit whose aboutness
    // matches the query can overtake a higher-FTS doc that doesn't (the lift).
    r.blendedScore = r.confidence + softTierAlpha * norm + keyphraseBeta * (r.kpMatch ?? 0);
  }

  // Final deterministic sort per Lock 0.3 — this is the LEXICAL ranked list.
  results.sort(compareSearchResult);

  // feat/microrag-semantic — OPTIONAL dense-retrieval fusion. When the dense arm
  // is active AND vectors were gathered AND the local model loads (so we can
  // embed the query), reorder `results` by fusing the dense cosine ranking into
  // the lexical ranking via the proven confidence-gated rank-preserve rule. ANY
  // miss (model unavailable, zero vectors gathered, embed throws) leaves the
  // lexical order UNTOUCHED → byte-identical to semantic:false. The
  // fusion is pure reordering over the already-gathered candidates (no new DB
  // reads), so it cannot starve or change the candidate SET — only its order.
  let semanticFused = false;
  if (semanticActive && denseDocs.length > 0 && results.length > 0) {
    try {
      const load = await loadEmbedder();
      if (load.available) {
        const qVec = await load.embedder.embedQuery(query);
        const fusedOrder = fuseDense(
          results,
          qVec,
          denseDocs,
          fusionBlendHi,
          fusionBlendMid,
          SNIPPET_LEN,
        );
        // Replace the results array contents in fused order (preserves lexical
        // object identities; dense-only docs are freshly materialized).
        results.length = 0;
        for (const r of fusedOrder) results.push(r);
        semanticFused = true;
      }
    } catch {
      // Any failure → keep the lexical order (results is still sorted). No throw.
      semanticFused = false;
    }
  }

  // Truncate to the caller's limit.
  const truncated = results.slice(0, limit);

  // --- V-C-1 Phase C (L3): empty-result self-heal ---------------------------
  // Opt-in (args.selfHeal) so the harness/bench/direct-callers stay byte-
  // deterministic. Fires ONLY on an empty result: if any in-scope vault has
  // content NEWER than its index watermark — a non-Lyt write (Obsidian edit,
  // git pull, manual drop) that L1/L2 can't catch — reindex those vault(s)
  // ONCE, then re-run the query (selfHeal:false → no recursion) before
  // reporting "no matches". An empty+fresh pod reports honestly (no heal).
  if (args.selfHeal === true && truncated.length === 0) {
    // actively-frozen vaults are excluded from the stale-heal target
    // set — rebuildVaultFlow now REFUSES frozen (the F13 chokepoint), and a
    // read verb must degrade gracefully on a frozen vault, not die on the
    // heal. An EXPIRED freeze stays healable (enforceNotFrozen auto-unfreezes).
    const stale = healTargets.filter((v) => {
      if (v.status === "tombstoned") return false;
      const fz = readFrozenLock(v.path);
      if (fz.frozen && !fz.expired) return false;
      return isVaultStale(v.path);
    });
    if (stale.length > 0) {
      const reindexedVaults: string[] = [];
      for (const v of stale) {
        try {
          await rebuildVaultFlow({
            vault: v.name,
            // C-1 — the self-heal rebuild is ALWAYS non-interactive: we do
            // NOT pass `embeddingsInteractive`, so its embeddings build gate
            // takes the non-interactive branch (never prompt, never auto-fetch
            // the ~23MB model). A 0-hit search must NEVER trigger a model
            // download — it degrades to lexical cleanly.
            // Reuse the caller's registry ONLY when it supplied one (still open);
            // a self-opened registry was already closed in the finally above.
            ...(callerSuppliedRegistry && args.registryDb !== undefined
              ? { registryDb: args.registryDb }
              : {}),
          });
          writeIndexWatermark(v.path);
          reindexedVaults.push(v.name);
        } catch {
          // Non-fatal — the markdown SoT is intact; report "no matches" honestly.
        }
      }
      if (reindexedVaults.length > 0) {
        const retry = await searchCascadeFlow({ ...args, selfHeal: false });
        return {
          ...retry,
          trace: { ...retry.trace, selfHealed: { reindexedVaults } },
          durationMs: Date.now() - startedAt,
        };
      }
    }
  }

  return {
    query,
    scope,
    scopeTarget: args.scopeTarget ?? null,
    limit,
    results: truncated,
    trace: {
      tiersRun: [...tiersRunSet].sort((a, b) => a - b),
      perTierHitCount: perTierHits.slice(),
      vaultsSearched,
      ...(semanticFused ? { semanticFused: true } : {}),
    },
    durationMs: Date.now() - startedAt,
  };
}

// feat/microrag-semantic — per-doc dense candidate carried into fusion. A doc
// the lexical cascade DID return appears in `lexical` too; a doc it did NOT
// (a pure semantic match) is materialized into a SearchResult below — this is
// the load-bearing recall-recovery the prototype proved (Q14/Q15-class docs
// with zero lexical overlap but high cosine to the query).
export interface DenseCandidate {
  key: string; // `${vaultName}::${figmentPath}`
  figmentPath: string;
  vaultName: string;
  meshName: string | null;
  vector: Float32Array;
}

// Confidence stamped on a DENSE-ONLY hit (one the lexical cascade never
// returned). Below tier-3 (0.50) so it can never be mistaken for a lexical-tier
// match; it exists purely so the fused list carries a well-formed SearchResult.
// The dense arm's VALUE is rank position (the fusion fill order), not this
// number — scoring/eval is path-based. tier=4 marks it "dense-only" in traces.
const DENSE_ONLY_CONFIDENCE = 0.4;
const DENSE_TIER = 4;

// The PROVEN confidence-gated rank-preserve fusion
// (.scratch/microrag-eval.mts adaptRankpres-1.05-0.95, the clean ~0.60 winner).
//
// Inputs:
//  - `lexical`: the lexically-ranked SearchResult[] (already sorted; results[0]
//    is the lexical top hit, carrying its blendedScore — the gate signal).
//  - `qVec`: the query's dense vector (unit-normalized).
//  - `denseDocs`: EVERY in-scope doc that has a vector (the WHOLE corpus, not
//    just the lexical gather) — this is what lets dense pull in lexical misses.
//
// Algorithm (verbatim from the prototype's adaptiveRankPreserve + fill):
//  1. keepN from the lexical TOP hit's blendedScore: >=hi→3, >=mid→2, else→0.
//  2. Cosine-rank the FULL dense corpus against qVec (deterministic key
//     tiebreak) → the dense ranked list.
//  3. Emit lexical[0..keepN) FIXED, then fill from the dense order (docs not
//     already emitted — materializing a SearchResult for dense-only docs), then
//     any remaining lexical. Deterministic.
//
// Exported for direct unit testing of the proven rule (deterministic, no model).
export function fuseDense(
  lexical: readonly SearchResult[],
  qVec: Float32Array,
  denseDocs: readonly DenseCandidate[],
  blendHi: number,
  blendMid: number,
  snippetLen: number = SNIPPET_LEN,
): SearchResult[] {
  void snippetLen; // snippet enrichment for dense-only hits is deferred (see below)
  const keyOf = (r: SearchResult): string => `${r.vault_name}::${r.figment_path}`;

  // keepN from the lexical top hit's blended score (the discriminative signal:
  // holds sit ~1.0-1.35, misses ~0.85-0.95 — see the prototype's confidence
  // diagnostic). FUSION_ADAPTIVE selects the adaptive band vs the threshold-free
  // plain keep-3 fallback (both proven clean; adaptive is the ~0.60 winner).
  const topBlend = lexical[0]?.blendedScore ?? lexical[0]?.confidence ?? 0;
  const keepN = FUSION_ADAPTIVE
    ? topBlend >= blendHi
      ? 3
      : topBlend >= blendMid
        ? 2
        : 0
    : FUSION_KEEP_N_FALLBACK;

  // Dense cosine ranking over the WHOLE corpus. Deterministic tiebreak on key.
  const denseRanked = [...denseDocs].sort((a, b) => {
    const sa = cosine(qVec, a.vector);
    const sb = cosine(qVec, b.vector);
    if (sa !== sb) return sb - sa;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  // Lexical-result lookup by key so a dense doc the lexical cascade also
  // returned reuses its (richer, snippet-bearing) SearchResult identity.
  const lexByKey = new Map<string, SearchResult>();
  for (const r of lexical) lexByKey.set(keyOf(r), r);

  // Materialize a dense-only doc into a minimal SearchResult. Snippet is empty
  // (the doc body isn't in hand here — the vault DBs are closed; the human
  // formatter skips empty snippets, and scoring is path-based). Enriching the
  // snippet is a deferred follow-up; it does not affect ranking.
  const materialize = (d: DenseCandidate): SearchResult => ({
    figment_path: d.figmentPath,
    vault_name: d.vaultName,
    mesh_name: d.meshName,
    snippet: "",
    confidence: DENSE_ONLY_CONFIDENCE,
    tier: DENSE_TIER,
  });

  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const emit = (r: SearchResult): void => {
    const k = keyOf(r);
    if (!seen.has(k)) {
      out.push(r);
      seen.add(k);
    }
  };

  // 1. Keep lexical top-keepN fixed at their ranks.
  for (const r of lexical.slice(0, keepN)) emit(r);
  // 2. Fill from the dense order — reuse the lexical result if the doc was also
  //    a lexical hit, else materialize the dense-only doc (the recall recovery).
  for (const d of denseRanked) {
    const lex = lexByKey.get(d.key);
    emit(lex ?? materialize(d));
  }
  // 3. Any remaining lexical (docs with no vector — e.g. a vault that never
  //    built embeddings — so they were absent from denseRanked). Guarantees no
  //    lexical hit is dropped.
  for (const r of lexical) emit(r);
  return out;
}

// V-C-1 Phase C (L3) — is the vault's index stale relative to its content?
// "Stale" = a figment FILE under notes/ is newer than the vault's index
// watermark (the timestamp L1/L2 stamp on every Lyt-mediated index). A newer
// file means an un-indexed write happened OUTSIDE a Lyt path. A null watermark
// (never indexed via Lyt) with any figment present is also stale. No figments →
// never stale (nothing to index). Cheap: runs only on an empty search.
function isVaultStale(vaultPath: string): boolean {
  const newest = newestFigmentMtimeMs(vaultPath);
  if (newest === null) return false;
  const watermark = readIndexWatermark(vaultPath);
  if (watermark === null) return true;
  return newest > watermark;
}

// Newest mtime (epoch ms) across the vault's indexable markdown, or null when
// there is none. B-4: rooted at the VAULT ROOT (not notes/) via the shared
// `walkVaultMarkdownFiles` + `isIndexable` — the SAME inclusion set the tiers the
// self-heal rebuilds (FTS / lanes / arcs) now use. Without this re-root, edits
// under non-`notes/` folders would never bump the watermark and never trigger
// the L3 self-heal.
function newestFigmentMtimeMs(vaultPath: string): number | null {
  let newest: number | null = null;
  for (const p of walkVaultMarkdownFiles(vaultPath, isIndexable)) {
    try {
      const ms = statSync(p).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    } catch {
      /* skip unreadable */
    }
  }
  return newest;
}

function compareSearchResult(a: SearchResult, b: SearchResult): number {
  // X1 soft-tier blend: PRIMARY key is the blended score (tier prior + capped
  // BM25 boost), so a strong body hit can outrank a weak tag hit across tiers
  // (V-F5). Falls back to confidence when blendedScore is absent (defensive;
  // every result is blended before this sort runs).
  const ba = a.blendedScore ?? a.confidence;
  const bb = b.blendedScore ?? b.confidence;
  if (ba !== bb) return bb - ba;
  // Tie → tier prior keeps arc/lane primacy over an equally-blended body hit.
  if (a.tier !== b.tier) return a.tier - b.tier;
  // A1 within-tier tiebreak: higher BM25 rawScore ranks first (undefined→0).
  // Only acts on EXACT (blendedScore, tier) ties, so it cannot invert relevance
  // the way BM25-as-primary-sort did — it just makes ties deterministic and
  // relevance-aware where the blend is silent. Preserves Lock 0.3.
  const ra = a.rawScore ?? 0;
  const rb = b.rawScore ?? 0;
  if (ra !== rb) return rb - ra;
  if (a.vault_name !== b.vault_name) return a.vault_name < b.vault_name ? -1 : 1;
  if (a.figment_path !== b.figment_path) return a.figment_path < b.figment_path ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency map (B1)
// ---------------------------------------------------------------------------

// Map `fn` over `items` with at most `concurrency` invocations in flight at
// once, returning results in INPUT order (not completion order). A fixed pool
// of workers pulls the next index off a shared cursor — no third-party dep, no
// unbounded Promise.all over an arbitrarily large vault list. If any `fn`
// rejects, the rejection propagates (Promise.all over the workers) after the
// in-flight tasks settle their own try/finally — the per-vault open is wrapped
// in try/finally by the caller, so a handle is never leaked on a sibling's
// failure.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return out;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

async function resolveScopeVaults(
  registryDb: Client,
  scope: SearchCascadeScope,
  scopeTarget: string | undefined,
): Promise<VaultRow[]> {
  switch (scope) {
    case "vault": {
      if (scopeTarget === undefined) {
        throw new Error("search-cascade: scope=vault requires a scopeTarget (vault name).");
      }
      const v = await getVaultByName(registryDb, scopeTarget);
      if (!v) {
        throw new Error(`search-cascade: no vault registered with name '${scopeTarget}'.`);
      }
      return [v];
    }
    case "mesh": {
      if (scopeTarget === undefined) {
        throw new Error("search-cascade: scope=mesh requires a scopeTarget (mesh name).");
      }
      const mesh: MeshRow | null = await getMeshByName(registryDb, scopeTarget);
      if (!mesh) {
        throw new Error(`search-cascade: no mesh registered with name '${scopeTarget}'.`);
      }
      // default = union of vaults whose home_mesh_rid == mesh.rid AND
      // vaults present in mesh_vaults for the mesh (deduplicated).
      //
      // Track C Wave 3 F5 — subscription targets join the union. `lyt mesh
      // subscribe` records the consumed vault in mesh_subscriptions (NOT
      // mesh_vaults), so subscribed content was structurally excluded from
      // mesh-scoped tier-2 FTS and only surfaced via tier-3 edges (0.5) —
      // under-ranking exactly the public-vault consumption the alpha leads
      // with it. A subscribed vault that isn't locally registered (clone
      // missing) is skipped — search reads local caches only.
      const allVaults = await listVaults(registryDb);
      const homeMatch = allVaults.filter(
        (v) => v.homeMeshRid !== null && equalBytes(v.homeMeshRid, mesh.rid),
      );
      const memberRows = await listVaultsInMesh(registryDb, mesh.rid);
      const memberByHex = new Set(memberRows.map((r) => r.vaultRidHex));
      const memberVaults = allVaults.filter((v) => memberByHex.has(v.ridHex));
      const subscriptionRows = await listSubscriptionsForMesh(registryDb, mesh.rid);
      const subscribedByHex = new Set(subscriptionRows.map((s) => s.externalVaultRidHex));
      const subscribedVaults = allVaults.filter((v) => subscribedByHex.has(v.ridHex));
      const byHex = new Map<string, VaultRow>();
      for (const v of homeMatch) byHex.set(v.ridHex, v);
      for (const v of memberVaults) byHex.set(v.ridHex, v);
      for (const v of subscribedVaults) byHex.set(v.ridHex, v);
      return [...byHex.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    case "federation": {
      // Default scope per master-plan §v1.D.3:786 — every registered
      // vault, deterministic name order.
      const allVaults = await listVaults(registryDb);
      return [...allVaults].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
  }
}

// Build vault_rid_hex → mesh_name map for output enrichment. Looks
// up each vault's home mesh; subscribed-only vaults (home_mesh_rid
// is null) get a null mesh name.
async function resolveMeshNamesForVaults(
  registryDb: Client,
  vaults: readonly VaultRow[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const meshCache = new Map<string, string>();
  for (const v of vaults) {
    if (v.homeMeshRid === null) continue;
    const homeHex = v.homeMeshRidHex!;
    let meshName = meshCache.get(homeHex);
    if (meshName === undefined) {
      const mesh = await getMeshByRidOrNull(registryDb, v.homeMeshRid);
      if (mesh !== null) {
        meshName = mesh.name;
        meshCache.set(homeHex, meshName);
      }
    }
    if (meshName !== undefined) {
      out.set(v.ridHex, meshName);
    }
  }
  return out;
}

async function getMeshByRidOrNull(db: Client, rid: Uint8Array): Promise<MeshRow | null> {
  const rows = await db.execute({
    sql: "SELECT * FROM meshes WHERE rid = ?",
    args: [rid],
  });
  if (rows.rows.length === 0) return null;
  const r = rows.rows[0] as unknown as Record<string, unknown>;
  // Reuse meshes-repo's row → typed projection by hand; we already
  // imported MeshRow but not the private rowToMesh; keep this thin.
  return {
    rid: r["rid"] as Uint8Array,
    ridHex: bufToHexLower(r["rid"] as Uint8Array),
    name: String(r["name"]),
    pushTarget: r["push_target"] == null ? null : String(r["push_target"]),
    pushKind: null,
    mainVaultRid: null,
    mainVaultRidHex: null,
    createdAt: String(r["created_at"]),
  };
}

function bufToHexLower(b: Uint8Array | ArrayBuffer): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tier 0 — arc-membership (confidence 0.95)
// ---------------------------------------------------------------------------

interface TierArgs {
  lytDb: Client;
  query: string;
  vault: VaultRow;
  meshName: string | null;
  seen: Set<string>;
  remaining: number;
}

async function runTier0Arcs(args: TierArgs): Promise<SearchResult[]> {
  if (args.remaining <= 0) return [];
  const q = args.query.toLowerCase();
  const arcs = await listArcs(args.lytDb);
  const matched = arcs.filter(
    (a) => a.name.toLowerCase().includes(q) || a.category.toLowerCase().includes(q),
  );
  const out: SearchResult[] = [];
  for (const arc of matched) {
    if (out.length + args.seen.size >= Number.POSITIVE_INFINITY) break;
    const members = await listMembersByArc(args.lytDb, arc.rid);
    for (const m of members) {
      if (out.length >= args.remaining) break;
      const key = `${args.vault.name}::${m.figmentPath}`;
      if (args.seen.has(key)) continue;
      args.seen.add(key);
      out.push({
        figment_path: m.figmentPath,
        vault_name: args.vault.name,
        mesh_name: args.meshName,
        snippet: readSnippetFromDisk(args.vault.path, m.figmentPath),
        confidence: SEARCH_CONFIDENCE_TIER_0,
        tier: TIER_0,
      });
    }
    if (out.length >= args.remaining) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier 1 — lane-membership (confidence 0.9)
// ---------------------------------------------------------------------------

async function runTier1Lanes(args: TierArgs): Promise<SearchResult[]> {
  if (args.remaining <= 0) return [];
  const q = args.query.toLowerCase();
  const lanes = await listLanes(args.lytDb);
  const matched = lanes.filter((l) => {
    if (l.name.toLowerCase().includes(q)) return true;
    return l.sourceKeywords.some((k) => k.toLowerCase().includes(q));
  });
  const out: SearchResult[] = [];
  for (const lane of matched) {
    const members = await listMembersByLane(args.lytDb, lane.rid);
    for (const m of members) {
      if (out.length >= args.remaining) break;
      const key = `${args.vault.name}::${m.figmentPath}`;
      if (args.seen.has(key)) continue;
      args.seen.add(key);
      out.push({
        figment_path: m.figmentPath,
        vault_name: args.vault.name,
        mesh_name: args.meshName,
        snippet: readSnippetFromDisk(args.vault.path, m.figmentPath),
        confidence: SEARCH_CONFIDENCE_TIER_1,
        tier: TIER_1,
      });
    }
    if (out.length >= args.remaining) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier 2 — FTS5 raw-count (confidence 0.7)
// ---------------------------------------------------------------------------

async function runTier2Fts(args: TierArgs): Promise<SearchResult[]> {
  if (args.remaining <= 0) return [];
  const hits = await searchFts(args.lytDb, args.query, args.remaining);
  const out: SearchResult[] = [];
  for (const h of hits) {
    if (out.length >= args.remaining) break;
    const key = `${args.vault.name}::${h.figmentPath}`;
    if (args.seen.has(key)) continue;
    args.seen.add(key);
    out.push({
      figment_path: h.figmentPath,
      vault_name: args.vault.name,
      mesh_name: args.meshName,
      // FTS5 snippet() already includes <mark> highlights. Trust the
      // SQL output verbatim — no truncation to SNIPPET_LEN since the
      // snippet() function gates the length itself.
      snippet: h.snippet,
      confidence: SEARCH_CONFIDENCE_TIER_2,
      tier: TIER_2,
      rawScore: h.rawHits, // BM25 strength → soft-tier blend + tiebreak
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier 3 — edge-traversal (confidence 0.5)
// ---------------------------------------------------------------------------

async function resolveTier3Neighbors(
  registryDb: Client,
  fromVault: VaultRow,
  alreadySearched: Set<string>,
): Promise<VaultRow[]> {
  // default = 1-hop. Walk edges in BOTH directions: this vault
  // may be the home of an edge (a child references it) OR the ref
  // (this vault references some home). Collect peer rids.
  const refEdges = await listMeshEdgesByRefVault(registryDb, fromVault.rid);
  const homeEdges = await listMeshEdgesByHomeVault(registryDb, fromVault.rid);
  const peerHexes = new Set<string>();
  for (const e of refEdges) peerHexes.add(e.homeVaultRidHex);
  for (const e of homeEdges) peerHexes.add(e.refVaultRidHex);

  const out: VaultRow[] = [];
  for (const peerHex of peerHexes) {
    if (alreadySearched.has(peerHex)) continue;
    const peerRid = hexLowerToBytes(peerHex);
    const peer = await getVaultByRid(registryDb, peerRid);
    if (peer === null) continue;
    if (peer.status === "tombstoned") continue;
    out.push(peer);
  }
  return out;
}

async function runTier3EdgeFts(args: TierArgs): Promise<SearchResult[]> {
  if (args.remaining <= 0) return [];
  const hits = await searchFts(args.lytDb, args.query, args.remaining);
  const out: SearchResult[] = [];
  for (const h of hits) {
    if (out.length >= args.remaining) break;
    const key = `${args.vault.name}::${h.figmentPath}`;
    if (args.seen.has(key)) continue;
    args.seen.add(key);
    out.push({
      figment_path: h.figmentPath,
      vault_name: args.vault.name,
      mesh_name: args.meshName,
      snippet: h.snippet,
      confidence: SEARCH_CONFIDENCE_TIER_3,
      tier: TIER_3,
      rawScore: h.rawHits, // BM25 strength → soft-tier blend + tiebreak
    });
  }
  return out;
}

function hexLowerToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snippet derivation for tier 0/1 (default — first 96 chars of body)
// ---------------------------------------------------------------------------

function readSnippetFromDisk(vaultPath: string, figmentPath: string): string {
  // figmentPath is vault-relative POSIX; on Windows join with native sep.
  const abs = join(vaultPath, figmentPath.split(posix.sep).join(sep));
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return "";
  }
  // Skip frontmatter; trim leading whitespace; take SNIPPET_LEN chars.
  const body = stripFrontmatterForSnippet(raw).replace(/^\s+/, "");
  if (body.length <= SNIPPET_LEN) return body.replace(/\s+/g, " ").trim();
  return body.slice(0, SNIPPET_LEN).replace(/\s+/g, " ").trim() + "…";
}

function stripFrontmatterForSnippet(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      firstNonEmpty = i;
      break;
    }
  }
  if (firstNonEmpty === -1 || lines[firstNonEmpty] !== "---") {
    return raw;
  }
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return raw;
}
