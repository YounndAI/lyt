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

// feat/keyphrase-boost — `rebuild-keyphrases` flow.
//
// Walks `<vault>/notes/**/*.md` and reflects each figment's deterministic top-K
// keyphrase token set into lyt.db's `keyphrases` cache. Like rebuild-fts there
// is NO intermediate YON SoT — the markdown files ARE the source of truth and
// the cache is derived directly over them (full-walk only; the incremental
// per-write keyphrase path is DEFERRED to a follow-up, mirroring how rebuild-fts
// preceded the Lane M per-write reconcile).
//
// Thin orchestration wrapper around `upsertKeyphrasesCache`, mirroring
// rebuild-fts.ts: resolve the registered vault, delegate the walk + insert, and
// return a shaped result. Open-once seam (v1.A.5 CR-B1): optional
// `registryDb?` / `lytDb?`; caller owns lifecycle when supplied.

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import {
  upsertKeyphrasesCache,
  type UpsertKeyphrasesCacheResult,
} from "./upsert-keyphrases-cache.js";

export interface RebuildKeyphrasesArgs {
  // Registered vault name. Mutually exclusive with `vaultPathOverride`.
  vault?: string;
  // Test / automator seam — operate on the given vault path directly.
  vaultPathOverride?: string;
  // Open-once seam (v1.A.5 CR-B1 pattern) for the registry.
  registryDb?: Client;
  // Open-once seam for the per-vault lyt.db — threaded through to the upsert.
  lytDb?: Client;
}

export interface RebuildKeyphrasesResult {
  vaultName: string;
  vaultPath: string;
  figmentsProcessed: number;
  keyphraseRowsUpserted: number;
  // True when the vault had at least one note; mirrors the upsert result.
  ran: boolean;
  durationMs: number;
}

export async function rebuildKeyphrasesFlow(
  args: RebuildKeyphrasesArgs,
): Promise<RebuildKeyphrasesResult> {
  const startedAt = Date.now();
  const { vaultName, vaultPath } = await resolveVault(args);

  const upsertOpts: { lytDb?: Client } = args.lytDb !== undefined ? { lytDb: args.lytDb } : {};
  const cacheRes: UpsertKeyphrasesCacheResult = await upsertKeyphrasesCache(vaultPath, upsertOpts);

  return {
    vaultName,
    vaultPath,
    figmentsProcessed: cacheRes.figmentsProcessed,
    keyphraseRowsUpserted: cacheRes.keyphraseRowsUpserted,
    ran: cacheRes.ran,
    durationMs: Date.now() - startedAt,
  };
}

interface ResolvedVault {
  vaultName: string;
  vaultPath: string;
}

async function resolveVault(args: RebuildKeyphrasesArgs): Promise<ResolvedVault> {
  if (args.vaultPathOverride !== undefined) {
    return {
      vaultName: args.vault ?? deriveVaultNameFromPath(args.vaultPathOverride),
      vaultPath: args.vaultPathOverride,
    };
  }
  if (args.vault === undefined) {
    throw new Error("rebuild-keyphrases: either --vault <name> or vaultPathOverride is required.");
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
    throw new Error(`rebuild-keyphrases: no vault registered with name '${args.vault}'.`);
  }
  if (vault.status === "tombstoned") {
    throw new Error(`rebuild-keyphrases: vault '${args.vault}' is tombstoned; cannot rebuild.`);
  }
  return { vaultName: vault.name, vaultPath: vault.path };
}

function deriveVaultNameFromPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts[parts.length - 1] ?? "vault";
}
