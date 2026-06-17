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

import { isUuidv7Bytes, newUuidv7Bytes, uuid7BytesToHex } from "../util/uuid7.js";

// Per-machine row tracking the locally-cached federation repo. v1.A.0 ships
// one row per machine (multi-handle support is a future concern; the PK
// allows it without schema change). SoT for federation contents lives in
// the {handle}/lyt-pod GH repo (repo name) cloned to ~/lyt/pod/ — this
// table is a thin pointer so `lyt init` can probe "did this machine
// already adopt the federation repo?" cheaply.
export interface FederationStateRow {
  handle: string;
  fedRidHex: string;
  fedRidBytes: Uint8Array;
  lastSyncedAt: string;
}

function rowToState(row: Record<string, unknown>): FederationStateRow {
  const handle = String(row["handle"]);
  const ridRaw = row["fed_rid"];
  if (!isUuidv7Bytes(ridRaw)) {
    throw new Error(
      `federation_state.fed_rid for handle ${JSON.stringify(handle)} is not a valid UUIDv7 blob.`,
    );
  }
  const bytes = ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
  return {
    handle,
    fedRidBytes: bytes,
    fedRidHex: uuid7BytesToHex(bytes),
    lastSyncedAt: String(row["last_synced_at"]),
  };
}

export async function readFederationState(
  db: Client,
  handle: string,
): Promise<FederationStateRow | null> {
  const r = await db.execute({
    sql: "SELECT handle, fed_rid, last_synced_at FROM federation_state WHERE handle = ?",
    args: [handle],
  });
  if (r.rows.length === 0) return null;
  return rowToState(r.rows[0] as unknown as Record<string, unknown>);
}

export async function listFederationStates(db: Client): Promise<FederationStateRow[]> {
  const r = await db.execute(
    "SELECT handle, fed_rid, last_synced_at FROM federation_state ORDER BY handle ASC",
  );
  return r.rows.map((row) => rowToState(row as unknown as Record<string, unknown>));
}

export interface UpsertFederationStateArgs {
  handle: string;
  fedRidBytes?: Uint8Array;
  lastSyncedAt?: string;
}

// Upsert the row. If `fedRidBytes` is omitted on first insert, a fresh
// UUIDv7 is generated; on UPDATE the existing rid is preserved (rids are
// stable forever per global directive).
//
// v1.A.1 fold (DO NOT SKIP #1 + #17):
// • Probe-read is GATED: when the caller passes `fedRidBytes` explicitly
// (all v1.A.0 federation flows seed once then pass everywhere) we skip
// the up-front round-trip read. Saves 1 SQL per upsert on the v1.A.0
// call pattern.
// • SQL preserves `fed_rid` on UPDATE. The ON CONFLICT clause only
// touches `last_synced_at`, so even if a future caller accidentally
// supplies a different `fedRidBytes` on second touch, the SQL never
// overwrites the stored rid. The "rids stable forever" invariant
// lives in SQL, not just in TS — defence-in-depth.
export async function upsertFederationState(
  db: Client,
  args: UpsertFederationStateArgs,
): Promise<FederationStateRow> {
  let bytes: Uint8Array;
  if (args.fedRidBytes !== undefined) {
    bytes = args.fedRidBytes;
  } else {
    const existing = await readFederationState(db, args.handle);
    bytes = existing?.fedRidBytes ?? newUuidv7Bytes();
  }
  const ts = args.lastSyncedAt ?? new Date().toISOString();
  await db.execute({
    sql:
      "INSERT INTO federation_state (handle, fed_rid, last_synced_at) VALUES (?, ?, ?)" +
      " ON CONFLICT(handle) DO UPDATE SET last_synced_at = excluded.last_synced_at",
    args: [args.handle, bytes, ts],
  });
  return {
    handle: args.handle,
    fedRidBytes: bytes,
    fedRidHex: uuid7BytesToHex(bytes),
    lastSyncedAt: ts,
  };
}

export async function deleteFederationState(db: Client, handle: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM federation_state WHERE handle = ?",
    args: [handle],
  });
}

// (2026-06-04) — remap the pod's handle from a PROVISIONAL
// handle (minted at a no-gh `lyt init`) to the REAL gh handle, at connect. The
// `fed_rid` is PRESERVED (rids are stable forever per the global UUIDv7
// directive) — a naive re-forge under the real handle would mint a NEW rid and
// silently fork the pod identity. Idempotent: a no-op when from === to, or when
// the `from` row is absent (already reconciled). Returns the resulting row
// under `toHandle`, or null when there was nothing to remap.
export async function remapFederationHandle(
  db: Client,
  fromHandle: string,
  toHandle: string,
  lastSyncedAt?: string,
): Promise<FederationStateRow | null> {
  if (fromHandle === toHandle) {
    // No remap needed; surface the existing row (if any) for the caller.
    return readFederationState(db, toHandle);
  }
  const from = await readFederationState(db, fromHandle);
  if (from === null) {
    // Already remapped (or never existed) — return the target row if present.
    return readFederationState(db, toHandle);
  }
  // release review fix-pass — the insert (real-handle row, PRESERVING the
  // stable fed_rid) + delete (provisional row) run in ONE atomic libSQL write
  // batch, so an interruption can never leave the 2-row state that the
  // single-pod consumers (connectPodFlow / podNeedsConnect / reconcile / regen)
  // all silently refuse to heal. All-or-nothing.
  const ts = lastSyncedAt ?? new Date().toISOString();
  await db.batch(
    [
      {
        sql:
          "INSERT INTO federation_state (handle, fed_rid, last_synced_at) VALUES (?, ?, ?)" +
          " ON CONFLICT(handle) DO UPDATE SET last_synced_at = excluded.last_synced_at",
        args: [toHandle, from.fedRidBytes, ts],
      },
      { sql: "DELETE FROM federation_state WHERE handle = ?", args: [fromHandle] },
    ],
    "write",
  );
  return {
    handle: toHandle,
    fedRidBytes: from.fedRidBytes,
    fedRidHex: uuid7BytesToHex(from.fedRidBytes),
    lastSyncedAt: ts,
  };
}
