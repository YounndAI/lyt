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

import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendPendingOp, closeOpLog, markOpApplied, openOpLog } from "../op/operation-log.js";
import { openReceiptAttempt, reopenReceiptAttempt } from "../op/receipt-attempt.js";
import { findPendingReceiptAttemptForOperation, queryReceiptAttempts } from "../op/receipt-repository.js";
import { parseReceiptV1ForEmission, type ReceiptV1 } from "../op/receipt-v1.js";
import { getLytHome } from "../util/paths.js";
import { normalizeGithubPublicationCoordinate } from "../util/publication-coordinate.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import { getWriterId } from "../util/writer-id.js";
import { withDestinationPolicyLock } from "./federation/destination-policy-lock.js";
import { unsubscribeOrphanFlow } from "./unsubscribe.js";

type Plan = { version: 1; operationId: string; coordinate: string; rid: string; writerId: string };
const JOURNAL_KIND = "unsubscribe-lifecycle-v1";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (p: Plan): string => createHash("sha256").update(JSON.stringify(p)).digest("hex");
const nextId = () => uuid7BytesToDashedString(newUuidv7Bytes());

function receipt(plan: Plan, attemptId: string, startedAt: string, status: "no-op" | "success", resumed: boolean): ReceiptV1 {
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt", schema_version: { major: 1, minor: 0 },
    operation_id: plan.operationId, attempt_id: attemptId, operation: "mesh-unsubscribe", scope: { kind: "system" },
    timestamps: { started_at: startedAt, finished_at: new Date().toISOString() },
    replay: { disposition: resumed ? "resumed" : "new", key_digest: digest(plan) },
    status, exit_code: 0, mutations: { local: status === "success" ? 1 : 0, remote: 0 },
    evidence: { before: [], after: [{ kind: "subscription-state", subject: "exact relationship retracted", digest: digest(plan) }] },
    next_action: null, error: null,
  });
}

async function loadPlan(operationId: string): Promise<{ plan: Plan; journalId: Uint8Array; status: string }> {
  if (!UUID_V7.test(operationId)) throw new Error("invalid unsubscribe operation ID");
  const db = await openOpLog();
  try {
    const rows = await db.execute({ sql: `SELECT id, file_set, status FROM op_log
      WHERE kind = ? AND json_valid(file_set) AND json_array_length(file_set) = 1
      AND json_valid(json_extract(file_set, '$[0]'))
      AND json_extract(json_extract(file_set, '$[0]'), '$.operationId') = ? LIMIT 2`, args: [JOURNAL_KIND, operationId] });
    if (rows.rows.length !== 1) throw new Error("unsubscribe journal is absent or ambiguous");
    const row = rows.rows[0]!; const files = JSON.parse(String(row["file_set"])) as unknown;
    if (!Array.isArray(files) || files.length !== 1 || typeof files[0] !== "string") throw new Error("unsubscribe journal is malformed");
    const p = JSON.parse(files[0]) as Partial<Plan>;
    if (p.version !== 1 || p.operationId !== operationId || typeof p.coordinate !== "string" || typeof p.rid !== "string" || typeof p.writerId !== "string" || !UUID_V7.test(p.writerId) || !/^[0-9a-f]{32}$/.test(p.rid) || normalizeGithubPublicationCoordinate(p.coordinate)?.coordinate !== p.coordinate) {
      throw new Error("unsubscribe journal is malformed");
    }
    const rawId = row["id"];
    const id = rawId instanceof Uint8Array ? rawId : rawId instanceof ArrayBuffer ? new Uint8Array(rawId) : null;
    if (id === null || id.length !== 16) throw new Error("unsubscribe journal identity is invalid");
    return { plan: p as Plan, journalId: id, status: String(row["status"]) };
  } finally { await closeOpLog(db); }
}

/** Durable plan + Receipt V1 around one exact, non-destructive relationship. */
export async function unsubscribeWithReceipt(args: {
  coordinate?: string; rid?: string; resume?: string; confirmed: boolean; onPlan?: (operationId: string) => void;
  /** Synthetic crash-injection seams; never supplied by CLI. */
  afterJournal?: (operationId: string) => void; afterReceipt?: () => void; afterApply?: () => void;
}): Promise<ReceiptV1> {
  if (!args.confirmed) throw new Error("unsubscribe requires explicit confirmation (--yes).");
  let plan: Plan; let journalId: Uint8Array; let journalStatus = "pending";
  if (args.resume !== undefined) {
    if (args.coordinate !== undefined || args.rid !== undefined) throw new Error("resume cannot be combined with a new coordinate or RID");
    const saved = await loadPlan(args.resume); plan = saved.plan; journalId = saved.journalId; journalStatus = saved.status;
  } else {
    const normalized = normalizeGithubPublicationCoordinate(args.coordinate);
    const rid = args.rid?.replace(/-/g, "").toLowerCase();
    if (normalized === null || rid === undefined || !/^[0-9a-f]{32}$/.test(rid)) throw new Error("unsubscribe requires a valid GitHub coordinate and exact RID");
    plan = { version: 1, operationId: nextId(), coordinate: normalized.coordinate, rid, writerId: getWriterId() };
    const db = await openOpLog();
    try { journalId = await appendPendingOp(db, { kind: JOURNAL_KIND, horizon: "local", fileSet: [JSON.stringify(plan)], inverse: { class: "none", reason: "Subscription retraction must be intentionally reversed by a new subscription." } }, new Date().toISOString()); }
    finally { await closeOpLog(db); }
    args.afterJournal?.(plan.operationId);
  }
  if (getWriterId() !== plan.writerId) throw new Error("unsubscribe writer identity changed; inspect before resuming");
  const lock = join(getLytHome(), "locks", `unsubscribe-${digest(plan)}.lock`);
  return withDestinationPolicyLock(lock, async () => {
    const db = await openOpLog();
    let pending: Awaited<ReturnType<typeof findPendingReceiptAttemptForOperation>>;
    try {
      const terminal = await queryReceiptAttempts(db, { operationId: plan.operationId, operation: "mesh-unsubscribe", limit: 1 });
      if (terminal.attempts.length > 0) {
        const stored = terminal.attempts[0] as ReceiptV1;
        if (stored.replay.key_digest !== digest(plan)) throw new Error("unsubscribe journal does not match its receipt");
        return stored;
      }
      pending = await findPendingReceiptAttemptForOperation(db, plan.operationId);
    } finally { await closeOpLog(db); }
    if (args.resume !== undefined && pending === null) {
      throw new Error("unsubscribe plan has no bound receipt; no relationship change was authorized by this plan. Start a new operation.");
    }
    const attemptId = pending?.attemptId ?? nextId();
    const startedAt = pending?.startedAt ?? new Date().toISOString();
    const initial = receipt(plan, attemptId, startedAt, "no-op", pending !== null);
    const opened = pending === null ? await openReceiptAttempt(initial) : await reopenReceiptAttempt(initial);
    if (opened.kind !== "ready") throw new Error(`Receipt store unavailable; no relationship change was attempted. Resume operation ${plan.operationId}.`);
    try {
      args.onPlan?.(plan.operationId);
      args.afterReceipt?.();
      const result = await unsubscribeOrphanFlow({ coordinate: plan.coordinate, rid: plan.rid, confirmed: true, operationId: plan.operationId, writerId: plan.writerId });
      args.afterApply?.();
      const terminal = receipt(plan, attemptId, startedAt, result.status === "retracted" ? "success" : "no-op", pending !== null);
      const warnings = await opened.session.finalize(terminal);
      if (warnings.length > 0) throw new Error(`Receipt finalization unverified; resume operation ${plan.operationId}.`);
      if (journalStatus === "pending") {
        const journal = await openOpLog();
        try { await markOpApplied(journal, journalId, { horizon: "local", inverse: { class: "none", reason: "Subscription retraction must be intentionally reversed by a new subscription." } }, new Date().toISOString()); }
        finally { await closeOpLog(journal); }
      }
      return terminal;
    } catch (error) {
      await opened.session.close?.();
      throw new Error(`Unsubscribe did not reach a verified terminal receipt; resume operation ${plan.operationId}. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }, { acquireTimeoutMs: 5_000, leaseMs: 60_000, subject: plan.operationId });
}
