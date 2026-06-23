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
// FOLD (OR-Set, add-wins): the convergence function over the union of all
// shards. A vault-subscription (keyed by `coordinate`) is LIVE iff some shard
// has an `active` record for it that is not superseded by a tombstone —
// ADD-WINS: a fresh `active` record in ANY shard beats a stale `tombstoned`
// one. Resolution is by per-shard append order, NEVER by `added_at` (audit
// only). Deterministic output: sorted by `coordinate`.
//
// Why add-wins across shards reduces to "any shard ends active": within one
// shard, the LAST record for a coordinate is that shard's verdict (append
// order = causal order for a single writer). Across shards there is no global
// order — `added_at` is audit-only and forbidden as a merge key — so the only
// monotone, deterministic, conflict-free rule is the lattice join: a
// coordinate is live iff ANY shard's final verdict is `active`. A tombstone
// only "wins" when EVERY shard's final verdict is `tombstoned` (nobody
// re-added). That is exactly OR-Set add-wins.

export interface SubscriptionRecord {
  coordinate: string;
  rid: string;
  entryMode: string;
  addedAt: string;
  state: SubscriptionState;
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
  return {
    coordinate,
    rid: rec.fields.get("rid") ?? "",
    entryMode: rec.fields.get("entry_mode") ?? "subscribe",
    addedAt: rec.fields.get("added_at") ?? "",
    state,
    writerId,
  };
}

// The OR-Set add-wins fold. Consolidates all shards → the deterministic live
// subscription set, sorted by coordinate.
//
// Algorithm:
//  1. Per shard, in APPEND order, take the LAST record per coordinate as that
//     shard's verdict (append order = causal order for one writer).
//  2. Across shards, a coordinate is LIVE iff ANY shard's verdict is `active`
//     (add-wins lattice join). `added_at` is never consulted.
//  3. Output sorted by coordinate ASC for determinism.
export function foldSubscriptions(records: readonly SubscriptionRecord[]): LiveSubscription[] {
  // deferred-E — IDENTITY is keyed on the CANONICAL coordinate, never the RAW
  // string. Two writers (or one writer across machines) can subscribe the SAME
  // upstream vault via DIFFERENT coordinate spellings (case-different host, or a
  // known-forge owner/repo case variant). Folding on the raw string would treat
  // those as DISTINCT coordinates and emit TWO live subscriptions for one vault;
  // keying on `canonicalizeCoordinate(...)` collapses them to ONE — the
  // convergence-correct identity. canonicalizeCoordinate is idempotent and
  // passes non-forge coordinates through unchanged, so already-canonical inputs
  // are unaffected. Every map below (per-shard verdict, cross-shard live,
  // tombstonedOnly) keys on this canonical form so add-wins/tombstone semantics
  // operate on identity, not spelling.

  // shard verdict: canonical coordinate -> last record seen for it within that shard.
  const perShard = new Map<string, Map<string, SubscriptionRecord>>();
  for (const rec of records) {
    let shard = perShard.get(rec.writerId);
    if (shard === undefined) {
      shard = new Map<string, SubscriptionRecord>();
      perShard.set(rec.writerId, shard);
    }
    // Records arrive in append order within a writerId (readAllSubscriptionRecords
    // walks each shard contiguously), so a later set() overwrites the earlier
    // verdict — last-write-wins within the shard. Key on the canonical
    // coordinate so two spellings within one shard collapse to one verdict.
    shard.set(canonicalizeCoordinate(rec.coordinate), rec);
  }

  // add-wins join across shards: live iff any shard's verdict is active. Keep
  // the winning active record (any active verdict) for its informational
  // rid/entry_mode.
  //
  // TIE-BREAK = min(writerId) on the read path: `perShard` is populated in the
  // order records arrive, and the on-disk read path (readAllSubscriptionRecords
  // → listSubscriptionShards sorts writerIds ASC) feeds them in sorted-writerId
  // order — so iteration here is sorted-writerId order. The `!live.has`
  // first-active-wins guard therefore resolves a tie (two writers naming the
  // SAME coordinate with DIFFERENT informational fields, e.g. entry_mode
  // subscribe vs shared) to the LOWEST writerId deterministically. The
  // coordinate's LIVENESS is unaffected (add-wins); only the informational
  // rid/entry_mode carried forward is the lowest-writerId shard's. (As a pure
  // function, the fold resolves by INPUT order; the sort lives in the read
  // path.) Pinned by the "entry_mode tie → min(writerId)" unit test.
  const live = new Map<string, LiveSubscription>();
  const tombstonedOnly = new Set<string>();
  for (const shard of perShard.values()) {
    for (const rec of shard.values()) {
      // Re-canonicalize the record's coordinate as the cross-shard key. The
      // emitted `LiveSubscription.coordinate` is the CANONICAL form — it is the
      // convergence value, so callers (incl. the subscribe-flow idempotence
      // check) compare against the same canonical key the fold deduped on.
      const key = canonicalizeCoordinate(rec.coordinate);
      if (rec.state === "active") {
        if (!live.has(key)) {
          live.set(key, {
            coordinate: key,
            rid: rec.rid,
            entryMode: rec.entryMode,
          });
        }
      } else {
        tombstonedOnly.add(key);
      }
    }
  }
  // A coordinate that is active in any shard is live regardless of tombstones
  // elsewhere (add-wins). tombstonedOnly is informational; the live map is the
  // authority. Output sorted by coordinate ASC.
  void tombstonedOnly;
  return [...live.values()].sort((a, b) => (a.coordinate < b.coordinate ? -1 : a.coordinate > b.coordinate ? 1 : 0));
}

// Convenience: read + fold in one call.
export function liveSubscriptions(podRoot?: string): LiveSubscription[] {
  return foldSubscriptions(readAllSubscriptionRecords(podRoot));
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
