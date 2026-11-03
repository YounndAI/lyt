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

import { resolve } from "node:path";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { readKnownPaths, removeKnownPath } from "../registry/known-paths.js";
import { deleteVault, getVaultByName, tombstoneVault, type VaultRow } from "../registry/repo.js";
import { deleteVaultDerivedState } from "../scaffold/delete.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { dropAliasesForTargetRid, liveAliasNamesForTargetRid } from "./alias.js";
import { ensureVaultRetraction } from "./vault-retraction.js";
import { refreshScopedVaultProjection } from "./scoped-vault-projection.js";
import { retractScopedMeshHome } from "./scoped-mesh-home.js";
import { assertNoTargetPublication, retractTargetDestination } from "./lifecycle-preflight.js";
import { applyVaultSubscriptionRetraction, planVaultSubscriptionRetraction } from "./vault-subscription-retraction.js";
import { isUnderDefaultVaultsRoot } from "./register.js";
import { assertNotMeshMainVault } from "./main-vault-removal-guard.js";

export interface DeleteFlowOptions {
  noTombstone?: boolean;
  expectedRid?: string;
  expectedPath?: string;
  expectedHomeMeshRid?: string | null;
  expectedSource?: VaultRow["source"];
  expectedGitUrl?: string | null;
  operationId?: string;
  writerId?: string;
  afterStage?: (stage: string) => void;
  beforeFilesystem?: () => Promise<void>;
  onMutation?: () => void;
}

export interface DeleteFlowResult {
  vault: VaultRow;
  removedLytDir: boolean;
  lytDirPath: string;
  tombstoned: boolean;
  removedKnownPath: boolean;
  projectionPending: boolean;
  projectionNote?: string;
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
  let retracted = false;
  try {
    const vault = await getVaultByName(db, name);
    if (!vault) {
      throw new Error(`No vault registered with name '${name}'.`);
    }
    if ((opts.expectedRid !== undefined && vault.ridHex !== opts.expectedRid) ||
        (opts.expectedPath !== undefined && vault.path !== opts.expectedPath) ||
        (opts.expectedHomeMeshRid !== undefined && vault.homeMeshRidHex !== opts.expectedHomeMeshRid) ||
        (opts.expectedSource !== undefined && vault.source !== opts.expectedSource) ||
        (opts.expectedGitUrl !== undefined && vault.gitUrl !== opts.expectedGitUrl)) throw new Error("Vault binding changed; refusing lifecycle replay.");
    if (vault.status === "tombstoned") {
      throw new Error(`Vault '${name}' is already tombstoned.`);
    }
    await assertNotMeshMainVault(db, vault, "delete");
    await enforceNotFrozen(vault.path, vault.name);
    assertNoTargetPublication(vault);
    const subscription = planVaultSubscriptionRetraction(vault);
    if (ensureVaultRetraction(vault, opts.operationId, opts.writerId)) opts.onMutation?.();
    retracted = true;
    opts.afterStage?.("vault-ledger");
    if (await retractTargetDestination(db, vault)) opts.onMutation?.();
    opts.afterStage?.("destination");
    if (applyVaultSubscriptionRetraction(subscription)) opts.onMutation?.();
    opts.afterStage?.("subscription");
    if (await retractScopedMeshHome(db, vault)) opts.onMutation?.();
    opts.afterStage?.("mesh-home");
    // Snapshot aliases before registry mutation; retract them while the row is
    // still addressable so a failed operation can be retried.
    const orphanedAliases = liveAliasNamesForTargetRid(vault.ridHex);
    opts.afterStage?.("before-filesystem");
    await opts.beforeFilesystem?.();
    const { removedLytDir, lytDirPath } = await deleteVaultDerivedState(vault.path);
    if (removedLytDir) opts.onMutation?.();
    opts.afterStage?.("filesystem");
    // Keep the row until alias retractions are complete so an interrupted
    // operation remains addressable by name on retry.
    if (orphanedAliases.length > 0) { await dropAliasesForTargetRid(vault.ridHex, db); opts.onMutation?.(); }
    opts.afterStage?.("aliases");
    let result: DeleteFlowResult;
    if (noTombstone) {
      let removedKnownPath = false;
      if (!isUnderDefaultVaultsRoot(vault.path) && readKnownPaths().includes(resolve(vault.path))) {
        removeKnownPath(vault.path);
        removedKnownPath = true;
        opts.onMutation?.();
      }
      await deleteVault(db, vault.rid);
      opts.onMutation?.();
      result = {
        vault,
        removedLytDir,
        lytDirPath,
        tombstoned: false,
        removedKnownPath,
        projectionPending: false,
        orphanedAliases,
      };
    } else {
      await tombstoneVault(db, vault.rid);
      opts.onMutation?.();
      result = {
        vault: { ...vault, status: "tombstoned" },
        removedLytDir,
        lytDirPath,
        tombstoned: true,
        removedKnownPath: false,
        projectionPending: false,
        orphanedAliases,
      };
    }
    opts.afterStage?.("registry");
    const projection = await refreshScopedVaultProjection(db, vault.ridHex);
    if (projection.changed === true) opts.onMutation?.();
    result.projectionPending = projection.pending;
    if (projection.reason !== undefined) result.projectionNote = projection.reason;
    opts.afterStage?.("projection");
    return result;
  } catch (error) {
    if (retracted) throw new Error(`Partial delete of '${name}': a vault-ledger tombstone was verified; local state or aliases may be incomplete. Inspect before recovery. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    throw error;
  } finally {
    await closeRegistry(db);
  }
}
