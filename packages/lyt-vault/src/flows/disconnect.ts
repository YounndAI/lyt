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
import {
  getVaultByName,
  updateVaultStatus,
  type VaultRow,
  type VaultStatus,
} from "../registry/repo.js";

export interface DisconnectFlowResult {
  vault: VaultRow;
  newStatus: VaultStatus;
}

export async function disconnectVaultFlow(name: string): Promise<DisconnectFlowResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, name);
    if (!vault) {
      throw new Error(`No vault registered with name '${name}'.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(`Vault '${name}' is tombstoned (terminal state).`);
    }
    await updateVaultStatus(db, vault.rid, "disconnected");
    return { vault: { ...vault, status: "disconnected" }, newStatus: "disconnected" };
  } finally {
    await closeRegistry(db);
  }
}
