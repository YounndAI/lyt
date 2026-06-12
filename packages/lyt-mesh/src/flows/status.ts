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

import {
  closeRegistry,
  listVaults,
  openRegistry,
  ridsEqual,
  type VaultRow,
} from "@younndai/lyt-vault";

import type { Client } from "@libsql/client";

// v1.A.1b: `mesh_edges` no longer carries single-mesh (sourceVaultRid,
// edgeType, targetVaultRid) triples — its cross-mesh shape only fills in
// once `lyt mesh init` lands in v1.B.1. Until then, status traverses the
// `vaults.parent_vault` BLOB FK directly (same fallback as lyt-vault
// `flows/sync-metadata.ts`). The legacy `share_with` semantic collapses to
// mesh subscriptions in v1.C.1 and is intentionally absent here.

export interface StatusCluster {
  rootRid: string; // dashed-UUIDv7 hex (vault.ridHex)
  members: string[]; // dashed-UUIDv7 hex per member
}

export interface StatusOutcome {
  vaults: VaultRow[];
  roots: string[]; // dashed-UUIDv7 hex
  clusters: StatusCluster[];
}

export interface StatusOptions {
  db?: Client;
}

export async function statusFlow(opts: StatusOptions = {}): Promise<StatusOutcome> {
  const db = opts.db ?? (await openRegistry());
  const ownDb = opts.db === undefined;
  try {
    const vaults = await listVaults(db);

    // Children lookup: bytes-equal parent_vault → child membership.
    const ridHexes = new Set(vaults.map((v) => v.ridHex));
    const roots: string[] = [];
    for (const v of vaults) {
      const parentHex = v.parentVaultHex;
      if (parentHex === null || !ridHexes.has(parentHex)) {
        roots.push(v.ridHex);
      }
    }

    const clusters: StatusCluster[] = [];
    for (const rootHex of roots) {
      const members = collectSubtree(rootHex, vaults);
      clusters.push({ rootRid: rootHex, members });
    }

    return { vaults, roots, clusters };
  } finally {
    if (ownDb) {
      await closeRegistry(db);
    }
  }
}

function collectSubtree(rootHex: string, vaults: readonly VaultRow[]): string[] {
  const byRidHex = new Map<string, VaultRow>(vaults.map((v) => [v.ridHex, v]));
  const childrenOf = new Map<string, string[]>();
  for (const v of vaults) {
    if (!v.parentVault) continue;
    const parent = vaults.find((p) => ridsEqual(p.rid, v.parentVault));
    if (!parent) continue;
    const arr = childrenOf.get(parent.ridHex);
    if (arr) arr.push(v.ridHex);
    else childrenOf.set(parent.ridHex, [v.ridHex]);
  }
  const visited = new Set<string>();
  const out: string[] = [];
  const stack: string[] = [rootHex];
  while (stack.length > 0) {
    const r = stack.pop()!;
    if (visited.has(r)) continue;
    if (!byRidHex.has(r)) continue;
    visited.add(r);
    out.push(r);
    const kids = childrenOf.get(r) ?? [];
    for (const k of kids) stack.push(k);
  }
  return out;
}
