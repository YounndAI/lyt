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
import { removeKnownPath } from "../registry/known-paths.js";
import { deleteVault, getVaultByName, tombstoneVault, type VaultRow } from "../registry/repo.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { dropAliasesForTargetRid, liveAliasNamesForTargetRid } from "./alias.js";
import { regeneratePodManifestNonFatal } from "./federation/regenerate.js";
import { isUnderDefaultVaultsRoot } from "./register.js";

export interface ForgetFlowOptions {
  tombstone?: boolean;
}

export interface ForgetFlowResult {
  vault: VaultRow;
  tombstoned: boolean;
  removedKnownPath: boolean;
  // Phase E item 1 (#9) — pod-local alias names that POINTED at this vault
  // and were dropped (tombstoned) because forget (the vault-unsubscribe path)
  // orphans them. Empty when the vault had no aliases. forget has no interactive
  // gate, so this is reported alongside the action (the confirmed path).
  orphanedAliases: string[];
}

export async function forgetVaultFlow(
  name: string,
  opts: ForgetFlowOptions = {},
): Promise<ForgetFlowResult> {
  const tombstone = opts.tombstone === true;
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, name);
    if (!vault) {
      throw new Error(`No vault registered with name '${name}'.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(
        `Vault '${name}' is already tombstoned. Use a fresh 'lyt vault init' at a new path if you want to start over.`,
      );
    }
    await enforceNotFrozen(vault.path, vault.name);
    // Phase E item 1 (#9 — warn-then-drop). Snapshot the pod-local aliases
    // this forget would ORPHAN before mutating the registry; drop them after on
    // the confirmed path. (See flows/delete.ts for the symmetric wiring.)
    const orphanedAliases = liveAliasNamesForTargetRid(vault.ridHex);
    let result: ForgetFlowResult;
    if (tombstone) {
      await tombstoneVault(db, vault.rid);
      result = {
        vault: { ...vault, status: "tombstoned" },
        tombstoned: true,
        removedKnownPath: false,
        orphanedAliases,
      };
    } else {
      await deleteVault(db, vault.rid);
      let removedKnownPath = false;
      if (!isUnderDefaultVaultsRoot(vault.path)) {
        removeKnownPath(vault.path);
        removedKnownPath = true;
      }
      result = { vault, tombstoned: false, removedKnownPath, orphanedAliases };
    }
    // Drop the orphaned aliases on the confirmed path — tombstone each via the
    // existing removeAliasFlow / appendAliasTombstone path. Reuses the open db.
    if (orphanedAliases.length > 0) {
      await dropAliasesForTargetRid(vault.ridHex, db);
    }
    // (Brief A) — forget mutates the registry's vault set; regenerate the
    // derived pod manifest so the removed vault drops out of pod.yon. Non-fatal;
    // reuses the open registry.
    await regeneratePodManifestNonFatal(db);
    return result;
  } finally {
    await closeRegistry(db);
  }
}
