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
import { deleteVault, getVaultByName, getVaultByRid, tombstoneVault, type VaultRow } from "../registry/repo.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { dropAliasesForTargetRid, liveAliasNamesForTargetRid } from "./alias.js";
import { ensureVaultRetraction } from "./vault-retraction.js";
import { readAllFedVaultRecords } from "../yon/federation-vault-ledger-read.js";
import { refreshScopedVaultProjection } from "./scoped-vault-projection.js";
import { retractScopedMeshHome } from "./scoped-mesh-home.js";
import { assertNoTargetPublication, retractTargetDestination } from "./lifecycle-preflight.js";
import { applyVaultSubscriptionRetraction, planVaultSubscriptionRetraction } from "./vault-subscription-retraction.js";
import { isUnderDefaultVaultsRoot } from "./register.js";
import { assertNotMeshMainVault } from "./main-vault-removal-guard.js";

export interface ForgetFlowOptions {
  tombstone?: boolean;
  expectedRid?: string;
  expectedPath?: string;
  expectedHomeMeshRid?: string | null;
  expectedSource?: VaultRow["source"];
  expectedGitUrl?: string | null;
  operationId?: string;
  writerId?: string;
  /** A receipt-bound immutable preimage for recovery after registry removal. */
  recoveryVault?: VaultRow;
  onMutation?: () => void;
  afterStage?: (stage: string) => void;
}

export interface ForgetFlowResult {
  vault: VaultRow;
  tombstoned: boolean;
  removedKnownPath: boolean;
  subscriptionLedgerTombstoned: boolean;
  projectionPending: boolean;
  projectionNote?: string;
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
  let retracted = false;
  try {
    const current = await getVaultByName(db, name);
    const vault = current ?? opts.recoveryVault;
    if (!vault) {
      throw new Error(`No vault registered with name '${name}'.`);
    }
    if (current === null || current.status === "tombstoned") {
      const prior = opts.recoveryVault;
      if (prior === undefined || opts.operationId === undefined || opts.writerId === undefined ||
          !readAllFedVaultRecords().some((r) => r.vaultRid.replace(/-/g, "").toLowerCase() === prior.ridHex.toLowerCase() && r.operationId === opts.operationId && r.writerId === opts.writerId && r.state === "tombstoned")) {
        throw new Error("Registry removal is not bound to this lifecycle operation; refusing recovery.");
      }
      const byRid = await getVaultByRid(db, prior.rid);
      if (byRid !== null && (byRid.name !== prior.name || byRid.status !== "tombstoned")) throw new Error("Vault identity was reused; refusing recovery.");
    }
    if (opts.expectedRid !== undefined && vault.ridHex !== opts.expectedRid) throw new Error("Vault identity changed; refusing lifecycle replay.");
    if ((opts.expectedPath !== undefined && vault.path !== opts.expectedPath) ||
        (opts.expectedHomeMeshRid !== undefined && vault.homeMeshRidHex !== opts.expectedHomeMeshRid) ||
        (opts.expectedSource !== undefined && vault.source !== opts.expectedSource) ||
        (opts.expectedGitUrl !== undefined && vault.gitUrl !== opts.expectedGitUrl)) {
      throw new Error("Vault binding changed; refusing lifecycle replay.");
    }
    if (vault.status === "tombstoned" && opts.recoveryVault === undefined) {
      throw new Error(
        `Vault '${name}' is already tombstoned. Use a fresh 'lyt vault init' at a new path if you want to start over.`,
      );
    }
    if (current !== null && current.status !== "tombstoned") await assertNotMeshMainVault(db, vault, "forget");
    await enforceNotFrozen(vault.path, vault.name);
    assertNoTargetPublication(vault);
    // Snapshot aliases before registry mutation; retract them while the row is
    // still addressable so a failed operation can be retried.
    const orphanedAliases = liveAliasNamesForTargetRid(vault.ridHex);
    const subscription = planVaultSubscriptionRetraction(vault);
    if (ensureVaultRetraction(vault, opts.operationId, opts.writerId)) opts.onMutation?.();
    retracted = true;
    opts.afterStage?.("vault-ledger");
    if (await retractTargetDestination(db, vault)) opts.onMutation?.();
    opts.afterStage?.("destination");
    const subscriptionLedgerTombstoned = applyVaultSubscriptionRetraction(subscription);
    if (subscriptionLedgerTombstoned) opts.onMutation?.();
    opts.afterStage?.("subscription");
    if (await retractScopedMeshHome(db, vault)) opts.onMutation?.();
    opts.afterStage?.("mesh-home");
    // Retain the registry row until alias retractions have completed so a
    // failed intermediate step can be retried by the same vault name.
    if (orphanedAliases.length > 0) { await dropAliasesForTargetRid(vault.ridHex, db); opts.onMutation?.(); }
    opts.afterStage?.("aliases");
    let result: ForgetFlowResult;
    if (tombstone) {
      if (current !== null && current.status !== "tombstoned") { await tombstoneVault(db, vault.rid); opts.onMutation?.(); }
      result = {
        vault: { ...vault, status: "tombstoned" },
        tombstoned: true,
        removedKnownPath: false,
        subscriptionLedgerTombstoned,
        projectionPending: false,
        orphanedAliases,
      };
    } else {
      let removedKnownPath = false;
      if (current !== null && !isUnderDefaultVaultsRoot(vault.path) && readKnownPaths().includes(resolve(vault.path))) {
        removeKnownPath(vault.path);
        removedKnownPath = true;
        opts.onMutation?.();
      }
      if (current !== null) { await deleteVault(db, vault.rid); opts.onMutation?.(); }
      result = {
        vault,
        tombstoned: false,
        removedKnownPath,
        subscriptionLedgerTombstoned,
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
    if (retracted) throw new Error(`Partial forget of '${name}': a vault-ledger tombstone was verified; later local steps may be incomplete. Inspect registry, subscriptions and aliases before recovery. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    throw error;
  } finally {
    await closeRegistry(db);
  }
}
