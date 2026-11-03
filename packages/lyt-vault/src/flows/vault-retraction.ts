/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { VaultRow } from "../registry/repo.js";
import { vaultRepoName } from "../util/federation-paths.js";
import { appendFedVaultTombstone } from "../yon/federation-vault-ledger-write.js";
import { foldFedVaultWinners, observedMaxFedVaultHlc, readAllFedVaultRecords } from "../yon/federation-vault-ledger-read.js";

/** Ensure the observed ledger winner is a tombstone before removing local state. */
export function ensureVaultRetraction(vault: VaultRow, operationId?: string, writerId?: string): boolean {
  const rid = vault.ridHex.toLowerCase();
  const winner = () => {
    const matches = [...foldFedVaultWinners(readAllFedVaultRecords()).values()]
      .filter((r) => r.vaultRid.replace(/-/g, "").toLowerCase() === rid);
    if (matches.length > 1) throw new Error(`Conflicting ledger keys for vault '${vault.name}'; retraction is not verified.`);
    return matches[0];
  };
  const alreadyBound = () => readAllFedVaultRecords().some((r) => r.vaultRid.replace(/-/g, "").toLowerCase() === rid && r.state === "tombstoned" && r.operationId === operationId && r.writerId === writerId);
  let changed = false;
  if (winner()?.state !== "tombstoned" || (operationId !== undefined && !alreadyBound())) {
    try {
      appendFedVaultTombstone({ vaultRid: vault.ridHex, vaultName: vault.name,
        homeMeshRidHex: vault.homeMeshRidHex, repo: vaultRepoName(vault.name),
        visibility: "private", status: "active", observedMaxHlc: observedMaxFedVaultHlc(),
        ...(operationId === undefined ? {} : { operationId }), ...(writerId === undefined ? {} : { writerId }) });
      changed = true;
    } catch (error) {
      throw new Error(`Retraction of '${vault.name}' failed or is unverified; the ledger may have changed, but local registry and vault state were not removed. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  try {
    if (winner()?.state !== "tombstoned" || (operationId !== undefined && !alreadyBound())) throw new Error("bound tombstone is not verified");
  } catch (error) {
    throw new Error(`Retraction of '${vault.name}' was not verified; the ledger may have changed, but local state was not removed. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return changed;
}
