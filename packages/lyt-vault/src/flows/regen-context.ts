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

import { existsSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { regenMeshContextFromYon } from "../scaffold/mesh-context.js";
import { enforceNotFrozen } from "../util/freeze-check.js";

export interface RegenContextResult {
  vault: VaultRow;
  meshContextPath: string;
}

export async function regenContextFlow(name: string): Promise<RegenContextResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, name);
    if (!vault) {
      throw new Error(`No vault registered with name '${name}'.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(
        `Vault '${name}' is tombstoned; regen-context refuses to write into a buried vault.`,
      );
    }
    await enforceNotFrozen(vault.path, vault.name);
    const yonPath = join(vault.path, ".lyt", "vault.yon");
    if (!existsSync(yonPath)) {
      throw new Error(
        `Vault '${name}' at ${vault.path} has no .lyt/vault.yon — cannot regenerate mesh-context.`,
      );
    }
    const meshContextPath = regenMeshContextFromYon(vault.path);
    return { vault, meshContextPath };
  } finally {
    await closeRegistry(db);
  }
}
