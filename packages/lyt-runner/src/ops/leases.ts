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

// Real lease ops (block-B Commit 4).
//
// Per arc-thoughts §6.6:201-216 the 5-step protocol fronts every automator
// run with `std:lease.acquire@v1`. Per arc-thoughts §6.11:443-446 lyt-runner
// registers three lease ops; the underlying writes go through
// `@younndai/lyt-vault`'s leases-repo (open-once seam, v1.A.1a fold #4 —
// `db: Client` threaded in; predicate `canAcquireLease(probe, opts)`
// extracted for the protocol orchestrator to consume separately from SQL).
//
// Op args travel as strings inside the @STEP record (YON has no native
// Uint8Array type — automator authors write hex/dashed UUIDs in the source).
// The handlers convert via `hexToUuid7Bytes` at the boundary; the lyt-vault
// repo expects bytes-in / bytes-out (v1.A.1b cascade). The boundary keeps
// rid-as-bytes from leaking into YON @STEP literals.
//
// On stub (no db / no machineId-runtime mismatch), the factory returns
// structured no-op-with-warning handlers that mirror the Commit-1 scaffold.
// `createLytRunner(config)` selects real vs stub based on `config.db`
// presence; the conditional dispatch lives in `src/index.ts:createLytRunner`.

import type { ExecutionContext, OpHandler } from "@younndai/yon-runner";
import {
  acquireLease,
  refreshLease,
  releaseLease,
  hexToUuid7Bytes,
  uuid7BytesToHex,
  type LeaseRow,
} from "@younndai/lyt-vault";

import type { LytRuntime } from "../runtime.js";

export interface LeaseAcquireOpArgs {
  automator_rid: string; // hex or dashed UUIDv7
  vault_rid: string;
  ttl_ms?: number;
}

export interface LeaseAcquireOpResult {
  status: "acquired";
  lease_id: string; // hex
  expires_at: number;
  acquired_at: number;
  machine_id: string;
}

export interface LeaseReleaseOpArgs {
  lease_id: string; // hex
  reason?: string;
}

export interface LeaseRefreshOpArgs {
  lease_id: string; // hex
  ttl_ms?: number;
}

export interface LeaseOpResult {
  status: "released" | "refreshed" | "not_active";
  lease_id: string;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`lease op: missing required string arg \`${key}\``);
  }
  return v;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`lease op: arg \`${key}\` must be a finite number, got ${typeof v}`);
  }
  return v;
}

export function createLeaseOps(runtime: LytRuntime): Record<string, OpHandler> {
  return {
    "lease.acquire": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<LeaseAcquireOpResult> => {
      if (runtime.db === undefined) {
        throw new Error(
          "std:lease.acquire@v1: no libSQL client wired in LytRuntime; pass config.db to createLytRunner()",
        );
      }
      const automatorRid = hexToUuid7Bytes(requireString(args, "automator_rid"));
      const vaultRid = hexToUuid7Bytes(requireString(args, "vault_rid"));
      const ttlMs = optionalNumber(args, "ttl_ms");
      const row: LeaseRow = await acquireLease(runtime.db, {
        automatorRid,
        vaultRid,
        machineId: runtime.machineId,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        now: runtime.getNow(),
      });
      return {
        status: "acquired",
        lease_id: uuid7BytesToHex(row.leaseId),
        expires_at: row.expiresAt,
        acquired_at: row.acquiredAt,
        machine_id: row.machineId,
      };
    },
    "lease.release": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<LeaseOpResult> => {
      if (runtime.db === undefined) {
        throw new Error(
          "std:lease.release@v1: no libSQL client wired in LytRuntime; pass config.db to createLytRunner()",
        );
      }
      const leaseIdHex = requireString(args, "lease_id");
      const leaseId = hexToUuid7Bytes(leaseIdHex);
      const reasonRaw = args["reason"];
      const released = await releaseLease(runtime.db, {
        leaseId,
        ...(typeof reasonRaw === "string" ? { reason: reasonRaw } : {}),
        now: runtime.getNow(),
      });
      return {
        status: released ? "released" : "not_active",
        lease_id: leaseIdHex,
      };
    },
    "lease.refresh": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<LeaseOpResult> => {
      if (runtime.db === undefined) {
        throw new Error(
          "std:lease.refresh@v1: no libSQL client wired in LytRuntime; pass config.db to createLytRunner()",
        );
      }
      const leaseIdHex = requireString(args, "lease_id");
      const leaseId = hexToUuid7Bytes(leaseIdHex);
      const ttlMs = optionalNumber(args, "ttl_ms");
      const refreshed = await refreshLease(runtime.db, {
        leaseId,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        now: runtime.getNow(),
      });
      return {
        status: refreshed ? "refreshed" : "not_active",
        lease_id: leaseIdHex,
      };
    },
  };
}
