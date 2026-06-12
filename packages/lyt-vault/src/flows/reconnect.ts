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

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { addKnownPath, removeKnownPath } from "../registry/known-paths.js";
import {
  getVaultByName,
  markVaultActive,
  updateVaultPath,
  type VaultRow,
} from "../registry/repo.js";
import { regenMeshContextFromYon } from "../scaffold/mesh-context.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { hexToUuid7Bytes, ridsEqual } from "../util/uuid7.js";
import { parseVaultYon } from "../yon/parse.js";
import { isUnderDefaultVaultsRoot } from "./register.js";

export interface ReconnectFlowArgs {
  name: string;
  newPath: string;
}

export interface ReconnectFlowResult {
  vault: VaultRow;
  newPath: string;
  pathChanged: boolean;
  meshContextRegenerated: boolean;
}

export async function reconnectVaultFlow(args: ReconnectFlowArgs): Promise<ReconnectFlowResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, args.name);
    if (!vault) {
      throw new Error(`No vault registered with name '${args.name}'.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(
        `Vault '${args.name}' is tombstoned (terminal state). A new 'lyt vault init' at the target path will produce a new rid.`,
      );
    }
    await enforceNotFrozen(vault.path, vault.name);
    const absNewPath = resolve(args.newPath);
    if (!existsSync(absNewPath)) {
      throw new Error(`Path does not exist: ${absNewPath}`);
    }
    const yonPath = join(absNewPath, ".lyt", "vault.yon");
    if (!existsSync(yonPath)) {
      throw new Error(
        `No .lyt/vault.yon found at ${absNewPath}. Reconnect requires an already-Lyt-aware vault.`,
      );
    }
    const parsed = parseVaultYon(readFileSync(yonPath, "utf8"));
    const parsedRidBytes = hexToUuid7Bytes(parsed.rid);
    if (!ridsEqual(parsedRidBytes, vault.rid)) {
      throw new Error(
        `rid mismatch: registry row '${args.name}' has rid '${vault.ridHex}', but ${yonPath} declares '${parsed.rid}'.`,
      );
    }
    const pathChanged = absNewPath !== vault.path;
    if (pathChanged) {
      await updateVaultPath(db, vault.rid, absNewPath);
      const oldOutOfTree = !isUnderDefaultVaultsRoot(vault.path);
      const newOutOfTree = !isUnderDefaultVaultsRoot(absNewPath);
      if (oldOutOfTree) removeKnownPath(vault.path);
      if (newOutOfTree) addKnownPath(absNewPath);
    }
    await markVaultActive(db, vault.rid);

    let meshContextRegenerated = false;
    try {
      regenMeshContextFromYon(absNewPath);
      meshContextRegenerated = true;
    } catch {
      // Vault is pre-Phase-7A or missing scaffold pieces; don't fail reconnect on regen.
      meshContextRegenerated = false;
    }

    return {
      vault: { ...vault, path: absNewPath, status: "active", verifyFailCount: 0 },
      newPath: absNewPath,
      pathChanged,
      meshContextRegenerated,
    };
  } finally {
    await closeRegistry(db);
  }
}
