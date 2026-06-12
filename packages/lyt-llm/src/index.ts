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

// @younndai/lyt-llm — public entry point.
//
// Per arc-thoughts §6.12 (LOCKED 2026-05-27): a multi-source LLM gateway
// composing four adapters (ai-relay external / Ollama local / Harness
// CC-Codex / BYOK) behind a single createLlmGateway() surface.
//
// In Commit 2 the gateway ships standalone. The lyt-runner op composition
// (`std:llm.generate@v1`, `std:llm.stream@v1`, `std:llm.generate_object@v1`,
// `std:llm.embed@v1`) is deferred to block-B Commit 4 alongside the 5-step
// protocol — Commit 4 imports `createLlmGateway` + `registerLlmOps(runner,
// gateway)` (the latter shipped here in a future iteration) and wires them
// into the lyt-runner factory's `createLytRunner(config)`.
//
// Reference: zen-runner/src/index.ts L200-300 is the canonical Pattern A
// composition template; this gateway mirrors its factory + injected-deps
// shape so lyt-runner can compose both with identical ergonomics.

import { createCostTracker, type CostTracker } from "./cost-budget.js";
import { DEFAULT_SOURCE_PREFERENCE, selectAdapter } from "./routing.js";
import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  LlmAdapter,
  LlmGateway,
  LlmGatewayConfig,
  LlmSource,
} from "./types.js";

export function createLlmGateway(config: LlmGatewayConfig = {}): LlmGateway {
  const adapters: Partial<Record<LlmSource, LlmAdapter>> = { ...(config.adapters ?? {}) };
  const defaultPreference = config.preference ?? [...DEFAULT_SOURCE_PREFERENCE];
  const tracker: CostTracker = createCostTracker(config.costBudget);

  function preferenceFor(req: { sourcePreference?: LlmSource[] }): LlmSource[] {
    return req.sourcePreference && req.sourcePreference.length > 0
      ? req.sourcePreference
      : defaultPreference;
  }

  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const adapter = selectAdapter({
        mode: "generate",
        preference: preferenceFor(req),
        adapters,
        ...(req.hardConstraints !== undefined ? { hardConstraints: req.hardConstraints } : {}),
        ...(req.memscope !== undefined ? { memscope: req.memscope } : {}),
      });
      // Pre-flight budget check. Per arc §6.7 cost-shape lock the per-run
      // hard-stop fires BEFORE the call so we never burn cost on a request
      // that's already over budget. The estimate is 0 here — we don't have
      // a cheap pre-call cost estimate without tokenising the prompt
      // (block-D will integrate @younndai/ai-relay's `estimateCost`); the
      // assertWithin(0) call still throws if accumulated already exceeds
      // the budget (edge case after a previous call put us over).
      tracker.assertWithin(0);
      const result = await adapter.generate(req);
      tracker.record(result.costUsd);
      return result;
    },
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      const adapter = selectAdapter({
        mode: "embed",
        preference: preferenceFor(req),
        adapters,
        ...(req.hardConstraints !== undefined ? { hardConstraints: req.hardConstraints } : {}),
        ...(req.memscope !== undefined ? { memscope: req.memscope } : {}),
      });
      tracker.assertWithin(0);
      const result = await adapter.embed(req);
      tracker.record(result.costUsd);
      return result;
    },
    totalCostUsd() {
      return tracker.totalUsd();
    },
    totalCalls() {
      return tracker.callCount();
    },
    resetCostTracker() {
      tracker.reset();
    },
    registeredSources() {
      return (Object.keys(adapters) as LlmSource[]).filter((s) => adapters[s] !== undefined);
    },
  };
}

// Re-export the full public type surface so consumers (lyt-runner Commit 4,
// the future lyt-llm op composition module, the brief's gold-standard
// smoke test) can import everything from `@younndai/lyt-llm`.
export type {
  CostBudget,
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  HardConstraint,
  LlmAdapter,
  LlmCapability,
  LlmGateway,
  LlmGatewayConfig,
  LlmSource,
  MemscopeContext,
} from "./types.js";

export {
  CostBudgetExceededError,
  HardConstraintViolationError,
  NoEligibleAdapterError,
  UnknownHardConstraintError,
} from "./types.js";

export { createCostTracker, type CostTracker } from "./cost-budget.js";

export {
  DEFAULT_SOURCE_PREFERENCE,
  firstViolation,
  selectAdapter,
  type SelectAdapterArgs,
} from "./routing.js";

export {
  createAiRelayAdapter,
  createOllamaAdapter,
  createHarnessAdapter,
  createByokAdapter,
  OllamaUnreachableError,
  OllamaHttpError,
  type AiRelayAdapterConfig,
  type AiRelayGenerateFn,
  type AiRelayEmbedFn,
  type OllamaAdapterConfig,
  type FetchLike,
  type HarnessAdapterConfig,
  type HarnessInvokeArgs,
  type HarnessInvokeResult,
  type HarnessInvokeFn,
  type ByokAdapterConfig,
  type ByokClient,
} from "./adapters/index.js";
