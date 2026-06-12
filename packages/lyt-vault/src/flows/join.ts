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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByPath } from "../registry/repo.js";
import { initVaultDbs } from "../registry/vault-db.js";
import { parseVaultYon } from "../yon/parse.js";
import { relinkAllPatternsForVault } from "./pattern-relink-vault.js";
import { registerVaultFromYon, type RegisteredVault } from "./register.js";

export interface JoinResult extends RegisteredVault {
  alreadyRegistered: boolean;
  patternsLinked: number;
}

export async function joinVaultFlow(vaultPath: string): Promise<JoinResult> {
  const abs = resolve(vaultPath);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  const yonPath = join(abs, ".lyt", "vault.yon");
  if (!existsSync(yonPath)) {
    throw new Error(
      `No .lyt/vault.yon at ${abs}. Use 'lyt vault adopt' to add Lyt scaffolding to a plain Obsidian vault.`,
    );
  }

  const db = await openRegistry();
  let registered: RegisteredVault;
  let alreadyRegistered = false;
  try {
    const existingByPath = await getVaultByPath(db, abs);
    if (existingByPath) {
      registered = {
        rid: existingByPath.rid,
        ridHex: existingByPath.ridHex,
        name: existingByPath.name,
        path: existingByPath.path,
      };
      alreadyRegistered = true;
    } else {
      registered = await registerVaultFromYon(db, { vaultPath: abs });
    }
  } finally {
    await closeRegistry(db);
  }
  // Block-A Commit 4 + v1.A.2c DB SPLIT: a just-cloned vault has no
  // `.lyt/indexes/*.db` files (the entire `.lyt/indexes/` subdir is
  // `.gitignore`'d per arc §8). Initialise all three per-vault DBs
  // (lyt + audit + provenance) here so the cache schemas exist for
  // downstream verbs (idempotent — does nothing if the files already
  // exist with valid schema_migrations rows).
  //
  // hardening pass/22/25 — runs AFTER registration (was before): a registration
  // refusal (VaultHomeMeshNotRegisteredError) must leave NO per-vault libsql
  // handles in the tree, so the clone caller's cleanup-on-failure can remove
  // the dir without riding the Windows lock-release lag (5-10s per
  // tests/_helpers/fs-retry.ts).
  await initVaultDbs(abs);
  // Auto-link installed patterns (best-effort) on every join — even already-registered
  // vaults benefit from a re-link (the user may have installed new patterns since the
  // vault was first registered).
  const parsed = parseVaultYon(readFileSync(yonPath, "utf8"));
  const links = await relinkAllPatternsForVault(parsed.name);
  return { ...registered, alreadyRegistered, patternsLinked: links.length };
}
