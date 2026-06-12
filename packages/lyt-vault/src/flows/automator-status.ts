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

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { closeVaultDb, openLytDb } from "../registry/vault-db.js";
import {
  listAutomatorRuns,
  type AutomatorRunRow,
  type AutomatorRunStatus,
} from "../registry/vault-db-repo.js";
import { listLeasesByVault, type LeaseRow } from "../registry/leases-repo.js";
import { resolveSingleVault } from "../util/vault-resolve.js";
import { uuid7BytesToHex } from "../util/uuid7.js";

// block-B Commit 6 — `lyt automator status [--vault <name>] [--json]`.
//
// Snapshots automator_runs (per-vault DB) plus the active machine_leases
// for the vault (per-machine registry). The brief's "LEFT JOIN" wording
// is approximated in TS because the two tables live in different libSQL
// databases — they cannot be SQL-JOINed. Functional equivalence preserved.
//
// Buckets: running (status in body_*), leased (active leases), failed
// (status starts with failed_), completed (status='completed').

export interface AutomatorStatusEntry {
  runIdHex: string;
  automatorName: string;
  vaultRidHex: string;
  startedAt: number;
  endedAt: number | null;
  status: AutomatorRunStatus;
  vaultWritesCount: number;
  llmCallsCount: number;
  llmCostUsd: number;
  sourceUsed: string | null;
  errorSummary: string | null;
}

export interface AutomatorStatusLeaseEntry {
  leaseIdHex: string;
  automatorRidHex: string;
  machineId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface AutomatorStatusResult {
  vaultName: string;
  vaultPath: string;
  running: AutomatorStatusEntry[];
  leased: AutomatorStatusLeaseEntry[];
  failed: AutomatorStatusEntry[];
  completed: AutomatorStatusEntry[];
}

export interface AutomatorStatusArgs {
  vault?: string;
  limit?: number;
  vaultPathOverride?: string;
  // v1.A.5 CR-B1 open-once seam: caller-supplied registry client. When
  // omitted, the flow opens + closes its own. Caller owns lifecycle.
  registryDb?: Client;
}

export async function automatorStatusFlow(
  args: AutomatorStatusArgs = {},
): Promise<AutomatorStatusResult> {
  let vaultName: string;
  let vaultPath: string;
  let vaultRid: Uint8Array | null = null;
  if (args.vaultPathOverride !== undefined) {
    vaultPath = args.vaultPathOverride;
    vaultName = args.vault ?? "(override)";
  } else {
    const vault = await resolveSingleVault(args.vault);
    vaultName = vault.name;
    vaultPath = vault.path;
    vaultRid = vault.rid;
  }

  // Per-vault DB — automator_runs.
  let recentRuns: AutomatorRunRow[] = [];
  const limit = args.limit ?? 50;
  const vaultDb = await openLytDb(vaultPath);
  try {
    recentRuns = await listAutomatorRuns(vaultDb, { limit });
  } finally {
    await closeVaultDb(vaultDb);
  }

  // Per-machine registry — active leases for this vault.
  let leasesForVault: LeaseRow[] = [];
  if (vaultRid !== null) {
    const regDbCallerSupplied = args.registryDb !== undefined;
    const regDb = args.registryDb ?? (await openRegistry());
    try {
      const all = await listLeasesByVault(regDb, vaultRid);
      leasesForVault = all.filter((l) => l.status === "active");
    } finally {
      if (!regDbCallerSupplied) {
        await closeRegistry(regDb);
      }
    }
  }

  const toEntry = (row: AutomatorRunRow): AutomatorStatusEntry => ({
    runIdHex: uuid7BytesToHex(row.id),
    automatorName: row.automatorName,
    vaultRidHex: uuid7BytesToHex(row.vaultRid),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    status: row.status,
    vaultWritesCount: row.vaultWritesCount,
    llmCallsCount: row.llmCallsCount,
    llmCostUsd: row.llmCostUsd,
    sourceUsed: row.sourceUsed,
    errorSummary: row.errorSummary,
  });

  const running = recentRuns
    .filter(
      (r) => r.status === "body_running" || r.status === "lease_acquired" || r.status === "synced",
    )
    .map(toEntry);
  const failed = recentRuns.filter((r) => r.status.startsWith("failed_")).map(toEntry);
  const completed = recentRuns.filter((r) => r.status === "completed").map(toEntry);

  const leased = leasesForVault.map((l) => ({
    leaseIdHex: uuid7BytesToHex(l.leaseId),
    automatorRidHex: uuid7BytesToHex(l.automatorRid),
    machineId: l.machineId,
    acquiredAt: l.acquiredAt,
    expiresAt: l.expiresAt,
  }));

  return { vaultName, vaultPath, running, leased, failed, completed };
}
