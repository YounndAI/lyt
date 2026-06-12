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

import { closeRegistry, openRegistry } from "../registry/client.js";
import { initVaultDbs } from "../registry/vault-db.js";
import { adoptVault, type AdoptOptions, type AdoptResult } from "../scaffold/adopt.js";
import { parseVaultYon } from "../yon/parse.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { relinkAllPatternsForVault } from "./pattern-relink-vault.js";
import { reindexInboundVault } from "./reindex-inbound.js";
import { registerVaultFromYon } from "./register.js";

export interface AdoptFlowResult extends AdoptResult {
  registered: boolean;
  patternsLinked: number;
  // V-C-1 Phase B (L2) — true when the adopted vault's content caches (all
  // tiers) were rebuilt so search/recall/primer hit with no manual reindex.
  indexed: boolean;
}

export async function adoptVaultFlow(opts: AdoptOptions): Promise<AdoptFlowResult> {
  const result = adoptVault(opts);
  // Block-A Commit 4 + v1.A.2c DB SPLIT: ensure the per-vault libSQL
  // projection exists at `.lyt/indexes/{lyt,audit,provenance}.db`. Adopted
  // vaults are typically `.lyt/indexes/`-less (they came in as plain
  // Obsidian); initVaultDbs creates all three so downstream verbs land on
  // ready schemas without per-call open guards.
  await initVaultDbs(result.vaultPath);
  const db = await openRegistry();
  try {
    await registerVaultFromYon(db, { vaultPath: result.vaultPath });
  } finally {
    await closeRegistry(db);
  }
  // Auto-link installed patterns (best-effort; per Phase 7F decision #13 + the
  // symlink-mechanics paragraph in the master brief).
  const yon = parseVaultYon(readFileSync(join(result.vaultPath, ".lyt", "vault.yon"), "utf8"));
  const links = await relinkAllPatternsForVault(yon.name);

  // V-C-1 Phase B (L2) — reindex-on-inbound. An adopted vault came in as plain
  // Obsidian markdown with EMPTY content caches (initVaultDbs created the schema
  // only). Without this, search/recall/primer returned nothing until a manual
  // `lyt reindex` (V-B-6). Rebuild all tiers from the markdown; best-effort —
  // the vault is registered + the markdown is the SoT, so an index failure logs
  // but never fails the adopt.
  const idx = await reindexInboundVault({ vault: yon.name, vaultPath: result.vaultPath });
  if (!idx.reindexed) {
    // eslint-disable-next-line no-console
    console.error(
      `lyt vault adopt: index of ${yon.name} deferred (${idx.error ?? "unknown"}); ` +
        "markdown SoT intact — run `lyt reindex --vault " +
        yon.name +
        "`.",
    );
  }
  return { ...result, registered: true, patternsLinked: links.length, indexed: idx.reindexed };
}
