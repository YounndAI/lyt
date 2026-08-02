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

import { Buffer } from "node:buffer";

import type { Client, InArgs, InStatement, InValue, ResultSet, Transaction } from "@libsql/client";

import { hexToUuid7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import { getOperationLogStoreIdentity } from "./operation-log.js";
import {
  consumeReceiptV1,
  parseReceiptV1ForEmission,
  type ReceiptV1,
  type ReceiptV1Consumption,
} from "./receipt-v1.js";

export type StoredReceiptV1 = Extract<ReceiptV1Consumption, { status: "accepted" }>["receipt"];
export const RECEIPT_V1_STORED_JSON_MAX_BYTES = 64 * 1024;

// libSQL's local client can block its own JavaScript event loop for the
// connection busy_timeout while BEGIN IMMEDIATE waits on another client. Once
// that bounded wait returns SQLITE_BUSY, the winning client can commit. A
// A per-physical-store FIFO prevents that driver-level collision within one
// process while unrelated stores continue independently. External contention
// retries only inside one acquisition deadline. Never replay a transaction body
// whose mutation state could be ambiguous.
const RECEIPT_WRITE_TX_RETRY_DELAY_MS = 10;
const RECEIPT_WRITE_ACQUISITION_DEADLINE_MS = 7_000;
const RECEIPT_WRITE_BUSY_TIMEOUT_MAX_MS = 5_000;

type ReceiptWriteWaiter = {
  deadline: number;
  resolve(release: () => void): void;
  reject(error: ReceiptRepositoryError): void;
  timeout: ReturnType<typeof setTimeout>;
};

type ReceiptWriteCoordinator = {
  locked: boolean;
  waiters: ReceiptWriteWaiter[];
};

const receiptWriteCoordinators = new Map<string, ReceiptWriteCoordinator>();

const UUID_V7_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_HEX = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/i;
// SEE ALSO: receipt-v1.ts, commands/receipt.ts — operation identifiers are
// persisted UUIDv7 (historical) or UUIDv8 (deterministic creation); attempt
// identifiers remain clock-derived UUIDv7.
const UUID_V7_OR_V8_DASHED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_OR_V8_HEX = /^[0-9a-f]{12}[78][0-9a-f]{3}[89ab][0-9a-f]{15}$/i;

export interface ReceiptQueryClient {
  execute(statement: InStatement | string, args?: InArgs): Promise<ResultSet>;
}

export type BeginReceiptAttemptResult = {
  operationId: string;
  attemptId: string;
  operationCreated: boolean;
  priorTerminalStatus: StoredReceiptV1["status"] | null;
};

export type SupersedePendingReceiptAttemptResult = {
  operationId: string;
  attemptId: string;
  startedAt: string;
  supersededAttemptId: string;
};

export type RecoverableTerminalReceiptAttempt = Readonly<{
  operationId: string;
  attemptId: string;
  startedAt: string;
  status: "partial" | "failed" | "refused";
  replayKeyDigest: string;
}>;

/** Return at most two latest terminal failures, excluding operations with a pending attempt. */
export async function findRecoverablePodRepairReceiptAttempts(
  db: ReceiptQueryClient,
): Promise<readonly RecoverableTerminalReceiptAttempt[]> {
  const found = await db.execute({
    sql: `SELECT o.operation_id, a.attempt_id, a.started_at, o.replay_key_digest,
                 CASE WHEN json_valid(a.receipt_json)
                      THEN json_extract(a.receipt_json, '$.status') ELSE NULL END AS terminal_status
            FROM operations o
            JOIN operation_attempts a ON a.operation_id = o.operation_id
           WHERE o.operation = 'pod-repair'
             AND a.finished_at IS NOT NULL
             AND a.receipt_json IS NOT NULL
             AND a.attempt_id = (
                   SELECT newest.attempt_id
                     FROM operation_attempts newest
                    WHERE newest.operation_id = o.operation_id
                      AND newest.finished_at IS NOT NULL
                      AND newest.receipt_json IS NOT NULL
                    ORDER BY newest.started_at DESC, newest.attempt_id DESC
                    LIMIT 1
                 )
             AND NOT EXISTS (
                   SELECT 1 FROM operation_attempts pending
                    WHERE pending.operation_id = o.operation_id
                      AND pending.finished_at IS NULL
                      AND pending.receipt_json IS NULL
                 )
             AND CASE WHEN json_valid(a.receipt_json)
                      THEN json_extract(a.receipt_json, '$.status') ELSE NULL END
                   IN ('partial', 'failed', 'refused')
           ORDER BY o.operation_id ASC
           LIMIT 2`,
    args: [],
  });
  return found.rows.map((row) => ({
    operationId: uuid7BytesToDashedString(blobToBytes(row["operation_id"])),
    attemptId: uuid7BytesToDashedString(blobToBytes(row["attempt_id"])),
    startedAt: String(row["started_at"]),
    status: String(row["terminal_status"]) as RecoverableTerminalReceiptAttempt["status"],
    replayKeyDigest: String(row["replay_key_digest"]),
  }));
}

export interface SupersedePendingReceiptAttemptDependencies {
  readonly beforeCommit?: () => void;
}

export class ReceiptRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReceiptRepositoryError";
  }
}

type OperationMetadata = {
  operationId: string;
  replayKeyDigest: string;
  operation: string;
  scopeJson: string;
};

function metadata(receipt: ReceiptV1): OperationMetadata {
  return {
    operationId: receipt.operation_id,
    replayKeyDigest: receipt.replay.key_digest.toLowerCase(),
    operation: receipt.operation,
    scopeJson: JSON.stringify(receipt.scope),
  };
}

function blobToBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new ReceiptRepositoryError("receipt-store-corrupt", "stored identifier is not a BLOB");
}

function storedOperationMetadata(row: Record<string, unknown>): OperationMetadata {
  return {
    operationId: uuid7BytesToDashedString(blobToBytes(row["operation_id"])),
    replayKeyDigest: String(row["replay_key_digest"]).toLowerCase(),
    operation: String(row["operation"]),
    scopeJson: String(row["scope_json"]),
  };
}

function assertMetadataMatches(expected: OperationMetadata, actual: OperationMetadata): void {
  if (
    expected.operationId !== actual.operationId ||
    expected.replayKeyDigest !== actual.replayKeyDigest ||
    expected.operation !== actual.operation ||
    expected.scopeJson !== actual.scopeJson
  ) {
    throw new ReceiptRepositoryError(
      "receipt-operation-metadata-mismatch",
      "the operation identity, replay key, verb, and scope must match the existing record",
    );
  }
}

async function rollbackQuietly(tx: Transaction): Promise<void> {
  try {
    if (!tx.closed) await tx.rollback();
  } catch {
    // Preserve the original repository error. The connection owns any further
    // recovery and close behavior.
  }
}

function isSqliteBusy(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is locked/i.test(message);
}

function receiptStoreBusy(message: string): ReceiptRepositoryError {
  return new ReceiptRepositoryError("receipt-store-busy", message);
}

async function acquireReceiptWriteTransaction(db: Client, deadline: number): Promise<Transaction> {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw receiptStoreBusy("timed out acquiring the receipt store write transaction");
    }
    await db.execute(
      `PRAGMA busy_timeout=${Math.max(1, Math.min(RECEIPT_WRITE_BUSY_TIMEOUT_MAX_MS, remaining))}`,
    );
    try {
      const tx = await db.transaction("write");
      if (Date.now() <= deadline) return tx;
      await rollbackQuietly(tx);
      throw receiptStoreBusy("timed out acquiring the receipt store write transaction");
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      if (Date.now() + RECEIPT_WRITE_TX_RETRY_DELAY_MS > deadline) {
        throw receiptStoreBusy("timed out acquiring the receipt store write transaction");
      }
      await new Promise((resolve) => setTimeout(resolve, RECEIPT_WRITE_TX_RETRY_DELAY_MS));
    }
  }
}

function releaseReceiptWriteTurn(identity: string, coordinator: ReceiptWriteCoordinator): void {
  for (;;) {
    const waiter = coordinator.waiters.shift();
    if (waiter === undefined) {
      coordinator.locked = false;
      if (receiptWriteCoordinators.get(identity) === coordinator) {
        receiptWriteCoordinators.delete(identity);
      }
      return;
    }
    clearTimeout(waiter.timeout);
    if (Date.now() > waiter.deadline) {
      waiter.reject(receiptStoreBusy("timed out waiting for another receipt writer"));
      continue;
    }
    waiter.resolve(() => releaseReceiptWriteTurn(identity, coordinator));
    return;
  }
}

async function acquireReceiptWriteTurn(db: Client, deadline: number): Promise<() => void> {
  const identity = getOperationLogStoreIdentity(db);
  let coordinator = receiptWriteCoordinators.get(identity);
  if (coordinator === undefined) {
    coordinator = { locked: true, waiters: [] };
    receiptWriteCoordinators.set(identity, coordinator);
    return () => releaseReceiptWriteTurn(identity, coordinator!);
  }
  if (!coordinator.locked) {
    coordinator.locked = true;
    return () => releaseReceiptWriteTurn(identity, coordinator!);
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: ReceiptWriteWaiter = {
      deadline,
      resolve,
      reject,
      timeout: setTimeout(
        () => {
          const index = coordinator!.waiters.indexOf(waiter);
          if (index >= 0) coordinator!.waiters.splice(index, 1);
          reject(receiptStoreBusy("timed out waiting for another receipt writer"));
        },
        Math.max(0, deadline - Date.now()),
      ),
    };
    coordinator!.waiters.push(waiter);
  });
}

async function withReceiptWriteTurn<T>(
  db: Client,
  work: (deadline: number) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + RECEIPT_WRITE_ACQUISITION_DEADLINE_MS;
  const release = await acquireReceiptWriteTurn(db, deadline);
  try {
    return await work(deadline);
  } finally {
    release();
  }
}

/**
 * Atomically find-or-create the logical operation and append one pending
 * attempt. The full Receipt V1 is accepted here so the same strict producer
 * contract binds both the pending metadata and its eventual terminal row.
 */
export async function beginReceiptAttempt(
  db: Client,
  value: unknown,
): Promise<BeginReceiptAttemptResult> {
  return withReceiptWriteTurn(db, (deadline) =>
    beginReceiptAttemptTransaction(db, value, deadline, false),
  );
}

/** Adopt the existing logical operation selected by an exact replay-plan digest. */
export async function beginReceiptAttemptForReplayPlan(
  db: Client,
  value: unknown,
): Promise<BeginReceiptAttemptResult> {
  return withReceiptWriteTurn(db, (deadline) =>
    beginReceiptAttemptTransaction(db, value, deadline, true),
  );
}

export type ReceiptAttemptState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "pending"; startedAt: string }>
  | Readonly<{ kind: "terminal"; receipt: StoredReceiptV1 }>;

/** Distinguish an absent attempt from a durable pending attempt without exposing storage internals. */
export async function readReceiptAttemptState(
  db: Client,
  attemptId: string,
): Promise<ReceiptAttemptState> {
  const canonicalAttemptId = canonicalUuid7(attemptId);
  if (canonicalAttemptId === null) {
    throw new ReceiptRepositoryError(
      "invalid-receipt-id",
      "the attempt identifier must be a UUIDv7",
    );
  }
  const result = await db.execute({
    sql: "SELECT started_at, receipt_json FROM operation_attempts WHERE attempt_id = ?",
    args: [canonicalAttemptId],
  });
  const row = result.rows[0];
  if (row === undefined) return Object.freeze({ kind: "absent" });
  if (row["receipt_json"] === null) {
    return Object.freeze({ kind: "pending", startedAt: String(row["started_at"]) });
  }
  return Object.freeze({
    kind: "terminal",
    receipt: storedReceiptFromJson(row["receipt_json"]),
  });
}

/** Locate the sole crash-recoverable pending attempt for one exact logical operation. */
export async function findPendingReceiptAttemptForOperation(
  db: ReceiptQueryClient,
  operationId: string,
): Promise<Readonly<{ attemptId: string; startedAt: string }> | null> {
  const canonicalOperationId = canonicalUuid7OrV8(operationId);
  if (canonicalOperationId === null) return null;
  const result = await db.execute({
    sql: `SELECT a.attempt_id, a.started_at
            FROM operation_attempts a
           WHERE a.operation_id = ?
             AND a.finished_at IS NULL
             AND a.receipt_json IS NULL
           ORDER BY a.started_at ASC, a.attempt_id ASC
           LIMIT 2`,
    args: [canonicalOperationId],
  });
  if (result.rows.length > 1) {
    throw new ReceiptRepositoryError(
      "receipt-store-corrupt",
      "one logical operation has multiple pending attempts",
    );
  }
  const row = result.rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    attemptId: uuid7BytesToDashedString(blobToBytes(row["attempt_id"])),
    startedAt: String(row["started_at"]),
  });
}

/**
 * Reopen one exact pending attempt. Operation/replay/scope metadata and the
 * original start time must still match; absent or terminal attempts refuse.
 * The receipt write turn makes two concurrent reopeners observe one logical
 * pending attempt without creating a second row.
 */
export async function resumePendingReceiptAttempt(
  db: Client,
  value: unknown,
): Promise<Readonly<{ operationId: string; attemptId: string; startedAt: string }>> {
  return withReceiptWriteTurn(db, async (deadline) => {
    const receipt = parseReceiptV1ForEmission(value);
    const expected = metadata(receipt);
    const attemptId = hexToUuid7Bytes(receipt.attempt_id);
    const tx = await acquireReceiptWriteTransaction(db, deadline);
    try {
      const found = await tx.execute({
        sql: `SELECT o.operation_id, o.replay_key_digest, o.operation, o.scope_json,
                     a.started_at, a.finished_at, a.receipt_json
                FROM operation_attempts a
                JOIN operations o ON o.operation_id = a.operation_id
               WHERE a.attempt_id = ?`,
        args: [attemptId],
      });
      const row = found.rows[0];
      if (row === undefined) {
        throw new ReceiptRepositoryError(
          "receipt-attempt-not-found",
          "the pending attempt does not exist",
        );
      }
      assertMetadataMatches(expected, storedOperationMetadata(row));
      if (row["finished_at"] !== null || row["receipt_json"] !== null) {
        throw new ReceiptRepositoryError(
          "receipt-attempt-already-finalized",
          "a terminal attempt cannot be reopened",
        );
      }
      const startedAt = String(row["started_at"]);
      await tx.commit();
      return Object.freeze({
        operationId: receipt.operation_id,
        attemptId: receipt.attempt_id,
        startedAt,
      });
    } catch (error) {
      await rollbackQuietly(tx);
      throw error;
    }
  });
}

/**
 * Atomically terminalize the sole interrupted attempt for one logical operation
 * and append a fresh resumed attempt. A crash or injected fault rolls back both
 * writes, so callers can never expose two pending attempts.
 */
export async function supersedePendingReceiptAttempt(
  db: Client,
  interruptedValue: unknown,
  freshValue: unknown,
  dependencies: SupersedePendingReceiptAttemptDependencies = {},
): Promise<SupersedePendingReceiptAttemptResult> {
  return withReceiptWriteTurn(db, async (deadline) => {
    const interrupted = parseReceiptV1ForEmission(interruptedValue);
    const fresh = parseReceiptV1ForEmission(freshValue);
    const expected = metadata(interrupted);
    assertMetadataMatches(expected, metadata(fresh));
    if (interrupted.attempt_id === fresh.attempt_id) {
      throw new ReceiptRepositoryError(
        "receipt-attempt-already-exists",
        "a resumed invocation requires a fresh attempt identifier",
      );
    }
    if (fresh.replay.disposition !== "resumed") {
      throw new ReceiptRepositoryError(
        "receipt-operation-metadata-mismatch",
        "a fresh attempt replacing an interrupted attempt must be marked resumed",
      );
    }
    const operationId = hexToUuid7Bytes(interrupted.operation_id);
    const interruptedAttemptId = hexToUuid7Bytes(interrupted.attempt_id);
    const freshAttemptId = hexToUuid7Bytes(fresh.attempt_id);
    const interruptedJson = JSON.stringify(interrupted);
    if (Buffer.byteLength(interruptedJson, "utf8") > RECEIPT_V1_STORED_JSON_MAX_BYTES) {
      throw new ReceiptRepositoryError(
        "receipt-store-too-large",
        "the interrupted receipt exceeds the durable storage bound",
      );
    }
    const tx = await acquireReceiptWriteTransaction(db, deadline);
    try {
      const operation = await tx.execute({
        sql: `SELECT operation_id, replay_key_digest, operation, scope_json
                FROM operations
               WHERE operation_id = ? OR replay_key_digest = ?`,
        args: [operationId, expected.replayKeyDigest],
      });
      if (operation.rows.length !== 1) {
        throw new ReceiptRepositoryError(
          "receipt-operation-metadata-mismatch",
          "the interrupted operation and replay identity must resolve to one record",
        );
      }
      assertMetadataMatches(expected, storedOperationMetadata(operation.rows[0]!));
      const pending = await tx.execute({
        sql: `SELECT attempt_id, started_at
                FROM operation_attempts
               WHERE operation_id = ?
                 AND finished_at IS NULL
                 AND receipt_json IS NULL
               ORDER BY started_at ASC, attempt_id ASC
               LIMIT 2`,
        args: [operationId],
      });
      if (pending.rows.length !== 1) {
        throw new ReceiptRepositoryError(
          "receipt-store-corrupt",
          "the logical operation must have exactly one pending attempt to resume",
        );
      }
      const prior = pending.rows[0]!;
      const priorId = uuid7BytesToDashedString(blobToBytes(prior["attempt_id"]));
      if (
        priorId !== interrupted.attempt_id ||
        String(prior["started_at"]) !== interrupted.timestamps.started_at
      ) {
        throw new ReceiptRepositoryError(
          "receipt-operation-metadata-mismatch",
          "the interrupted receipt does not identify the sole pending attempt",
        );
      }
      const duplicate = await tx.execute({
        sql: "SELECT 1 FROM operation_attempts WHERE attempt_id = ? LIMIT 1",
        args: [freshAttemptId],
      });
      if (duplicate.rows.length !== 0) {
        throw new ReceiptRepositoryError(
          "receipt-attempt-already-exists",
          "the fresh resumed attempt identifier already exists",
        );
      }
      const terminalized = await tx.execute({
        sql: `UPDATE operation_attempts
                 SET finished_at = ?, receipt_json = ?
               WHERE attempt_id = ? AND operation_id = ?
                 AND finished_at IS NULL AND receipt_json IS NULL`,
        args: [
          interrupted.timestamps.finished_at,
          interruptedJson,
          interruptedAttemptId,
          operationId,
        ],
      });
      if (Number(terminalized.rowsAffected) !== 1) {
        throw new ReceiptRepositoryError(
          "receipt-store-corrupt",
          "the interrupted attempt changed during the resume transition",
        );
      }
      await tx.execute({
        sql: `INSERT INTO operation_attempts
                (attempt_id, operation_id, started_at, finished_at, receipt_json)
              VALUES (?, ?, ?, NULL, NULL)`,
        args: [freshAttemptId, operationId, fresh.timestamps.started_at],
      });
      dependencies.beforeCommit?.();
      await tx.commit();
      return {
        operationId: fresh.operation_id,
        attemptId: fresh.attempt_id,
        startedAt: fresh.timestamps.started_at,
        supersededAttemptId: interrupted.attempt_id,
      };
    } catch (error) {
      await rollbackQuietly(tx);
      throw error;
    }
  });
}

async function beginReceiptAttemptTransaction(
  db: Client,
  value: unknown,
  deadline: number,
  adoptReplayIdentity: boolean,
): Promise<BeginReceiptAttemptResult> {
  const receipt = parseReceiptV1ForEmission(value);
  const expected = metadata(receipt);
  const operationId = hexToUuid7Bytes(receipt.operation_id);
  const attemptId = hexToUuid7Bytes(receipt.attempt_id);
  const tx = await acquireReceiptWriteTransaction(db, deadline);
  try {
    const existing = await tx.execute({
      sql: `SELECT operation_id, replay_key_digest, operation, scope_json
              FROM operations
             WHERE operation_id = ? OR replay_key_digest = ?`,
      args: [operationId, expected.replayKeyDigest],
    });
    if (existing.rows.length > 1) {
      throw new ReceiptRepositoryError(
        "receipt-operation-metadata-mismatch",
        "the operation id and replay key resolve to different records",
      );
    }

    let operationCreated = false;
    let priorTerminalStatus: StoredReceiptV1["status"] | null = null;
    const row = existing.rows[0];
    let effectiveOperationId = receipt.operation_id;
    let effectiveOperationBytes = operationId;
    if (row === undefined) {
      await tx.execute({
        sql: `INSERT INTO operations
                (operation_id, replay_key_digest, operation, scope_json, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          operationId,
          expected.replayKeyDigest,
          receipt.operation,
          expected.scopeJson,
          receipt.timestamps.started_at,
        ],
      });
      operationCreated = true;
    } else {
      const actual = storedOperationMetadata(row);
      if (adoptReplayIdentity && expected.operationId !== actual.operationId) {
        assertMetadataMatches({ ...expected, operationId: actual.operationId }, actual);
        effectiveOperationId = actual.operationId;
        effectiveOperationBytes = hexToUuid7Bytes(actual.operationId);
      } else {
        assertMetadataMatches(expected, actual);
      }
    }

    if (adoptReplayIdentity) {
      const pending = await tx.execute({
        sql: `SELECT 1
                FROM operation_attempts
               WHERE operation_id = ?
                 AND finished_at IS NULL
                 AND receipt_json IS NULL
               LIMIT 1`,
        args: [effectiveOperationBytes],
      });
      if (pending.rows.length !== 0) {
        throw new ReceiptRepositoryError(
          "receipt-operation-already-pending",
          "the logical replay operation already has an active pending attempt",
        );
      }
      const priorTerminal = await tx.execute({
        sql: `SELECT receipt_json
                FROM operation_attempts
               WHERE operation_id = ?
                 AND finished_at IS NOT NULL
                 AND receipt_json IS NOT NULL
               ORDER BY started_at DESC, attempt_id DESC
               LIMIT 1`,
        args: [effectiveOperationBytes],
      });
      if (priorTerminal.rows[0] !== undefined) {
        priorTerminalStatus = storedReceiptFromJson(priorTerminal.rows[0]["receipt_json"]).status;
      }
    }

    const duplicateAttempt = await tx.execute({
      sql: "SELECT attempt_id FROM operation_attempts WHERE attempt_id = ?",
      args: [attemptId],
    });
    if (duplicateAttempt.rows.length !== 0) {
      throw new ReceiptRepositoryError(
        "receipt-attempt-already-exists",
        "an attempt with this identifier already exists",
      );
    }
    await tx.execute({
      sql: `INSERT INTO operation_attempts
              (attempt_id, operation_id, started_at, finished_at, receipt_json)
            VALUES (?, ?, ?, NULL, NULL)`,
      args: [attemptId, effectiveOperationBytes, receipt.timestamps.started_at],
    });
    await tx.commit();
    return {
      operationId: effectiveOperationId,
      attemptId: receipt.attempt_id,
      operationCreated,
      priorTerminalStatus,
    };
  } catch (error) {
    await rollbackQuietly(tx);
    throw error;
  }
}

/** Finalize exactly one pending attempt. A second finalize is always refused. */
export async function finalizeReceiptAttempt(db: Client, value: unknown): Promise<void> {
  return withReceiptWriteTurn(db, (deadline) =>
    finalizeReceiptAttemptTransaction(db, value, deadline),
  );
}

async function finalizeReceiptAttemptTransaction(
  db: Client,
  value: unknown,
  deadline: number,
): Promise<void> {
  const receipt = parseReceiptV1ForEmission(value);
  const expected = metadata(receipt);
  const operationId = hexToUuid7Bytes(receipt.operation_id);
  const attemptId = hexToUuid7Bytes(receipt.attempt_id);
  const tx = await acquireReceiptWriteTransaction(db, deadline);
  try {
    const found = await tx.execute({
      sql: `SELECT o.operation_id, o.replay_key_digest, o.operation, o.scope_json,
                   a.started_at, a.finished_at, a.receipt_json
              FROM operation_attempts a
              JOIN operations o ON o.operation_id = a.operation_id
             WHERE a.attempt_id = ?`,
      args: [attemptId],
    });
    const row = found.rows[0];
    if (row === undefined) {
      throw new ReceiptRepositoryError(
        "receipt-attempt-not-found",
        "the attempt must be appended before it can be finalized",
      );
    }
    assertMetadataMatches(expected, storedOperationMetadata(row));
    if (String(row["started_at"]) !== receipt.timestamps.started_at) {
      throw new ReceiptRepositoryError(
        "receipt-operation-metadata-mismatch",
        "the attempt start timestamp does not match its pending record",
      );
    }
    if (row["finished_at"] !== null || row["receipt_json"] !== null) {
      throw new ReceiptRepositoryError(
        "receipt-attempt-already-finalized",
        "a terminal receipt can be written only once",
      );
    }

    const receiptJson = JSON.stringify(receipt);
    if (Buffer.byteLength(receiptJson, "utf8") > RECEIPT_V1_STORED_JSON_MAX_BYTES) {
      throw new ReceiptRepositoryError(
        "receipt-store-too-large",
        "the terminal receipt exceeds the durable storage bound",
      );
    }
    const update = await tx.execute({
      sql: `UPDATE operation_attempts
               SET finished_at = ?, receipt_json = ?
             WHERE attempt_id = ? AND operation_id = ?
               AND finished_at IS NULL AND receipt_json IS NULL`,
      args: [receipt.timestamps.finished_at, receiptJson, attemptId, operationId],
    });
    if (Number(update.rowsAffected) !== 1) {
      throw new ReceiptRepositoryError(
        "receipt-attempt-already-finalized",
        "a terminal receipt can be written only once",
      );
    }
    await tx.commit();
  } catch (error) {
    await rollbackQuietly(tx);
    throw error;
  }
}

/** Read one finalized attempt through the additive Receipt V1 consumer. */
export async function readReceiptAttempt(
  db: Client,
  attemptId: string,
): Promise<StoredReceiptV1 | null> {
  const canonicalAttemptId = canonicalUuid7(attemptId);
  if (canonicalAttemptId === null) {
    throw new ReceiptRepositoryError(
      "invalid-receipt-id",
      "the attempt identifier must be a UUIDv7",
    );
  }
  const result = await db.execute({
    sql: "SELECT receipt_json FROM operation_attempts WHERE attempt_id = ?",
    args: [canonicalAttemptId],
  });
  const row = result.rows[0];
  if (row === undefined || row["receipt_json"] === null) return null;

  return storedReceiptFromJson(row["receipt_json"]);
}

export type ReceiptAttemptSummary = {
  attemptId: string;
  operationId: string;
  operation: string;
  status: StoredReceiptV1["status"] | "pending";
  startedAt: string;
  finishedAt: string | null;
};

export type ReceiptAttemptQuery = {
  operationId: string;
  attemptId?: string;
  operation?: string;
  status?: StoredReceiptV1["status"];
  limit?: number;
};

const RECEIPT_QUERY_LIMIT_DEFAULT = 20;
const RECEIPT_QUERY_LIMIT_MAX = 100;

function canonicalUuid7(value: string): Uint8Array | null {
  if (!UUID_V7_DASHED.test(value) && !UUID_V7_HEX.test(value)) return null;
  try {
    return hexToUuid7Bytes(value);
  } catch {
    return null;
  }
}

function canonicalUuid7OrV8(value: string): Uint8Array | null {
  if (!UUID_V7_OR_V8_DASHED.test(value) && !UUID_V7_OR_V8_HEX.test(value)) return null;
  try {
    return hexToUuid7Bytes(value);
  } catch {
    return null;
  }
}

function storedReceiptFromJson(value: unknown): StoredReceiptV1 {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > RECEIPT_V1_STORED_JSON_MAX_BYTES
  ) {
    throw new ReceiptRepositoryError(
      "receipt-store-corrupt",
      "stored receipt exceeds the supported byte bound",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new ReceiptRepositoryError("receipt-store-corrupt", "stored receipt is not JSON");
  }
  const consumed = consumeReceiptV1(raw);
  if (consumed.status !== "accepted") {
    throw new ReceiptRepositoryError(
      "receipt-store-corrupt",
      "stored receipt does not satisfy the supported Receipt V1 contract",
    );
  }
  return consumed.receipt;
}

/**
 * Read finalized receipt attempts for one logical operation. This deliberately
 * has no migration, transaction, or persistence side effect: inspection is not
 * an operation attempt and must never create a receipt of its own.
 */
export async function queryReceiptAttempts(
  db: ReceiptQueryClient,
  query: ReceiptAttemptQuery,
): Promise<{ operationKnown: boolean; attempts: StoredReceiptV1[] }> {
  const operationId = canonicalUuid7OrV8(query.operationId);
  if (operationId === null) return { operationKnown: false, attempts: [] };
  const attemptId = query.attemptId === undefined ? undefined : canonicalUuid7(query.attemptId);
  if (query.attemptId !== undefined && attemptId === null)
    return { operationKnown: true, attempts: [] };
  const limit = Math.min(
    Math.max(query.limit ?? RECEIPT_QUERY_LIMIT_DEFAULT, 1),
    RECEIPT_QUERY_LIMIT_MAX,
  );
  const clauses = ["a.operation_id = ?", "a.receipt_json IS NOT NULL"];
  const args: InValue[] = [operationId];
  if (attemptId !== undefined) {
    clauses.push("a.attempt_id = ?");
    args.push(attemptId);
  }
  if (query.operation !== undefined) {
    clauses.push("o.operation = ?");
    args.push(query.operation);
  }
  // Receipt status is safely extracted by SQLite from validated stored JSON.
  if (query.status !== undefined) {
    clauses.push("json_extract(a.receipt_json, '$.status') = ?");
    args.push(query.status);
  }
  args.push(limit);
  const known = await db.execute({
    sql: "SELECT 1 FROM operations WHERE operation_id = ? LIMIT 1",
    args: [operationId],
  });
  const result = await db.execute({
    sql: `SELECT a.receipt_json
            FROM operation_attempts a
            JOIN operations o ON o.operation_id = a.operation_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY a.finished_at DESC, a.attempt_id DESC
           LIMIT ?`,
    args,
  });
  return {
    operationKnown: known.rows.length === 1,
    attempts: result.rows.map((row) => storedReceiptFromJson(row["receipt_json"])),
  };
}

/** List bounded terminal attempt summaries without projecting receipt evidence. */
export async function listReceiptAttemptSummaries(
  db: ReceiptQueryClient,
  query: Omit<ReceiptAttemptQuery, "operationId"> = {},
): Promise<ReceiptAttemptSummary[]> {
  const limit = Math.min(
    Math.max(query.limit ?? RECEIPT_QUERY_LIMIT_DEFAULT, 1),
    RECEIPT_QUERY_LIMIT_MAX,
  );
  const clauses = ["a.receipt_json IS NOT NULL"];
  const args: InValue[] = [];
  if (query.operation !== undefined) {
    clauses.push("o.operation = ?");
    args.push(query.operation);
  }
  if (query.status !== undefined) {
    clauses.push("json_extract(a.receipt_json, '$.status') = ?");
    args.push(query.status);
  }
  args.push(limit);
  const result = await db.execute({
    sql: `SELECT a.attempt_id, a.operation_id, a.started_at, a.finished_at, a.receipt_json, o.operation
            FROM operation_attempts a
            JOIN operations o ON o.operation_id = a.operation_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY a.finished_at DESC, a.attempt_id DESC
           LIMIT ?`,
    args,
  });
  return result.rows.map((row) => {
    const receipt = storedReceiptFromJson(row["receipt_json"]);
    return {
      attemptId: uuid7BytesToDashedString(blobToBytes(row["attempt_id"])),
      operationId: uuid7BytesToDashedString(blobToBytes(row["operation_id"])),
      operation: String(row["operation"]),
      status: receipt.status,
      startedAt: String(row["started_at"]),
      finishedAt: row["finished_at"] === null ? null : String(row["finished_at"]),
    };
  });
}

export async function countReceiptOperations(db: Client): Promise<number> {
  const result = await db.execute("SELECT COUNT(*) AS n FROM operations");
  return Number(result.rows[0]?.["n"] ?? 0);
}

export async function countReceiptAttempts(db: Client): Promise<number> {
  const result = await db.execute("SELECT COUNT(*) AS n FROM operation_attempts");
  return Number(result.rows[0]?.["n"] ?? 0);
}
