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

// Phase E Unit 3 (plan C6) — the VERSIONED `lyt reindex --json` schema.
//
// ONE zod definition, shared by BOTH:
//   • the command emit-path (`packages/lyt/src/commands/reindex.ts` builds an
//     envelope that conforms to this schema), and
//   • the agent skill consumer (the `lyt-search` / reindex SKILL.md harness
//     parses `--json` with this schema to voice model + index + nudge state).
// A single source = no drift between what we emit and what the agent expects.
//
// The envelope carries a `schemaVersion` so a future field add/rename is a
// VERSION BUMP, not a silent break: an agent pins the version it understands and
// fails loud on an unknown one. The schema IS the test (Unit 3): a test
// validates a REAL emitted `--json` payload against `ReindexJsonSchema`.
//
// Payload = model + index + nudge-trace (plan C6):
//   • model — the embeddings build outcome per vault (the one-time local model
//     id/dim, whether it ran/was available, and why not). This is the "model"
//     facet the agent reads to voice "semantic on/off".
//   • index — the lexical content-tier counts per vault (lanes/arcs/fts/rollup).
//   • nudge — the OPTIONAL Phase-D discovery-nudge decision-trace (reused shape,
//     single source via NudgeDecisionTrace), present only when a nudge surface
//     ran; absent on a deterministic/non-nudge reindex.

import { z } from "zod";

import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from "./embeddings.js";
import { NudgeDecisionTraceSchema, type NudgeDecisionTraceJson } from "./nudge-json-schema.js";
import type { ReindexResult } from "../flows/reindex.js";

// The current schema version. Bump on any structural change to the payload.
export const REINDEX_JSON_SCHEMA_VERSION = 1 as const;

// Per-vault MODEL facet — the embeddings build outcome. Mirrors
// RebuildEmbeddingsResult's surfaced fields. `built` true ⇔ vectors written;
// `available` false ⇔ the model was absent/failed (lexical fallback) with a
// `reason`. `modelId`/`dim` are present whenever embeddings were attempted.
// Phase E fix-pass (release review R3 FIX 4) — `.strict()` rejects an unknown
// key at the consumer/test boundary, hardening the single-source contract: an
// emit-path field added without a schema bump fails loud instead of passing
// silently. The builder is a closed whitelist, so the round-trip still passes.
const ModelFacetSchema = z
  .object({
    built: z.boolean(),
    available: z.boolean(),
    modelId: z.string(),
    dim: z.number().int().positive(),
    figmentsEmbedded: z.number().int().nonnegative(),
    reason: z.string().optional(),
  })
  .strict();

// Per-vault INDEX facet — the lexical content-tier counts.
const IndexFacetSchema = z
  .object({
    lanesWritten: z.number().int().nonnegative(),
    arcsWritten: z.number().int().nonnegative(),
    ftsDocsInserted: z.number().int().nonnegative(),
    rollupRowsWritten: z.number().int().nonnegative(),
  })
  .strict();

const VaultEntrySchema = z
  .object({
    vaultName: z.string(),
    index: IndexFacetSchema,
    // model is null when the embeddings build was skipped entirely (disabled /
    // no notes / non-interactive model-absent) — the common base-pod case.
    model: ModelFacetSchema.nullable(),
  })
  .strict();

const SkippedFrozenSchema = z.object({
  name: z.string(),
  frozenUntil: z.string().nullable(),
});

// The full versioned envelope.
export const ReindexJsonSchema = z
  .object({
    schemaVersion: z.literal(REINDEX_JSON_SCHEMA_VERSION),
    scope: z.enum(["all", "mesh", "vault"]),
    target: z.string().nullable(),
    vaultsReindexed: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    vaults: z.array(VaultEntrySchema),
    vaultsSkippedFrozen: z.array(SkippedFrozenSchema),
    // The OPTIONAL discovery-nudge decision-trace (Phase-D shape, single source).
    // Present only when a nudge surface ran; absent on a plain reindex.
    nudge: NudgeDecisionTraceSchema.optional(),
  })
  .strict();

export type ReindexJson = z.infer<typeof ReindexJsonSchema>;
export type ReindexJsonModelFacet = z.infer<typeof ModelFacetSchema>;
export type ReindexJsonVaultEntry = z.infer<typeof VaultEntrySchema>;

// Re-export the model constants so an emit-path builder fills modelId/dim from
// the SAME source the embedder uses (no literal drift).
export { EMBEDDING_DIM, EMBEDDING_MODEL_ID };

// Build the versioned `--json` envelope from a ReindexResult. ONE construction,
// shared by the command emit-path AND the schema test — so the emitted payload
// and the validated shape can never drift. `nudge` is threaded through only when
// a nudge surface ran (optional). The output is guaranteed to conform to
// ReindexJsonSchema (the test asserts it).
export function buildReindexJson(
  result: ReindexResult,
  opts: { nudge?: NudgeDecisionTraceJson } = {},
): ReindexJson {
  const env: ReindexJson = {
    schemaVersion: REINDEX_JSON_SCHEMA_VERSION,
    scope: result.scope,
    target: result.target,
    vaultsReindexed: result.vaultsReindexed,
    durationMs: result.durationMs,
    vaults: result.vaults.map((v) => ({
      vaultName: v.vaultName,
      index: {
        lanesWritten: v.lanes.lanesWritten,
        arcsWritten: v.arcs.arcsWritten,
        ftsDocsInserted: v.fts.ftsDocsInserted,
        rollupRowsWritten: v.rollup.rollupRowsWritten,
      },
      model:
        v.embeddings === null
          ? null
          : {
              built: v.embeddings.ran,
              available: v.embeddings.available,
              modelId: EMBEDDING_MODEL_ID,
              dim: EMBEDDING_DIM,
              figmentsEmbedded: v.embeddings.figmentsProcessed,
              ...(v.embeddings.reason !== undefined ? { reason: v.embeddings.reason } : {}),
            },
    })),
    vaultsSkippedFrozen: result.vaultsSkippedFrozen.map((s) => ({
      name: s.name,
      frozenUntil: s.frozenUntil,
    })),
    ...(opts.nudge !== undefined ? { nudge: opts.nudge } : {}),
  };
  return env;
}
