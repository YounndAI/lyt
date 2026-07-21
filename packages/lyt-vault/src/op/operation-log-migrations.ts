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

export const OP_LOG_SCHEMA_VERSION = 1;
export const OP_LOG_UPGRADE_REQUIRED = "op-log-upgrade-required";

export class OpLogUpgradeRequiredError extends Error {
  readonly code = OP_LOG_UPGRADE_REQUIRED;

  constructor(foundVersion: number) {
    super(
      `${OP_LOG_UPGRADE_REQUIRED}: this operation log uses schema version ${foundVersion}, but this Lyt build supports up to ${OP_LOG_SCHEMA_VERSION}`,
    );
    this.name = "OpLogUpgradeRequiredError";
  }
}

export const OP_LOG_RECEIPT_SCHEMA_REQUIRED = "op-log-receipt-schema-required";

export class OpLogReceiptSchemaRequiredError extends Error {
  readonly code = OP_LOG_RECEIPT_SCHEMA_REQUIRED;

  constructor(detail: string) {
    super(
      `${OP_LOG_RECEIPT_SCHEMA_REQUIRED}: receipt inspection requires the current operation-log schema (${detail})`,
    );
    this.name = "OpLogReceiptSchemaRequiredError";
  }
}

/** Refuse an unsupported future schema without first mutating the database. */
export async function assertSupportedOperationLogSchema(db: Client): Promise<void> {
  const table = await db.execute(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'op_log_schema_migrations' LIMIT 1",
  );
  if (table.rows.length === 0) return;

  const applied = await db.execute(
    "SELECT version FROM op_log_schema_migrations ORDER BY version ASC",
  );
  const versions = applied.rows.map((row) => Number(row["version"]));
  const newest = versions.length === 0 ? 0 : Math.max(...versions);
  if (!Number.isSafeInteger(newest) || newest > OP_LOG_SCHEMA_VERSION) {
    throw new OpLogUpgradeRequiredError(newest);
  }
}

/** Require the additive receipt tables without migrating or creating anything. */
export async function assertReadableReceiptSchema(db: Client): Promise<void> {
  await assertSupportedOperationLogSchema(db);
  const migration = await db
    .execute({
      sql: `SELECT 1
            FROM op_log_schema_migrations
           WHERE version = ?
           LIMIT 1`,
      args: [OP_LOG_SCHEMA_VERSION],
    })
    .catch(() => null);
  if (migration === null || migration.rows.length !== 1) {
    throw new OpLogReceiptSchemaRequiredError("migration is absent");
  }

  const required: Readonly<Record<string, readonly string[]>> = {
    operations: ["operation_id", "replay_key_digest", "operation", "scope_json", "created_at"],
    operation_attempts: ["attempt_id", "operation_id", "started_at", "finished_at", "receipt_json"],
  };
  for (const [table, columns] of Object.entries(required)) {
    let observed: Set<string>;
    try {
      const result = await db.execute(`SELECT name FROM pragma_table_xinfo('${table}')`);
      observed = new Set(result.rows.map((row) => String(row["name"])));
    } catch {
      throw new OpLogReceiptSchemaRequiredError(`${table} is absent`);
    }
    const missing = columns.filter((column) => !observed.has(column));
    if (missing.length > 0) {
      throw new OpLogReceiptSchemaRequiredError(`${table} is missing ${missing.join(",")}`);
    }
  }
}

/**
 * Add receipt history alongside the legacy undo log. This deliberately does
 * not copy or reinterpret `op_log`: legacy undo rows and receipt attempts have
 * different identities and lifecycles.
 */
export async function migrateOperationLog(db: Client): Promise<void> {
  await assertSupportedOperationLogSchema(db);
  await db.execute(`CREATE TABLE IF NOT EXISTS op_log_schema_migrations (
 version INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 applied_at TEXT NOT NULL
  )`);

  const applied = await db.execute(
    "SELECT version FROM op_log_schema_migrations ORDER BY version ASC",
  );
  const versions = applied.rows.map((row) => Number(row["version"]));
  const newest = versions.length === 0 ? 0 : Math.max(...versions);
  if (!Number.isSafeInteger(newest) || newest > OP_LOG_SCHEMA_VERSION) {
    throw new OpLogUpgradeRequiredError(newest);
  }
  if (versions.includes(OP_LOG_SCHEMA_VERSION)) return;

  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS operations (
 operation_id BLOB PRIMARY KEY,
 replay_key_digest TEXT NOT NULL UNIQUE,
 operation TEXT NOT NULL,
 scope_json TEXT NOT NULL,
 created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS operation_attempts (
 attempt_id BLOB PRIMARY KEY,
 operation_id BLOB NOT NULL,
 started_at TEXT NOT NULL,
 finished_at TEXT,
 receipt_json TEXT,
 FOREIGN KEY(operation_id) REFERENCES operations(operation_id),
 CHECK ((finished_at IS NULL AND receipt_json IS NULL) OR
        (finished_at IS NOT NULL AND receipt_json IS NOT NULL))
      )`,
      "CREATE INDEX IF NOT EXISTS operation_attempts_operation_id_idx ON operation_attempts(operation_id)",
      {
        sql: "INSERT INTO op_log_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        args: [OP_LOG_SCHEMA_VERSION, "durable-operation-receipts", new Date().toISOString()],
      },
    ],
    "write",
  );
}
