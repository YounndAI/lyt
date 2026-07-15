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
import { getVaultByPath, type VaultSource } from "../registry/repo.js";
import { initVaultDbs } from "../registry/vault-db.js";
import { parseVaultYon } from "../yon/parse.js";
import { relinkAllPatternsForVault } from "./pattern-relink-vault.js";
import { registerVaultFromYon, type RegisteredVault } from "./register.js";

export interface JoinResult extends RegisteredVault {
  alreadyRegistered: boolean;
  patternsLinked: number;
}

export async function joinVaultFlow(
  vaultPath: string,
  // (CRIT-1) — optional registry-side home-mesh rebind, threaded straight
  // to registerVaultFromYon. The preserve-rid subscribe/adopt clone passes the
  // LOCAL target mesh rid so the vault is homed locally without rewriting its
  // (byte-frozen) committed vault.yon. Omitted on every other caller (default
  // clone, `lyt vault join`), which register using the vault.yon's own binding.
  //
  // `skipPatternRelink` keeps a read-only subscriber/adopt MIRROR's
  // working tree CLEAN. relinkAllPatternsForVault regenerates the TRACKED
  // `.lyt/agents.md` pattern block to match the LOCAL machine's installed
  // patterns; on a preserve-rid clone the committed agents.md is the publisher's
  // and must stay byte-unchanged (the same A2c clean-tree reason the preserve
  // path already skips writeScaffoldConformance — a dirty tracked file wedges
  // the no-autostash read-only pull). The junction relink is machine-local
  // convenience the subscriber can run on demand; the read-only mirror does not
  // commit it. Omitted (relink runs) on every OTHER caller.
  // Inc-2 Phase B / `source` threads the own-vs-clone provenance to
  // registerVaultFromYon's fresh-INSERT arm. The foreign clone-on-subscribe /
  // mesh-adopt member paths pass 'subscribed'; omitted everywhere else →
  // fail-closed 'own'.
  opts?: {
    homeMeshRidOverride?: Uint8Array | undefined;
    skipPatternRelink?: boolean | undefined;
    source?: VaultSource | undefined;
  },
): Promise<JoinResult> {
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
      registered = await registerVaultFromYon(db, {
        vaultPath: abs,
        ...(opts?.homeMeshRidOverride !== undefined
          ? { homeMeshRidOverride: opts.homeMeshRidOverride }
          : {}),
        ...(opts?.source !== undefined ? { source: opts.source } : {}),
      });
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
  // vault was first registered). SKIPPED on a preserve-rid subscriber/adopt
  // mirror so the tracked agents.md stays byte-unchanged (clean tree).
  if (opts?.skipPatternRelink === true) {
    return { ...registered, alreadyRegistered, patternsLinked: 0 };
  }
  const parsed = parseVaultYon(readFileSync(yonPath, "utf8"));
  const links = await relinkAllPatternsForVault(parsed.name);
  return { ...registered, alreadyRegistered, patternsLinked: links.length };
}
