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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";

import type { Client } from "@libsql/client";

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
}

export interface SearchCascadeArgs {
  query: string;
  scope?: SearchCascadeScope;
  scopeTarget?: string;
  limit?: number;
  // Open-once seam (v1.A.5 CR-B1).
  registryDb?: Client;
  // Lane V fix-pass — soft-tier blend coefficient (tuning seam). Defaults to
  // SOFT_TIER_ALPHA; threaded so the bench / α-sweep can probe alternative
  // values without a rebuild. Internal — NOT exposed as a CLI flag.
  softTierAlpha?: number;
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

    for (const vault of targetVaults) {
      if (results.length >= gatherCap) break;
      vaultsSearched.push(vault.name);
      const meshName = meshNameByVaultHex.get(vault.ridHex) ?? null;

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
        // union afterward; the global cap is enforced at the vault-loop boundary
        // (and the final slice), not between tiers within a vault.
        // --- Tier 0: arc-membership -----------------------------
        tiersRunSet.add(TIER_0);
        const arcHits = await runTier0Arcs({
          lytDb,
          query,
          vault,
          meshName,
          seen,
          remaining: gatherCap,
        });
        for (const hit of arcHits) results.push(hit);
        perTierHits[TIER_0]! += arcHits.length;
        // --- Tier 1: lane-membership ----------------------------
        tiersRunSet.add(TIER_1);
        const laneHits = await runTier1Lanes({
          lytDb,
          query,
          vault,
          meshName,
          seen,
          remaining: gatherCap,
        });
        for (const hit of laneHits) results.push(hit);
        perTierHits[TIER_1]! += laneHits.length;
        // --- Tier 2: FTS5 raw-count (ALWAYS runs — never tier-0/1-starved) ---
        tiersRunSet.add(TIER_2);
        const ftsHits = await runTier2Fts({
          lytDb,
          query,
          vault,
          meshName,
          seen,
          remaining: gatherCap,
        });
        for (const hit of ftsHits) results.push(hit);
        perTierHits[TIER_2]! += ftsHits.length;
      } finally {
        await closeVaultDb(lytDb);
      }

      // Queue Tier 3 candidates from this vault's mesh_edges (skip
      // at scope=vault). We collect candidates here but flush AFTER
      // the primary loop so Tier 3 always runs last (per spec).
      if (scope !== "vault" && results.length < gatherCap) {
        const neighbors = await resolveTier3Neighbors(registryDb, vault, searchedVaultHexes);
        for (const n of neighbors) {
          // Mark searched so we don't queue the same neighbor twice
          // (e.g. when both ref + home edges point at it).
          searchedVaultHexes.add(n.ridHex);
          tier3Candidates.push(n);
        }
      }
    }

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
            query,
            vault: neighbor,
            meshName,
            seen,
            remaining: gatherCap - results.length,
          });
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
    r.blendedScore = r.confidence + softTierAlpha * norm;
  }

  // Final deterministic sort per Lock 0.3, then truncate to the caller's limit.
  results.sort(compareSearchResult);
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
    },
    durationMs: Date.now() - startedAt,
  };
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

// Newest mtime (epoch ms) across `<vault>/notes/**/*.md`, or null when the
// notes tree is absent/empty. Mirrors the notes-walk scope of rebuild-fts /
// rebuild-lanes (the tiers the self-heal rebuilds).
function newestFigmentMtimeMs(vaultPath: string): number | null {
  let newest: number | null = null;
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && p.toLowerCase().endsWith(".md")) {
        try {
          const ms = statSync(p).mtimeMs;
          if (newest === null || ms > newest) newest = ms;
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(join(vaultPath, "notes"));
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
