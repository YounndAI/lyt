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

// feat/microrag-semantic — embeddings cache repo.
//
// Stores one per-figment dense vector (bge-small-en-v1.5, 384-dim) so the
// search cascade can run an OPTIONAL dense-retrieval arm and confidence-gated
// fusion (see flows/search-cascade.ts). Posture (Lock 0.2): a derived cache
// over the markdown SoT, rebuilt by the same full-walk cadence as keyphrases —
// but only POPULATED when embeddings are enabled + the local model is available
// (ARC-D2). An absent/empty table makes dense retrieval a clean no-op.
//
// `figment_rid` is the vault-relative POSIX path (same key shape as
// figment_fts.figment_rid / keyphrases.figment_rid). The vector is stored as a
// plain BLOB of raw little-endian Float32 bytes; cosine is computed in JS over
// the loaded vectors (libSQL @0.15.15 has no native vector ops). Mirrors
// keyphrases-repo.ts: whole-table truncate for the full-walk rebuild, plus a
// delete-by-path + atomic replace primitive for a future per-write reconcile.

import type { Client, InValue } from "@libsql/client";

import { blobToVector, vectorToBlob } from "../util/embeddings.js";

export interface EmbeddingRow {
  figmentRid: string;
  vector: Float32Array;
}

// Whole-table truncate — invoked by the full-walk rebuild so the cache reflects
// the SoT verbatim (drops figments removed on disk between rebuilds, and clears
// stale vectors when embeddings get disabled then a rebuild runs).
export async function deleteAllEmbeddings(db: Client): Promise<number> {
  const res = await db.execute("DELETE FROM embeddings");
  return Number(res.rowsAffected);
}

// Delete-by-figment primitive — reserved for the deferred per-write reconcile
// path (on delete, or as the first half of an idempotent replace).
export async function deleteEmbeddingByPath(db: Client, figmentRid: string): Promise<number> {
  const res = await db.execute({
    sql: "DELETE FROM embeddings WHERE figment_rid = ?",
    args: [figmentRid],
  });
  return Number(res.rowsAffected);
}

// Idempotent upsert of one figment's vector (atomic replace). `bodyHash` lets a
// future incremental path skip unchanged docs. Stores the raw Float32 bytes.
export async function upsertEmbeddingForFigment(
  db: Client,
  figmentRid: string,
  vector: Float32Array,
  bodyHash: string,
): Promise<void> {
  const blob = vectorToBlob(vector);
  await db.execute({
    sql: `INSERT INTO embeddings (figment_rid, dim, body_hash, vec)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(figment_rid) DO UPDATE SET
            dim = excluded.dim,
            body_hash = excluded.body_hash,
            vec = excluded.vec`,
    args: [figmentRid, vector.length, bodyHash, blob as unknown as InValue],
  });
}

export async function countEmbeddings(db: Client): Promise<number> {
  const res = await db.execute("SELECT COUNT(*) AS n FROM embeddings");
  const row = res.rows[0];
  if (row === undefined) return 0;
  return Number(row["n"] as number | bigint);
}

// Load the ENTIRE per-vault embedding cache as { figment_rid, vector }[]. The
// cascade calls this once per in-scope vault inside its dense arm, then cosine-
// ranks the query vector against every doc vector. A vault with no embeddings
// (base pod, or embeddings never built) yields an empty array → the dense arm
// contributes nothing for that vault (graceful no-op, not an error).
export async function loadAllEmbeddings(db: Client): Promise<EmbeddingRow[]> {
  const res = await db.execute("SELECT figment_rid, vec FROM embeddings");
  const out: EmbeddingRow[] = [];
  for (const r of res.rows) {
    const path = r["figment_rid"] as string;
    const raw = r["vec"] as Uint8Array | ArrayBuffer;
    out.push({ figmentRid: path, vector: blobToVector(raw) });
  }
  return out;
}
