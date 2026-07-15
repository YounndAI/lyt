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

import {
  type Hlc,
  compareHlc,
  compareHlcStamped,
  isForgedFutureHlc,
  parseHlc,
} from "../util/hlc.js";
import { walkLedger, type LedgerRecord } from "./ledger-read.js";
import { getFedMeshLedgerDir, type FedMeshState } from "./federation-mesh-ledger-write.js";
import type { FedMeshPushKind, FedMeshRole } from "./federation-write.js";

// Inc-2 Phase 0 — the READ + FOLD half of the per-writer
// append-only @FED_MESH manifest store, a `mesh_rid`-KEYED HLC-LWW REGISTER
// (mirrors federation-vault-ledger-read.ts exactly, keyed on mesh_rid). See that
// file for the full register / delete-wins / receive-rule rationale.

export interface FedMeshLedgerRecord {
  meshRid: string;
  fedRidHex: string;
  meshName: string;
  pushTarget: string;
  pushKind: FedMeshPushKind;
  role: FedMeshRole;
  hlc: Hlc | null;
  seq: number;
  addedAt: string;
  state: FedMeshState;
  writerId: string;
}

export interface LiveFedMesh {
  meshRid: string;
  fedRidHex: string;
  meshName: string;
  pushTarget: string;
  pushKind: FedMeshPushKind;
  role: FedMeshRole;
  addedAt: string;
}

export function listFedMeshShards(podRoot?: string): string[] {
  const dir = getFedMeshLedgerDir(podRoot);
  if (!existsSync(dir) || !safeIsDir(dir)) return [];
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (safeIsDir(full)) {
      names.add(entry);
    } else if (entry.endsWith(".yon")) {
      names.add(entry.replace(/\.yon$/, ""));
    }
  }
  return [...names].sort();
}

export function readAllFedMeshRecords(podRoot?: string): FedMeshLedgerRecord[] {
  const dir = getFedMeshLedgerDir(podRoot);
  const out: FedMeshLedgerRecord[] = [];
  for (const writerId of listFedMeshShards(podRoot)) {
    const records = walkLedger(dir, writerId);
    for (const rec of records) {
      const parsed = toFedMeshLedgerRecord(rec, writerId);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

function toFedMeshLedgerRecord(rec: LedgerRecord, writerId: string): FedMeshLedgerRecord | null {
  if (rec.recordType !== "FED_MESH") return null;
  const meshRid = rec.fields.get("mesh_rid");
  if (meshRid === undefined || meshRid.length === 0) return null;
  const meshName = rec.fields.get("mesh_name");
  if (meshName === undefined || meshName.length === 0) return null;

  const pushKindRaw = rec.fields.get("push_kind");
  const pushKind: FedMeshPushKind = pushKindRaw === "org" ? "org" : "handle";
  const roleRaw = rec.fields.get("role");
  // M2 (0.12.1 identity-safety) — FAIL-CLOSED, coupled with the pod.yon parser
  // (federation-read.ts). This folded `role` feeds rebuildFederationCacheFlow's
  // own_created write-back; a blank/garbled/absent role must fold to `join`, not
  // `own`. Only an explicit `role=="own"` confers ownership. KEEP IN SYNC with
  // federation-read.ts's role default.
  const role: FedMeshRole = roleRaw === "own" ? "own" : "join";

  const stateRaw = rec.fields.get("state");
  const state: FedMeshState = stateRaw === "tombstoned" ? "tombstoned" : "active";

  const hlcRaw = rec.fields.get("hlc");
  const hlc = hlcRaw !== undefined ? parseHlc(hlcRaw) : null;
  const seqRaw = rec.fields.get("seq");
  const seqParsed = seqRaw !== undefined ? Number(seqRaw) : NaN;
  const seq = Number.isSafeInteger(seqParsed) && seqParsed >= 0 ? seqParsed : 0;

  return {
    meshRid,
    fedRidHex: rec.fields.get("fed_rid") ?? "",
    meshName,
    pushTarget: rec.fields.get("push_target") ?? "",
    pushKind,
    role,
    hlc,
    seq,
    addedAt: rec.fields.get("added_at") ?? "",
    state,
    writerId,
  };
}

function compareFedMeshRecords(a: FedMeshLedgerRecord, b: FedMeshLedgerRecord): number {
  if (a.hlc !== null && b.hlc !== null) {
    return compareHlcStamped(
      { hlc: a.hlc, writerId: a.writerId, seq: a.seq },
      { hlc: b.hlc, writerId: b.writerId, seq: b.seq },
    );
  }
  if (a.hlc === null && b.hlc !== null) return -1;
  if (a.hlc !== null && b.hlc === null) return 1;
  if (a.state !== b.state) {
    const aRank = a.state === "tombstoned" ? 1 : 0;
    const bRank = b.state === "tombstoned" ? 1 : 0;
    return aRank < bRank ? -1 : 1;
  }
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
  return 0;
}

// G4 (0.12.1 identity-safety, design §6.1 G4) — SAME-RID DIVERGENT-CONTENT RULE,
// named. This is a `mesh_rid`-keyed HLC-LWW REGISTER: when two writers hold
// records for the SAME mesh_rid with DIVERGENT content (different push_target,
// push_kind, role, or state), they are NEVER co-live and per-shard APPEND ORDER
// is NEVER the authority. The single winner is the record with the maximum
// (hlc, writerId, seq) total order (compareFedMeshRecords) — last-writer-wins by
// the HLC merge key, writerId + seq breaking exact ties. The forged-future-HLC
// flag (below) guards this rule: a writer forging a far-future wall clock would
// win this register — and thus the mesh's `role`/`push_target` ownership
// authority — indefinitely.
//
// The winning RECORD per mesh_rid (carrying its writerId + state + hlc) across
// the union of shards — the pre-projection half of the fold. Mesh-rail analog of
// foldFedVaultWinners: callers that need the winner's ORIGIN (writerId) or `hlc`
// — e.g. rebuildFederationCacheFlow's origin-writer own_created guard — consume
// this map directly. Same (hlc, writerId, seq) total order the value fold uses.
export function foldFedMeshWinners(
  records: readonly FedMeshLedgerRecord[],
): Map<string, FedMeshLedgerRecord> {
  const winnerByRid = new Map<string, FedMeshLedgerRecord>();
  for (const rec of records) {
    const cur = winnerByRid.get(rec.meshRid);
    if (cur === undefined || compareFedMeshRecords(rec, cur) > 0) {
      winnerByRid.set(rec.meshRid, rec);
    }
  }
  return winnerByRid;
}

// The mesh_rid-keyed HLC-LWW register fold → the deterministic live mesh set,
// sorted by (mesh_name, mesh_rid) to match the pod.yon renderer's order.
export function foldFedMeshes(records: readonly FedMeshLedgerRecord[]): LiveFedMesh[] {
  return projectLiveFedMeshes(foldFedMeshWinners(records));
}

// FIX F (A2-R2 G4-N2 / A2-R3 MINOR-3) — the pure PROJECTION half (winners → the
// live VALUE set), extracted so `liveFedMeshes` can fold the winners ONCE and reuse
// them for BOTH the forged-future check AND this projection (previously folded
// twice). The returned winner set is unchanged.
function projectLiveFedMeshes(
  winnerByRid: ReadonlyMap<string, FedMeshLedgerRecord>,
): LiveFedMesh[] {
  const live: LiveFedMesh[] = [];
  for (const rec of winnerByRid.values()) {
    if (rec.state === "active") {
      live.push({
        meshRid: rec.meshRid,
        fedRidHex: rec.fedRidHex,
        meshName: rec.meshName,
        pushTarget: rec.pushTarget,
        pushKind: rec.pushKind,
        role: rec.role,
        addedAt: rec.addedAt,
      });
    }
  }
  return live.sort(compareLiveByName);
}

function compareLiveByName(a: LiveFedMesh, b: LiveFedMesh): number {
  if (a.meshName < b.meshName) return -1;
  if (a.meshName > b.meshName) return 1;
  if (a.meshRid < b.meshRid) return -1;
  if (a.meshRid > b.meshRid) return 1;
  return 0;
}

// G4 — the forged-future-HLC FLAG over the mesh register's WINNERS (mesh-rail
// analog of forgedFutureFedVaultWinners). PURE (nowMs injected); returns the
// flagged winners so a caller can surface them. Detects + flags only — no
// rejection/clamping (0.12.x hardening lane).
export function forgedFutureFedMeshWinners(
  winners: ReadonlyMap<string, FedMeshLedgerRecord>,
  nowMs: number,
  toleranceMs?: number,
): FedMeshLedgerRecord[] {
  const flagged: FedMeshLedgerRecord[] = [];
  for (const rec of winners.values()) {
    if (rec.hlc !== null && isForgedFutureHlc(rec.hlc, nowMs, toleranceMs)) flagged.push(rec);
  }
  return flagged;
}

// Convenience: read + fold in one call. Also SURFACES the G4 forged-future flag
// (a forged/skewed clock winning the mesh register captures the mesh's role +
// push_target ownership authority): warn (non-rejecting) rather than let it be
// silent.
export function liveFedMeshes(podRoot?: string): LiveFedMesh[] {
  const records = readAllFedMeshRecords(podRoot);
  // FIX F — fold the winners ONCE and reuse for both the forged-check and the
  // projection (was double-folding). Winner set unchanged (observability-only).
  const winners = foldFedMeshWinners(records);
  const forged = forgedFutureFedMeshWinners(winners, Date.now());
  if (forged.length > 0) {
    // 0.12.x: warn-DEDUP (once-per-process for a repeatedly-derived pod) is OUT OF
    // SCOPE for this fix-pass — a per-derive warn is retained here.
    // eslint-disable-next-line no-console
    console.warn(
      `lyt: ${forged.length} live mesh record(s) carry an implausibly-future HLC ` +
        `(forged/skewed clock — would win last-writer-wins indefinitely, capturing the ` +
        `mesh's role/push_target authority): ` +
        `${forged.map((r) => `mesh:${r.meshRid}@${r.writerId}`).join(", ")}`,
    );
  }
  return projectLiveFedMeshes(winners);
}

// The HLC RECEIVE-RULE input for a new @FED_MESH write (see the vault analog).
export function observedMaxFedMeshHlc(podRoot?: string): Hlc | null {
  return observedMaxHlcFromFedMeshRecords(readAllFedMeshRecords(podRoot));
}

// The PURE variant over an already-read record set (the F2 per-derive dedup —
// see the vault analog observedMaxHlcFromFedVaultRecords). Result-identical to
// observedMaxFedMeshHlc(podRoot) when `records === readAllFedMeshRecords(podRoot)`.
export function observedMaxHlcFromFedMeshRecords(
  records: readonly FedMeshLedgerRecord[],
): Hlc | null {
  let max: Hlc | null = null;
  for (const rec of records) {
    if (rec.hlc === null) continue;
    if (max === null || compareHlc(rec.hlc, max) > 0) max = rec.hlc;
  }
  return max;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
