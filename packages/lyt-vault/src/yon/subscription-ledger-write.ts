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

import { join } from "node:path";

import { getFederationRoot } from "../util/federation-paths.js";
import { getWriterId } from "../util/writer-id.js";
import { type Hlc, serializeHlc, stampNext } from "../util/hlc.js";
import { appendLedgerRecord, type AppendLedgerRecordResult } from "./ledger-write.js";

// Fed-v2 Layer-1 (Phase C) — the WRITE half of the per-writer append-only
// subscription store.
//
// The pod's federation subscriptions live as per-writer append-only YON shard
// logs under `<podRoot>/ledger/subscriptions/<writerId>/`. Each writer (= each
// machine, keyed by getWriterId()) only ever appends to its OWN shard dir —
// never another writer's. The shards converge across machines by git
// construction (disjoint write paths never conflict-merge); the migration-safe
// HLC-LWW fold (subscription-ledger-read.ts foldSubscriptions) reconciles the
// locally present union into the live subscription set.
//
// A subscription event is a single `@SUBSCRIPTION` record appended via the
// generic ledger writer (ledger-write.ts appendLedgerRecord) — REUSED, not
// re-implemented. The writer owns the file layout (current `<name>.yon` +
// monthly `<name>/YYYY-MM.yon` archives, atomic tmp+rename, chain-hash @STAMP);
// here the "ledger name" IS the writerId, so a writer's whole shard is its own
// monthly-rotated log.
//
// Record shape (locked, Phase C brief §"Record shape"):
//   @SUBSCRIPTION
//   coordinate: lyt:vault:github.com/owner/repo   # identity + dedup key
//   rid:        <uuidv7 of subscribed vault>       # informational
//   entry_mode: subscribe | shared
//   added_at:   <iso>                              # AUDIT ONLY — excluded
//                                                  #   from identity/sort/merge
//   state:      active | tombstoned

export type SubscriptionEntryMode = "subscribe" | "shared";
export type SubscriptionState = "active" | "tombstoned";

export interface AppendSubscriptionArgs {
  // The dedup/identity key — the subscribed vault's cross-pod origin
  // coordinate (`lyt:vault:<host>/<owner>/<repo>`). REQUIRED; the subscribe
  // flow fails closed when it cannot resolve a coordinate, so a record is
  // never written without one.
  coordinate: string;
  // Informational — the self-asserted UUIDv7 of the subscribed vault. NOT the
  // identity key (a forged rid does not collide a distinct coordinate).
  rid: string;
  entryMode: SubscriptionEntryMode;
  state: SubscriptionState;
  /** 0.20.16+ merge key; tests may pin it, production advances the persisted clock. */
  hlc?: Hlc;
  /** Greatest HLC already observed across every locally present shard. */
  observedMaxHlc?: Hlc | null;
  seq?: number;
  // AUDIT ONLY. Defaults to now. The fold IGNORES this for identity, sort, and
  // merge resolution. Legacy rows alone retain their historical add-wins fold.
  addedAt?: string;
  // Test seam — override the pod root (defaults to getFederationRoot()).
  podRoot?: string;
  // Test seam — override the writer id (defaults to getWriterId()).
  writerId?: string;
  // Test seam for the persisted HLC clock.
  hlcPath?: string;
}

// Directory holding every writer's subscription shard:
// `<podRoot>/ledger/subscriptions`. Each writer's shard is the ledger named
// `<writerId>` rooted here (current file + monthly archive subdir).
export function getSubscriptionsLedgerDir(podRoot?: string): string {
  return join(podRoot ?? getFederationRoot(), "ledger", "subscriptions");
}

// Append one @SUBSCRIPTION record to the CURRENT writer's own shard. Returns
// the underlying ledger append result (ts + chain-hash + initialised flag).
export function appendSubscriptionRecord(
  args: AppendSubscriptionArgs,
): AppendLedgerRecordResult {
  const writerId = args.writerId ?? getWriterId();
  const ledgerDir = getSubscriptionsLedgerDir(args.podRoot);
  const ledgerPath = join(ledgerDir, `${writerId}.yon`);
  const addedAt = args.addedAt ?? new Date().toISOString();
  let hlc: Hlc;
  let seq: number;
  if (args.hlc !== undefined) {
    hlc = args.hlc;
    seq = args.seq ?? 0;
  } else {
    const stamped = stampNext(writerId, {
      observedMaxHlc: args.observedMaxHlc ?? null,
      path: args.hlcPath,
    });
    hlc = stamped.hlc;
    seq = stamped.seq;
  }
  return appendLedgerRecord({
    ledgerPath,
    ledgerName: writerId,
    recordType: "SUBSCRIPTION",
    fields: [
      ["coordinate", args.coordinate],
      ["rid", args.rid],
      ["entry_mode", args.entryMode],
      ["hlc", serializeHlc(hlc)],
      ["seq", seq],
      ["added_at", addedAt],
      ["state", args.state],
    ],
    stampSrc: "flows/subscribe",
    // The @STAMP ts is the record's audit ts too; keep them aligned so a
    // hand-reader sees one timestamp for the event.
    ts: addedAt,
  });
}

// Convenience for the subscribe path: append an `active` record.
export function appendSubscriptionActive(
  args: Omit<AppendSubscriptionArgs, "state">,
): AppendLedgerRecordResult {
  return appendSubscriptionRecord({ ...args, state: "active" });
}

// Convenience for the unsubscribe path: append a `tombstoned` record to the
// CURRENT writer's OWN shard (never mutate another shard). A newer HLC
// tombstone dominates every observed stale active shard; a later intentional
// active re-subscribe wins with a newer HLC.
export function appendSubscriptionTombstone(
  args: Omit<AppendSubscriptionArgs, "state">,
): AppendLedgerRecordResult {
  return appendSubscriptionRecord({ ...args, state: "tombstoned" });
}
