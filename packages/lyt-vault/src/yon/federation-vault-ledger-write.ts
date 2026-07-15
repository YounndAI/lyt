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
import type { FederationVisibility, FedVaultStatus } from "./federation-write.js";

// Inc-2 Phase 0 — the WRITE half of the per-writer append-only
// @FED_VAULT manifest store. The 4th instance of the repo's generic ledger
// primitive, mirroring the @ALIAS HLC-LWW REGISTER (alias-ledger-write.ts)
// precisely — the vault manifest is a record of MUTABLE fields keyed on a stable
// identity plus a delete, which is exactly the register shape (NOT the OR-Set
// the subscription/mesh-edge rails use: an OR-Set has no "update a field" op and
// its delete loses to a concurrent foreign add).
//
// The pod's vault manifest lives as per-writer append-only YON shard logs under
// `<podRoot>/ledger/vaults/<writerId>.yon` (+ monthly `<writerId>/YYYY-MM.yon`
// archives, owned by the generic writer). Each writer (= each machine, keyed by
// getWriterId()) only ever appends to its OWN shard — never another writer's.
// The shards converge across machines by git construction (disjoint write paths
// never conflict-merge — dissolves M-1, the merge-conflict-in-SoT); the
// vault_rid-keyed HLC-LWW REGISTER fold (federation-vault-ledger-read.ts
// foldFedVaults) reconciles the union into the live vault set.
//
// A manifest event is a single `@FED_VAULT` record appended via the generic
// ledger writer (ledger-write.ts appendLedgerRecord) — REUSED, not
// re-implemented. The writer owns the file layout (atomic tmp+rename, chain-hash
// @STAMP, monthly rotation); here the "ledger name" IS the writerId, so a
// writer's whole shard is its own monthly-rotated log.
//
// Record shape (register model — the 3 NEW merge fields hlc/seq/state extend the
// existing FedVaultRecord struct, federation-write.ts:75-91):
//   @FED_VAULT
//   vault_rid:      <uuidv7 hex>                    # the REGISTER KEY (alone)
//   vault_name:     personal/main                   # register VALUE
//   home_mesh_rid:  mesh:<uuidv7> | mesh:none       # register VALUE
//   repo:           lyt-vault-<mesh>--<leaf>        # register VALUE
//   visibility:     private | public                # register VALUE
//   status:         active|disconnected|missing|access_lost   # register VALUE (reachability)
//   hlc:            <wallMs.counter>                 # the MERGE KEY (LWW order)
//   seq:            <n>                              # per-writer final tiebreak
//   registered_at:  <iso>                            # AUDIT ONLY — excluded
//                                                    #   from key/sort/merge
//   state:          active | tombstoned              # the CRDT delete channel
//
// REGISTER KEY = `vault_rid` ALONE; every other field is the register VALUE the
// winning record carries. The winner per vault_rid across all shards is the
// record with the max `(hlc, writerId, seq)` total order (util/hlc
// compareHlcStamped). An `active` winner → the vault is live; a `tombstoned`
// winner → the vault is retracted (the C-1 cross-machine delete channel: a
// newer-hlc tombstone beats a FOREIGN writer's active, which the OR-Set could
// not express). Like the alias rail, the `hlc` field — UNLIKE `registered_at` —
// is LOAD-BEARING for merge (a register's clock IS its merge key), and the
// persisted-per-writer HLC (util/hlc.ts) is monotone across restarts + wall-clock
// skew, which is why a wall-clock `registered_at` could NOT serve as merge order.

export type FedVaultState = "active" | "tombstoned";

export interface AppendFedVaultArgs {
  // The subject vault's UUIDv7 (hex). The REGISTER KEY (alone). Re-pointing any
  // VALUE field (name/home_mesh/repo/visibility/status) is a NEW active for the
  // SAME key — a newer-hlc active supersedes the older (LWW).
  vaultRid: string;
  // ---- register VALUE fields (carried by the winning record) ----
  vaultName: string;
  homeMeshRidHex: string | null; // null → orphan (rendered `mesh:none`)
  repo: string;
  visibility: FederationVisibility;
  status: FedVaultStatus;
  state: FedVaultState;
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
  // The per-writer monotonic seq tiebreaker. Supplied explicitly only by tests
  // that pin a clock AND want a controlled seq; otherwise stampNext mints it.
  seq?: number;
  // AUDIT ONLY. Defaults to now. The fold IGNORES this for the register key,
  // sort, and merge (the `hlc` field is the merge authority now).
  registeredAt?: string;
  // Test seam — override the pod root (defaults to getFederationRoot()).
  podRoot?: string;
  // Test seam — override the writer id (defaults to getWriterId()).
  writerId?: string;
  // Test seam — override the per-writer HLC clock-file path (defaults to
  // getHlcPath()). Lets a test isolate the persisted high-water mark.
  hlcPath?: string;
}

// Directory holding every writer's vault-manifest shard:
// `<podRoot>/ledger/vaults`. Each writer's shard is the ledger named
// `<writerId>` rooted here (current file + monthly archive subdir).
export function getFedVaultLedgerDir(podRoot?: string): string {
  return join(podRoot ?? getFederationRoot(), "ledger", "vaults");
}

// The register key is `vault_rid` ALONE, so the fold groups by that single
// field — no composite join, no separator. But the VALUE strings are emitted
// into the pipe-delimited YON record, and a NUL byte inside any of them would
// corrupt the ledger line the same way it would break an alias identity key.
// Fail-closed at the write boundary (alias-ledger parity,
// alias-ledger-write.ts:126-134): a record carrying the NUL separator byte can
// never be persisted.
const IDENTITY_SEPARATOR = "\x00";

function assertNoIdentitySeparator(field: string, value: string): void {
  if (value.includes(IDENTITY_SEPARATOR)) {
    throw new Error(
      `@FED_VAULT ${field} must not contain the NUL separator byte (\\x00) — it would corrupt the ledger record and break register-key injectivity`,
    );
  }
}

// Append one @FED_VAULT record to the CURRENT writer's own shard. Returns the
// underlying ledger append result (ts + chain-hash + initialised flag).
export function appendFedVaultRecord(args: AppendFedVaultArgs): AppendLedgerRecordResult {
  // Fail-closed injectivity/corruption guard — BEFORE any write.
  assertNoIdentitySeparator("vault_rid", args.vaultRid);
  assertNoIdentitySeparator("vault_name", args.vaultName);
  assertNoIdentitySeparator("repo", args.repo);
  if (args.homeMeshRidHex !== null) {
    assertNoIdentitySeparator("home_mesh_rid", args.homeMeshRidHex);
  }

  const writerId = args.writerId ?? getWriterId();
  const ledgerDir = getFedVaultLedgerDir(args.podRoot);
  const ledgerPath = join(ledgerDir, `${writerId}.yon`);
  const registeredAt = args.registeredAt ?? new Date().toISOString();
  // The MERGE KEY + the final seq tiebreaker. Stamp this writer's monotone,
  // persisted HLC unless the caller pinned one (tests). stampNext applies the
  // RECEIVE RULE (seed = MAX(local HWM, observedMaxHlc)) under a cross-process
  // lock and mints a per-writer monotonic seq.
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
  // home_mesh_rid encodes an orphan (no mesh) as the sentinel `none`, matching
  // the pod.yon renderer's `mesh:none` convention so the fold round-trips it
  // without a sentinel-vs-missing ambiguity.
  const homeMeshField = args.homeMeshRidHex ?? "none";
  return appendLedgerRecord({
    ledgerPath,
    ledgerName: writerId,
    recordType: "FED_VAULT",
    fields: [
      ["vault_rid", args.vaultRid],
      ["vault_name", args.vaultName],
      ["home_mesh_rid", homeMeshField],
      ["repo", args.repo],
      ["visibility", args.visibility],
      ["status", args.status],
      ["hlc", serializeHlc(hlc)],
      ["seq", seq],
      ["registered_at", registeredAt],
      ["state", args.state],
    ],
    stampSrc: "flows/federation/manifest",
    ts: registeredAt,
  });
}

// Convenience: append an `active` register record (a vault appear / re-point /
// field update).
export function appendFedVaultActive(
  args: Omit<AppendFedVaultArgs, "state">,
): AppendLedgerRecordResult {
  return appendFedVaultRecord({ ...args, state: "active" });
}

// Convenience: append a `tombstoned` register record (a vault delete/forget) to
// the CURRENT writer's OWN shard (never mutate another shard). In the HLC-LWW
// register fold this tombstone RETRACTS `vault_rid` iff its `(hlc, writerId, seq)`
// is the greatest across ALL shards — so a newer-hlc tombstone supersedes ANY
// active, INCLUDING a FOREIGN writer's active (the cross-machine REMOVE the
// OR-Set could not express); and it is itself superseded by any later-hlc
// `active` (re-add).
export function appendFedVaultTombstone(
  args: Omit<AppendFedVaultArgs, "state">,
): AppendLedgerRecordResult {
  return appendFedVaultRecord({ ...args, state: "tombstoned" });
}
