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

// Per-vault libSQL helpers — automator_runs / automator_run_events /
// provenance / audit_log writers.
//
// The block-A.3 schema (vault-db-migrations.ts migration001) declared the
// tables; block-B Commit 5 (this module) ships the open-once-seam writers
// the lyt-runner pre-write hook + 5-step protocol invoke. Same pattern as
// leases-repo.ts: every helper takes `db: Client` as its first arg and is
// pure SQL + bindings — no top-level state, no module-scope caches.
//
// Source: arc-thoughts §6.6 (5-step protocol) + §6.9 (observability —
// automator_run_events level enum + audit_log action enum) + §11.4
// (pre-write hook 6-step contract) + brief @TASK clauses 5 + 8 + @ACCEPT.h.

import type { Client } from "@libsql/client";

import { AUDIT_ACTIONS, type AuditAction } from "./vault-db-migrations.js";

// ---------------------------------------------------------------------------
// automator_runs
// ---------------------------------------------------------------------------

export type AutomatorRunStatus =
  | "pending"
  | "lease_acquired"
  | "synced"
  | "body_running"
  | "body_completed"
  | "committed"
  | "completed"
  | "failed_lease"
  | "failed_sync"
  | "failed_body"
  | "failed_commit"
  | "failed_release";

export interface AutomatorRunRow {
  id: Uint8Array;
  automatorName: string;
  vaultRid: Uint8Array;
  startedAt: number;
  endedAt: number | null;
  status: AutomatorRunStatus;
  vaultWritesCount: number;
  llmCallsCount: number;
  llmCostUsd: number;
  sourceUsed: string | null;
  errorSummary: string | null;
}

export interface InsertAutomatorRunArgs {
  id: Uint8Array;
  automatorName: string;
  vaultRid: Uint8Array;
  startedAt: number;
  status?: AutomatorRunStatus;
  sourceUsed?: string;
}

export async function insertAutomatorRun(db: Client, args: InsertAutomatorRunArgs): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO automator_runs (id, automator_name, vault_rid, started_at, status, vault_writes_count, llm_calls_count, llm_cost_usd, source_used) " +
      "VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)",
    args: [
      args.id,
      args.automatorName,
      args.vaultRid,
      args.startedAt,
      args.status ?? "pending",
      args.sourceUsed ?? null,
    ],
  });
}

export interface UpdateAutomatorRunStatusArgs {
  id: Uint8Array;
  status: AutomatorRunStatus;
  endedAt?: number;
  vaultWritesCount?: number;
  llmCallsCount?: number;
  llmCostUsd?: number;
  sourceUsed?: string;
  errorSummary?: string;
}

export async function updateAutomatorRunStatus(
  db: Client,
  args: UpdateAutomatorRunStatusArgs,
): Promise<void> {
  const sets: string[] = ["status = ?"];
  const values: Array<string | number | Uint8Array | null> = [args.status];
  if (args.endedAt !== undefined) {
    sets.push("ended_at = ?");
    values.push(args.endedAt);
  }
  if (args.vaultWritesCount !== undefined) {
    sets.push("vault_writes_count = ?");
    values.push(args.vaultWritesCount);
  }
  if (args.llmCallsCount !== undefined) {
    sets.push("llm_calls_count = ?");
    values.push(args.llmCallsCount);
  }
  if (args.llmCostUsd !== undefined) {
    sets.push("llm_cost_usd = ?");
    values.push(args.llmCostUsd);
  }
  if (args.sourceUsed !== undefined) {
    sets.push("source_used = ?");
    values.push(args.sourceUsed);
  }
  if (args.errorSummary !== undefined) {
    sets.push("error_summary = ?");
    values.push(args.errorSummary);
  }
  values.push(args.id);
  await db.execute({
    sql: `UPDATE automator_runs SET ${sets.join(", ")} WHERE id = ?`,
    args: values,
  });
}

export async function incrementVaultWritesCount(db: Client, runId: Uint8Array): Promise<void> {
  await db.execute({
    sql: "UPDATE automator_runs SET vault_writes_count = vault_writes_count + 1 WHERE id = ?",
    args: [runId],
  });
}

export async function getAutomatorRunById(
  db: Client,
  id: Uint8Array,
): Promise<AutomatorRunRow | null> {
  const r = await db.execute({
    sql:
      "SELECT id, automator_name, vault_rid, started_at, ended_at, status, vault_writes_count, llm_calls_count, llm_cost_usd, source_used, error_summary " +
      "FROM automator_runs WHERE id = ? LIMIT 1",
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return rowToAutomatorRun(r.rows[0]!);
}

export interface ListAutomatorRunsFilter {
  automatorName?: string;
  vaultRid?: Uint8Array;
  sinceMs?: number;
  status?: AutomatorRunStatus;
  limit?: number;
}

export async function listAutomatorRuns(
  db: Client,
  filter: ListAutomatorRunsFilter = {},
): Promise<AutomatorRunRow[]> {
  const where: string[] = [];
  const vals: Array<string | number | Uint8Array> = [];
  if (filter.automatorName !== undefined) {
    where.push("automator_name = ?");
    vals.push(filter.automatorName);
  }
  if (filter.vaultRid !== undefined) {
    where.push("vault_rid = ?");
    vals.push(filter.vaultRid);
  }
  if (filter.sinceMs !== undefined) {
    where.push("started_at >= ?");
    vals.push(filter.sinceMs);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    vals.push(filter.status);
  }
  const limit = filter.limit ?? 100;
  const sql =
    "SELECT id, automator_name, vault_rid, started_at, ended_at, status, vault_writes_count, llm_calls_count, llm_cost_usd, source_used, error_summary " +
    "FROM automator_runs" +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY started_at DESC LIMIT ${limit}`;
  const r = await db.execute({ sql, args: vals });
  return r.rows.map((row) => rowToAutomatorRun(row));
}

function rowToAutomatorRun(row: Record<string, unknown>): AutomatorRunRow {
  return {
    id: toBytes(row["id"]),
    automatorName: row["automator_name"] as string,
    vaultRid: toBytes(row["vault_rid"]),
    startedAt: Number(row["started_at"]),
    endedAt: row["ended_at"] === null ? null : Number(row["ended_at"]),
    status: row["status"] as AutomatorRunStatus,
    vaultWritesCount: Number(row["vault_writes_count"] ?? 0),
    llmCallsCount: Number(row["llm_calls_count"] ?? 0),
    llmCostUsd: Number(row["llm_cost_usd"] ?? 0),
    sourceUsed: (row["source_used"] as string | null) ?? null,
    errorSummary: (row["error_summary"] as string | null) ?? null,
  };
}

// libSQL's driver returns BLOB columns as `ArrayBuffer` (libsql/v0.15
// behavior). Block-A's vaults-repo + leases-repo both adopt the same
// `toBytes` boundary helper — we mirror it here for consistency.
function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new Error(`vault-db-repo: expected BLOB column, got ${typeof raw}`);
}

// ---------------------------------------------------------------------------
// automator_run_events
// ---------------------------------------------------------------------------

export type AutomatorRunEventLevel = "debug" | "info" | "warn" | "error";

export interface AutomatorRunEventRow {
  id: Uint8Array;
  runId: Uint8Array;
  ts: number;
  level: AutomatorRunEventLevel;
  message: string;
  dataJson: string | null;
}

export interface InsertAutomatorRunEventArgs {
  id: Uint8Array;
  runId: Uint8Array;
  ts: number;
  level: AutomatorRunEventLevel;
  message: string;
  data?: Record<string, unknown>;
}

export async function insertAutomatorRunEvent(
  db: Client,
  args: InsertAutomatorRunEventArgs,
): Promise<void> {
  const dataJson = args.data === undefined ? null : JSON.stringify(args.data);
  await db.execute({
    sql: "INSERT INTO automator_run_events (id, run_id, ts, level, message, data_json) VALUES (?, ?, ?, ?, ?, ?)",
    args: [args.id, args.runId, args.ts, args.level, args.message, dataJson],
  });
}

export interface ListAutomatorRunEventsFilter {
  runId?: Uint8Array;
  sinceMs?: number;
  level?: AutomatorRunEventLevel;
  limit?: number;
}

export async function listAutomatorRunEvents(
  db: Client,
  filter: ListAutomatorRunEventsFilter = {},
): Promise<AutomatorRunEventRow[]> {
  const where: string[] = [];
  const vals: Array<string | number | Uint8Array> = [];
  if (filter.runId !== undefined) {
    where.push("run_id = ?");
    vals.push(filter.runId);
  }
  if (filter.sinceMs !== undefined) {
    where.push("ts >= ?");
    vals.push(filter.sinceMs);
  }
  if (filter.level !== undefined) {
    where.push("level = ?");
    vals.push(filter.level);
  }
  const limit = filter.limit ?? 500;
  const sql =
    "SELECT id, run_id, ts, level, message, data_json FROM automator_run_events" +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ts ASC LIMIT ${limit}`;
  const r = await db.execute({ sql, args: vals });
  return r.rows.map((row) => ({
    id: toBytes(row["id"]),
    runId: toBytes(row["run_id"]),
    ts: Number(row["ts"]),
    level: row["level"] as AutomatorRunEventLevel,
    message: row["message"] as string,
    dataJson: (row["data_json"] as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

// Write-time target type enum for the pre-write hook (arc-thoughts §11.4
// step 2). Narrower than the read-side `ProvenanceTargetType` exported by
// flows/provenance-trace.ts — the read side accepts the legacy "vault" /
// "automator" / "memscope" prefixes that have already shipped per-vault
// rows. New automator writes go through this narrower enum so the write
// pipeline can't accidentally widen the target_type vocabulary.
export type ProvenanceWriteTargetType =
  | "note"
  | "declaration"
  | "rollup"
  | "automator-run"
  | "audit-event";

export interface ProvenanceRow {
  id: Uint8Array;
  targetType: ProvenanceWriteTargetType;
  targetId: string;
  ts: number;
  src: string;
  method: string | null;
  confidence: number | null;
  hash: string | null;
  tokens: number | null;
  costUsd: number | null;
  model: string | null;
  approver: string | null;
  detailsJson: string | null;
}

export interface InsertProvenanceArgs {
  id: Uint8Array;
  targetType: ProvenanceWriteTargetType;
  targetId: string;
  ts: number;
  src: string;
  method?: string;
  confidence?: number;
  hash?: string;
  tokens?: number;
  costUsd?: number;
  model?: string;
  approver?: string;
  details?: Record<string, unknown>;
}

export async function insertProvenance(db: Client, args: InsertProvenanceArgs): Promise<void> {
  const detailsJson = args.details === undefined ? null : JSON.stringify(args.details);
  await db.execute({
    sql:
      "INSERT INTO provenance (id, target_type, target_id, ts, src, method, confidence, hash, tokens, cost_usd, model, approver, details_json) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      args.id,
      args.targetType,
      args.targetId,
      args.ts,
      args.src,
      args.method ?? null,
      args.confidence ?? null,
      args.hash ?? null,
      args.tokens ?? null,
      args.costUsd ?? null,
      args.model ?? null,
      args.approver ?? null,
      detailsJson,
    ],
  });
}

export async function listProvenanceByTarget(
  db: Client,
  targetType: ProvenanceWriteTargetType,
  targetId: string,
): Promise<ProvenanceRow[]> {
  const r = await db.execute({
    sql:
      "SELECT id, target_type, target_id, ts, src, method, confidence, hash, tokens, cost_usd, model, approver, details_json " +
      "FROM provenance WHERE target_type = ? AND target_id = ? ORDER BY ts ASC",
    args: [targetType, targetId],
  });
  return r.rows.map((row) => ({
    id: toBytes(row["id"]),
    targetType: row["target_type"] as ProvenanceWriteTargetType,
    targetId: row["target_id"] as string,
    ts: Number(row["ts"]),
    src: row["src"] as string,
    method: (row["method"] as string | null) ?? null,
    confidence: row["confidence"] === null ? null : Number(row["confidence"]),
    hash: (row["hash"] as string | null) ?? null,
    tokens: row["tokens"] === null ? null : Number(row["tokens"]),
    costUsd: row["cost_usd"] === null ? null : Number(row["cost_usd"]),
    model: (row["model"] as string | null) ?? null,
    approver: (row["approver"] as string | null) ?? null,
    detailsJson: (row["details_json"] as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// audit_log
// ---------------------------------------------------------------------------

export type AuditLogResult = "success" | "failure" | "denied";

export interface InsertAuditLogArgs {
  id: Uint8Array;
  ts: number;
  actor: string;
  action: AuditAction | string;
  targetType: string;
  targetId: string;
  result?: AuditLogResult;
  details?: Record<string, unknown>;
}

export async function insertAuditLog(db: Client, args: InsertAuditLogArgs): Promise<void> {
  const detailsJson = args.details === undefined ? null : JSON.stringify(args.details);
  await db.execute({
    sql:
      "INSERT INTO audit_log (id, ts, actor, action, target_type, target_id, result, details_json) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      args.id,
      args.ts,
      args.actor,
      args.action,
      args.targetType,
      args.targetId,
      args.result ?? "success",
      detailsJson,
    ],
  });
}

// Convenience — automator.write audit row. The pre-write hook (lyt-runner
// hooks/stamp-on-write.ts) calls this after a provenance row is INSERTed
// per arc §11.4 step 6.
export async function insertAutomatorWriteAuditLog(
  db: Client,
  args: {
    id: Uint8Array;
    ts: number;
    actor: string; // typically `automator:<name>/v<ver>`
    provenanceId: Uint8Array;
    targetPath: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  // The audit row points at the provenance row id (hex-stringified to fit
  // the TEXT target_id column). The full chain is then queryable by joining
  // audit_log.target_id → provenance.id at read time.
  const provenanceIdHex = Buffer.from(args.provenanceId).toString("hex");
  const details = {
    target_path: args.targetPath,
    ...(args.details ?? {}),
  };
  await insertAuditLog(db, {
    id: args.id,
    ts: args.ts,
    actor: args.actor,
    action: AUDIT_ACTIONS.AUTOMATOR_WRITE,
    targetType: "provenance",
    targetId: provenanceIdHex,
    result: "success",
    details,
  });
}

// Re-export AUDIT_ACTIONS for callers that want symbolic constants.
export { AUDIT_ACTIONS };
