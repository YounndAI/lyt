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

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { canonicalizeCoordinate } from "../registry/vault-addressing.js";
import { type Hlc, compareHlc, compareHlcStamped, parseHlc } from "../util/hlc.js";
import { walkLedger, type LedgerRecord } from "./ledger-read.js";
import {
  getSubscriptionsLedgerDir,
  type SubscriptionEntryMode,
  type SubscriptionState,
} from "./subscription-ledger-write.js";

// Fed-v2 Layer-1 (Phase C) — the READ + FOLD half of the per-writer
// append-only subscription store.
//
// READ: enumerate every writer shard under `<podRoot>/ledger/subscriptions/`
// and walk each shard with walkLedger (REUSED — the same monthly-segment +
// current-file model the audit/provenance ledgers use). A shard is the set of
// files for one writerId: `<writerId>/YYYY-MM.yon` archives + `<writerId>.yon`
// current. walkLedger returns each shard's records in APPEND ORDER, which is
// the merge authority for that shard.
//
// FOLD: legacy rows reproduce the exact pre-0.20.16 add-wins verdict as a
// synthetic floor. HLC-bearing rows then resolve one coordinate-keyed LWW
// register by (hlc, writerId, seq). `added_at` remains audit-only.

export interface SubscriptionRecord {
  coordinate: string;
  rid: string;
  entryMode: string;
  addedAt: string;
  state: SubscriptionState;
  /** Null for legacy pre-0.20.16 rows. */
  hlc: Hlc | null;
  /** True only when an HLC field was present but malformed; never a legacy floor event. */
  hlcMalformed?: boolean;
  seq: number;
  // The shard (writerId) the record came from. Useful for provenance + tests.
  writerId: string;
}

export interface LiveSubscription {
  coordinate: string;
  // The rid + entry_mode carried by the winning `active` record (the
  // shard-final active record that made this coordinate live). Informational.
  rid: string;
  entryMode: SubscriptionEntryMode | string;
}

// Enumerate the writerId shard names present under the subscriptions ledger
// dir. A shard manifests as either a current file `<writerId>.yon` OR an
// archive subdir `<writerId>/`. We collect the union of both so a writer whose
// current file rotated into archives (leaving only the subdir) is still found.
export function listSubscriptionShards(podRoot?: string): string[] {
  const dir = getSubscriptionsLedgerDir(podRoot);
  if (!existsSync(dir) || !safeIsDir(dir)) return [];
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (safeIsDir(full)) {
      // archive subdir `<writerId>/`
      names.add(entry);
    } else if (entry.endsWith(".yon")) {
      // current file `<writerId>.yon`
      names.add(entry.replace(/\.yon$/, ""));
    }
  }
  return [...names].sort();
}

// Read every @SUBSCRIPTION record across all shards, in (shard-sorted,
// per-shard append) order. Non-@SUBSCRIPTION records (should not occur in a
// subscription shard, but the walker is vocabulary-agnostic) are ignored.
export function readAllSubscriptionRecords(podRoot?: string): SubscriptionRecord[] {
  const dir = getSubscriptionsLedgerDir(podRoot);
  const out: SubscriptionRecord[] = [];
  for (const writerId of listSubscriptionShards(podRoot)) {
    const records = walkLedger(dir, writerId);
    for (const rec of records) {
      const parsed = toSubscriptionRecord(rec, writerId);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

function toSubscriptionRecord(rec: LedgerRecord, writerId: string): SubscriptionRecord | null {
  if (rec.recordType !== "SUBSCRIPTION") return null;
  const coordinate = rec.fields.get("coordinate");
  if (coordinate === undefined || coordinate.length === 0) return null;
  const stateRaw = rec.fields.get("state");
  const state: SubscriptionState = stateRaw === "tombstoned" ? "tombstoned" : "active";
  const rawHlc = rec.fields.get("hlc");
  const hlc = rawHlc === undefined ? null : parseHlc(rawHlc);
  return {
    coordinate,
    rid: rec.fields.get("rid") ?? "",
    entryMode: rec.fields.get("entry_mode") ?? "subscribe",
    addedAt: rec.fields.get("added_at") ?? "",
    state,
    hlc,
    hlcMalformed: rawHlc !== undefined && hlc === null,
    seq: parseSeq(rec.fields.get("seq")),
    writerId,
  };
}

// Migration-safe HLC-LWW desired-state fold. Legacy rows first reproduce the
// exact 0.20.15 add-wins verdict as a synthetic floor. HLC-bearing 0.20.16+
// events then form one coordinate-keyed LWW register above that floor.
export function foldSubscriptions(records: readonly SubscriptionRecord[]): LiveSubscription[] {
  const legacyPerShard = new Map<string, Map<string, SubscriptionRecord>>();
  const modernWinner = new Map<string, SubscriptionRecord>();
  for (const rec of records) {
    const key = canonicalizeCoordinate(rec.coordinate);
    // A malformed 0.20.16+ event is corrupt modern data, not legacy history.
    // Ignore it fail-closed so an invalid active cannot be laundered into the
    // synthetic add-wins floor and resurrect a subscription.
    if (rec.hlcMalformed === true) continue;
    if (rec.hlc !== null) {
      const current = modernWinner.get(key);
      if (current === undefined || compareModern(rec, current) > 0) modernWinner.set(key, rec);
      continue;
    }
    let shard = legacyPerShard.get(rec.writerId);
    if (shard === undefined) {
      shard = new Map<string, SubscriptionRecord>();
      legacyPerShard.set(rec.writerId, shard);
    }
    shard.set(key, rec);
  }

  // Reproduce the old cross-shard add-wins verdict exactly. Sorting writer IDs
  // preserves its deterministic informational winner independently of input order.
  const legacyActive = new Map<string, SubscriptionRecord>();
  for (const writerId of [...legacyPerShard.keys()].sort()) {
    const shard = legacyPerShard.get(writerId)!;
    for (const rec of shard.values()) {
      const key = canonicalizeCoordinate(rec.coordinate);
      if (rec.state === "active" && !legacyActive.has(key)) legacyActive.set(key, rec);
    }
  }

  const keys = new Set([...legacyActive.keys(), ...modernWinner.keys()]);
  const live: LiveSubscription[] = [];
  for (const key of [...keys].sort()) {
    const winner = modernWinner.get(key) ?? legacyActive.get(key);
    if (winner === undefined || winner.state !== "active") continue;
    live.push({ coordinate: key, rid: winner.rid, entryMode: winner.entryMode });
  }
  return live;
}

// Convenience: read + fold in one call.
export function liveSubscriptions(podRoot?: string): LiveSubscription[] {
  return foldSubscriptions(readAllSubscriptionRecords(podRoot));
}

export function observedMaxSubscriptionHlc(podRoot?: string): Hlc | null {
  let max: Hlc | null = null;
  for (const record of readAllSubscriptionRecords(podRoot)) {
    if (record.hlc === null) continue;
    if (max === null || compareHlc(record.hlc, max) > 0) max = record.hlc;
  }
  return max;
}

function compareModern(a: SubscriptionRecord, b: SubscriptionRecord): number {
  if (a.hlc === null || b.hlc === null) throw new Error("modern subscription comparison requires HLC rows");
  return compareHlcStamped(
    { hlc: a.hlc, writerId: a.writerId, seq: a.seq },
    { hlc: b.hlc, writerId: b.writerId, seq: b.seq },
  );
}

function parseSeq(raw: string | undefined): number {
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
