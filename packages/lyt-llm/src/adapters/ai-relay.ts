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

// ai-relay adapter — composes @younndai/ai-relay (Vercel AI SDK substrate).
//
// Covers external providers Anthropic / OpenAI / Google (arc-thoughts §6.12
// L460-462). The real wiring uses @younndai/ai-relay's `generate` + `embed`
// functions; for Commit 2 the adapter takes both as injectable handles so
// unit tests can drive it without provider credentials. Block-B Commit 4
// wires the real handles at lyt-runner factory time.
//
// Why injectable: the brief's Forbidden actions #9 forbids "Ollama runtime
// dep that ships in v1"; same principle applied here — credentials must
// live at the caller (the user's env or `~/lyt/machine.yon`), not inside
// this package. The adapter is pure routing + tokenisation glue.

import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  LlmAdapter,
} from "../types.js";

export interface AiRelayGenerateFn {
  (args: {
    prompt: string;
    system?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{
    text: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }>;
}

export interface AiRelayEmbedFn {
  (args: { texts: string[]; model?: string }): Promise<{
    vectors: number[][];
    model: string;
    tokensIn: number;
    costUsd: number;
  }>;
}

export interface AiRelayAdapterConfig {
  generate: AiRelayGenerateFn;
  embed?: AiRelayEmbedFn;
  // Default model when the request doesn't pin one. The provider preset
  // (cheap / deep / structured) maps via @younndai/ai-relay's resolveModel;
  // the gateway leaves model resolution to ai-relay and only surfaces the
  // chosen ID via GenerateResult.modelUsed for audit.
  defaultModel?: string;
}

export function createAiRelayAdapter(config: AiRelayAdapterConfig): LlmAdapter {
  return {
    source: "ai-relay",
    supports(mode) {
      if (mode === "embed") return Boolean(config.embed);
      return true;
    },
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const result = await config.generate({
        prompt: req.prompt,
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.model !== undefined
          ? { model: req.model }
          : config.defaultModel
            ? { model: config.defaultModel }
            : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      });
      return {
        text: result.text,
        sourceUsed: "ai-relay",
        modelUsed: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
      };
    },
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      if (!config.embed) {
        throw new Error(
          "ai-relay adapter constructed without an embed handle; pass `embed` in AiRelayAdapterConfig",
        );
      }
      const result = await config.embed({
        texts: req.texts,
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
      return {
        vectors: result.vectors,
        sourceUsed: "ai-relay",
        modelUsed: result.model,
        tokensIn: result.tokensIn,
        costUsd: result.costUsd,
      };
    },
  };
}
