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

// Fed-v2 Layer-1 (Phase E / E1) — the WRITE half of the per-writer
// append-only ALIAS store. The alias analog of the Phase-C subscription
// shard ledger (subscription-ledger-write.ts), mirrored precisely.
//
// The pod's pod-local aliases live as per-writer append-only YON shard logs
// under `<podRoot>/ledger/aliases/<writerId>/`. Each writer (= each machine,
// keyed by getWriterId()) only ever appends to its OWN shard dir — never
// another writer's. The shards converge across machines by git construction
// (disjoint write paths never conflict-merge); the name-keyed HLC-LWW REGISTER
// fold (alias-ledger-read.ts foldAliases) reconciles the union into the live
// alias set.
//
// An alias event is a single `@ALIAS` record appended via the generic ledger
// writer (ledger-write.ts appendLedgerRecord) — REUSED, not re-implemented.
// The writer owns the file layout (current `<name>.yon` + monthly
// `<name>/YYYY-MM.yon` archives, atomic tmp+rename, chain-hash @STAMP); here
// the "ledger name" IS the writerId, so a writer's whole shard is its own
// monthly-rotated log.
//
// Record shape (Slice 1a — REGISTER model):
//   @ALIAS
//   name:        ro                                  # the REGISTER KEY (alone)
//   target_rid:  <uuidv7 of aliased vault>           # the register VALUE
//   kind:        vault                               # open enum (string)
//   hlc:         <wallMs.counter>                    # the MERGE KEY (LWW order)
//   created_at:  <iso>                               # AUDIT ONLY — excluded
//                                                    #   from key/sort/merge
//   state:       active | tombstoned
//
// REGISTER KEY = `name` ALONE; `target_rid` is the register VALUE. The winner
// per name across all shards is the record with the max `(hlc, writerId)` (the
// alias-ledger-read fold's total order). `created_at` stays audit-only.
//
// Slice-1a amendment to the Phase-0 "timestamp audit-only" lock — FOR ALIASES
// ONLY: the alias rail is no longer an OR-Set (whose merge authority is per-shard
// APPEND ORDER); it is an HLC-ordered LWW register, and a register's clock IS its
// merge key. So the `hlc` field — UNLIKE `created_at` — is load-bearing for merge.
// The persisted-per-writer HLC (util/hlc.ts) is monotone across restarts and
// against wall-clock skew, which is exactly why a wall-clock `created_at` could
// NOT serve as the register's merge order.

// `kind` is an OPEN enum — `'vault'` is the only kind today, but the field is
// kept a free string so future kinds (mesh, pod, ...) don't require a schema
// migration. Do not hard-restrict.
export type AliasKind = string;
export type AliasState = "active" | "tombstoned";

export interface AppendAliasArgs {
  // The pod-local alias name (e.g. `ro`). The REGISTER KEY (alone). Re-pointing
  // `name` at a different rid is a NEW active for the SAME key — a newer-hlc
  // active supersedes the older (LWW), it is not a distinct binding.
  name: string;
  // The aliased vault's UUIDv7 (hex). The register VALUE carried by the winning
  // record — NOT part of the merge key.
  targetRid: string;
  // Open enum — `'vault'` today. Informational; NOT part of the key/merge.
  kind: AliasKind;
  state: AliasState;
  // The MERGE KEY — the HLC ordering this record in the LWW register. When
  // omitted, stampNext(writerId) advances + persists this writer's monotone
  // clock (the default production path). Supplied explicitly only by tests that
  // need a pinned/controlled clock.
  hlc?: Hlc;
  // The RECEIVE-RULE input — the max hlc this writer has OBSERVED across ALL
  // synced shards (its own + every foreign writer's), computed by the flow and
  // threaded down so stampNext seeds the new stamp above everything observed (a
  // lagging-clock machine must not stamp BELOW a remote it already saw). Ignored
  // when an explicit `hlc` is pinned (tests). Null/omitted → pure local clock.
  observedMaxHlc?: Hlc | null;
  // The per-writer monotonic seq tiebreaker (the final never-collide order
  // component). Supplied explicitly only by tests that pin a clock AND want a
  // controlled seq; otherwise stampNext mints + persists it under the lock.
  seq?: number;
  // AUDIT ONLY. Defaults to now. The fold IGNORES this for the register key,
  // sort, and merge (the `hlc` field is the merge authority now).
  createdAt?: string;
  // Test seam — override the pod root (defaults to getFederationRoot()).
  podRoot?: string;
  // Test seam — override the writer id (defaults to getWriterId()).
  writerId?: string;
  // Test seam — override the per-writer HLC clock-file path (defaults to
  // getHlcPath()). Lets a test isolate the persisted high-water mark.
  hlcPath?: string;
}

// Directory holding every writer's alias shard: `<podRoot>/ledger/aliases`.
// Each writer's shard is the ledger named `<writerId>` rooted here (current
// file + monthly archive subdir).
export function getAliasesLedgerDir(podRoot?: string): string {
  return join(podRoot ?? getFederationRoot(), "ledger", "aliases");
}

// The composite identity key (alias-ledger-read.ts identityKey) joins
// `name` + `target_rid` with the NUL byte `\x00` as separator. That join is
// injective ONLY if the separator never appears INSIDE either part — otherwise
// two distinct (name, target_rid) pairs collide to one key, silently merging
// aliases / crossing tombstones. `name` is a free handler-supplied string and
// nothing upstream rejects NUL (validateAliasName only rejects whitespace, and
// is not on this rail), so the write boundary MUST enforce the precondition
// fail-closed: a colliding record can never be persisted. Scoped exactly to the
// separator byte — broader name/charset/length validation is a flows-layer
// concern, deliberately NOT here.
const IDENTITY_SEPARATOR = "\x00";

function assertNoIdentitySeparator(field: string, value: string): void {
  if (value.includes(IDENTITY_SEPARATOR)) {
    throw new Error(
      `alias ${field} must not contain the NUL separator byte (\\x00) — it is the alias identity-key separator and would break key injectivity`,
    );
  }
}

// Append one @ALIAS record to the CURRENT writer's own shard. Returns the
// underlying ledger append result (ts + chain-hash + initialised flag).
export function appendAliasRecord(args: AppendAliasArgs): AppendLedgerRecordResult {
  // Fail-closed injectivity guard — BEFORE any write. Reject a name/target_rid
  // carrying the NUL identity-key separator, so a colliding record can never be
  // persisted (the read-path identityKey comment's claimed precondition is
  // enforced HERE, on the authoritative write path).
  assertNoIdentitySeparator("name", args.name);
  assertNoIdentitySeparator("target_rid", args.targetRid);

  const writerId = args.writerId ?? getWriterId();
  const ledgerDir = getAliasesLedgerDir(args.podRoot);
  const ledgerPath = join(ledgerDir, `${writerId}.yon`);
  const createdAt = args.createdAt ?? new Date().toISOString();
  // The MERGE KEY + the final seq tiebreaker. Stamp this writer's monotone,
  // persisted HLC unless the caller pinned one (tests). stampNext applies the
  // RECEIVE RULE (seed = MAX(local HWM, observedMaxHlc)) under a cross-process
  // lock and mints a per-writer monotonic seq — so the emitted (hlc, seq) is
  // monotone across restarts, wall-clock skew, observed remotes, AND concurrent
  // same-machine processes.
  let hlc: Hlc;
  let seq: number;
  if (args.hlc !== undefined) {
    // Pinned clock (tests): honour an explicit seq if given, else default 0.
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
    recordType: "ALIAS",
    fields: [
      ["name", args.name],
      ["target_rid", args.targetRid],
      ["kind", args.kind],
      ["hlc", serializeHlc(hlc)],
      ["seq", seq],
      ["created_at", createdAt],
      ["state", args.state],
    ],
    stampSrc: "flows/alias",
    // The @STAMP ts is the record's audit ts too; keep them aligned so a
    // hand-reader sees one timestamp for the event.
    ts: createdAt,
  });
}

// Convenience for the alias path: append an `active` record.
export function appendAliasActive(
  args: Omit<AppendAliasArgs, "state">,
): AppendLedgerRecordResult {
  return appendAliasRecord({ ...args, state: "active" });
}

// Convenience for the unalias path: append a `tombstoned` record to the
// CURRENT writer's OWN shard (never mutate another shard). In the HLC-LWW
// register fold, this tombstone RETRACTS `name` iff its `(hlc, writerId)` is the
// greatest across ALL shards — so a newer-hlc tombstone supersedes ANY active,
// INCLUDING a FOREIGN writer's active (the cross-machine REMOVE the OR-Set could
// not express); and it is itself superseded by any later-hlc `active` (re-add).
export function appendAliasTombstone(
  args: Omit<AppendAliasArgs, "state">,
): AppendLedgerRecordResult {
  return appendAliasRecord({ ...args, state: "tombstoned" });
}
