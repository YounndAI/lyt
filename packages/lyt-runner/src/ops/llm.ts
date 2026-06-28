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

// LLM op composition.
//
// Per arc-thoughts §6.12:489-494 (LOCKED 2026-05-27) `@younndai/lyt-llm`
// registers four ops with the underlying yon-runner via lyt-runner:
// std:llm.generate@v1 — real, delegates to gateway.generate
// std:llm.embed@v1 — real, delegates to gateway.embed
// std:llm.stream@v1 — stub-with-warning (block-D — gateway has
// no stream method yet; lyt-llm
// src/index.ts:9 documents the deferral)
// std:llm.generate_object@v1 — stub-with-warning (block-D — zod-schema
// structured output deferred per lyt-llm
// src/index.ts:9; brief clause (4))
//
// Real handlers convert @STEP-string args to LlmGateway request shape and
// surface the gateway's structured GenerateResult / EmbedResult unchanged
// so downstream stamps (block-B Commit 5 provenance hook) can record
// `tokensIn / tokensOut / costUsd / sourceUsed / modelUsed` per arc §6.9.

import type { ExecutionContext, OpHandler } from "@younndai/yon-runner";
import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  HardConstraint,
  LlmCapability,
  LlmGateway,
  LlmSource,
  MemscopeContext,
} from "@younndai/lyt-llm";

export interface LlmGenerateOpArgs {
  prompt: string;
  system?: string;
  capability?: LlmCapability;
  source_preference?: LlmSource[];
  hard_constraints?: HardConstraint[];
  memscope?: MemscopeContext;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface LlmEmbedOpArgs {
  texts: string[];
  source_preference?: LlmSource[];
  hard_constraints?: HardConstraint[];
  memscope?: MemscopeContext;
  model?: string;
}

export interface LlmStubResult {
  status: "stub";
  op: string;
  warning: string;
  args: Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string, op: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${op}: missing required string arg \`${key}\``);
  }
  return v;
}

function requireStringArray(args: Record<string, unknown>, key: string, op: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`${op}: required arg \`${key}\` must be a non-empty array of strings`);
  }
  for (const x of v) {
    if (typeof x !== "string") {
      throw new Error(`${op}: arg \`${key}\` entries must be strings`);
    }
  }
  return v as string[];
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  op: string,
): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${op}: arg \`${key}\` must be a finite number, got ${typeof v}`);
  }
  return v;
}

function buildGenerateRequest(args: Record<string, unknown>, op: string): GenerateRequest {
  const prompt = requireString(args, "prompt", op);
  const req: GenerateRequest = { prompt };
  const system = args["system"];
  if (typeof system === "string") req.system = system;
  const capability = args["capability"];
  if (typeof capability === "string") req.capability = capability as LlmCapability;
  const sourcePreference = args["source_preference"];
  if (Array.isArray(sourcePreference)) req.sourcePreference = sourcePreference as LlmSource[];
  const hardConstraints = args["hard_constraints"];
  if (Array.isArray(hardConstraints)) {
    req.hardConstraints = hardConstraints as HardConstraint[];
  }
  const memscope = args["memscope"];
  if (memscope && typeof memscope === "object") req.memscope = memscope as MemscopeContext;
  const model = args["model"];
  if (typeof model === "string") req.model = model;
  const maxTokens = optionalNumber(args, "max_tokens", op);
  if (maxTokens !== undefined) req.maxTokens = maxTokens;
  const temperature = optionalNumber(args, "temperature", op);
  if (temperature !== undefined) req.temperature = temperature;
  return req;
}

function buildEmbedRequest(args: Record<string, unknown>, op: string): EmbedRequest {
  const texts = requireStringArray(args, "texts", op);
  const req: EmbedRequest = { texts };
  const sourcePreference = args["source_preference"];
  if (Array.isArray(sourcePreference)) req.sourcePreference = sourcePreference as LlmSource[];
  const hardConstraints = args["hard_constraints"];
  if (Array.isArray(hardConstraints)) {
    req.hardConstraints = hardConstraints as HardConstraint[];
  }
  const memscope = args["memscope"];
  if (memscope && typeof memscope === "object") req.memscope = memscope as MemscopeContext;
  const model = args["model"];
  if (typeof model === "string") req.model = model;
  return req;
}

export function createLlmOps(gateway: LlmGateway | undefined): Record<string, OpHandler> {
  return {
    "llm.generate": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<GenerateResult> => {
      if (gateway === undefined) {
        throw new Error(
          "std:llm.generate@v1: no LlmGateway wired in LytRuntime; pass config.llmGateway to createLytRunner()",
        );
      }
      const req = buildGenerateRequest(args, "std:llm.generate@v1");
      return gateway.generate(req);
    },
    "llm.embed": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<EmbedResult> => {
      if (gateway === undefined) {
        throw new Error(
          "std:llm.embed@v1: no LlmGateway wired in LytRuntime; pass config.llmGateway to createLytRunner()",
        );
      }
      const req = buildEmbedRequest(args, "std:llm.embed@v1");
      return gateway.embed(req);
    },
    "llm.stream": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<LlmStubResult> => {
      // Per lyt-llm/src/index.ts:9 the gateway has no `stream` method in
      // Commit 2 — streaming surface lands at block-D. The op exists so
      // @AUTOMATOR authors can register the intent now; the stub surfaces a
      // structured warning rather than failing the runner.
      return {
        status: "stub",
        op: "std:llm.stream@v1",
        warning:
          "std:llm.stream@v1 is not yet implemented; a streaming surface is planned for a future release.",
        args,
      };
    },
    "llm.generate_object": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<LlmStubResult> => {
      // Per lyt-llm/src/index.ts:9 zod-schema structured output is deferred
      // to block-D. Same stub-with-warning shape as llm.stream.
      return {
        status: "stub",
        op: "std:llm.generate_object@v1",
        warning:
          "std:llm.generate_object@v1 is not yet implemented; schema-structured output is planned for a future release.",
        args,
      };
    },
  };
}
