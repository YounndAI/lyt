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
import { getVaultByName, listVaults, type VaultRow } from "../registry/repo.js";

// Single source of truth for the "pick one vault" + "pick the set of active
// vaults" lookups that every block-A.2 verb (friction, provenance trace,
// audit export) was repeating verbatim. release review — factored
// here pre-A.3 Commit 11 because that commit adds a 4th caller (machine
// verbs), which would have tripled the duplication.

// Returns the single vault matching `vaultName`, or — when `vaultName` is
// undefined — the only active (non-tombstoned) vault registered. Throws on
// ambiguity ("--vault required when N active vaults are registered") or on
// the empty case. Callers do not need to wrap with their own openRegistry /
// closeRegistry.
export async function resolveSingleVault(vaultName: string | undefined): Promise<VaultRow> {
  const db = await openRegistry();
  try {
    if (vaultName) {
      const v = await getVaultByName(db, vaultName);
      if (!v) throw new Error(`No vault registered with name '${vaultName}'.`);
      return v;
    }
    const all = await listVaults(db);
    const active = all.filter((v) => v.status !== "tombstoned");
    if (active.length === 0) {
      throw new Error(
        "No registered non-tombstoned vault available. Run `lyt vault init <name>` or pass --vault <name>.",
      );
    }
    if (active.length > 1) {
      throw new Error(
        `--vault is required when ${active.length} non-tombstoned vaults are registered. Vaults: ${active.map((v) => v.name).join(", ")}`,
      );
    }
    return active[0]!;
  } finally {
    await closeRegistry(db);
  }
}

// Returns either the single matching vault as a 1-element list (or empty if
// the name is unknown), or every active vault. Used by export-shaped verbs
// that fan out across the mesh rather than ambiguity-erroring like
// resolveSingleVault.
export async function resolveVaults(vaultName: string | undefined): Promise<VaultRow[]> {
  const db = await openRegistry();
  try {
    if (vaultName) {
      const v = await getVaultByName(db, vaultName);
      return v ? [v] : [];
    }
    const all = await listVaults(db);
    return all.filter((v) => v.status !== "tombstoned");
  } finally {
    await closeRegistry(db);
  }
}
