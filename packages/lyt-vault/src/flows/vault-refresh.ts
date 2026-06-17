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

// 0.9.3 — `lyt vault refresh <name>`. Writability is derived on-demand
// and cached in-process (writability.ts: no schema column, Path C). For a
// FOREIGN-HOME subscription each fresh CLI process already re-probes gh, so a
// later access grant is picked up automatically; but a PURE subscriber
// short-circuits to `subscriber-default-false` WITHOUT a probe (the upgrade is
// invisible), and within one long-running process the 60s cache can pin a stale
// verdict. This flow forces a live re-probe (forceProbe: bypass cache + skip the
// subscriber short-circuit) so a handler can confirm a gained/lost access
// transition on demand. The gh probe is the source of truth; the role is a hint.

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName } from "../registry/repo.js";
import { deriveVaultWritable, type DeriveVaultWritableOpts, type WritabilityVerdict } from "./writability.js";

export interface RefreshWritabilityResult {
  name: string;
  writable: WritabilityVerdict["writable"];
  reason: WritabilityVerdict["reason"];
}

export async function refreshVaultWritableFlow(
  name: string,
  opts: DeriveVaultWritableOpts = {},
): Promise<RefreshWritabilityResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, name);
    if (!vault) {
      throw new Error(`No vault registered with name '${name}'. Try 'lyt vault list'.`);
    }
    const verdict = await deriveVaultWritable(vault, db, { ...opts, forceProbe: true });
    return { name: vault.name, writable: verdict.writable, reason: verdict.reason };
  } finally {
    await closeRegistry(db);
  }
}
