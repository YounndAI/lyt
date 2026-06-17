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

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { createClient, type Client } from "@libsql/client";

import { getLytHome } from "../../util/paths.js";
import { newUuidv7Bytes } from "../../util/uuid7.js";

// Brief B (B.2) — the resumable publish OUTBOX.
//
// The reconcile engine enqueues one durable work-item per outward op
// (publish-vault:<name>, publish-pod) BEFORE attempting it, and DELETES it on
// success. If a sync is interrupted mid-publish (network kill, gh hiccup,
// process death), the un-drained items survive in `outbox.db`; the next
// `lyt sync` re-loads them and completes the round-trip — never a half-publish
// with no record. A failed attempt keeps the row (attempts++ + last_error) so
// it is retried, not lost.
//
// Substrate: a small libSQL file at `${LYT_HOME}/outbox.db` (pod-level, NOT
// per-vault — it queues the whole pod's publish round-trip). DELETE journal +
// busy_timeout mirror the registry open path (registry/client.ts). The op set
// is closed (publish-vault | publish-pod); (op, target) is UNIQUE so
// re-enqueueing an in-flight item is an idempotent no-op.

export type OutboxOp = "publish-vault" | "publish-pod";

export interface OutboxEntry {
  op: OutboxOp;
  target: string; // a vault name for publish-vault; "pod" for publish-pod
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

const OUTBOX_BUSY_TIMEOUT_MS = 5000;

export function getOutboxPath(): string {
  return join(getLytHome(), "outbox.db");
}

export async function openOutbox(opts?: { path?: string }): Promise<Client> {
  const dbPath = opts?.path ?? getOutboxPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await db.execute("PRAGMA journal_mode=DELETE");
    await db.execute(`PRAGMA busy_timeout=${OUTBOX_BUSY_TIMEOUT_MS}`);
    await db.execute(
      `CREATE TABLE IF NOT EXISTS outbox (
 id BLOB PRIMARY KEY,
 op TEXT NOT NULL,
 target TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(op, target)
      )`,
    );
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export async function closeOutbox(db: Client): Promise<void> {
  db.close();
  if (process.platform === "win32") {
    await new Promise((r) => setTimeout(r, 200));
  } else {
    await new Promise((r) => setImmediate(r));
  }
}

// Enqueue a pending op. Idempotent by (op, target): re-enqueueing an in-flight
// item does NOTHING (keeps its attempts/error), so a re-run after a crash
// doesn't reset retry bookkeeping.
export async function enqueueOutbox(
  db: Client,
  op: OutboxOp,
  target: string,
  nowIso: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO outbox (id, op, target, attempts, created_at, updated_at)
 VALUES (?, ?, ?, 0, ?, ?)
          ON CONFLICT(op, target) DO NOTHING`,
    args: [newUuidv7Bytes(), op, target, nowIso, nowIso],
  });
}

// All outstanding (un-drained / failed) items, oldest first.
export async function listOutbox(db: Client): Promise<OutboxEntry[]> {
  const rs = await db.execute(
    "SELECT op, target, attempts, last_error, created_at, updated_at FROM outbox ORDER BY created_at ASC, op ASC, target ASC",
  );
  return rs.rows.map((r) => ({
    op: String(r["op"]) as OutboxOp,
    target: String(r["target"]),
    attempts: Number(r["attempts"] ?? 0),
    lastError:
      r["last_error"] === null || r["last_error"] === undefined ? null : String(r["last_error"]),
    createdAt: String(r["created_at"]),
    updatedAt: String(r["updated_at"]),
  }));
}

// Success → remove the item (an empty outbox == fully published).
export async function markOutboxDone(db: Client, op: OutboxOp, target: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM outbox WHERE op = ? AND target = ?",
    args: [op, target],
  });
}

// Failure → keep the item (retried next run), bump attempts + record the error.
export async function markOutboxFailed(
  db: Client,
  op: OutboxOp,
  target: string,
  error: string,
  nowIso: string,
): Promise<void> {
  await db.execute({
    sql: "UPDATE outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE op = ? AND target = ?",
    args: [error.slice(0, 500), nowIso, op, target],
  });
}

export async function countOutbox(db: Client): Promise<number> {
  const rs = await db.execute("SELECT COUNT(*) AS n FROM outbox");
  return Number(rs.rows[0]?.["n"] ?? 0);
}
