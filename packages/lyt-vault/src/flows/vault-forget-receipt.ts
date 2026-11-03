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
import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { getLytHome } from "../util/paths.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import { getWriterId } from "../util/writer-id.js";
import { withDestinationPolicyLock } from "./federation/destination-policy-lock.js";
import { forgetVaultFlow } from "./forget.js";
import { readAllFedVaultRecords } from "../yon/federation-vault-ledger-read.js";

type Snapshot = Omit<VaultRow, "rid" | "homeMeshRid" | "memscopeRid" | "parentVault">;
type Plan = { version: 1; operationId: string; writerId: string; tombstone: boolean; vault: Snapshot };
const kind = "vault-forget-lifecycle-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hex = /^[0-9a-f]{32}$/i;
const nextId = () => uuid7BytesToDashedString(newUuidv7Bytes());
const digest = (p: Plan) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
const inverse = { class: "none" as const, reason: "Rejoining a forgotten vault requires a new operation." };

function snapshot(v: VaultRow): Snapshot {
  const { rid: _rid, homeMeshRid: _home, memscopeRid: _memscope, parentVault: _parent, ...rest } = v;
  return rest;
}
function hydrate(v: Snapshot): VaultRow {
  const bytes = (s: string | null) => s === null ? null : new Uint8Array(Buffer.from(s, "hex"));
  return { ...v, rid: bytes(v.ridHex)!, homeMeshRid: bytes(v.homeMeshRidHex), memscopeRid: bytes(v.memscopeRidHex), parentVault: bytes(v.parentVaultHex) };
}
function validate(p: Plan, id: string): void {
  const v = p?.vault;
  const optionalHex = (x: unknown) => x === null || (typeof x === "string" && hex.test(x));
  if (p?.version !== 1 || p.operationId !== id || !uuid.test(id) || !uuid.test(p.writerId) || typeof p.tombstone !== "boolean" ||
      !v || typeof v.name !== "string" || typeof v.path !== "string" || !hex.test(v.ridHex) ||
      !optionalHex(v.homeMeshRidHex) || !optionalHex(v.memscopeRidHex) || !optionalHex(v.parentVaultHex) ||
      !["own", "subscribed", "shared"].includes(v.source) || !(v.gitUrl === null || typeof v.gitUrl === "string")) {
    throw new Error("Forget journal is malformed.");
  }
}
function receipt(p: Plan, attemptId: string, startedAt: string, resumed: boolean, status: "no-op" | "success" | "partial" | "failed"): ReceiptV1 {
  const incomplete = status === "partial" || status === "failed";
  const mutated = status === "success" || status === "partial";
  return parseReceiptV1ForEmission({ schema_id: "lyt.receipt", schema_version: { major: 1, minor: 0 },
    operation_id: p.operationId, attempt_id: attemptId, operation: "vault-forget", scope: { kind: "system" },
    timestamps: { started_at: startedAt, finished_at: new Date().toISOString() },
    replay: { disposition: resumed ? "resumed" : "new", key_digest: digest(p) }, status,
    exit_code: incomplete ? 1 : 0, mutations: { local: mutated ? 1 : 0, remote: 0 }, evidence: { before: [], after: mutated ? [{ kind: "vault-ledger", subject: "operation-bound local retraction recorded", digest: digest(p) }] : [] },
    next_action: incomplete ? { code: "resume-vault-forget", summary: "Resolve the local cause and resume this operation by its operation ID." } : null,
    error: incomplete ? { code: "forget-incomplete", summary: "Local forget did not reach a verified complete state.", retryable: true } : null });
}

async function load(id: string): Promise<{ plan: Plan; journalId: Uint8Array; status: string }> {
  if (!uuid.test(id)) throw new Error("Invalid forget operation ID.");
  const db = await openOpLog();
  try {
    const rows = await db.execute({ sql: `SELECT id, file_set, status FROM op_log WHERE kind = ? AND json_valid(file_set) AND json_array_length(file_set) = 1 AND json_valid(json_extract(file_set, '$[0]')) AND json_extract(json_extract(file_set, '$[0]'), '$.operationId') = ? LIMIT 2`, args: [kind, id] });
    if (rows.rows.length !== 1) throw new Error("Forget journal is absent or ambiguous.");
    const row = rows.rows[0]!; const files = JSON.parse(String(row["file_set"])) as unknown;
    if (!Array.isArray(files) || files.length !== 1 || typeof files[0] !== "string") throw new Error("Forget journal is malformed.");
    const plan = JSON.parse(files[0]) as Plan; validate(plan, id);
    const raw = row["id"]; const journalId = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    if (!journalId || journalId.length !== 16) throw new Error("Forget journal identity is invalid.");
    return { plan, journalId, status: String(row["status"]) };
  } finally { await closeOpLog(db); }
}

/** Journal and bind the exact vault before a non-destructive retraction. */
export async function forgetWithReceipt(args: { name?: string; tombstone?: boolean; resume?: string; onPlan?: (id: string) => void; afterJournal?: (id: string) => void; afterReceipt?: () => void; afterStage?: (stage: string) => void }): Promise<ReceiptV1> {
  let plan: Plan; let journalId: Uint8Array; let journalStatus = "pending";
  if (args.resume !== undefined) {
    if (args.name !== undefined || args.tombstone !== undefined) throw new Error("Resume cannot be combined with a new vault or options.");
    ({ plan, journalId, status: journalStatus } = await load(args.resume));
  } else {
    if (!args.name) throw new Error("A vault name is required.");
    const db = await openRegistry(); let vault: VaultRow | null;
    try { vault = await getVaultByName(db, args.name); } finally { await closeRegistry(db); }
    if (!vault || vault.status === "tombstoned") throw new Error("Vault is not actively registered.");
    plan = { version: 1, operationId: nextId(), writerId: getWriterId(), tombstone: args.tombstone === true, vault: snapshot(vault) };
    const log = await openOpLog();
    try { journalId = await appendPendingOp(log, { kind, horizon: "local", fileSet: [JSON.stringify(plan)], inverse }, new Date().toISOString()); }
    finally { await closeOpLog(log); }
    args.afterJournal?.(plan.operationId);
  }
  if (getWriterId() !== plan.writerId) throw new Error("Forget writer identity changed; inspect before resuming.");
  return withDestinationPolicyLock(join(getLytHome(), "locks", `forget-${digest(plan)}.lock`), async () => {
    const db = await openOpLog(); let pending: Awaited<ReturnType<typeof findPendingReceiptAttemptForOperation>>; let prior: ReceiptV1 | undefined;
    try {
      const terminal = await queryReceiptAttempts(db, { operationId: plan.operationId, operation: "vault-forget", limit: 1 });
      if (terminal.attempts.length > 0) {
        prior = terminal.attempts[0] as ReceiptV1;
        if (prior.replay.key_digest !== digest(plan)) throw new Error("Forget journal does not match its receipt.");
        if (prior.status === "success" || prior.status === "no-op") {
          if (journalStatus === "pending") await markOpApplied(db, journalId, { horizon: "local", inverse }, new Date().toISOString());
          return prior;
        }
      }
      pending = await findPendingReceiptAttemptForOperation(db, plan.operationId);
    } finally { await closeOpLog(db); }
    if (args.resume !== undefined && pending === null && prior === undefined) throw new Error("Forget plan has no bound receipt; start a new operation.");
    const attemptId = pending?.attemptId ?? nextId(); const startedAt = pending?.startedAt ?? new Date().toISOString();
    const resumed = args.resume !== undefined;
    const initial = receipt(plan, attemptId, startedAt, resumed, "no-op");
    const opened = pending === null ? await openReceiptAttempt(initial) : await reopenReceiptAttempt(initial);
    if (opened.kind !== "ready") throw new Error(`Receipt unavailable; resume operation ${plan.operationId}.`);
    const marker = () => readAllFedVaultRecords().some((r) => r.vaultRid.replace(/-/g, "").toLowerCase() === plan.vault.ridHex.toLowerCase() && r.operationId === plan.operationId && r.writerId === plan.writerId && r.state === "tombstoned");
    const markerBefore = marker(); let mutated = false; let knownFailure = false;
    const priorPendingEffect = pending !== null && prior === undefined && markerBefore;
    const ambiguousPendingEffect = pending !== null && prior !== undefined && markerBefore;
    try {
      args.onPlan?.(plan.operationId); args.afterReceipt?.();
      const v = plan.vault;
      const result = await forgetVaultFlow(v.name, { tombstone: plan.tombstone, expectedRid: v.ridHex, expectedPath: v.path, expectedHomeMeshRid: v.homeMeshRidHex, expectedSource: v.source, expectedGitUrl: v.gitUrl, operationId: plan.operationId, writerId: plan.writerId, recoveryVault: hydrate(v), onMutation: () => { mutated = true; },
        ...(args.afterStage === undefined ? {} : { afterStage: (stage: string) => { try { args.afterStage?.(stage); } catch (error) { knownFailure = true; throw error; } } }) });
      if (result.projectionPending) { knownFailure = true; throw new Error(`Pod projection remains pending: ${result.projectionNote ?? "unverified"}`); }
      if (!mutated && ambiguousPendingEffect) throw new Error("The interrupted attempt's mutation count is unverified.");
      const final = receipt(plan, attemptId, startedAt, resumed, mutated || priorPendingEffect ? "success" : "no-op");
      if ((await opened.session.finalize(final)).length > 0) throw new Error("Receipt finalization was not verified.");
      if (journalStatus === "pending") {
        const log = await openOpLog();
        try { await markOpApplied(log, journalId, { horizon: "local", inverse }, new Date().toISOString()); } finally { await closeOpLog(log); }
      }
      return final;
    } catch (error) {
      const changed = mutated || priorPendingEffect || (!markerBefore && marker());
      if (!changed && (ambiguousPendingEffect || !knownFailure)) {
        await opened.session.close?.();
        throw new Error(`Forget outcome is unverified; inspect and resume operation ${plan.operationId}.`, { cause: error });
      }
      const final = receipt(plan, attemptId, startedAt, resumed, changed ? "partial" : "failed");
      if ((await opened.session.finalize(final)).length > 0) throw new Error(`Receipt finalization unverified; resume operation ${plan.operationId}.`, { cause: error });
      return final;
    }
  }, { acquireTimeoutMs: 5_000, leaseMs: 60_000, subject: plan.operationId });
}
