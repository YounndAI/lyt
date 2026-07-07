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

// Increment 1 · Phase A.2 — the logline sink (an ADAPTER, not a free-text sink).
//
// An Operation's `logline()` is one plain-language sentence for the human. The
// vault's audit ledger, though, has a FIXED structured schema (recordAudit /
// audit-write.ts: {actor, action, targetType, targetId, result?, details?} +
// YON SoT). This adapter maps an Operation + its verified Receipt onto that
// schema — the logline rides in `details.logline`, the machine facts (kind,
// horizon, verified) fill the structured columns. It does NOT invent a new
// free-text table; it reuses the existing YON-first audit path (which appends
// `<vault>/.lyt/ledgers/audit/<writerId>.yon` then upserts the .db cache).
//
// The audit db is the VAULT content DB (audit_log lives there); the caller
// passes the same db it opened for the op + supplies the op-specific target
// (a `capture` targets the figment path; a `sync` targets the pod).

import type { Client } from "@libsql/client";

import { recordAudit, type RecordAuditResult } from "../registry/audit-write.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import type { Operation, Receipt } from "./operation.js";

export interface OpAuditTarget {
  /** Structured audit target type — e.g. "figment" | "pod" | "vault". */
  targetType: string;
  /** Structured audit target id — e.g. the vault-relative figment path, or "pod". */
  targetId: string;
  /** Who ran the op. Defaults to "handler" (mechanical-first: a bare-terminal run has no agent). */
  actor?: string;
  /** Test seam — override the writerId shard the record lands in. */
  writerId?: string;
}

/**
 * Record one audit entry for a completed Operation. Maps `op.logline()` +
 * `receipt` onto recordAudit's fixed schema:
 *   action     = `op.<kind>`      (dotted, namespaced alongside vault.* / sync.*)
 *   targetType = target.targetType
 *   targetId   = target.targetId
 *   details    = { logline, horizon, verified }   (the sentence + machine facts)
 *
 * `result` reflects the Receipt: a verified apply → "success", an unverified one
 * → "failure" (an existing `AuditLogResult` member), so the .db audit cache never
 * lies about an unverified op; `details.verified` carries the same fact for
 * machine readers.
 */
export async function recordOperationAudit(
  vaultPath: string,
  db: Client,
  op: Operation,
  receipt: Receipt,
  target: OpAuditTarget,
): Promise<RecordAuditResult> {
  return recordAudit(vaultPath, db, {
    id: newUuidv7Bytes(),
    ts: Date.now(),
    actor: target.actor ?? "handler",
    action: `op.${op.kind}`,
    targetType: target.targetType,
    targetId: target.targetId,
    result: receipt.verified ? "success" : "failure",
    details: {
      logline: op.logline(),
      horizon: receipt.horizon,
      verified: receipt.verified,
    },
    stampSrc: `op/${op.kind}`,
    ...(target.writerId !== undefined ? { writerId: target.writerId } : {}),
  });
}
