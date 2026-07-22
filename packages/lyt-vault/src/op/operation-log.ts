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

// Increment 1 · Phase A.2 — the APPEND-ONLY operation log.
//
// This is the crash-safety substrate `lyt undo` reads. Every in-scope
// Operation records ONE durable row here BEFORE `apply()` mutates
// (enqueue-before-apply), so a process death mid-apply still leaves a
// reversible entry — never a mutation with no record. When `apply()` completes
// the SAME row is UPDATED with the horizon ACTUALLY reached + `applied_at` (an
// outcome update, NOT a lifecycle delete). Rows are NEVER deleted; an undo is
// itself appended as a new op, so undo-the-undo stays well-defined later.
//
// CONTRAST WITH outbox.ts (the review's HIGH R1/F3 — do not repeat the bug):
// the outbox is a WORK QUEUE that DELETEs a row on success (an empty outbox ==
// fully drained). This log is HISTORY. We reuse ONLY outbox's libSQL *plumbing*
// — the `${LYT_HOME}` file store, `PRAGMA journal_mode=DELETE` + busy_timeout,
// a uuidv7 BLOB PK, the win32 close-delay — and NONE of its delete-on-success
// lifecycle. If a future edit adds a `DELETE FROM op_log`, it has reintroduced
// the exact bug that leaves `lyt undo` finding nothing.
//
// Substrate: a small libSQL file at `${LYT_HOME}/op-log.db` — pod-level, NOT
// per-vault: the undo history spans every vault the handler writes to from this
// machine (a `sync` op, for one, touches the whole pod's publish round-trip).
//
// TIMING (the honesty rule from operation.ts): `horizon` is the INTENDED value
// at enqueue and the ACTUAL value after apply — `markOpApplied` writes back
// what really happened, so a half-landed op is never mislabelled in history.

import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";

import { openSqliteReadOnly, type ReadOnlySqliteQueryClient } from "../sqlite/read-only-client.js";
import { getLytHome } from "../util/paths.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import {
  assertReadableReceiptSchema,
  assertSupportedOperationLogSchema,
  migrateOperationLog,
} from "./operation-log-migrations.js";
import type { Inverse, SyncHorizon } from "./operation.js";

/**
 * Lifecycle of a logged op:
 * `pending` = enqueued but `apply()` has not confirmed completion (a
 * crash-window entry the recovery path reconciles).
 * `applied` = `apply()` finished and made a real state change (the actual
 * horizon was written back); the newest such op is what `lyt undo`
 * acts on.
 * `aborted` = enqueued but produced NO undoable state change — a capture that
 * was refused before writing (validation throw) or was a no-op
 * (the note already existed). Deliberately distinct from both
 * `applied` (so it does NOT shadow the real undoable op beneath it
 * — release review) and `pending` (so the recovery path is not
 * misled into "recovering" a capture that correctly wrote nothing
 * — release review R2). Neither `readLastAppliedOp` nor
 * `readPendingOps` returns it.
 */
export type OpStatus = "pending" | "applied" | "aborted";

/** What `appendPendingOp` records BEFORE `apply()` runs (intended values). */
export interface OpLogInput {
  /** The Operation's verb identity — "capture" | "sync" | "undo". */
  kind: string;
  /** INTENDED horizon at enqueue; overwritten with the ACTUAL horizon at markOpApplied. */
  horizon: SyncHorizon;
  /** The vault-relative files this op will touch — carried so a later multi-file inverse is expressible. */
  fileSet: string[];
  /** The INTENDED inverse at enqueue; overwritten with the ACTUAL inverse at markOpApplied. */
  inverse: Inverse;
}

/** A row read back from the log. */
export interface OpLogRow {
  id: Uint8Array;
  kind: string;
  horizon: SyncHorizon;
  fileSet: string[];
  inverse: Inverse;
  status: OpStatus;
  createdAt: string;
  appliedAt: string | null;
}

const OP_LOG_BUSY_TIMEOUT_MS = 5000;

const operationLogStoreIdentities = new WeakMap<Client, string>();

function normalizedOperationLogStoreIdentity(path: string): string {
  const absolute = normalize(resolve(path));
  let physical = absolute;
  try {
    physical = realpathSync.native(absolute);
  } catch {
    // The client creates a missing database lazily. The resolved absolute path
    // is still a stable identity until the file exists.
  }
  const normalized = normalize(physical);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Internal metadata seam for per-store receipt write coordination. */
export function getOperationLogStoreIdentity(db: Client): string {
  const identity = operationLogStoreIdentities.get(db);
  if (identity === undefined) {
    throw new Error("operation-log client is missing its physical store identity");
  }
  return identity;
}

const SELECT_COLS =
  "SELECT id, kind, horizon, file_set, inverse_json, status, created_at, applied_at FROM op_log";

export const POD_REPAIR_OPERATION_ID_SQL = `CASE
  WHEN json_valid(file_set)
   AND json_array_length(file_set) = 1
   AND json_type(file_set, '$[0]') = 'text'
   AND json_valid(json_extract(file_set, '$[0]'))
  THEN json_extract(json_extract(file_set, '$[0]'), '$.operation_id')
  ELSE NULL
END`;

export function getOpLogPath(): string {
  return join(getLytHome(), "op-log.db");
}

export type ReadOnlyOperationLogClient = ReadOnlySqliteQueryClient;

export type ReadOnlyOperationLogOpenResult =
  | Readonly<{ kind: "missing"; path: string }>
  | Readonly<{
      kind: "open";
      path: string;
      client: ReadOnlyOperationLogClient;
      close(): void;
    }>;

/** Open the existing receipt store behind the shared read-only capability. */
export async function openOpLogReadOnly(opts?: {
  path?: string;
}): Promise<ReadOnlyOperationLogOpenResult> {
  const path = opts?.path ?? getOpLogPath();
  const opened = openSqliteReadOnly(path);
  if (opened.kind === "missing") return opened;
  try {
    await assertReadableReceiptSchema(opened.database.client as unknown as Client);
    return Object.freeze({
      kind: "open" as const,
      path: opened.path,
      client: opened.database.client,
      close: () => opened.database.close(),
    });
  } catch (error) {
    opened.database.close();
    throw error;
  }
}

export async function openOpLog(opts?: { path?: string }): Promise<Client> {
  const dbPath = opts?.path ?? getOpLogPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await assertSupportedOperationLogSchema(db);
    await db.execute("PRAGMA journal_mode=DELETE");
    await db.execute(`PRAGMA busy_timeout=${OP_LOG_BUSY_TIMEOUT_MS}`);
    await migrateOperationLog(db);
    await db.execute(
      `CREATE TABLE IF NOT EXISTS op_log (
 id BLOB PRIMARY KEY,
 kind TEXT NOT NULL,
 horizon TEXT NOT NULL,
 file_set TEXT NOT NULL,
 inverse_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL,
 applied_at TEXT
      )`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS op_log_pod_repair_operation_idx
         ON op_log(kind, (${POD_REPAIR_OPERATION_ID_SQL}))`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS operations_operation_id_kind_idx
         ON operations(operation, operation_id)`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS operation_attempts_latest_idx
         ON operation_attempts(operation_id, started_at DESC, attempt_id DESC)`,
    );
    operationLogStoreIdentities.set(db, normalizedOperationLogStoreIdentity(dbPath));
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export async function closeOpLog(db: Client): Promise<void> {
  db.close();
  if (process.platform === "win32") {
    await new Promise((r) => setTimeout(r, 200));
  } else {
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * ENQUEUE-BEFORE-APPLY. Append a `pending` row for an op that is ABOUT to
 * mutate, and return its id so the caller can finalize it after `apply()`. The
 * row is durable the moment this resolves — a crash before `apply()` completes
 * leaves a `pending` entry the recovery / undo path can still act on. This is
 * the load-bearing crash-safety guarantee; call it BEFORE the mutation.
 */
export async function appendPendingOp(
  db: Client,
  input: OpLogInput,
  nowIso: string,
): Promise<Uint8Array> {
  const id = newUuidv7Bytes();
  await db.execute({
    sql: `INSERT INTO op_log (id, kind, horizon, file_set, inverse_json, status, created_at, applied_at)
 VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    args: [id, input.kind, input.horizon, JSON.stringify(input.fileSet), JSON.stringify(input.inverse), nowIso],
  });
  return id;
}

/**
 * Finalize the pending row after `apply()` completes — an OUTCOME UPDATE of the
 * SAME row (never a delete). Writes back the horizon ACTUALLY reached, the
 * (possibly recomputed) inverse, and `applied_at`. Passing `fileSet` overwrites
 * the enqueued planned set with the actual one; omit it to keep the planned set.
 *
 * This UPDATE is explicitly NOT the delete-on-success lifecycle the outbox uses
 * — the row (and thus the undo entry) survives.
 *
 * The `AND status='pending'` guard + the exactly-one-row assert make a
 * double-finalize (or a bogus id) a DETECTED error rather than a silent rewrite
 * of an already-recorded outcome — history fidelity (release review).
 */
export async function markOpApplied(
  db: Client,
  id: Uint8Array,
  outcome: { horizon: SyncHorizon; inverse: Inverse; fileSet?: string[] },
  nowIso: string,
): Promise<void> {
  const res =
    outcome.fileSet !== undefined
      ? await db.execute({
          sql: "UPDATE op_log SET status='applied', horizon=?, inverse_json=?, file_set=?, applied_at=? WHERE id=? AND status='pending'",
          args: [outcome.horizon, JSON.stringify(outcome.inverse), JSON.stringify(outcome.fileSet), nowIso, id],
        })
      : await db.execute({
          sql: "UPDATE op_log SET status='applied', horizon=?, inverse_json=?, applied_at=? WHERE id=? AND status='pending'",
          args: [outcome.horizon, JSON.stringify(outcome.inverse), nowIso, id],
        });
  if (Number(res.rowsAffected) !== 1) {
    throw new Error(
      `markOpApplied: expected exactly 1 pending op to finalize, updated ${Number(res.rowsAffected)} (double-finalize or unknown id).`,
    );
  }
}

/**
 * Finalize a pending row as `aborted` — the op was enqueued but made no undoable
 * state change (a capture refused before writing, or a no-op onto a pre-existing
 * note). Records a `none` inverse carrying the plain reason. Like `markOpApplied`
 * this is an outcome UPDATE of the same row (append-only; never a delete), guarded
 * on `status='pending'`. An aborted row is invisible to both `readLastAppliedOp`
 * and `readPendingOps` by design.
 */
export async function markOpAborted(
  db: Client,
  id: Uint8Array,
  reason: string,
  nowIso: string,
): Promise<void> {
  const inverse: Inverse = { class: "none", reason };
  const res = await db.execute({
    sql: "UPDATE op_log SET status='aborted', inverse_json=?, applied_at=? WHERE id=? AND status='pending'",
    args: [JSON.stringify(inverse), nowIso, id],
  });
  if (Number(res.rowsAffected) !== 1) {
    throw new Error(
      `markOpAborted: expected exactly 1 pending op to abort, updated ${Number(res.rowsAffected)} (double-finalize or unknown id).`,
    );
  }
}

/**
 * The most-recent APPLIED op — what `lyt undo` reverses (single-step, A.3).
 *
 * Ordered by the uuidv7 PK `id` DESC, NOT `created_at`: the id is generated
 * in-process at enqueue and its leading 48 bits are a big-endian millisecond
 * timestamp, so a byte-wise BLOB compare (SQLite's native BLOB ordering) is the
 * TRUE insertion order — immune to clock skew, a stale/recomputed caller
 * `created_at`, or an NTP step-back. `created_at` is a plain caller-supplied
 * string and MUST NOT be the correctness key for a LIFO undo (release review
 * a review finding + R2-MAJOR). A `pending` (crash-window) op is deliberately excluded —
 * undo acts on a completed op; see `readPendingOps` for the recovery path.
 */
export async function readLastAppliedOp(db: Client): Promise<OpLogRow | null> {
  const rs = await db.execute(`${SELECT_COLS} WHERE status='applied' ORDER BY id DESC LIMIT 1`);
  const row = rs.rows[0];
  return row === undefined ? null : rowToOp(row);
}

/**
 * The crash-window rows: ops enqueued (`appendPendingOp`) but never finalized
 * (`markOpApplied`) — a process died between the durable log entry and `apply()`
 * completing, or mid-apply. This is the READ side of the enqueue-before-apply
 * guarantee. NOTE (release review A.G a review finding): a crash-recovery reconciler that
 * CONSUMES these — to reverse or complete a half-applied op — is NOT yet wired;
 * there is no production consumer today, so the crash-window row is currently
 * write-only (the note is safe on disk, never falsely claimed undoable — it
 * fails safe, it just under-delivers the recovery guarantee). Wiring the
 * reconciler (into `openOpLog`/`lyt doctor`) is tracked as a follow-up; the
 * op-seam conformance test allowlists this until then. Newest first (uuidv7 `id` DESC).
 */
export async function readPendingOps(db: Client): Promise<OpLogRow[]> {
  const rs = await db.execute(`${SELECT_COLS} WHERE status='pending' ORDER BY id DESC`);
  return rs.rows.map(rowToOp);
}

/**
 * Recent ops (any status), newest first (uuidv7 `id` DESC) — for history /
 * diagnostics. `limit` caps the window (default 50); a pod that writes more ops
 * than this between inspections sees only the most recent — it is "recent ops",
 * not the full ledger.
 */
export async function listOps(db: Client, limit = 50): Promise<OpLogRow[]> {
  const rs = await db.execute({
    sql: `${SELECT_COLS} ORDER BY id DESC LIMIT ?`,
    args: [limit],
  });
  return rs.rows.map(rowToOp);
}

export async function countOps(db: Client): Promise<number> {
  const rs = await db.execute("SELECT COUNT(*) AS n FROM op_log");
  return Number(rs.rows[0]?.["n"] ?? 0);
}

// libSQL returns a BLOB column as Uint8Array — or as a plain ArrayBuffer on
// some Windows build paths (same quirk uuid7.ts guards). Normalize to bytes.
function blobToBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error("op_log.id is not a BLOB");
}

function rowToOp(r: Record<string, unknown>): OpLogRow {
  return {
    id: blobToBytes(r["id"]),
    kind: String(r["kind"]),
    horizon: String(r["horizon"]) as SyncHorizon,
    fileSet: safeParseFileSet(String(r["file_set"])),
    inverse: safeParseInverse(String(r["inverse_json"])),
    status: String(r["status"]) as OpStatus,
    createdAt: String(r["created_at"]),
    appliedAt: r["applied_at"] === null || r["applied_at"] === undefined ? null : String(r["applied_at"]),
  };
}

// The op-log file is pod-level and externally editable — a read-back row is
// UNTRUSTED INPUT ([lyt.untrusted] / agent-corruptor reflex; release review A.G
// a review finding). The `inverse` is the load-bearing field: it can carry a `delete-figment`
// action that `lyt undo` turns into an `rmSync`. So it is VALIDATED on read, not
// blind-cast — a malformed/garbled inverse (or a delete action with non-string
// paths) collapses to a refuse-safe `none` that can never drive a delete. (undo
// independently re-validates vaultPath against the registry — defense in depth.)
const CORRUPT_INVERSE: Inverse = {
  class: "none",
  reason: "This record looks corrupted, so it can't be undone here.",
};

function safeParseInverse(raw: string): Inverse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return CORRUPT_INVERSE;
  }
  if (typeof parsed !== "object" || parsed === null) return CORRUPT_INVERSE;
  const cls = (parsed as { class?: unknown }).class;
  if (cls === "clean-undo") {
    const action = (parsed as { action?: unknown }).action;
    if (action === undefined) return { class: "clean-undo" };
    if (typeof action !== "object" || action === null) return CORRUPT_INVERSE;
    const a = action as { type?: unknown; vaultPath?: unknown; relPath?: unknown };
    // The ONLY action type today; a delete action MUST carry string paths or it
    // is unusable — refuse-safe rather than hand undo a garbled delete target.
    if (a.type !== "delete-figment" || typeof a.vaultPath !== "string" || typeof a.relPath !== "string") {
      return CORRUPT_INVERSE;
    }
    return { class: "clean-undo", action: { type: "delete-figment", vaultPath: a.vaultPath, relPath: a.relPath } };
  }
  if (cls === "compensating") {
    const note = (parsed as { note?: unknown }).note;
    return { class: "compensating", note: typeof note === "string" ? note : "This can only be reversed by a new action." };
  }
  if (cls === "none") {
    const reason = (parsed as { reason?: unknown }).reason;
    return { class: "none", reason: typeof reason === "string" ? reason : "This can't be undone here." };
  }
  return CORRUPT_INVERSE; // unknown class
}

function safeParseFileSet(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[];
  } catch {
    /* fall through */
  }
  return [];
}
