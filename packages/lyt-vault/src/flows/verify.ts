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

import { existsSync } from "node:fs";

import { closeRegistry, openRegistry } from "../registry/client.js";
import {
  bumpVerifyFailCount,
  listVaults,
  markVaultActive,
  markVaultMissing,
  tombstoneVault,
  updateLastVerified,
  type VaultRow,
} from "../registry/repo.js";

export const DEFAULT_TOMBSTONE_THRESHOLD = 3;
export const TOMBSTONE_THRESHOLD_ENV = "LYT_TOMBSTONE_THRESHOLD";

export interface VerifyFlowOptions {
  thresholdN?: number;
}

export interface VerifyTransition {
  rid: string;
  name: string;
  path: string;
  from: VaultRow["status"];
  to: VaultRow["status"];
  reason: "path-present" | "path-missing" | "auto-promoted" | "recovered" | "skipped-tombstoned";
}

export interface VerifyFlowResult {
  checked: number;
  active_unchanged: number;
  missing_new: number;
  recovered: number;
  tombstoned_new: number;
  skipped_tombstoned: number;
  errored: number;
  threshold: number;
  transitions: VerifyTransition[];
}

export function resolveTombstoneThreshold(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = process.env[TOMBSTONE_THRESHOLD_ENV];
  if (raw === undefined || raw === "") return DEFAULT_TOMBSTONE_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${TOMBSTONE_THRESHOLD_ENV} must be a positive integer (got '${raw}').`);
  }
  return parsed;
}

export async function verifyVaultsFlow(opts: VerifyFlowOptions = {}): Promise<VerifyFlowResult> {
  const threshold = resolveTombstoneThreshold(opts.thresholdN);
  const db = await openRegistry();
  try {
    const vaults = await listVaults(db);
    const result: VerifyFlowResult = {
      checked: 0,
      active_unchanged: 0,
      missing_new: 0,
      recovered: 0,
      tombstoned_new: 0,
      skipped_tombstoned: 0,
      errored: 0,
      threshold,
      transitions: [],
    };
    for (const v of vaults) {
      result.checked += 1;
      if (v.status === "tombstoned") {
        result.skipped_tombstoned += 1;
        result.transitions.push({
          rid: v.ridHex,
          name: v.name,
          path: v.path,
          from: "tombstoned",
          to: "tombstoned",
          reason: "skipped-tombstoned",
        });
        continue;
      }
      let exists: boolean;
      try {
        exists = existsSync(v.path);
      } catch {
        result.errored += 1;
        continue;
      }
      if (exists) {
        if (v.status === "missing") {
          await markVaultActive(db, v.rid);
          result.recovered += 1;
          result.transitions.push({
            rid: v.ridHex,
            name: v.name,
            path: v.path,
            from: "missing",
            to: "active",
            reason: "recovered",
          });
        } else if (v.status === "active") {
          await updateLastVerified(db, v.rid);
          result.active_unchanged += 1;
          result.transitions.push({
            rid: v.ridHex,
            name: v.name,
            path: v.path,
            from: "active",
            to: "active",
            reason: "path-present",
          });
        } else {
          // disconnected — leave the status alone but touch last_verified_at
          await updateLastVerified(db, v.rid);
          result.active_unchanged += 1;
          result.transitions.push({
            rid: v.ridHex,
            name: v.name,
            path: v.path,
            from: v.status,
            to: v.status,
            reason: "path-present",
          });
        }
        continue;
      }
      // path is gone
      if (v.status === "active" || v.status === "disconnected") {
        await markVaultMissing(db, v.rid);
        result.missing_new += 1;
        result.transitions.push({
          rid: v.ridHex,
          name: v.name,
          path: v.path,
          from: v.status,
          to: "missing",
          reason: "path-missing",
        });
      } else if (v.status === "missing") {
        const newCount = await bumpVerifyFailCount(db, v.rid);
        if (newCount >= threshold) {
          await tombstoneVault(db, v.rid);
          result.tombstoned_new += 1;
          result.transitions.push({
            rid: v.ridHex,
            name: v.name,
            path: v.path,
            from: "missing",
            to: "tombstoned",
            reason: "auto-promoted",
          });
        } else {
          result.transitions.push({
            rid: v.ridHex,
            name: v.name,
            path: v.path,
            from: "missing",
            to: "missing",
            reason: "path-missing",
          });
        }
      }
    }
    return result;
  } finally {
    await closeRegistry(db);
  }
}
