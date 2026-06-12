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

// harness adapter — Claude Code / Codex skill invocation.
//
// Per arc-thoughts §6.12 L463-464 + §6.7 ("STRONGEST adoption lever — use the
// €20 you already pay"). The harness adapter calls into the user's existing
// CC/Codex skill bridge so an automator running under e.g. `claude` already
// has billed LLM access — zero marginal cost from the Lyt side.
//
// The bridge surface is intentionally tiny: a single `invokeSkill(args)`
// function that returns text + diagnostic counts. Block-B Commit 4 wires the
// real bridge (process-stdin streaming to the parent CC session); for Commit
// 2 the bridge is fully injectable so unit tests pass a fake.
//
// Harness does NOT support embeddings — CC/Codex skills don't expose an
// embedding API. The brief's @TASK clause (4) covers ai-relay + ollama for
// std:llm.embed; harness is generate-only.

import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  LlmAdapter,
} from "../types.js";

export interface HarnessInvokeArgs {
  prompt: string;
  system?: string;
  // The harness skill name to dispatch to. Defaults are CC's `/llm-grunt` for
  // capability=grunt, `/llm-reason` for capability=reasoning. The Lyt-side
  // skill package (block-B Commit 6 wires `lyt automator run` to call this)
  // ships the actual skill names; this adapter just maps capability → name.
  skill: string;
}

export interface HarnessInvokeResult {
  text: string;
  // The CC/Codex model identifier (e.g. "claude-sonnet-4-6"). May be omitted
  // if the bridge doesn't surface it — the adapter falls back to
  // "harness:<skill>".
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export type HarnessInvokeFn = (args: HarnessInvokeArgs) => Promise<HarnessInvokeResult>;

export interface HarnessAdapterConfig {
  invokeSkill: HarnessInvokeFn;
  // Per-capability skill-name override. The bridge is free-form; these are
  // just sensible defaults matching the lyt-skills package shape (block-B
  // Commit 6 wires the actual skill names).
  skillForCapability?: Partial<Record<"grunt" | "reasoning" | "structured", string>>;
}

const DEFAULT_SKILLS = {
  grunt: "lyt-llm-grunt",
  reasoning: "lyt-llm-reason",
  structured: "lyt-llm-structured",
} as const;

export function createHarnessAdapter(config: HarnessAdapterConfig): LlmAdapter {
  const skills = { ...DEFAULT_SKILLS, ...config.skillForCapability };

  return {
    source: "harness",
    supports(mode) {
      // Embeddings are not exposed via CC/Codex skill APIs — embed routes to
      // ai-relay / ollama instead. Generate is fully supported.
      return mode === "generate";
    },
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const cap: "grunt" | "reasoning" | "structured" =
        req.capability === "reasoning" || req.capability === "structured"
          ? req.capability
          : "grunt";
      const skill = skills[cap];
      const result = await config.invokeSkill({
        prompt: req.prompt,
        ...(req.system !== undefined ? { system: req.system } : {}),
        skill,
      });
      return {
        text: result.text,
        sourceUsed: "harness",
        modelUsed: result.model ?? `harness:${skill}`,
        tokensIn: result.tokensIn ?? 0,
        tokensOut: result.tokensOut ?? 0,
        // Zero marginal $ cost — the user's CC/Codex subscription absorbs it.
        // Per arc §6.7 cost-shape table this is the STRONGEST adoption lever.
        costUsd: 0,
      };
    },
    async embed(_req: EmbedRequest): Promise<EmbedResult> {
      throw new Error(
        "harness adapter does not support embeddings — route embed via ai-relay or ollama",
      );
    },
  };
}
