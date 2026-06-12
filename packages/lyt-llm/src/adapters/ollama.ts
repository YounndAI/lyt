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

// ollama adapter — OpenAI-compatible HTTP client.
//
// Per arc-thoughts §6.12 L498-499 + brief Forbidden #9-#10: NO Ollama runtime
// dependency. The user provides their own Ollama install at the configured
// endpoint (default http://localhost:11434). This adapter is pure HTTP +
// response parsing; the `fetch` impl is injectable so tests don't require
// a running server.
//
// Endpoint contract: the adapter targets the OpenAI-compatible
// `/v1/chat/completions` shape (Ollama 0.5+) so the same payload works
// against vLLM / LM Studio / any other OpenAI-API-compatible server. Cost
// is zero (local compute); token counts come from the server response.

import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  LlmAdapter,
} from "../types.js";

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OllamaAdapterConfig {
  // Injectable so unit tests pass a fake; production passes globalThis.fetch.
  fetchImpl: FetchLike;
  endpoint?: string; // default "http://localhost:11434"
  defaultModel?: string; // e.g. "llama3.1:8b"
  embedModel?: string; // e.g. "nomic-embed-text"
  // Reserved for the brief's `LYT_TEST_LIVE=1` env gate (Open Decision #5
  // default). Block-B Commit 7 wires the env-gated live smoke; Commit 2
  // ships the field declaration only.
  liveSmoke?: boolean;
}

export class OllamaUnreachableError extends Error {
  override readonly name = "OllamaUnreachableError";
  constructor(endpoint: string, cause: unknown) {
    super(`Ollama endpoint unreachable at ${endpoint}: ${stringifyCause(cause)}`);
  }
}

export class OllamaHttpError extends Error {
  override readonly name = "OllamaHttpError";
  constructor(
    public readonly status: number,
    body: unknown,
  ) {
    super(`Ollama HTTP ${status}: ${stringifyCause(body)}`);
  }
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

const DEFAULT_ENDPOINT = "http://localhost:11434";

export function createOllamaAdapter(config: OllamaAdapterConfig): LlmAdapter {
  const endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");

  async function post(path: string, body: unknown): Promise<unknown> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await config.fetchImpl(`${endpoint}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OllamaUnreachableError(endpoint, err);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "<unparseable>" }));
      throw new OllamaHttpError(res.status, body);
    }
    return await res.json();
  }

  return {
    source: "ollama",
    supports(mode) {
      if (mode === "embed") return Boolean(config.embedModel);
      return true;
    },
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const model = req.model ?? config.defaultModel;
      if (!model) {
        throw new Error(
          "ollama adapter requires either GenerateRequest.model or OllamaAdapterConfig.defaultModel",
        );
      }
      const messages: { role: string; content: string }[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      messages.push({ role: "user", content: req.prompt });

      const payload = await post("/v1/chat/completions", {
        model,
        messages,
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      });
      const parsed = parseChatCompletion(payload);

      return {
        text: parsed.text,
        sourceUsed: "ollama",
        modelUsed: parsed.model ?? model,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        // Local compute — zero marginal $ cost per arc §6.7 cost-shape table.
        // Hardware cost is the user's responsibility and not surfaced here.
        costUsd: 0,
      };
    },
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      const model = req.model ?? config.embedModel;
      if (!model) {
        throw new Error(
          "ollama adapter requires either EmbedRequest.model or OllamaAdapterConfig.embedModel for embeddings",
        );
      }
      const payload = await post("/v1/embeddings", {
        model,
        input: req.texts,
      });
      const parsed = parseEmbeddings(payload);
      return {
        vectors: parsed.vectors,
        sourceUsed: "ollama",
        modelUsed: parsed.model ?? model,
        tokensIn: parsed.tokensIn,
        costUsd: 0,
      };
    },
  };
}

interface ChatCompletionParsed {
  text: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
}

function parseChatCompletion(payload: unknown): ChatCompletionParsed {
  if (!payload || typeof payload !== "object") {
    throw new Error(`ollama: unparseable chat-completion response: ${JSON.stringify(payload)}`);
  }
  const p = payload as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = p.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error(
      `ollama: chat-completion missing choices[0].message.content: ${JSON.stringify(payload)}`,
    );
  }
  return {
    text,
    ...(p.model ? { model: p.model } : {}),
    tokensIn: p.usage?.prompt_tokens ?? 0,
    tokensOut: p.usage?.completion_tokens ?? 0,
  };
}

interface EmbedParsed {
  vectors: number[][];
  model?: string;
  tokensIn: number;
}

function parseEmbeddings(payload: unknown): EmbedParsed {
  if (!payload || typeof payload !== "object") {
    throw new Error(`ollama: unparseable embeddings response: ${JSON.stringify(payload)}`);
  }
  const p = payload as {
    data?: { embedding?: number[] }[];
    model?: string;
    usage?: { prompt_tokens?: number };
  };
  const vectors = (p.data ?? []).map((d, idx) => {
    if (!Array.isArray(d.embedding)) {
      throw new Error(`ollama: data[${idx}].embedding is not a vector`);
    }
    return d.embedding;
  });
  return {
    vectors,
    ...(p.model ? { model: p.model } : {}),
    tokensIn: p.usage?.prompt_tokens ?? 0,
  };
}
