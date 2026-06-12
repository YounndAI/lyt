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

// Routing policy engine.
//
// Per arc-thoughts §6.7 + §6.12: each @AUTOMATOR declares a
// `llm_source_preference` (ordered list) + `llm_hard_constraints` (gating
// predicates). The gateway walks the preference order, filters by
// hard-constraints + adapter availability + mode support, and picks the
// first match. No fallback ranking — explicit preference order is the
// contract.
//
// Default preference is `[harness, ai-relay, byok, ollama]` matching arc
// §6.7 cost-shape table: harness is the "use the €20 you already pay"
// adoption lever (zero marginal cost), ai-relay is the cheap-tier default
// for grunt work, byok is power-user direct, ollama is the local fallback.
//
// Constraint evaluation is fail-loud: unknown constraint kinds throw
// UnknownHardConstraintError rather than being silently ignored. Per arc
// §6.7: "hard_constraint is a hard contract; soft preferences belong in
// source_preference".

import {
  HardConstraintViolationError,
  type LlmAdapter,
  type LlmSource,
  type HardConstraint,
  type MemscopeContext,
  UnknownHardConstraintError,
  NoEligibleAdapterError,
} from "./types.js";

// Brief @TASK clause (4): "default `[cheap, harness, byok, local]` per arc §6.10".
// Translated to source vocabulary: cheap → ai-relay; harness → harness;
// byok → byok; local → ollama. Order preserved from arc §6.10 default.
export const DEFAULT_SOURCE_PREFERENCE: readonly LlmSource[] = Object.freeze([
  "ai-relay",
  "harness",
  "byok",
  "ollama",
]);

const KNOWN_CONSTRAINT_KINDS = new Set([
  "local_only",
  "never_external_when_private_memscope",
  "max_cost_per_run_usd",
  "provider",
]);

const EXTERNAL_SOURCES = new Set<LlmSource>(["ai-relay", "byok"]);
const LOCAL_SOURCES = new Set<LlmSource>(["ollama", "harness"]);

export interface SelectAdapterArgs {
  mode: "generate" | "embed";
  preference: LlmSource[];
  adapters: Partial<Record<LlmSource, LlmAdapter>>;
  hardConstraints?: HardConstraint[];
  memscope?: MemscopeContext;
}

// Walk preference in order; return the first adapter that (a) is registered,
// (b) supports the requested mode, and (c) passes every hard constraint.
// Throws NoEligibleAdapterError if no candidate qualifies — the caller
// surfaces this as a structured automator_run_events row.
export function selectAdapter(args: SelectAdapterArgs): LlmAdapter {
  const constraints = args.hardConstraints ?? [];
  // Validate constraint kinds up-front so we fail-loud BEFORE iterating
  // preference. Defensive — keeps the "unknown constraint" diagnostic clean.
  for (const c of constraints) {
    if (!KNOWN_CONSTRAINT_KINDS.has(c.kind)) {
      throw new UnknownHardConstraintError(c.kind);
    }
  }

  const reasons: string[] = [];
  for (const source of args.preference) {
    const adapter = args.adapters[source];
    if (!adapter) {
      reasons.push(`${source}: no adapter registered`);
      continue;
    }
    if (!adapter.supports(args.mode)) {
      reasons.push(`${source}: does not support mode=${args.mode}`);
      continue;
    }
    const violation = firstViolation(source, constraints, args.memscope);
    if (violation) {
      reasons.push(`${source}: ${violation.constraintKind} (${violation.detail})`);
      continue;
    }
    return adapter;
  }

  throw new NoEligibleAdapterError(
    args.mode,
    args.preference,
    reasons.length > 0 ? reasons.join("; ") : "preference list is empty",
  );
}

// Public helper for adapter-shopping callers (e.g., the lyt-runner pre-write
// hook from Commit 5 may pre-validate constraints before issuing the call).
// Returns the first violation, or null if every constraint is satisfied.
export function firstViolation(
  source: LlmSource,
  constraints: HardConstraint[],
  memscope?: MemscopeContext,
): HardConstraintViolationError | null {
  for (const c of constraints) {
    const detail = evaluateOne(source, c, memscope);
    if (detail !== null) {
      return new HardConstraintViolationError(c.kind, source, detail);
    }
  }
  return null;
}

// Per-constraint evaluator. Returns a non-null detail string when the
// constraint REJECTS this source, or null when the constraint accepts it.
//
// New constraint kinds must (1) be added to KNOWN_CONSTRAINT_KINDS,
// (2) get a branch here, and (3) be documented in
// the LYT design doc `lyt-yai-domain.md` §`@AUTOMATOR`.
function evaluateOne(
  source: LlmSource,
  c: HardConstraint,
  memscope?: MemscopeContext,
): string | null {
  switch (c.kind) {
    case "local_only": {
      if (!LOCAL_SOURCES.has(source)) {
        return `source ${source} is external; only ${[...LOCAL_SOURCES].join(",")} allowed`;
      }
      return null;
    }
    case "never_external_when_private_memscope": {
      if (memscope?.defaultView === "private" && EXTERNAL_SOURCES.has(source)) {
        return `memscope default_view=private; source ${source} is external`;
      }
      return null;
    }
    case "max_cost_per_run_usd": {
      // Adapter-mode constraint is advisory at routing time — actual
      // enforcement happens in the cost-budget tracker at call time. We
      // simply confirm the args shape is well-formed; if not, treat as
      // rejection so the constraint can't be silently misconfigured.
      const usd = (c.args as { usd?: unknown } | undefined)?.usd;
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
        return `max_cost_per_run_usd requires args.usd:number>=0; got ${JSON.stringify(c.args)}`;
      }
      return null;
    }
    case "provider": {
      // Pin to a specific provider name. Source-level scoping: ai-relay and
      // byok are the provider-bearing surfaces; ollama and harness are
      // implicitly local/integrated and don't honour provider pinning.
      const requested = (c.args as { name?: unknown } | undefined)?.name;
      if (typeof requested !== "string" || requested.length === 0) {
        return `provider requires args.name:string; got ${JSON.stringify(c.args)}`;
      }
      if (source === "ollama" || source === "harness") {
        return `provider pinning ('${requested}') is incompatible with source '${source}'`;
      }
      return null;
    }
    default: {
      // Unreachable — KNOWN_CONSTRAINT_KINDS is checked at the top of
      // selectAdapter. Defensive against the gate being widened without
      // a matching switch arm.
      throw new UnknownHardConstraintError(c.kind);
    }
  }
}
