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

// Lane M Wave 0 (P0-a backfill) — one-time idempotent heal that
// re-reconciles an EXISTING vault's derived FTS5 cache to the markdown
// on disk. It heals the FTS CACHE ONLY (it does NOT touch the provenance
// ledger — provenance is the future opt-in tier; see
// reconcile-figment-write.ts). Pre-Lane-M pods accumulated stale / empty
// `figment_fts` because captures never wrote to the index (only `git
// pull` did). This flow brings an existing pod's search index back in
// sync without a pull. The watcher (sync-watch.ts) runs it once per
// watched vault on startup so a stale pod self-heals.
//
// It deliberately delegates to the existing FULL-WALK reconcile
// (`upsertFtsCache` — `walkMarkdownFiles` + `deleteAllFts` + re-insert).
// A full-walk truncate+reinsert is the correct shape for a one-time
// repair: it drops orphan rows (notes deleted off-disk while the index
// was stale) AND de-duplicates any rows the old bare-INSERT path left
// behind. The PER-WRITE path stays incremental
// (flows/reconcile-figment-write.ts) — full-walk is heal-only.
//
// Idempotent by construction: `upsertFtsCache` produces the same row set
// for the same on-disk state, so a second run is a no-op (identical
// counts; no duplicate rows).

import { upsertFtsCache } from "./upsert-fts-cache.js";

export interface BackfillFigmentCachesResult {
  vaultPath: string;
  // True when the vault had at least one note under `notes/` and the FTS
  // cache was (re)built. False when `notes/` is missing/empty.
  ran: boolean;
  // Number of figment rows written to the FTS cache.
  ftsDocsUpserted: number;
  durationMs: number;
}

export async function backfillFigmentCaches(
  vaultPath: string,
): Promise<BackfillFigmentCachesResult> {
  const res = await upsertFtsCache(vaultPath);
  return {
    vaultPath: res.vaultPath,
    ran: res.ran,
    ftsDocsUpserted: res.ftsDocsUpserted,
    durationMs: res.durationMs,
  };
}
