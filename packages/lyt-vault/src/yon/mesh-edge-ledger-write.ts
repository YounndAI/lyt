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
import { appendLedgerRecord, type AppendLedgerRecordResult } from "./ledger-write.js";

// Slice 2a — the WRITE half of the per-writer append-only MESH-EDGE store.
//
// The mesh-edge analog of the Phase-C subscription shard ledger
// (subscription-ledger-write.ts), mirrored precisely — an OR-Set, NOT the
// alias HLC-LWW register. mesh.yon is no longer the @MESH_EDGE SoT; the
// per-writer ledger shards under `<podRoot>/ledger/mesh-edges/<writerId>/` are,
// reconstituted into the `mesh_edges` cache by rebuildFederationCacheFlow.
//
// Each writer (= each machine, keyed by getWriterId()) only ever appends to its
// OWN shard — never another writer's. The shards converge across machines by
// git construction (disjoint write paths never conflict-merge); the OR-Set
// add-wins fold (mesh-edge-ledger-read.ts foldMeshEdges) reconciles the union
// into the live edge set.
//
// A mesh-edge event is a single `@MESH_EDGE` record appended via the generic
// ledger writer (ledger-write.ts appendLedgerRecord) — REUSED, not
// re-implemented. The writer owns the file layout (current `<name>.yon` +
// monthly `<name>/YYYY-MM.yon` archives, atomic tmp+rename, chain-hash @STAMP);
// here the "ledger name" IS the writerId, so a writer's whole shard is its own
// monthly-rotated log.
//
// Record shape (locked, design §"Unit 2a"; FU-1 2-tuple narrowing):
//   @MESH_EDGE
//   ref_vault_rid:  <uuidv7 dashed>   # identity (1/2)
//   home_vault_rid: <uuidv7 dashed>   # identity (2/2)
//   ref_mesh_rid:   <uuidv7 dashed>   # VALUE (free-rider; derived at recon)
//   home_mesh_rid:  <uuidv7 dashed>   # VALUE (free-rider; derived at recon)
//   kind:           parent            # VALUE (CHECK singleton today)
//   added_at:       <iso>             # AUDIT ONLY — excluded from
//                                     #   identity/sort/merge
//   state:          active | tombstoned
//
// ELEMENT IDENTITY = the 2-TUPLE `(ref_vault_rid, home_vault_rid)` (FU-1).
// `ref_mesh_rid`, `home_mesh_rid` AND `kind` are VALUES, not identity: a vault
// has exactly one home mesh (home_mesh is determined by home_vault), the
// referencing mesh is likewise determined by ref_vault, and `kind` is a CHECK
// singleton (`IN ('parent')`) — so none widens the OR-Set key. Keying on
// ref_mesh OR home_mesh would phantom-split a future home-mesh reassignment into
// 2 live elements that collapse to 1 cache row (the cache PK has neither a
// ref_mesh nor a home_mesh column under FU-1).
//
// OR-Set (NOT a register): the merge authority is per-shard APPEND ORDER — no
// HLC, no `hlc`/`seq` fields, hlc.ts NOT reused. `added_at` is audit-only and
// forbidden as a merge key (per the Phase-0 timestamp-audit-only lock, which
// the alias rail amended ONLY for itself).

export type MeshEdgeKind = "parent";
export type MeshEdgeState = "active" | "tombstoned";

export interface AppendMeshEdgeArgs {
  // VALUE (FU-1) — the referencing mesh's rid, bare dashed-UUIDv7. A free-rider
  // determined by ref_vault; NOT part of the OR-Set key. Still persisted as an
  // audit/provenance value.
  refMeshRid: string;
  // Identity (1/2) — the referencing (parent) vault's rid, bare dashed-UUIDv7.
  refVaultRid: string;
  // Identity (2/2) — the referenced (child) vault's rid, bare dashed-UUIDv7.
  homeVaultRid: string;
  // VALUE — the referenced vault's home mesh rid, bare dashed-UUIDv7. A
  // free-rider determined by home_vault_rid; NOT part of the OR-Set key. At
  // reconstitution it is DERIVED from the live home vault, not trusted from the
  // record — but it is persisted as an audit/provenance value.
  homeMeshRid: string;
  // VALUE — `parent` today (CHECK singleton). Informational; NOT part of the key.
  kind: MeshEdgeKind;
  state: MeshEdgeState;
  // AUDIT ONLY. Defaults to now. The fold IGNORES this for identity, sort, and
  // add-wins resolution (per-shard append ORDER is the merge authority).
  addedAt?: string;
  // Test seam — override the pod root (defaults to getFederationRoot()).
  podRoot?: string;
  // Test seam — override the writer id (defaults to getWriterId()).
  writerId?: string;
}

// Directory holding every writer's mesh-edge shard:
// `<podRoot>/ledger/mesh-edges`. Each writer's shard is the ledger named
// `<writerId>` rooted here (current file + monthly archive subdir).
export function getMeshEdgesLedgerDir(podRoot?: string): string {
  return join(podRoot ?? getFederationRoot(), "ledger", "mesh-edges");
}

// The composite identity key (mesh-edge-ledger-read.ts identityKey) joins the
// 2 identity rids with the NUL byte `\x00` as separator (FU-1). That join is
// injective ONLY if the separator never appears INSIDE any part — otherwise two
// distinct 2-tuples collide to one key, silently merging edges / crossing
// tombstones. The rids are dashed-UUIDv7 strings (never contain NUL), but the
// write boundary MUST enforce the precondition fail-closed (alias-ledger parity,
// alias-ledger-write.ts:126-134): a colliding record can never be persisted.
const IDENTITY_SEPARATOR = "\x00";

function assertNoIdentitySeparator(field: string, value: string): void {
  if (value.includes(IDENTITY_SEPARATOR)) {
    throw new Error(
      `mesh-edge ${field} must not contain the NUL separator byte (\\x00) — it is the mesh-edge identity-key separator and would break key injectivity`,
    );
  }
}

// Append one @MESH_EDGE record to the CURRENT writer's own shard. Returns the
// underlying ledger append result (ts + chain-hash + initialised flag).
export function appendMeshEdgeRecord(args: AppendMeshEdgeArgs): AppendLedgerRecordResult {
  // Fail-closed injectivity guard — BEFORE any write. Reject either of the 2
  // IDENTITY rids carrying the NUL identity-key separator, so a colliding
  // record can never be persisted (FU-1 2-tuple identity).
  assertNoIdentitySeparator("ref_vault_rid", args.refVaultRid);
  assertNoIdentitySeparator("home_vault_rid", args.homeVaultRid);
  // ref_mesh_rid is now a VALUE field (FU-1), not identity — so a NUL byte in it
  // cannot collide two distinct edges in the key. Still sanitize it as a value
  // (a NUL byte has no place in a dashed-UUIDv7 and would corrupt the ledger
  // line), but this is optional value hygiene, NOT the identity injectivity guard.
  assertNoIdentitySeparator("ref_mesh_rid", args.refMeshRid);

  const writerId = args.writerId ?? getWriterId();
  const ledgerDir = getMeshEdgesLedgerDir(args.podRoot);
  const ledgerPath = join(ledgerDir, `${writerId}.yon`);
  const addedAt = args.addedAt ?? new Date().toISOString();
  return appendLedgerRecord({
    ledgerPath,
    ledgerName: writerId,
    recordType: "MESH_EDGE",
    fields: [
      ["ref_mesh_rid", args.refMeshRid],
      ["ref_vault_rid", args.refVaultRid],
      ["home_vault_rid", args.homeVaultRid],
      ["home_mesh_rid", args.homeMeshRid],
      ["kind", args.kind],
      ["added_at", addedAt],
      ["state", args.state],
    ],
    stampSrc: "flows/mesh-edge",
    // The @STAMP ts is the record's audit ts too; keep them aligned so a
    // hand-reader sees one timestamp for the event.
    ts: addedAt,
  });
}

// Convenience for the add-edge path: append an `active` record.
export function appendMeshEdgeActive(
  args: Omit<AppendMeshEdgeArgs, "state">,
): AppendLedgerRecordResult {
  return appendMeshEdgeRecord({ ...args, state: "active" });
}

// Convenience for the remove/re-parent path: append a `tombstoned` record to
// the CURRENT writer's OWN shard (never mutate another shard). The tombstone
// supersedes any earlier `active` for the same 2-tuple WITHIN this shard, and —
// via the add-wins OR-Set fold — is itself superseded by any later `active`
// (re-add) in ANY shard.
export function appendMeshEdgeTombstone(
  args: Omit<AppendMeshEdgeArgs, "state">,
): AppendLedgerRecordResult {
  return appendMeshEdgeRecord({ ...args, state: "tombstoned" });
}
