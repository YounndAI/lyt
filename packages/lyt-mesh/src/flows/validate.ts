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

// v1.A.1b: `mesh_edges` no longer carries (sourceVaultRid, edgeType,
// targetVaultRid) — share_with semantic migrated to mesh subscriptions
// (v1.C.1) and the cross-mesh parent edges land in v1.B.1. Validation
// reduces to per-vault `parent_vault` FK checks against the vaults table.

export type ValidateIssueStatus = "dangling" | "tombstoned-target";

export type ValidateEdgeKind = "parent_vault";

export interface ValidateFinding {
  sourceVaultRid: string; // dashed-UUIDv7 hex (vault.ridHex)
  sourceVaultName: string;
  declaredEdge: ValidateEdgeKind;
  targetVaultRid: string; // dashed-UUIDv7 hex (parentVaultHex)
  status: ValidateIssueStatus;
}

export interface ValidateOutcome {
  findings: ValidateFinding[];
  totalVaults: number;
  // Edge count surfaced as the count of populated `vaults.parent_vault`
  // FKs (the only edge surface in v1.A.1b). Renamed mentally from
  // mesh_edges row count.
  totalEdges: number;
}

export interface ValidateOptions {
  db?: Client;
}

export async function validateFlow(opts: ValidateOptions = {}): Promise<ValidateOutcome> {
  const db = opts.db ?? (await openRegistry());
  const ownDb = opts.db === undefined;
  try {
    const vaults = await listVaults(db);
    const findings: ValidateFinding[] = [];
    let edgeCount = 0;

    for (const v of vaults) {
      if (v.parentVault === null) continue;
      edgeCount += 1;
      const target = vaults.find((p) => ridsEqual(p.rid, v.parentVault));
      const parentHex = v.parentVaultHex ?? "(unknown)";
      if (!target) {
        findings.push({
          sourceVaultRid: v.ridHex,
          sourceVaultName: v.name,
          declaredEdge: "parent_vault",
          targetVaultRid: parentHex,
          status: "dangling",
        });
        continue;
      }
      if (target.status === "tombstoned") {
        findings.push({
          sourceVaultRid: v.ridHex,
          sourceVaultName: v.name,
          declaredEdge: "parent_vault",
          targetVaultRid: target.ridHex,
          status: "tombstoned-target",
        });
      }
    }

    return {
      findings,
      totalVaults: vaults.length,
      totalEdges: edgeCount,
    };
  } finally {
    if (ownDb) {
      await closeRegistry(db);
    }
  }
}

// Re-export VaultRow for callers that previously relied on the validate
// module being the carrier of cross-package types.
export type { VaultRow };
