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

import type { Client } from "@libsql/client";
import { listFederationStates } from "../registry/federation-state.js";
import type { VaultRow } from "../registry/repo.js";
import { destinationPolicyKey } from "../registry/destination-policy.js";
import { openSqliteReadOnly } from "../sqlite/read-only-client.js";
import { getOutboxPath, parseVaultOutboxTarget } from "./federation/outbox.js";
import { foldDestinationPolicyWinners, readAllDestinationPolicyRecords } from "./federation/destination-policy-ledger.js";
import { tombstoneCanonicalVaultDestination } from "./federation/destination-policy-service.js";

/** Preserve any pending publication for this exact vault rather than drop it. */
export function assertNoTargetPublication(vault: VaultRow): void {
  const opened = openSqliteReadOnly(getOutboxPath());
  if (opened.kind === "missing") return;
  try {
    const rows = opened.database.queryAll<{ op: string; target: string }>("SELECT op, target FROM outbox");
    if (rows.some((row) => row.op === "publish-vault" &&
      (parseVaultOutboxTarget(row.target)?.replace(/-/g, "").toLowerCase() === vault.ridHex.toLowerCase() || row.target === vault.name))) {
      throw new Error(`Pending publication for '${vault.name}' must be resolved before local removal; it was not cleared.`);
    }
  } finally { opened.database.close(); }
}

/** Retract the target policy, not inherited mesh policy or unrelated winners. */
export async function retractTargetDestination(db: Client, vault: VaultRow): Promise<boolean> {
  const states = await listFederationStates(db);
  if (states.length === 0) return false;
  if (states.length !== 1) throw new Error("pod identity is ambiguous; destination policy is unchanged");
  const podRid = states[0]!.fedRidHex;
  const winner = () => foldDestinationPolicyWinners(readAllDestinationPolicyRecords(podRid))
    .get(destinationPolicyKey("vault", vault.ridHex));
  if (winner()?.state !== "active") return false;
  await tombstoneCanonicalVaultDestination(db, vault.rid);
  if (winner()?.state !== "tombstoned") throw new Error("destination retraction could not be verified");
  return true;
}
