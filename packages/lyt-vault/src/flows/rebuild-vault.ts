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

// Lane V Phase 0 (0.5 / CLI gap C3) — `lyt vault rebuild` flow.
//
// One per-vault umbrella that rebuilds ALL content-tier caches in the correct
// order: lanes → arcs → fts → rollup. Distinct from `lyt vault rebuild-index`
// (C4: that DROPs + recreates the DB schema — destructive; this rebuilds
// CONTENT from the markdown SoT into the existing schema). Composes the four
// existing single-tier flows behind the open-once registry seam (v1.A.5 CR-B1):
// open the registry once here, thread it through every sub-flow.
//
// Order rationale: rollup reads each vault's `lanes` cache (rebuild-rollup.ts
// readVaultKeywords), so lanes MUST precede rollup; arcs + fts are independent.

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName } from "../registry/repo.js";
import { healLytDbIfCorrupt } from "../registry/vault-db.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { rebuildLanesFlow, type RebuildLanesResult } from "./rebuild-lanes.js";
import { rebuildArcsFlow, type RebuildArcsResult } from "./rebuild-arcs.js";
import { rebuildFtsFlow, type RebuildFtsResult } from "./rebuild-fts.js";
import { rebuildRollupFlow, type RebuildRollupResult } from "./rebuild-rollup.js";

export interface RebuildVaultArgs {
  // Registered vault name.
  vault: string;
  // Lane clustering threshold passthrough (default = rebuild-lanes default).
  threshold?: number;
  // Open-once seam (v1.A.5 CR-B1). When supplied the caller owns lifecycle.
  registryDb?: Client;
  // Deterministic timestamp override threaded to lanes/arcs/rollup.
  nowIso?: string;
}

export interface RebuildVaultResult {
  vaultName: string;
  lanes: RebuildLanesResult;
  arcs: RebuildArcsResult;
  fts: RebuildFtsResult;
  rollup: RebuildRollupResult;
  // Track C Wave 3 F15 — when the vault's lyt.db was corrupt at entry, the
  // path it was quarantined to (rebuild then proceeded on a fresh schema);
  // null on the healthy path.
  indexQuarantinedTo: string | null;
  durationMs: number;
}

export async function rebuildVaultFlow(args: RebuildVaultArgs): Promise<RebuildVaultResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());
  const { vault } = args;
  const nowIso = args.nowIso;

  try {
    // F15 — probe-open the vault's lyt.db before any tier rebuild; a corrupt
    // file is quarantined + recreated so `lyt reindex` IS the remedy instead
    // of choking on the same SQLITE_NOTADB the user is trying to escape.
    const vaultRow = await getVaultByName(registryDb, vault);
    if (vaultRow === null) {
      throw new Error(`rebuild: no vault registered with name '${vault}'.`);
    }
    // hardening pass (fix-pass): the F13 chokepoint — closes the freeze-divergence
    // pair (`lyt rebuild-index` REFUSED frozen while `lyt reindex` proceeded
    // through this flow). Covers reindexFlow, repair --apply's index heal,
    // and the L3 self-heals (search-cascade filters frozen vaults out of its
    // stale-heal targets so reads stay open and degrade gracefully).
    await enforceNotFrozen(vaultRow.path, vaultRow.name);
    const heal = await healLytDbIfCorrupt(vaultRow.path, nowIso);

    const lanes = await rebuildLanesFlow({
      vault,
      registryDb,
      ...(nowIso !== undefined ? { nowIso } : {}),
      ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
    });
    const arcs = await rebuildArcsFlow({
      vault,
      registryDb,
      ...(nowIso !== undefined ? { nowIso } : {}),
    });
    // rebuild-fts also refreshes figment_edges + figment_meta (Lane V 0.3/0.4).
    const fts = await rebuildFtsFlow({ vault, registryDb });
    const rollup = await rebuildRollupFlow({
      vault,
      registryDb,
      ...(nowIso !== undefined ? { nowIso } : {}),
    });

    return {
      vaultName: lanes.vaultName,
      lanes,
      arcs,
      fts,
      rollup,
      indexQuarantinedTo: heal.quarantinedTo,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(registryDb);
  }
}
