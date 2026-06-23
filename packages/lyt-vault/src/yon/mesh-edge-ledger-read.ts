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

import { walkLedger, type LedgerRecord } from "./ledger-read.js";
import {
  getMeshEdgesLedgerDir,
  type MeshEdgeKind,
  type MeshEdgeState,
} from "./mesh-edge-ledger-write.js";

// Slice 2a — the READ + FOLD half of the per-writer append-only MESH-EDGE
// store. Structural clone of subscription-ledger-read.ts (the OR-Set, NOT the
// alias HLC-LWW register).
//
// READ: enumerate every writer shard under `<podRoot>/ledger/mesh-edges/` and
// walk each shard with walkLedger (REUSED — the same monthly-segment +
// current-file model the audit/provenance/subscription ledgers use). walkLedger
// returns each shard's records in APPEND ORDER, which is the merge authority for
// that shard.
//
// FOLD (OR-Set, add-wins): the convergence function over the union of all
// shards. A mesh-edge (keyed by the 2-tuple `(ref_vault_rid, home_vault_rid)`)
// is LIVE iff some shard has an `active` record for it that is not superseded by
// a tombstone — ADD-WINS: a fresh `active` record in ANY shard beats a stale
// `tombstoned` one. Resolution is by per-shard append order, NEVER by
// `added_at` (audit only). Deterministic output: sorted by the concatenated-rid
// identity key.
//
// IDENTITY = the 2-TUPLE only (FU-1). `ref_mesh_rid`, `home_mesh_rid` + `kind`
// are VALUES carried by the winning `active` record (informational). `ref_mesh`
// is DROPPED from the key: a vault has exactly one home mesh (home_mesh is
// determined by home_vault) and the referencing mesh is likewise a free-rider
// determined by ref_vault — keying on either would phantom-split a home-mesh
// reassignment into two live elements that collapse to one cache row. NO
// coordinate-canonicalization — rids are already canonical (unlike the
// subscription rail, which canonicalizes origin coordinates).

export interface MeshEdgeRecord {
  refMeshRid: string;
  refVaultRid: string;
  homeVaultRid: string;
  homeMeshRid: string;
  kind: string;
  addedAt: string;
  state: MeshEdgeState;
  // The shard (writerId) the record came from. Useful for provenance + tests.
  writerId: string;
}

export interface LiveMeshEdge {
  refMeshRid: string;
  refVaultRid: string;
  homeVaultRid: string;
  // The home_mesh_rid + kind carried by the winning `active` record (the
  // shard-final active record that made this edge live). VALUES, not identity.
  // NOTE: reconstitution DERIVES home_mesh from the live home vault rather than
  // trusting this stored value (a move can stale it); it is informational here.
  homeMeshRid: string;
  kind: MeshEdgeKind | string;
}

// The identity-key separator — mirrors the write-boundary guard
// (mesh-edge-ledger-write.ts assertNoIdentitySeparator). The 2 identity rids are
// joined with NUL; the write path guarantees no part contains it.
const IDENTITY_SEPARATOR = "\x00";

// The OR-Set element identity: the concatenated 2-tuple (FU-1). `ref_mesh_rid`,
// `home_mesh_rid` and `kind` are EXCLUDED (values, not identity). This is the
// single key-derivation proving the 2-tuple identity + no-HLC contract.
function identityKey(rec: { refVaultRid: string; homeVaultRid: string }): string {
  return [rec.refVaultRid, rec.homeVaultRid].join(IDENTITY_SEPARATOR);
}

// Enumerate the writerId shard names present under the mesh-edges ledger dir. A
// shard manifests as either a current file `<writerId>.yon` OR an archive subdir
// `<writerId>/`. We collect the union of both so a writer whose current file
// rotated into archives (leaving only the subdir) is still found.
export function listMeshEdgeShards(podRoot?: string): string[] {
  const dir = getMeshEdgesLedgerDir(podRoot);
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

// Read every @MESH_EDGE record across all shards, in (shard-sorted, per-shard
// append) order. Non-@MESH_EDGE records (should not occur in a mesh-edge shard,
// but the walker is vocabulary-agnostic) are ignored.
export function readAllMeshEdgeRecords(podRoot?: string): MeshEdgeRecord[] {
  const dir = getMeshEdgesLedgerDir(podRoot);
  const out: MeshEdgeRecord[] = [];
  for (const writerId of listMeshEdgeShards(podRoot)) {
    const records = walkLedger(dir, writerId);
    for (const rec of records) {
      const parsed = toMeshEdgeRecord(rec, writerId);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

function toMeshEdgeRecord(rec: LedgerRecord, writerId: string): MeshEdgeRecord | null {
  if (rec.recordType !== "MESH_EDGE") return null;
  const refVaultRid = rec.fields.get("ref_vault_rid");
  const homeVaultRid = rec.fields.get("home_vault_rid");
  // FU-1: identity is the 2-tuple (ref_vault_rid, home_vault_rid) — BOTH must be
  // present + non-empty or the record is not a well-formed edge and is ignored
  // (defensive). `ref_mesh_rid` is now a VALUE field that may be absent/empty
  // (defaults to '' below); it is no longer an identity guard.
  if (refVaultRid === undefined || refVaultRid.length === 0) return null;
  if (homeVaultRid === undefined || homeVaultRid.length === 0) return null;
  const refMeshRid = rec.fields.get("ref_mesh_rid") ?? "";
  const stateRaw = rec.fields.get("state");
  const state: MeshEdgeState = stateRaw === "tombstoned" ? "tombstoned" : "active";
  return {
    refMeshRid,
    refVaultRid,
    homeVaultRid,
    homeMeshRid: rec.fields.get("home_mesh_rid") ?? "",
    kind: rec.fields.get("kind") ?? "parent",
    addedAt: rec.fields.get("added_at") ?? "",
    state,
    writerId,
  };
}

// The OR-Set add-wins fold. Consolidates all shards → the deterministic live
// mesh-edge set, sorted by the concatenated-rid identity key.
//
// Algorithm (clone of foldSubscriptions):
//  1. Per shard, in APPEND order, take the LAST record per identity-key as that
//     shard's verdict (append order = causal order for one writer).
//  2. Across shards, an edge is LIVE iff ANY shard's verdict is `active`
//     (add-wins lattice join). `added_at` is never consulted.
//  3. Output sorted by the identity key ASC for determinism.
export function foldMeshEdges(records: readonly MeshEdgeRecord[]): LiveMeshEdge[] {
  // shard verdict: identity key -> last record seen for it within that shard.
  const perShard = new Map<string, Map<string, MeshEdgeRecord>>();
  for (const rec of records) {
    let shard = perShard.get(rec.writerId);
    if (shard === undefined) {
      shard = new Map<string, MeshEdgeRecord>();
      perShard.set(rec.writerId, shard);
    }
    // Records arrive in append order within a writerId (readAllMeshEdgeRecords
    // walks each shard contiguously), so a later set() overwrites the earlier
    // verdict — last-write-wins within the shard.
    shard.set(identityKey(rec), rec);
  }

  // add-wins join across shards: live iff any shard's verdict is active. Keep
  // the winning active record (any active verdict) for its informational
  // home_mesh_rid/kind.
  //
  // TIE-BREAK = min(writerId) on the read path: `perShard` is populated in the
  // order records arrive, and the on-disk read path (readAllMeshEdgeRecords →
  // listMeshEdgeShards sorts writerIds ASC) feeds them in sorted-writerId order
  // — so iteration here is sorted-writerId order. The `!live.has`
  // first-active-wins guard therefore resolves a tie (two writers naming the
  // SAME 2-tuple with DIFFERENT informational fields) to the LOWEST writerId
  // deterministically. The edge's LIVENESS is unaffected (add-wins); only the
  // informational home_mesh_rid/kind carried forward is the lowest-writerId
  // shard's. (As a pure function, the fold resolves by INPUT order; the sort
  // lives in the read path — same contract as foldSubscriptions.)
  const live = new Map<string, LiveMeshEdge>();
  for (const shard of perShard.values()) {
    for (const rec of shard.values()) {
      const key = identityKey(rec);
      if (rec.state === "active") {
        if (!live.has(key)) {
          live.set(key, {
            refMeshRid: rec.refMeshRid,
            refVaultRid: rec.refVaultRid,
            homeVaultRid: rec.homeVaultRid,
            homeMeshRid: rec.homeMeshRid,
            kind: rec.kind,
          });
        }
      }
      // tombstoned verdicts contribute nothing to the live map; an edge is live
      // iff some shard's verdict is active (add-wins).
    }
  }
  // Output sorted by the concatenated identity key ASC.
  return [...live.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, v]) => v);
}

// Convenience: read + fold in one call.
export function liveMeshEdges(podRoot?: string): LiveMeshEdge[] {
  return foldMeshEdges(readAllMeshEdgeRecords(podRoot));
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
