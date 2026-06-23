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

// `lyt sync` post-pull hook — walks YON ledgers and upserts new records
// into the per-vault libSQL cache.
//
// Closes master-plan §v1.A.2 acceptance item 4: `lyt sync` post-pull
// triggers DB upsert. Called by lyt-mesh/src/flows/sync.ts after a
// successful `git pull --rebase --quiet` lands new audit.yon / provenance.yon
// records from collaborators (or other machines the same handler owns).
//
// Idempotent — natural-key probes prevent duplicate injection. Safe to
// re-run on every sync.

import { reinjectAuditRecord, walkAllAuditShards } from "../registry/audit-write.js";
import {
  mapAuditYonToCacheArgs,
  mapProvenanceYonToCacheArgs,
} from "../registry/_helpers/ledger-yon-mapper.js";
import { reinjectProvenanceRecord, walkAllProvenanceShards } from "../registry/provenance-write.js";
import { closeVaultDb, openAuditDb, openProvenanceDb } from "../registry/vault-db.js";

export interface UpsertLedgerCacheResult {
  vaultPath: string;
  auditUpserted: number;
  provenanceUpserted: number;
  durationMs: number;
}

export async function upsertLedgerCache(vaultPath: string): Promise<UpsertLedgerCacheResult> {
  const startedAt = Date.now();
  let auditUpserted = 0;
  let provenanceUpserted = 0;
  // v1.A.2c DB SPLIT: audit + provenance live in separate per-ledger .db
  // caches under .lyt/indexes/. Open both; reverse-acquire close order to
  // play nicely with Windows file-lock release semantics.
  const auditDb = await openAuditDb(vaultPath);
  const provenanceDb = await openProvenanceDb(vaultPath);
  try {
    // Slice 2b: walk all per-writerId shards + legacy flat file.
    for (const r of walkAllAuditShards(vaultPath)) {
      // sync defaults "vault.access.lost" preserved verbatim.
      const fields = mapAuditYonToCacheArgs(r, "vault.access.lost");
      if (fields === null) continue;
      if (await reinjectAuditRecord(auditDb, fields)) auditUpserted += 1;
    }
    for (const r of walkAllProvenanceShards(vaultPath)) {
      const fields = mapProvenanceYonToCacheArgs(r);
      if (fields === null) continue;
      if (await reinjectProvenanceRecord(provenanceDb, fields)) provenanceUpserted += 1;
    }
  } finally {
    await closeVaultDb(provenanceDb);
    await closeVaultDb(auditDb);
  }
  return {
    vaultPath,
    auditUpserted,
    provenanceUpserted,
    durationMs: Date.now() - startedAt,
  };
}
