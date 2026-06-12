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

// v1.D.3a — `lyt vault rebuild-fts` flow.
//
// Walks `<vault>/notes/**/*.md`, strips YAML frontmatter from each
// figment, and reflects the body text into the lyt.db `figment_fts`
// virtual table (FTS5 cache). Distinct from rebuild-lanes /
// rebuild-arcs in one important way: there's NO intermediate YON SoT
// file. The markdown files on disk ARE the source of truth; FTS5
// holds derived state directly over them.
//
// This is a thin orchestration wrapper around `upsertFtsCache`:
// - resolves the registered vault by name (via the registry seam)
// - delegates the walk + insert to `upsertFtsCache`
// - returns a shaped result for the manual CLI verb's --json output
//
// Open-once seam from the start (v1.A.5 CR-B1 + v1.D.1 + v1.D.2a
// vindication): accept optional `registryDb?: Client` and `lytDb?:
// Client`; only `openRegistry()` / `openLytDb()` when omitted; caller
// owns lifecycle when supplied. Mirrors rebuild-arcs.ts. Applies to
// BOTH the manual `lyt vault rebuild-fts` CLI verb AND any future
// v1.D.3c automator wrapper (per master-plan, no automator ships in
// v1.D.3 — search is interactive, not scheduled — but the seam is
// future-proof).

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { upsertFtsCache, type UpsertFtsCacheResult } from "./upsert-fts-cache.js";

export interface RebuildFtsArgs {
  // Registered vault name. Mutually exclusive with `vaultPathOverride`.
  vault?: string;
  // Test / automator seam — bypass the registry lookup and operate on
  // the given vault path directly.
  vaultPathOverride?: string;
  // Open-once seam (v1.A.5 CR-B1 pattern). When supplied, the flow
  // uses the caller's registry client and does NOT close it.
  registryDb?: Client;
  // Open-once seam for the per-vault lyt.db. Threaded through to
  // `upsertFtsCache`.
  lytDb?: Client;
}

export interface RebuildFtsResult {
  vaultName: string;
  vaultPath: string;
  ftsDocsInserted: number;
  // True when the vault had at least one note; mirrors
  // UpsertFtsCacheResult.ran. False when notes/ is empty / absent.
  ran: boolean;
  durationMs: number;
}

export async function rebuildFtsFlow(args: RebuildFtsArgs): Promise<RebuildFtsResult> {
  const startedAt = Date.now();
  const { vaultName, vaultPath } = await resolveVault(args);

  const upsertOpts: { lytDb?: Client } = args.lytDb !== undefined ? { lytDb: args.lytDb } : {};
  const cacheRes: UpsertFtsCacheResult = await upsertFtsCache(vaultPath, upsertOpts);

  return {
    vaultName,
    vaultPath,
    ftsDocsInserted: cacheRes.ftsDocsUpserted,
    ran: cacheRes.ran,
    durationMs: Date.now() - startedAt,
  };
}

interface ResolvedVault {
  vaultName: string;
  vaultPath: string;
}

async function resolveVault(args: RebuildFtsArgs): Promise<ResolvedVault> {
  if (args.vaultPathOverride !== undefined) {
    return {
      vaultName: args.vault ?? deriveVaultNameFromPath(args.vaultPathOverride),
      vaultPath: args.vaultPathOverride,
    };
  }
  if (args.vault === undefined) {
    throw new Error("rebuild-fts: either --vault <name> or vaultPathOverride is required.");
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
    throw new Error(`rebuild-fts: no vault registered with name '${args.vault}'.`);
  }
  if (vault.status === "tombstoned") {
    throw new Error(`rebuild-fts: vault '${args.vault}' is tombstoned; cannot rebuild fts.`);
  }
  return { vaultName: vault.name, vaultPath: vault.path };
}

function deriveVaultNameFromPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts[parts.length - 1] ?? "vault";
}
