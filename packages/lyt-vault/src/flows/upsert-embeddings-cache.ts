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

// feat/microrag-semantic — `upsertEmbeddingsCache` full-walk dense-vector cache
// refresh. Walks `<vault>/notes/**/*.md`, derives each figment's FTS-identical
// body via extractFtsBody (so the dense corpus is exactly the searchable prose
// the FTS + keyphrase arms see — no drift), embeds it with the local model, and
// reflects the vector into lyt.db's `embeddings` table.
//
// ARC-D2 (the load-bearing optional/lazy contract): this flow is a clean NO-OP
// when embeddings are unavailable. It first asks loadEmbedder() — if fastembed
// is absent, offline-with-no-cached-model, or the runtime fails to load, it
// returns { ran: false, available: false, reason } WITHOUT touching the table
// and WITHOUT throwing. The base pod therefore builds + searches with zero
// embeddings present and no error. The ~23MB model is lazy-fetched on first
// successful init (see util/embeddings.ts), never bundled.
//
// Mirrors upsert-keyphrases-cache.ts: same walk, same extractFtsBody body, same
// scaffold-note exclusion (via walkVaultMarkdownFiles), same open-once seam,
// same truncate-then-insert idempotence (Lock 0.2). Determinism: BGE int8 ONNX
// inference is deterministic for fixed input on a fixed model — a second call
// on the same vault state produces the identical vectors (no Date.now/random).

import { readFileSync } from "node:fs";

import type { Client } from "@libsql/client";

import { closeVaultDb, openLytDb } from "../registry/vault-db.js";
import { deleteAllEmbeddings, upsertEmbeddingForFigment } from "../registry/embeddings-repo.js";
import { extractFtsBody, toVaultRelPosix, walkVaultFigmentFiles } from "./upsert-fts-cache.js";
import { loadEmbedder, type Embedder } from "../util/embeddings.js";

export interface UpsertEmbeddingsCacheResult {
  vaultPath: string;
  // True when the local model was available AND at least one note was embedded.
  // False when the model is unavailable (graceful skip) OR the notes/ dir is
  // empty — the caller treats either as a no-op.
  ran: boolean;
  // Whether the local embedder was available at all (ARC-D2 surface): false →
  // dense skipped, lexical-only path unchanged. `reason` explains why.
  available: boolean;
  reason?: string;
  figmentsProcessed: number;
  embeddingRowsUpserted: number;
  durationMs: number;
}

export interface UpsertEmbeddingsCacheOpts {
  // Open-once seam (v1.A.5 CR-B1 pattern).
  lytDb?: Client;
  // Test seam — inject a pre-loaded embedder (skips loadEmbedder()).
  embedder?: Embedder;
  // C-1 — VISIBLE fetch on the consented build path. When true, the
  // loadEmbedder() call surfaces fastembed's download bar (the HIL branch sets
  // this after the handler consents on a TTY). Default-undefined keeps the
  // prior silent behavior.
  showDownloadProgress?: boolean;
}

// Cheap deterministic content hash for the body text (FNV-1a over the embedded
// text), stored alongside the vector so a future incremental path can skip
// unchanged docs. Not used for skip yet (full-walk truncate-then-insert).
function bodyHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// The exact text embedded per figment — the FTS-identical body, VERBATIM as the
// proven prototype embedded it (.scratch/microrag-eval.mts: it embedded
// extractFtsBody(rawOnDisk).body with a "(empty)" sentinel, and NOT the title).
// Matching this byte-for-byte is load-bearing for reproducing the measured lift:
// folding the title in shifts the vectors and measurably lowers the oracle
// nDCG@5 (0.547 with title vs 0.55→0.60 band body-only). So: body only.
function embedText(body: string): string {
  return body && body.trim().length > 0 ? body : "(empty)";
}

export async function upsertEmbeddingsCache(
  vaultPath: string,
  opts: UpsertEmbeddingsCacheOpts = {},
): Promise<UpsertEmbeddingsCacheResult> {
  const startedAt = Date.now();

  // C-1 (no-notes guard, moved AHEAD of loadEmbedder) — an EMPTY vault has
  // nothing to embed, so there is no reason to load (and possibly FETCH) the
  // ~23MB model. The empty-check therefore runs BEFORE the embedder resolve:
  // walk first, and if there are no note files, skip cleanly WITHOUT touching
  // loadEmbedder(). This closes the C-1 chain where `lyt reindex` on a fresh
  // (note-less) vault silently downloaded the model. (Was: loadEmbedder ran
  // first, the empty-check second — so the fetch happened even with 0 notes.)
  const noteFiles = walkVaultFigmentFiles(vaultPath);
  if (noteFiles.length === 0) {
    return {
      vaultPath,
      ran: false,
      available: true,
      figmentsProcessed: 0,
      embeddingRowsUpserted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  // ARC-D2: resolve the local embedder. Unavailable → clean skip, no table
  // touch, no throw. Notes exist (guarded above), so a load here is justified.
  let embedder: Embedder;
  if (opts.embedder !== undefined) {
    embedder = opts.embedder;
  } else {
    const load = await loadEmbedder(
      opts.showDownloadProgress === true ? { showDownloadProgress: true } : {},
    );
    if (!load.available) {
      return {
        vaultPath,
        ran: false,
        available: false,
        reason: load.reason,
        figmentsProcessed: 0,
        embeddingRowsUpserted: 0,
        durationMs: Date.now() - startedAt,
      };
    }
    embedder = load.embedder;
  }

  // Gather the per-doc text first (the embed is batched).
  const docs: { relPath: string; text: string }[] = [];
  for (const abs of noteFiles) {
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const relPath = toVaultRelPosix(abs, vaultPath);
    const { body } = extractFtsBody(content);
    docs.push({ relPath, text: embedText(body) });
  }

  let vectors: Float32Array[];
  try {
    vectors = await embedder.embedPassages(docs.map((d) => d.text));
  } catch (err) {
    // A mid-embed runtime failure also degrades cleanly — leave the table
    // untouched (we have not truncated yet) and report unavailable.
    return {
      vaultPath,
      ran: false,
      available: false,
      reason: `embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      figmentsProcessed: 0,
      embeddingRowsUpserted: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  if (vectors.length !== docs.length) {
    return {
      vaultPath,
      ran: false,
      available: false,
      reason: `embed count mismatch: ${vectors.length} vectors for ${docs.length} docs`,
      figmentsProcessed: 0,
      embeddingRowsUpserted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const callerSupplied = opts.lytDb !== undefined;
  const db = opts.lytDb ?? (await openLytDb(vaultPath));
  let embeddingRowsUpserted = 0;
  try {
    // Truncate first so the cache reflects the SoT verbatim.
    await deleteAllEmbeddings(db);
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i]!;
      await upsertEmbeddingForFigment(db, d.relPath, vectors[i]!, bodyHash(d.text));
      embeddingRowsUpserted += 1;
    }
  } finally {
    if (!callerSupplied) await closeVaultDb(db);
  }

  return {
    vaultPath,
    ran: true,
    available: true,
    figmentsProcessed: docs.length,
    embeddingRowsUpserted,
    durationMs: Date.now() - startedAt,
  };
}
