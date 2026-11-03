/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { canonicalizeCoordinate, vaultOriginCoordinate } from "../registry/vault-addressing.js";
import type { VaultRow } from "../registry/repo.js";
import { foldSubscriptions, observedMaxSubscriptionHlc, readAllSubscriptionRecords } from "../yon/subscription-ledger-read.js";
import { appendSubscriptionTombstone, type SubscriptionEntryMode } from "../yon/subscription-ledger-write.js";

export interface SubscriptionRetraction { coordinate: string; rid: string; entryMode: SubscriptionEntryMode }

/** Resolve and bind the currently live relationship before any mutation. */
export function planVaultSubscriptionRetraction(vault: VaultRow): SubscriptionRetraction | null {
  const raw = vaultOriginCoordinate(vault);
  if (raw === null) {
    if (vault.source !== "own") throw new Error(`Cannot retract '${vault.name}': foreign origin is missing or invalid.`);
    return null;
  }
  const coordinate = canonicalizeCoordinate(raw);
  const records = readAllSubscriptionRecords();
  if (records.some((r) => canonicalizeCoordinate(r.coordinate) === coordinate && r.hlcMalformed === true)) {
    throw new Error("Cannot retract subscription with malformed ledger history.");
  }
  const live = foldSubscriptions(records).find((s) => s.coordinate === coordinate);
  if (live === undefined) return null;
  const rid = live.rid.replace(/-/g, "").toLowerCase();
  if (rid !== vault.ridHex.toLowerCase() || (live.entryMode !== "shared" && live.entryMode !== "subscribe")) {
    throw new Error("Subscription identity or entry mode differs from the registered vault.");
  }
  return { coordinate, rid, entryMode: live.entryMode };
}

export function applyVaultSubscriptionRetraction(plan: SubscriptionRetraction | null): boolean {
  if (plan === null) return false;
  // Recheck the winner immediately before append; a changed identity is never
  // silently retracted. A previously retracted relationship is an idempotent no-op.
  const current = foldSubscriptions(readAllSubscriptionRecords()).find((s) => s.coordinate === plan.coordinate);
  if (current === undefined) return false;
  if (current.rid.replace(/-/g, "").toLowerCase() !== plan.rid || current.entryMode !== plan.entryMode) {
    throw new Error("Subscription changed while retraction was in progress.");
  }
  appendSubscriptionTombstone({ ...plan, observedMaxHlc: observedMaxSubscriptionHlc() });
  if (foldSubscriptions(readAllSubscriptionRecords()).some((s) => s.coordinate === plan.coordinate)) {
    throw new Error("Subscription tombstone was appended but its retraction is not verified.");
  }
  return true;
}
