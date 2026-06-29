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

// Lyt LLM gateway public type surface.
//
// Per arc-thoughts §6.12 (LOCKED 2026-05-27): four LLM source kinds composed
// behind one gateway. The names below are the canonical brief vocabulary used
// in @AUTOMATOR's `llm_source_preference` field — do not rename without
// updating the yai.lyt domain schema (v1.A.3 lands the JSON schema; Lyt-side
// rename would invalidate every shipped `metadata-filler.yon` etc.).
//
// Capabilities track the user-facing taxonomy from arc §6.7 cost-shape table
// ("grunt" maps to cheap-tier; "reasoning" to deep-tier; "embed" + "structured"
// are orthogonal modes). The gateway uses capability to (a) hint adapter
// selection where multiple are eligible and (b) record the audit trail in
// `automator_runs.llm_capability_used`.

export type LlmSource = "ai-relay" | "ollama" | "harness" | "byok";

export type LlmCapability =
  | "grunt" // cheap-tier housekeeping (Haiku 4.5 / Flash / nano per arc §6.7)
  | "reasoning" // deep-tier (Opus / o-series)
  | "embed" // embedding model
  | "structured"; // generate_object — zod-schema constrained

// Hard constraints declared by an @AUTOMATOR. Commit 2 supports the four
// enumerated in arc §6.7 + §6.12; new constraint kinds extend via the same
// `{ kind, args? }` shape without breaking existing automators.
//
// The well-known kinds:
// - "local_only" — only ollama + harness eligible
// - "never_external_when_private_memscope" — gate ai-relay + byok by memscope
// - "max_cost_per_run_usd" — { args.usd: number }
// - "provider" — { args.name: "anthropic" | ... }
//
// Unknown kinds throw at evaluateHardConstraints() time — fail-loud per
// arc §6.7 ("hard_constraint is a hard contract; soft preferences belong in
// source_preference").
export interface HardConstraint {
  kind: string;
  args?: Record<string, unknown>;
}

export interface CostBudget {
  // Per-run hard-stop. The gateway throws CostBudgetExceededError once the
  // accumulated cost for the current run exceeds this number. Open Decision
  // #3 default (recommended): hard-stop on per-run, warn-on-monthly.
  perRunUsd: number;
  // Monthly soft-warn surface. Commit 2 stores it but does not enforce —
  // enforcement lands at block-D when admin review CLI surfaces it
  // (`lyt automator status --json` filter per Open Decision #3).
  monthlyUsd?: number;
}

// Memscope context passed into evaluateHardConstraints() so the
// "never_external_when_private_memscope" gate has the data it needs without
// each adapter having to know about memscope semantics.
export interface MemscopeContext {
  // From @MEMSCOPE.default_view. The gate fires when "private".
  defaultView?: "private" | "group" | "public";
  // Reserved for v3 — the cryptographic redaction enforcement per
  // arc §7 F12. v1/v2 read this for advisory routing only.
  redactPiiV3?: boolean;
}

export interface GenerateRequest {
  prompt: string;
  // Optional system message (Anthropic-style separation). Passed through to
  // every adapter as-is; adapters that don't natively support a system role
  // (older Ollama models) prepend it to the prompt.
  system?: string;
  capability?: LlmCapability;
  // Per-request override of the gateway's default source preference.
  sourcePreference?: LlmSource[];
  hardConstraints?: HardConstraint[];
  memscope?: MemscopeContext;
  // Adapter-specific overrides — e.g., `{ model: "claude-haiku-4-5" }` for
  // ai-relay, `{ model: "llama3.1:8b" }` for ollama. Adapters that don't
  // recognise the model name throw at adapter.generate() time.
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResult {
  text: string;
  sourceUsed: LlmSource;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface EmbedRequest {
  texts: string[];
  sourcePreference?: LlmSource[];
  hardConstraints?: HardConstraint[];
  memscope?: MemscopeContext;
  model?: string;
}

export interface EmbedResult {
  vectors: number[][];
  sourceUsed: LlmSource;
  modelUsed: string;
  tokensIn: number;
  costUsd: number;
}

// Adapter surface every concrete adapter (ai-relay / ollama / harness / byok)
// implements. The gateway calls supports() during routing to filter
// candidates by mode (some adapters don't implement embeddings — e.g. the
// harness adapter, since CC/Codex skills don't expose an embedding API).
export interface LlmAdapter {
  readonly source: LlmSource;
  supports(mode: "generate" | "embed"): boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

export interface LlmGatewayConfig {
  // Global default preference. Per-request `GenerateRequest.sourcePreference`
  // overrides. If neither is set, the gateway uses
  // DEFAULT_SOURCE_PREFERENCE from routing.ts ([cheap, harness, byok, local]
  // per arc §6.10 `llm_source_preference` default).
  preference?: LlmSource[];
  costBudget?: CostBudget;
  // Adapters injected from outside — adapter shells in this Commit 2
  // scaffold take their concrete client/fetch/invoker as constructor arg
  // so the gateway can be unit-tested without external dependencies. The
  // real wiring (process.env credentials, native fetch, CC skill bridge)
  // happens at the caller — block-B Commit 4 wires it into lyt-runner.
  adapters?: Partial<Record<LlmSource, LlmAdapter>>;
}

export interface LlmGateway {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
  // Cost-tracker accessors. Block-B Commit 4 wires these into
  // `automator_runs.llm_cost_usd` / `automator_runs.llm_calls_count` on
  // 5-step protocol completion.
  totalCostUsd(): number;
  totalCalls(): number;
  resetCostTracker(): void;
  // Introspection — which sources are actually wired. Used by the brief's
  // gold-standard smoke test to confirm the adapters got injected.
  registeredSources(): LlmSource[];
}

// Errors surfaced at the gateway boundary. Each carries enough context for
// the lyt-runner pre-write hook (block-B Commit 5) to write a structured
// automator_run_events row.

export class NoEligibleAdapterError extends Error {
  override readonly name = "NoEligibleAdapterError";
  constructor(
    public readonly mode: "generate" | "embed",
    public readonly preference: LlmSource[],
    public readonly reason: string,
  ) {
    super(
      `No eligible LLM adapter for mode=${mode} after applying preference=[${preference.join(",")}]: ${reason}`,
    );
  }
}

export class CostBudgetExceededError extends Error {
  override readonly name = "CostBudgetExceededError";
  constructor(
    public readonly budgetUsd: number,
    public readonly accumulatedUsd: number,
    public readonly attemptedUsd: number,
  ) {
    super(
      `Cost budget exceeded: budget=${budgetUsd.toFixed(4)}, accumulated=${accumulatedUsd.toFixed(4)}, this-call=${attemptedUsd.toFixed(4)}`,
    );
  }
}

export class HardConstraintViolationError extends Error {
  override readonly name = "HardConstraintViolationError";
  constructor(
    public readonly constraintKind: string,
    public readonly source: LlmSource,
    public readonly detail: string,
  ) {
    super(`Hard constraint '${constraintKind}' rejects source '${source}': ${detail}`);
  }
}

export class UnknownHardConstraintError extends Error {
  override readonly name = "UnknownHardConstraintError";
  constructor(public readonly constraintKind: string) {
    super(
      `Unknown hard constraint kind '${constraintKind}'. Known kinds: local_only, never_external_when_private_memscope, max_cost_per_run_usd, provider`,
    );
  }
}
