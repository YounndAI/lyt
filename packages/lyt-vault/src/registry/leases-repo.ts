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

// machine_leases repo — per-machine automator lease ledger.
//
// Per block-B brief clause (5)-(6) + arc-thoughts §6.6 5-step protocol:
// every automator run acquires a libSQL row with TTL (default 60s,
// overridable per @AUTOMATOR via lease_expiry_ms field) before stepping
// into the protocol's vault-sync/run/commit/release sequence. The lease
// prevents same-machine concurrent runs of the same (vault, automator)
// tuple — Turso eventual consistency handles cross-machine coordination
// at the lease-row level via UUIDv7 PK + INSERT semantics.
//
// Open-once seam preserved (v1.A.1a fold #4): every helper takes
// `db: Client` as its first arg and threads it through to repo calls.
// The `canAcquireLease(probe)` predicate is extracted so flows from
// lyt-runner can reason about lease availability without coupling to
// SQL — mirrors the `shouldSelfHealFederation(probe, opts)` pattern
// from federation-state.ts (v1.A.1a commit c6041b8).

import type { Client } from "@libsql/client";

import { newUuidv7Bytes, isUuidv7Bytes } from "../util/uuid7.js";

export type LeaseStatus = "active" | "released" | "expired";

export interface LeaseRow {
  leaseId: Uint8Array;
  automatorRid: Uint8Array;
  vaultRid: Uint8Array;
  machineId: string;
  acquiredAt: number;
  expiresAt: number;
  status: LeaseStatus;
  releasedAt: number | null;
  releasedReason: string | null;
}

export interface AcquireLeaseArgs {
  automatorRid: Uint8Array;
  vaultRid: Uint8Array;
  machineId: string;
  ttlMs?: number; // default 60_000 ms per arc §6.6
  now?: number; // injectable clock for tests
}

export interface ReleaseLeaseArgs {
  leaseId: Uint8Array;
  reason?: string;
  now?: number;
}

export interface RefreshLeaseArgs {
  leaseId: Uint8Array;
  ttlMs?: number;
  now?: number;
}

const DEFAULT_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Predicate (open-once seam) — pure function over probe state. Tests can
// invoke this without constructing a full libSQL client; flows in
// lyt-runner consume the predicate rather than embedding SQL.
// ---------------------------------------------------------------------------

export interface LeaseProbe {
  // The current set of active (vault, automator) leases on this machine,
  // as returned by `probeActiveLeases(db, ...)`. Empty array = no contention.
  activeLeases: ReadonlyArray<{
    automatorRid: Uint8Array;
    vaultRid: Uint8Array;
    expiresAt: number;
  }>;
  now: number;
}

export interface CanAcquireLeaseDecision {
  ok: boolean;
  reason?: string;
  conflictingMachineId?: string;
}

// Decide whether a new lease for (automatorRid, vaultRid) can be acquired
// given the current probe. The predicate is purely a function — no SQL,
// no side effects. lyt-runner calls this after probeActiveLeases() to
// fail fast on conflict without writing a doomed INSERT.
export function canAcquireLease(
  probe: LeaseProbe,
  args: { automatorRid: Uint8Array; vaultRid: Uint8Array },
): CanAcquireLeaseDecision {
  for (const lease of probe.activeLeases) {
    if (lease.expiresAt < probe.now) continue; // already expired; sweep will clean
    if (!bytesEqual(lease.automatorRid, args.automatorRid)) continue;
    if (!bytesEqual(lease.vaultRid, args.vaultRid)) continue;
    return {
      ok: false,
      reason: `lease already active for this (automator, vault) tuple on this machine; expires_at=${lease.expiresAt}`,
    };
  }
  return { ok: true };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Probe + sweep — read-side helpers consumed by acquireLease().
// ---------------------------------------------------------------------------

export async function probeActiveLeases(
  db: Client,
  args: { automatorRid: Uint8Array; vaultRid: Uint8Array },
): Promise<LeaseProbe["activeLeases"]> {
  const rows = await db.execute({
    sql: `SELECT automator_rid, vault_rid, expires_at FROM machine_leases
          WHERE status = 'active' AND vault_rid = ? AND automator_rid = ?`,
    args: [args.vaultRid, args.automatorRid],
  });
  return rows.rows.map((r) => ({
    automatorRid: toBytes(r["automator_rid"]),
    vaultRid: toBytes(r["vault_rid"]),
    expiresAt: Number(r["expires_at"] as number | bigint),
  }));
}

// Auto-expiry sweep (lazy cleanup, per brief clause (6)). Flips every
// row with status='active' AND expires_at < now to status='expired'. Called
// on every acquireLease() — keeps the lease ledger tidy without a daemon.
export async function sweepExpiredLeases(db: Client, now: number): Promise<number> {
  const result = await db.execute({
    sql: `UPDATE machine_leases SET status = 'expired', released_at = ?,
          released_reason = 'auto-expiry-sweep'
          WHERE status = 'active' AND expires_at < ?`,
    args: [now, now],
  });
  return Number(result.rowsAffected);
}

// ---------------------------------------------------------------------------
// CRUD — write-side helpers. Each accepts `db: Client` for the open-once
// seam (v1.A.1a fold #4).
// ---------------------------------------------------------------------------

export async function acquireLease(db: Client, args: AcquireLeaseArgs): Promise<LeaseRow> {
  if (!isUuidv7Bytes(args.automatorRid)) {
    throw new Error("acquireLease: automatorRid must be a 16-byte UUIDv7");
  }
  if (!isUuidv7Bytes(args.vaultRid)) {
    throw new Error("acquireLease: vaultRid must be a 16-byte UUIDv7");
  }
  const now = args.now ?? Date.now();
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS;

  // 1. Sweep expired leases (lazy cleanup pattern).
  await sweepExpiredLeases(db, now);

  // 2. Probe current contention.
  const active = await probeActiveLeases(db, args);
  const decision = canAcquireLease({ activeLeases: active, now }, args);
  if (!decision.ok) {
    throw new Error(`acquireLease: ${decision.reason ?? "lease conflict"}`);
  }

  // 3. Insert the new lease.
  const leaseId = newUuidv7Bytes();
  const expiresAt = now + ttl;
  await db.execute({
    sql: `INSERT INTO machine_leases
 (lease_id, automator_rid, vault_rid, machine_id, acquired_at, expires_at, status)
          VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    args: [leaseId, args.automatorRid, args.vaultRid, args.machineId, now, expiresAt],
  });

  return {
    leaseId,
    automatorRid: args.automatorRid,
    vaultRid: args.vaultRid,
    machineId: args.machineId,
    acquiredAt: now,
    expiresAt,
    status: "active",
    releasedAt: null,
    releasedReason: null,
  };
}

export async function releaseLease(db: Client, args: ReleaseLeaseArgs): Promise<boolean> {
  const now = args.now ?? Date.now();
  const result = await db.execute({
    sql: `UPDATE machine_leases
          SET status = 'released', released_at = ?, released_reason = ?
          WHERE lease_id = ? AND status = 'active'`,
    args: [now, args.reason ?? "released", args.leaseId],
  });
  return Number(result.rowsAffected) > 0;
}

export async function refreshLease(db: Client, args: RefreshLeaseArgs): Promise<boolean> {
  const now = args.now ?? Date.now();
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = now + ttl;
  const result = await db.execute({
    sql: `UPDATE machine_leases SET expires_at = ?
          WHERE lease_id = ? AND status = 'active' AND expires_at >= ?`,
    args: [expiresAt, args.leaseId, now],
  });
  return Number(result.rowsAffected) > 0;
}

export async function getLeaseById(db: Client, leaseId: Uint8Array): Promise<LeaseRow | null> {
  const rows = await db.execute({
    sql: `SELECT lease_id, automator_rid, vault_rid, machine_id,
 acquired_at, expires_at, status, released_at, released_reason
          FROM machine_leases WHERE lease_id = ?`,
    args: [leaseId],
  });
  const row = rows.rows[0];
  if (row === undefined) return null;
  return rowToLease(row);
}

export async function listLeasesByVault(db: Client, vaultRid: Uint8Array): Promise<LeaseRow[]> {
  const rows = await db.execute({
    sql: `SELECT lease_id, automator_rid, vault_rid, machine_id,
 acquired_at, expires_at, status, released_at, released_reason
 FROM machine_leases WHERE vault_rid = ?
          ORDER BY acquired_at DESC`,
    args: [vaultRid],
  });
  return rows.rows.map(rowToLease);
}

// ---------------------------------------------------------------------------
// Row → typed projection. Mirrors rowToVault / rowToState boundary pattern
// (v1.A.1b cascade): bytes validated at the SQL row boundary, callers see
// typed `LeaseRow` only.
// ---------------------------------------------------------------------------

function rowToLease(row: Record<string, unknown>): LeaseRow {
  const status = row["status"] as string;
  if (status !== "active" && status !== "released" && status !== "expired") {
    throw new Error(`leases-repo: invalid status "${status}" in row`);
  }
  return {
    leaseId: toBytes(row["lease_id"]),
    automatorRid: toBytes(row["automator_rid"]),
    vaultRid: toBytes(row["vault_rid"]),
    machineId: row["machine_id"] as string,
    acquiredAt: Number(row["acquired_at"] as number | bigint),
    expiresAt: Number(row["expires_at"] as number | bigint),
    status,
    releasedAt: row["released_at"] === null ? null : Number(row["released_at"] as number | bigint),
    releasedReason: (row["released_reason"] as string | null) ?? null,
  };
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new Error(`leases-repo: expected BLOB column, got ${typeof raw}`);
}
