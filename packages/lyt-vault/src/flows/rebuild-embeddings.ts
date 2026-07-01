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

// feat/microrag-semantic — `rebuild-embeddings` flow. Thin orchestration wrapper
// around `upsertEmbeddingsCache`, mirroring rebuild-keyphrases.ts: resolve the
// registered vault, delegate the walk + embed + insert, return a shaped result.
// Open-once seam (v1.A.5 CR-B1): optional `registryDb?` / `lytDb?`.
//
// ARC-D2: this NEVER fails the surrounding rebuild when embeddings are absent —
// upsertEmbeddingsCache returns { ran:false, available:false } and we pass it
// through. rebuildVaultFlow only calls this when embeddings are ENABLED (config
// flag); even then, an unavailable local model is a clean skip.

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import {
  upsertEmbeddingsCache,
  type UpsertEmbeddingsCacheResult,
} from "./upsert-embeddings-cache.js";
import type { Embedder } from "../util/embeddings.js";

export interface RebuildEmbeddingsArgs {
  vault?: string;
  vaultPathOverride?: string;
  registryDb?: Client;
  lytDb?: Client;
  // Test seam — inject a pre-loaded embedder.
  embedder?: Embedder;
  // C-1 — VISIBLE fetch on the consented build path (threaded to
  // upsertEmbeddingsCache → loadEmbedder).
  showDownloadProgress?: boolean;
  // Phase E (C6) — optional embed-loop progress, threaded straight through
  // to upsertEmbeddingsCache → embedPassages. Lets a CLI caller surface
  // "embedding N/M". Optional/inert: absent → no behavior change.
  onProgress?: (done: number, total: number) => void;
  // Phase E (C6) — optional model-DOWNLOAD byte-progress, threaded through
  // to upsertEmbeddingsCache → loadEmbedder → fetchModel. Fires only on a
  // consented fetch (model absent). Inert when absent.
  onDownloadProgress?: (bytesDone: number, totalBytes: number) => void;
}

export interface RebuildEmbeddingsResult {
  vaultName: string;
  vaultPath: string;
  figmentsProcessed: number;
  embeddingRowsUpserted: number;
  ran: boolean;
  available: boolean;
  reason?: string;
  // Phase E fix-pass (release review R1 FIX 1) — structured fetch-failure signal
  // carried alongside `reason`, so the rebuild-vault terminal-phase mapper can label
  // a real fetch stall as `timed-out` instead of the dishonest `offline-deferred`.
  // Present only on a fetch-fail path; absent for non-fetch unavailability.
  classification?: "offline" | "stalled" | "locked" | "corrupt" | "error";
  durationMs: number;
}

export async function rebuildEmbeddingsFlow(
  args: RebuildEmbeddingsArgs,
): Promise<RebuildEmbeddingsResult> {
  const startedAt = Date.now();
  const { vaultName, vaultPath } = await resolveVault(args);

  const upsertOpts: {
    lytDb?: Client;
    embedder?: Embedder;
    showDownloadProgress?: boolean;
    onProgress?: (done: number, total: number) => void;
    onDownloadProgress?: (bytesDone: number, totalBytes: number) => void;
  } = {};
  if (args.lytDb !== undefined) upsertOpts.lytDb = args.lytDb;
  if (args.embedder !== undefined) upsertOpts.embedder = args.embedder;
  if (args.showDownloadProgress === true) upsertOpts.showDownloadProgress = true;
  if (args.onProgress !== undefined) upsertOpts.onProgress = args.onProgress;
  if (args.onDownloadProgress !== undefined) {
    upsertOpts.onDownloadProgress = args.onDownloadProgress;
  }
  const cacheRes: UpsertEmbeddingsCacheResult = await upsertEmbeddingsCache(vaultPath, upsertOpts);

  return {
    vaultName,
    vaultPath,
    figmentsProcessed: cacheRes.figmentsProcessed,
    embeddingRowsUpserted: cacheRes.embeddingRowsUpserted,
    ran: cacheRes.ran,
    available: cacheRes.available,
    ...(cacheRes.reason !== undefined ? { reason: cacheRes.reason } : {}),
    ...(cacheRes.classification !== undefined ? { classification: cacheRes.classification } : {}),
    durationMs: Date.now() - startedAt,
  };
}

interface ResolvedVault {
  vaultName: string;
  vaultPath: string;
}

async function resolveVault(args: RebuildEmbeddingsArgs): Promise<ResolvedVault> {
  if (args.vaultPathOverride !== undefined) {
    return {
      vaultName: args.vault ?? deriveVaultNameFromPath(args.vaultPathOverride),
      vaultPath: args.vaultPathOverride,
    };
  }
  if (args.vault === undefined) {
    throw new Error("rebuild-embeddings: either --vault <name> or vaultPathOverride is required.");
  }
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  let vault: VaultRow | null;
  try {
    vault = await getVaultByName(db, args.vault);
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
  if (!vault) {
    throw new Error(`rebuild-embeddings: no vault registered with name '${args.vault}'.`);
  }
  if (vault.status === "tombstoned") {
    throw new Error(`rebuild-embeddings: vault '${args.vault}' is tombstoned; cannot rebuild.`);
  }
  return { vaultName: vault.name, vaultPath: vault.path };
}

function deriveVaultNameFromPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts[parts.length - 1] ?? "vault";
}
