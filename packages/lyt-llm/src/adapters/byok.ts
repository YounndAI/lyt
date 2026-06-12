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

// BYOK adapter — direct provider keys managed by the user.
//
// Per arc-thoughts §6.12 L465 + §6.7 ("BYOK — table stakes for power users").
// The adapter is a thin wrapper around a user-supplied client; it does NOT
// hold credentials. Credentials live in the user's env or `~/lyt/machine.yon`
// (block-A.1 shape — see the LYT design doc `yai.lyt.md`
// `@IDENTITY` section).
//
// Why BYOK is distinct from ai-relay even though both call external providers:
// - ai-relay routes through @younndai/ai-relay's provider abstraction +
// model registry — uniform cost tracking, prompt-cache hints, model presets
// - BYOK gives the user a raw escape hatch — e.g. a corporate Anthropic
// Bedrock endpoint, a fine-tuned OpenAI deployment, a custom Cloudflare
// Workers AI gateway. The user owns the request shape entirely.
//
// For Commit 2 the client is fully injectable; block-B Commit 4 wires the
// concrete client at lyt-runner factory time when a BYOK config is present.

import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  LlmAdapter,
} from "../types.js";

export interface ByokClient {
  // The provider identifier surfaced into `GenerateResult.modelUsed` for the
  // audit trail. E.g. "anthropic", "openai", "bedrock", "azure-openai".
  readonly provider: string;
  generate(args: {
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
  embed?(args: { texts: string[]; model?: string }): Promise<{
    vectors: number[][];
    model: string;
    tokensIn: number;
    costUsd: number;
  }>;
}

export interface ByokAdapterConfig {
  client: ByokClient;
  defaultModel?: string;
  defaultEmbedModel?: string;
}

export function createByokAdapter(config: ByokAdapterConfig): LlmAdapter {
  return {
    source: "byok",
    supports(mode) {
      if (mode === "embed") return typeof config.client.embed === "function";
      return true;
    },
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const result = await config.client.generate({
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
        sourceUsed: "byok",
        modelUsed: `${config.client.provider}:${result.model}`,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
      };
    },
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      if (!config.client.embed) {
        throw new Error(
          `byok client (provider=${config.client.provider}) does not implement embed; pass an embed-capable client`,
        );
      }
      const result = await config.client.embed({
        texts: req.texts,
        ...(req.model !== undefined
          ? { model: req.model }
          : config.defaultEmbedModel
            ? { model: config.defaultEmbedModel }
            : {}),
      });
      return {
        vectors: result.vectors,
        sourceUsed: "byok",
        modelUsed: `${config.client.provider}:${result.model}`,
        tokensIn: result.tokensIn,
        costUsd: result.costUsd,
      };
    },
  };
}
