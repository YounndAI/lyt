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

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { readKnownPaths } from "../registry/known-paths.js";
import { deleteAllVaults } from "../registry/repo.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { registerVaultFromYon } from "./register.js";

export interface RebuildFlowResult {
  scanned: string[];
  registered: { rid: Uint8Array; ridHex: string; name: string; path: string }[];
  skipped: { path: string; reason: string }[];
}

export async function registryRebuildFlow(): Promise<RebuildFlowResult> {
  const candidatePaths = collectCandidatePaths();
  const scanned: string[] = [];
  const registered: RebuildFlowResult["registered"] = [];
  const skipped: RebuildFlowResult["skipped"] = [];

  const db = await openRegistry();
  try {
    await deleteAllVaults(db);

    for (const path of candidatePaths) {
      scanned.push(path);
      const yonPath = join(path, ".lyt", "vault.yon");
      if (!existsSync(yonPath)) {
        skipped.push({ path, reason: "no .lyt/vault.yon" });
        continue;
      }
      try {
        // fed-v2 Layer-2 P1 — rebuild wipes the vaults table
        // (deleteAllVaults above) then re-registers the user's OWN local vaults
        // by scanning known paths: an identity-preserving restore of trusted
        // local content, so it carries trustedReconstruction (re-homing a rid to
        // its current local path is legitimate). The name-mismatch refusal stays
        // unconditional regardless. NOTE: trustedReconstruction is a no-op today
        // (upsertVault :267 `void`s it); pre-wired for the P5 same-name-arm gate.
        const v = await registerVaultFromYon(db, { vaultPath: path, trustedReconstruction: true });
        registered.push(v);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        skipped.push({ path, reason: msg });
      }
    }
  } finally {
    await closeRegistry(db);
  }

  return { scanned, registered, skipped };
}

function collectCandidatePaths(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const defaultRoot = resolve(getDefaultVaultsRoot());
  if (existsSync(defaultRoot) && statSync(defaultRoot).isDirectory()) {
    for (const entry of readdirSync(defaultRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = join(defaultRoot, entry.name);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
  }

  for (const p of readKnownPaths()) {
    const abs = resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }

  return out;
}
