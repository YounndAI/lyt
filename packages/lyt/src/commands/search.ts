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

// v1.D.3b — `lyt search` top-level CLI verb (meta-CLI level per the ratified default).
//
// First CONSUMER verb of Lane D — runs the tiered-cascade engine
// (Tier 0 arcs → Tier 1 lanes → Tier 2 FTS5 → Tier 3 edges) over
// the chosen scope and emits ranked results.
//
// Scope flags (mutually exclusive; default = federation per
// master-plan §v1.D.3:786):
// --vault <name> single-vault search (skips Tier 3 per spec)
// --mesh <name> mesh-scoped (home_mesh_rid ∪ mesh_vaults union
// per the ratified default)
// --all explicit alias for federation (ergonomics +
// symmetry with --vault / --mesh)
// (none) federation (every registered vault, name ASC)
//
// --limit defaults to 20 per the ratified default; --json emits Lock 0.3
// deterministic stable-key-ordered output.
//
// Error contract (per the ratified default):
// empty query → exit 1, JSON { error: "empty-query", ... }
// conflicting flags → exit 1, JSON { error: "conflicting-scope-flags", ... }
//
// Lives at the meta-CLI level (not under `vault` group) because the
// default scope is federation — putting it under `vault` would tilt
// user mental model toward single-vault use. The cascade engine
// itself lives in lyt-vault (data-layer ownership); this file is
// the CLI surface adapter.

import { Command } from "commander";

import {
  closeRegistry,
  markAsked,
  openRegistry,
  searchCascadeFlow,
  withSpinner,
  type SearchCascadeArgs,
  type SearchCascadeResult,
  type SearchCascadeScope,
} from "@younndai/lyt-vault";

interface SearchCliOpts {
  vault?: string;
  mesh?: string;
  all?: boolean;
  limit?: string;
  json?: boolean;
  // commander negatable flag: `selfHeal` defaults true; `--no-self-heal` → false.
  selfHeal?: boolean;
  // dense-retrieval fusion. Commander negatable flag: `semantic` defaults
  // true; `--no-semantic` → false. The flow's gate (semantic ?? embeddingsEnabled())
  // still decides whether fusion actually runs, so a pod with embeddings off
  // stays byte-identical even with the default-on flag.
  semantic?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;

export function buildSearchCommand(): Command {
  return new Command("search")
    .description(
      "Tiered-cascade search across vaults. Cascade: Tier 0 arcs (0.95) → Tier 1 lanes (0.9) → Tier 2 FTS5 (0.7) → Tier 3 edges (0.5). Default scope = federation (every vault across every mesh). Use --vault / --mesh for narrower scope; --all is the explicit federation alias.",
    )
    .argument("<query>", "Search query (multi-word: implicit AND)")
    .option("--vault <name>", "Search only the named vault (skips Tier 3)")
    .option("--mesh <name>", "Search only vaults home-to OR referenced-by the named mesh")
    .option("--all", "Explicit alias for federation scope (default behavior)")
    .option("--limit <n>", `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`)
    .option("--json", "Emit deterministic JSON instead of human-readable lines")
    .option(
      "--no-self-heal",
      "Disable the empty-result self-heal (on 0 hits, search reindexes stale vaults + re-queries). Auto-disabled under --json.",
    )
    .option(
      "--no-semantic",
      "Disable local dense-embedding fusion (on by default). By default search fuses dense retrieval into the cascade when embeddings are enabled + a vector cache is built; it already falls back to lexical search when the model/cache is unavailable. Pass --no-semantic to force the pure lexical cascade.",
    )
    .action(async (query: string, opts: SearchCliOpts) => {
      // Resolve scope from mutually-exclusive flags.
      const scopeFlags = [
        opts.vault !== undefined ? "--vault" : null,
        opts.mesh !== undefined ? "--mesh" : null,
        opts.all === true ? "--all" : null,
      ].filter((s): s is string => s !== null);
      if (scopeFlags.length > 1) {
        emitError(opts.json === true, {
          error: "conflicting-scope-flags",
          flags: scopeFlags,
          message: `Conflicting scope flags: ${scopeFlags.join(", ")}. Pass at most one.`,
        });
        process.exitCode = 1;
        return;
      }

      // Empty whitespace-only query (default = error).
      const trimmed = (query ?? "").trim();
      if (trimmed.length === 0) {
        emitError(opts.json === true, {
          error: "empty-query",
          message: "Empty search query. Provide at least one non-whitespace character.",
        });
        process.exitCode = 1;
        return;
      }

      // Parse + clamp limit.
      let limit = DEFAULT_LIMIT;
      if (opts.limit !== undefined) {
        const parsed = Number.parseInt(opts.limit, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          emitError(opts.json === true, {
            error: "invalid-limit",
            value: opts.limit,
            message: `--limit must be a positive integer (got: ${JSON.stringify(opts.limit)}).`,
          });
          process.exitCode = 1;
          return;
        }
        limit = Math.min(parsed, MAX_LIMIT);
      }

      // Scope resolution.
      let scope: SearchCascadeScope;
      let scopeTarget: string | undefined;
      if (opts.vault !== undefined) {
        scope = "vault";
        scopeTarget = opts.vault;
      } else if (opts.mesh !== undefined) {
        scope = "mesh";
        scopeTarget = opts.mesh;
      } else {
        // Default OR explicit --all: federation.
        scope = "federation";
      }

      // V-C-1 Phase C (L3) — enable the empty-result self-heal ONLY for human
      // runs: never under --json (deterministic output contract), never under
      // --no-self-heal, and never when LYT_NO_SELF_HEAL=1 (a hard determinism
      // escape hatch for the Lane V retrieval harness / any reproducible run).
      const selfHeal =
        opts.json !== true && opts.selfHeal !== false && process.env["LYT_NO_SELF_HEAL"] !== "1";

      try {
        const args: SearchCascadeArgs = {
          query: trimmed,
          scope,
          limit,
          // Phase D Slice 2b — the `lyt search` CLI is the discovery-nudge
          // surface: turn the nudge ON for BOTH human and --json runs (the flow
          // increments the pod-global cadence counter + computes trace.nudge).
          // The HUMAN ambient hint vs the --json trace are mutually exclusive
          // (F-D.2), enforced in the emitters below.
          nudge: true,
          ...(scopeTarget !== undefined ? { scopeTarget } : {}),
          ...(selfHeal ? { selfHeal: true } : {}),
          // the semantic DEFAULT now lives in the FLOW (semantic ??
          // embeddingsEnabled()), so CLI and MCP are consistent. The CLI only
          // forwards the EXPLICIT opt-out: --no-semantic sets opts.semantic=false
          // → semantic:false (forces the pure lexical cascade). When the user
          // does NOT pass --no-semantic we leave `semantic` UNSPECIFIED so the
          // flow applies the embeddingsEnabled() default (an embeddings-off pod
          // is byte-unchanged either way).
          ...(opts.semantic === false ? { semantic: false } : {}),
        };
        // V-DX-1 — liveness spinner over the silent DB-open + cascade window.
        // --json stays spinner-free (mirror init: useSpinner = json !== true);
        // non-TTY prints "Searching…" once (zero escape codes) per the
        // primitive's built-in agent-safe fallback.
        const res: SearchCascadeResult =
          opts.json !== true
            ? await withSpinner(scopeTarget ?? scope, () => searchCascadeFlow(args), {
                op: "search",
              })
            : await searchCascadeFlow(args);

        if (opts.json === true) {
          emitJsonResult(res);
        } else {
          emitHumanResult(res);
          // release review FIX 4(a) — the CLI ambient hint is now STATEFUL.
          // When the human path actually SURFACED the eligible hint, stamp the
          // ask against the pod-global singleton (atomic markAsked) so the SAME
          // 7-day cadence + auto-quiet that govern the agent path apply to CLI
          // users too (a human is no longer nagged on every search). XOR with the
          // --json agent path is preserved: this branch is the non-json path
          // only; the agent drives its own `nudge --asked`/`--decline`, so we do
          // NOT stamp under --json. Best-effort — a registry failure never fails
          // the search.
          if (res.trace.nudge?.eligible === true) {
            await maybeStampCliAsk();
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitError(opts.json === true, {
          error: "cascade-error",
          message,
        });
        process.exitCode = 2;
      }
    });
}

// release review FIX 4(a) — stamp the ask after the CLI surfaced the ambient
// hint to a human, so the CLI hint shares the agent's 7-day cadence + auto-quiet.
// Atomic markAsked (resets searches_since_ask, stamps last_ask_at). Best-effort:
// a registry-open / write failure is swallowed — surfacing the hint must never
// fail the search, and a missed stamp only means one extra (harmless) future
// hint. Exported for the human-cadence unit test.
export async function maybeStampCliAsk(): Promise<void> {
  let db: Awaited<ReturnType<typeof openRegistry>> | undefined;
  try {
    db = await openRegistry();
    await markAsked(db, new Date().toISOString());
  } catch {
    // best-effort — never fail the search on a nudge-cadence write.
  } finally {
    if (db !== undefined) await closeRegistry(db);
  }
}

// Phase D Slice 2b — the terminal ambient discovery hint (drafted copy,
// pinned per the release review trust-safety finding). USER-BENEFIT framing only;
// names the exact re-enable verb; NO size word ("one-time local"). Emitted on
// HUMAN stdout ONLY when the nudge trace is `eligible`. NEVER under --json (the
// --json run surfaces the decision-trace instead — F-D.2 mutual exclusion).
export const NUDGE_AMBIENT_HINT =
  "tip: concept search can find this by meaning, not just keywords — set it up " +
  "once with 'lyt model fetch' (one-time local, nothing leaves your machine).";

export function emitJsonResult(res: SearchCascadeResult): void {
  // Stable-key-ordered output per Lock 0.3 — Object construction order
  // determines JSON.stringify key order in Node.
  const stable = {
    query: res.query,
    scope: res.scope,
    scopeTarget: res.scopeTarget,
    limit: res.limit,
    results: res.results.map((r) => ({
      confidence: r.confidence,
      tier: r.tier,
      vault_name: r.vault_name,
      mesh_name: r.mesh_name,
      figment_path: r.figment_path,
      snippet: r.snippet,
    })),
    trace: {
      tiersRun: res.trace.tiersRun,
      perTierHitCount: res.trace.perTierHitCount,
      vaultsSearched: res.trace.vaultsSearched,
      // Phase D Slice 2b — surface the nudge decision-trace under --json so
      // the agent knows model state + WHY it should/shouldn't voice the nudge.
      // Additive: present ONLY when the flow ran the nudge (CLI runs always do),
      // so any existing --json snapshot without it is unchanged. The --json run
      // emits the TRACE, never the human hint (F-D.2 mutual exclusion).
      ...(res.trace.nudge !== undefined ? { nudge: res.trace.nudge } : {}),
    },
    durationMs: res.durationMs,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(stable, null, 2));
}

export function emitHumanResult(res: SearchCascadeResult): void {
  // V-C-1 Phase C (L3) — when the empty-result self-heal reindexed stale
  // vault(s) and re-queried, say so (the results below are post-heal).
  if (res.trace.selfHealed !== undefined) {
    const v = res.trace.selfHealed.reindexedVaults;
    // eslint-disable-next-line no-console
    console.log(
      `↻ self-healed: reindexed ${v.length} stale vault(s) (${v.join(", ")}) before this result.`,
    );
  }
  if (res.results.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `No matches for ${JSON.stringify(res.query)} (scope=${res.scope}, vaults searched: ${res.trace.vaultsSearched.length}).`,
    );
    // A 0-hit search is a PRIME moment for the discovery hint — semantic might
    // find by meaning what lexical missed. Same eligibility + mutual-exclusion
    // (F-D.2) as the with-results path.
    maybeEmitNudgeHint(res);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `${res.results.length} match(es) for ${JSON.stringify(res.query)} (scope=${res.scope}, ${res.durationMs}ms):`,
  );
  for (const r of res.results) {
    // eslint-disable-next-line no-console
    console.log(` [${r.tier}.${r.confidence.toFixed(2)}] ${r.vault_name}/${r.figment_path}`);
    if (r.snippet.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`         ${r.snippet}`);
    }
  }
  maybeEmitNudgeHint(res);
}

// Phase D Slice 2b — the ambient discovery hint, on HUMAN stdout only, iff
// the nudge trace says eligible (model absent, not declined/disabled, cadence
// due). This is the human counterpart to the --json decision-trace: the human
// path NEVER emits the trace, the --json path NEVER emits this hint (F-D.2
// mutual exclusion — emitJsonResult does not call this). Absent trace /
// ineligible → silent.
function maybeEmitNudgeHint(res: SearchCascadeResult): void {
  if (res.trace.nudge?.eligible === true) {
    // eslint-disable-next-line no-console
    console.log(NUDGE_AMBIENT_HINT);
  }
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  // Track C Wave 3 F14 — a corrupt vault index used to fail with the bare
  // libSQL message and no remedy. Name the fix: `lyt reindex` quarantines +
  // rebuilds corrupt index caches (F15 self-heal), so route the user/agent
  // straight there.
  const msg = String(body["message"] ?? body["error"]);
  const corrupt =
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("file is not a database") ||
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("database disk image is malformed");
  const remedy = corrupt
    ? "a vault's index cache is corrupt (derived state — safe to rebuild). Run `lyt reindex --vault <name>` (or `lyt reindex --all`) to quarantine and rebuild it."
    : null;
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(remedy !== null ? { ...body, remedy } : body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt search: ${msg}${remedy !== null ? ` — ${remedy}` : ""}`);
  }
}
