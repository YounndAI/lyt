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
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync } from "node:fs";
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
import { assertSafeWritePath } from "../util/write-path-guard.js";
import { readAllFedVaultRecords } from "../yon/federation-vault-ledger-read.js";
import { deleteVaultFlow } from "./delete.js";
import { withDestinationPolicyLock } from "./federation/destination-policy-lock.js";

type Entry = { path: string; kind: "file" | "directory" | "link"; dev: number; ino: number; links: number; size: number; mtime: number; digest?: string; target?: string };
type Plan = { version: 1; operationId: string; writerId: string; action: "delete" | "abandon"; name: string; rid: string; path: string; homeMeshRid: string | null; source: VaultRow["source"]; gitUrl: string | null; noTombstone: boolean; inventory: Entry[] };
const journalKind = "vault-delete-lifecycle-v1";
const filesystemIntentKind = "vault-delete-filesystem-intent-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nextId = () => uuid7BytesToDashedString(newUuidv7Bytes());
const digest = (plan: Plan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");
const inverse = { class: "none" as const, reason: "Deleting local derived state is not automatically reversible." };

/** A bounded no-follow preimage. Link targets are recorded, never traversed. */
function inventory(vaultPath: string): Entry[] {
  const root = join(vaultPath, ".lyt"); assertSafeWritePath(root);
  const result: Entry[] = []; let totalBytes = 0;
  const visit = (relative: string): void => {
    if (result.length >= 100_000) throw new Error("Derived-state inventory exceeds 100000 entries; inspect manually.");
    const full = relative === "" ? root : join(root, relative);
    let s; try { s = lstatSync(full); } catch (error) { if (relative === "" && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const base = { path: relative, dev: s.dev, ino: s.ino, links: s.nlink, size: s.size, mtime: s.mtimeMs };
    if (s.isSymbolicLink()) { result.push({ ...base, kind: "link", target: readlinkSync(full) }); return; }
    if (s.isDirectory()) {
      result.push({ ...base, kind: "directory" });
      for (const name of readdirSync(full).sort()) visit(relative === "" ? name : join(relative, name));
      return;
    }
    if (!s.isFile()) throw new Error("Derived-state inventory contains an unsupported filesystem entry.");
    totalBytes += s.size; if (totalBytes > 1_073_741_824) throw new Error("Derived-state inventory exceeds 1 GiB; inspect manually.");
    const hash = createHash("sha256"); const fd = openSync(full, "r");
    try {
      const current = fstatSync(fd);
      if (current.dev !== s.dev || current.ino !== s.ino || current.size !== s.size || current.mtimeMs !== s.mtimeMs) throw new Error("Derived-state entry changed during inventory.");
      const buffer = Buffer.allocUnsafe(64 * 1024); let n: number;
      while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
      const after = fstatSync(fd);
      if (after.size !== s.size || after.mtimeMs !== s.mtimeMs) throw new Error("Derived-state entry changed during inventory.");
    } finally { closeSync(fd); }
    result.push({ ...base, kind: "file", digest: hash.digest("hex") });
  };
  visit("");
  if (result.length > 0 && result[0]?.kind !== "directory") throw new Error("Derived-state root is not a directory.");
  return result;
}

function receipt(plan: Plan, attempt: string, started: string, resumed: boolean, status: "no-op" | "success" | "partial" | "failed", audit = false): ReceiptV1 {
  const partial = status === "partial";
  const incomplete = partial || status === "failed";
  return parseReceiptV1ForEmission({ schema_id: "lyt.receipt", schema_version: { major: 1, minor: 0 }, operation_id: plan.operationId,
    attempt_id: attempt, operation: `vault-${plan.action}`, scope: { kind: "system" }, timestamps: { started_at: started, finished_at: new Date().toISOString() },
    replay: { disposition: resumed ? "resumed" : "new", key_digest: digest(plan) }, status, exit_code: incomplete ? 1 : 0,
    mutations: { local: status === "success" || partial ? 1 : 0, remote: 0 }, evidence: { before: [], after: status === "success" || partial ? [{ kind: "vault-ledger", subject: "operation-bound local retraction recorded", digest: digest(plan) }] : [] },
    next_action: incomplete ? { code: audit ? "audit-local-delete" : "resume-local-delete", summary: audit ? "Inspect the exact local vault and lifecycle state before any further deletion." : "Resolve the local cause and resume this operation by its operation ID." } : null,
    error: incomplete ? { code: audit ? "delete-needs-audit" : "delete-incomplete", summary: audit ? "The destructive stage may have been interrupted; automatic replay is refused." : "Local deletion did not reach a verified complete state.", retryable: !audit } : null });
}
function boundMarker(p: Plan): boolean {
  return readAllFedVaultRecords().some((r) => r.vaultRid.replace(/-/g, "").toLowerCase() === p.rid.toLowerCase() && r.writerId === p.writerId && r.operationId === p.operationId && r.state === "tombstoned");
}
async function hasFilesystemIntent(id: string): Promise<boolean> {
  const db = await openOpLog();
  try {
    const rows = await db.execute({ sql: "SELECT id FROM op_log WHERE kind = ? AND file_set = ? LIMIT 2", args: [filesystemIntentKind, JSON.stringify([id])] });
    if (rows.rows.length > 1) throw new Error("Ambiguous filesystem intent; audit required.");
    return rows.rows.length === 1;
  } finally { await closeOpLog(db); }
}
async function recordFilesystemIntent(id: string): Promise<void> {
  if (await hasFilesystemIntent(id)) throw new Error("Filesystem stage already started; audit required.");
  const db = await openOpLog();
  try { await appendPendingOp(db, { kind: filesystemIntentKind, horizon: "local", fileSet: [id], inverse }, new Date().toISOString()); }
  finally { await closeOpLog(db); }
}
async function finishFilesystemIntent(id: string): Promise<void> {
  const db = await openOpLog();
  try {
    const rows = await db.execute({ sql: "SELECT id, status FROM op_log WHERE kind = ? AND file_set = ? LIMIT 2", args: [filesystemIntentKind, JSON.stringify([id])] });
    if (rows.rows.length !== 1) throw new Error("Filesystem intent is absent or ambiguous; audit required.");
    const row = rows.rows[0]!; const raw = row["id"];
    const intentId = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    if (!intentId || intentId.length !== 16) throw new Error("Filesystem intent identity is invalid.");
    if (row["status"] === "pending") await markOpApplied(db, intentId, { horizon: "local", inverse }, new Date().toISOString());
    else if (row["status"] !== "applied") throw new Error("Filesystem intent has an unexpected status.");
  } finally { await closeOpLog(db); }
}
async function load(id: string): Promise<{ plan: Plan; journalId: Uint8Array; status: string }> {
  if (!uuid.test(id)) throw new Error("Invalid lifecycle operation ID.");
  const db = await openOpLog();
  try {
    const rows = await db.execute({ sql: `SELECT id, file_set, status FROM op_log WHERE kind = ? AND json_valid(file_set) AND json_array_length(file_set) = 1 AND json_valid(json_extract(file_set, '$[0]')) AND json_extract(json_extract(file_set, '$[0]'), '$.operationId') = ? LIMIT 2`, args: [journalKind, id] });
    if (rows.rows.length !== 1) throw new Error("Delete journal is absent or ambiguous.");
    const row = rows.rows[0]!; const files = JSON.parse(String(row["file_set"])) as unknown;
    if (!Array.isArray(files) || files.length !== 1 || typeof files[0] !== "string") throw new Error("Delete journal is malformed.");
    const plan = JSON.parse(files[0]) as Plan;
    if (plan.version !== 1 || plan.operationId !== id || !uuid.test(plan.writerId) || !["delete", "abandon"].includes(plan.action) || typeof plan.name !== "string" || typeof plan.path !== "string" || !/^[0-9a-f]{32}$/i.test(plan.rid) || !Array.isArray(plan.inventory) || typeof plan.noTombstone !== "boolean") throw new Error("Delete journal is malformed.");
    const raw = row["id"]; const journalId = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    if (!journalId || journalId.length !== 16) throw new Error("Delete journal identity is invalid.");
    return { plan, journalId, status: String(row["status"]) };
  } finally { await closeOpLog(db); }
}

export async function deleteWithReceipt(args: { action: "delete" | "abandon"; name?: string; noTombstone?: boolean; resume?: string; confirmed: boolean; onPlan?: (id: string) => void; afterReceipt?: () => void; afterStage?: (stage: string) => void }): Promise<ReceiptV1> {
  if (!args.confirmed) throw new Error("Delete and abandon require --yes.");
  let plan: Plan; let journalId: Uint8Array; let journalStatus = "pending";
  if (args.resume !== undefined) {
    if (args.name !== undefined || args.noTombstone !== undefined) throw new Error("Resume cannot be combined with a new vault or options.");
    ({ plan, journalId, status: journalStatus } = await load(args.resume));
    if (plan.action !== args.action) throw new Error("Operation belongs to a different lifecycle command.");
  } else {
    if (!args.name) throw new Error("A vault name is required.");
    const db = await openRegistry(); let vault: VaultRow | null;
    try { vault = await getVaultByName(db, args.name); } finally { await closeRegistry(db); }
    if (!vault || vault.status === "tombstoned") throw new Error("Vault is not actively registered.");
    plan = { version: 1, operationId: nextId(), writerId: getWriterId(), action: args.action, name: vault.name, rid: vault.ridHex, path: vault.path, homeMeshRid: vault.homeMeshRidHex, source: vault.source, gitUrl: vault.gitUrl, noTombstone: args.action === "abandon" || args.noTombstone === true, inventory: inventory(vault.path) };
    const log = await openOpLog(); try { journalId = await appendPendingOp(log, { kind: journalKind, horizon: "local", fileSet: [JSON.stringify(plan)], inverse }, new Date().toISOString()); } finally { await closeOpLog(log); }
  }
  if (getWriterId() !== plan.writerId) throw new Error("Lifecycle writer identity changed; inspect before resuming.");
  return withDestinationPolicyLock(join(getLytHome(), "locks", `delete-${digest(plan)}.lock`), async () => {
    const db = await openOpLog(); let pending: Awaited<ReturnType<typeof findPendingReceiptAttemptForOperation>>; let prior: ReceiptV1 | undefined;
    try {
      const terminal = await queryReceiptAttempts(db, { operationId: plan.operationId, operation: `vault-${plan.action}`, limit: 1 });
      if (terminal.attempts.length > 0) {
        prior = terminal.attempts[0] as ReceiptV1;
        if (prior.replay.key_digest !== digest(plan)) throw new Error("Delete journal does not match its receipt.");
        if (prior.status === "success" || prior.status === "no-op" || prior.next_action?.code === "audit-local-delete") {
          if (prior.status === "success") await finishFilesystemIntent(plan.operationId);
          if (prior.status === "success" && journalStatus === "pending") await markOpApplied(db, journalId, { horizon: "local", inverse }, new Date().toISOString());
          return prior;
        }
      }
      pending = await findPendingReceiptAttemptForOperation(db, plan.operationId);
    } finally { await closeOpLog(db); }
    if (args.resume !== undefined && pending === null && prior === undefined) throw new Error("Delete plan has no bound receipt; start a new operation.");
    const attempt = pending?.attemptId ?? nextId(); const started = pending?.startedAt ?? new Date().toISOString();
    const initial = receipt(plan, attempt, started, args.resume !== undefined, "no-op");
    const opened = pending === null ? await openReceiptAttempt(initial) : await reopenReceiptAttempt(initial);
    if (opened.kind !== "ready") throw new Error(`Receipt unavailable; resume operation ${plan.operationId}.`);
    const markerBefore = boundMarker(plan); let mutated = false; let knownFailure = false;
    try {
      args.onPlan?.(plan.operationId); args.afterReceipt?.();
      let status: "success" | "partial" | "failed" = "success"; let audit = false;
      if (args.resume !== undefined && await hasFilesystemIntent(plan.operationId)) {
        if (pending !== null && prior !== undefined) throw new Error("Interrupted destructive attempt has an unknown mutation count; audit required.");
        status = pending !== null && markerBefore ? "partial" : "failed";
        audit = true;
      }
      else {
        try {
          if (JSON.stringify(inventory(plan.path)) !== JSON.stringify(plan.inventory)) { knownFailure = true; throw new Error("Derived-state preimage changed; delete is refused."); }
          const result = await deleteVaultFlow(plan.name, { noTombstone: plan.noTombstone, expectedRid: plan.rid, expectedPath: plan.path, expectedHomeMeshRid: plan.homeMeshRid, expectedSource: plan.source, expectedGitUrl: plan.gitUrl, operationId: plan.operationId, writerId: plan.writerId,
            onMutation: () => { mutated = true; },
            beforeFilesystem: async () => { if (JSON.stringify(inventory(plan.path)) !== JSON.stringify(plan.inventory)) { knownFailure = true; throw new Error("Derived-state preimage changed; delete is refused."); } await recordFilesystemIntent(plan.operationId); },
            ...(args.afterStage === undefined ? {} : { afterStage: (stage: string) => { try { args.afterStage?.(stage); } catch (error) { knownFailure = true; throw error; } } }) });
          if (result.projectionPending) { status = mutated ? "partial" : "failed"; audit = true; }
        } catch (error) {
          audit = await hasFilesystemIntent(plan.operationId);
          const changed = mutated || (!markerBefore && boundMarker(plan));
          if (!changed && !knownFailure) throw new Error("Local mutation outcome is unverified; audit before continuing.", { cause: error });
          status = changed ? "partial" : "failed";
        }
      }
      const final = receipt(plan, attempt, started, args.resume !== undefined, status, audit);
      if ((await opened.session.finalize(final)).length > 0) throw new Error("Receipt finalization was not verified.");
      if (status === "success") await finishFilesystemIntent(plan.operationId);
      if (status === "success" && journalStatus === "pending") { const log = await openOpLog(); try { await markOpApplied(log, journalId, { horizon: "local", inverse }, new Date().toISOString()); } finally { await closeOpLog(log); } }
      return final;
    } catch (error) { await opened.session.close?.(); throw new Error(`Lifecycle operation is not verified complete; resume ${plan.operationId}. ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }, { acquireTimeoutMs: 5_000, leaseMs: 60_000, subject: plan.operationId });
}
