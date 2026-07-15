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
import type { FedMeshPushKind, FedMeshRole } from "./federation-write.js";

// Inc-2 Phase 0 — the WRITE half of the per-writer append-only
// @FED_MESH manifest store. The mesh analog of federation-vault-ledger-write.ts:
// a `mesh_rid`-keyed HLC-LWW REGISTER, shards under `<podRoot>/ledger/meshes/`.
// Same reuse-the-primitive discipline (appendLedgerRecord + stampNext + the
// @STAMP chain-hash / monthly rotation); nothing new authored.
//
// Record shape (register model — hlc/seq/state extend FedMeshRecord,
// federation-write.ts:59-67):
//   @FED_MESH
//   mesh_rid:     <uuidv7 hex>          # the REGISTER KEY (alone)
//   fed_rid:      <uuidv7 hex>          # register VALUE
//   mesh_name:    personal              # register VALUE
//   push_target:  alex                  # register VALUE
//   push_kind:    handle | org          # register VALUE
//   role:         own | join            # register VALUE
//   hlc:          <wallMs.counter>      # the MERGE KEY (LWW order)
//   seq:          <n>                   # per-writer final tiebreak
//   added_at:     <iso>                 # AUDIT ONLY — excluded from merge
//   state:        active | tombstoned   # the CRDT delete channel
//
// REGISTER KEY = `mesh_rid` ALONE; the winner per mesh_rid is the max
// `(hlc, writerId, seq)` record across all shards (foldFedMeshes).

export type FedMeshState = "active" | "tombstoned";

export interface AppendFedMeshArgs {
  // The subject mesh's UUIDv7 (hex). The REGISTER KEY (alone).
  meshRid: string;
  // ---- register VALUE fields ----
  fedRidHex: string;
  meshName: string;
  pushTarget: string;
  pushKind: FedMeshPushKind;
  role: FedMeshRole;
  state: FedMeshState;
  // The MERGE KEY — omit to stampNext this writer's monotone persisted clock.
  hlc?: Hlc;
  // The RECEIVE-RULE input (max hlc observed across all synced shards).
  observedMaxHlc?: Hlc | null;
  // The per-writer monotonic seq tiebreaker (tests only).
  seq?: number;
  // AUDIT ONLY. Defaults to now. Excluded from key/sort/merge.
  addedAt?: string;
  // Test seams.
  podRoot?: string;
  writerId?: string;
  hlcPath?: string;
}

// Directory holding every writer's mesh-manifest shard:
// `<podRoot>/ledger/meshes`.
export function getFedMeshLedgerDir(podRoot?: string): string {
  return join(podRoot ?? getFederationRoot(), "ledger", "meshes");
}

const IDENTITY_SEPARATOR = "\x00";

function assertNoIdentitySeparator(field: string, value: string): void {
  if (value.includes(IDENTITY_SEPARATOR)) {
    throw new Error(
      `@FED_MESH ${field} must not contain the NUL separator byte (\\x00) — it would corrupt the ledger record and break register-key injectivity`,
    );
  }
}

// Append one @FED_MESH record to the CURRENT writer's own shard.
export function appendFedMeshRecord(args: AppendFedMeshArgs): AppendLedgerRecordResult {
  assertNoIdentitySeparator("mesh_rid", args.meshRid);
  assertNoIdentitySeparator("mesh_name", args.meshName);
  assertNoIdentitySeparator("push_target", args.pushTarget);

  const writerId = args.writerId ?? getWriterId();
  const ledgerDir = getFedMeshLedgerDir(args.podRoot);
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
    recordType: "FED_MESH",
    fields: [
      ["mesh_rid", args.meshRid],
      ["fed_rid", args.fedRidHex],
      ["mesh_name", args.meshName],
      ["push_target", args.pushTarget],
      ["push_kind", args.pushKind],
      ["role", args.role],
      ["hlc", serializeHlc(hlc)],
      ["seq", seq],
      ["added_at", addedAt],
      ["state", args.state],
    ],
    stampSrc: "flows/federation/manifest",
    ts: addedAt,
  });
}

export function appendFedMeshActive(
  args: Omit<AppendFedMeshArgs, "state">,
): AppendLedgerRecordResult {
  return appendFedMeshRecord({ ...args, state: "active" });
}

export function appendFedMeshTombstone(
  args: Omit<AppendFedMeshArgs, "state">,
): AppendLedgerRecordResult {
  return appendFedMeshRecord({ ...args, state: "tombstoned" });
}
