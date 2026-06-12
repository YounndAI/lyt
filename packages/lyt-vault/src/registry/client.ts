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

import { getLytHome } from "../util/paths.js";
import { migrate } from "./migrate.js";

export function getRegistryPath(): string {
  return join(getLytHome(), "registry.db");
}

// Brief A A.4 / a review finding — busy_timeout for the SHARED registry open path. Several
// flows briefly hold a registry connection while a sub-flow opens another
// (historically meshInitFlow nested inside initVaultFlow/adoptAndPrimeFlow —
// now threaded via the open-once `db` seam, but defense-in-depth remains). With
// DELETE journal mode the writer takes an exclusive lock; a 2nd connection that
// hits it would get an immediate SQLITE_BUSY without this. busy_timeout makes
// the 2nd connection WAIT up to N ms for the lock instead of erroring. 5s is
// far above any real single-machine CLI contention window (the close() Windows
// lock wait is 200ms) yet bounded so a genuine deadlock still surfaces.
const REGISTRY_BUSY_TIMEOUT_MS = 5000;

export async function openRegistry(opts?: { path?: string }): Promise<Client> {
  const dbPath = opts?.path ?? getRegistryPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = createClient({ url: `file:${dbPath}` });
  try {
    // Enable FK enforcement per connection (libSQL/SQLite default is OFF).
    // `mesh_edges.source_vault_rid → vaults(rid) ON DELETE CASCADE` is otherwise
    // decorative — orphan edges would survive a `DELETE FROM vaults`.
    await db.execute("PRAGMA foreign_keys = ON");
    // DELETE journal mode (no WAL) — keeps the registry to a single small file
    // and avoids lingering .db-wal / .db-shm sidecars on Windows.
    await db.execute("PRAGMA journal_mode=DELETE");
    // Wait (don't immediately error) when another connection holds the write
    // lock. Set per-connection (busy_timeout is not persisted in the DB file).
    await db.execute(`PRAGMA busy_timeout=${REGISTRY_BUSY_TIMEOUT_MS}`);
    await migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export async function closeRegistry(db: Client): Promise<void> {
  db.close();
  // @libsql/client's native Node binding holds a Windows file lock briefly
  // after close() returns. Wait long enough for the OS to release the handle
  // before callers attempt to unlink / remove the registry file. The delay
  // is invisible to interactive CLI use (one close per invocation).
  if (process.platform === "win32") {
    // 200ms (was 50ms) — matches closeVaultDb. The 50ms wait was insufficient
    // under heavily concurrent test load; production CLI cost is negligible
    // (one wait per CLI invocation) and the trade-off avoids back-to-back
    // close→rm EBUSY races.
    await new Promise((r) => setTimeout(r, 200));
  } else {
    await new Promise((r) => setImmediate(r));
  }
}
