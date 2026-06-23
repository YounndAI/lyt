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
import { deleteVaultDerivedState } from "../scaffold/delete.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { dropAliasesForTargetRid, liveAliasNamesForTargetRid } from "./alias.js";
import { regeneratePodManifestNonFatal } from "./federation/regenerate.js";
import { isUnderDefaultVaultsRoot } from "./register.js";

export interface DeleteFlowOptions {
  noTombstone?: boolean;
}

export interface DeleteFlowResult {
  vault: VaultRow;
  removedLytDir: boolean;
  lytDirPath: string;
  tombstoned: boolean;
  removedKnownPath: boolean;
  // Phase E item 1 (#9) — pod-local alias names that POINTED at this vault
  // and were dropped (tombstoned) because the delete orphans them. Empty when
  // the vault had no aliases. The CLI surfaces this as the pre-warning + outcome
  // (this flow is the confirmed path: delete has no interactive gate, so the
  // warning is reported alongside the action rather than before a prompt).
  orphanedAliases: string[];
}

export async function deleteVaultFlow(
  name: string,
  opts: DeleteFlowOptions = {},
): Promise<DeleteFlowResult> {
  const noTombstone = opts.noTombstone === true;
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, name);
    if (!vault) {
      throw new Error(`No vault registered with name '${name}'.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(`Vault '${name}' is already tombstoned.`);
    }
    await enforceNotFrozen(vault.path, vault.name);
    // Phase E item 1 (#9 — warn-then-drop). Discover the pod-local aliases
    // this delete would ORPHAN (live aliases whose target is this vault's rid)
    // BEFORE the destructive registry mutation, so the outcome carries the
    // warning list. The actual drop happens AFTER the vault is removed (the
    // confirmed path); discovery here just snapshots the affected names.
    const orphanedAliases = liveAliasNamesForTargetRid(vault.ridHex);
    const { removedLytDir, lytDirPath } = await deleteVaultDerivedState(vault.path);
    let result: DeleteFlowResult;
    if (noTombstone) {
      await deleteVault(db, vault.rid);
      let removedKnownPath = false;
      if (!isUnderDefaultVaultsRoot(vault.path)) {
        removeKnownPath(vault.path);
        removedKnownPath = true;
      }
      result = {
        vault,
        removedLytDir,
        lytDirPath,
        tombstoned: false,
        removedKnownPath,
        orphanedAliases,
      };
    } else {
      await tombstoneVault(db, vault.rid);
      result = {
        vault: { ...vault, status: "tombstoned" },
        removedLytDir,
        lytDirPath,
        tombstoned: true,
        removedKnownPath: false,
        orphanedAliases,
      };
    }
    // Drop the orphaned aliases on the confirmed path — tombstone each via the
    // existing removeAliasFlow / appendAliasTombstone path (HLC-stamped, own
    // shard, idempotent). Reuses the open registry client.
    if (orphanedAliases.length > 0) {
      await dropAliasesForTargetRid(vault.ridHex, db);
    }
    // (Brief A) — delete mutates the registry's vault set; regenerate the
    // derived pod manifest so pod.yon reflects the removal. Non-fatal; reuses
    // the open registry.
    await regeneratePodManifestNonFatal(db);
    return result;
  } finally {
    await closeRegistry(db);
  }
}
