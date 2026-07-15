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
import { getFedVaultLedgerDir, type FedVaultState } from "./federation-vault-ledger-write.js";
import type { FederationVisibility, FedVaultStatus } from "./federation-write.js";

// Inc-2 Phase 0 — the READ + FOLD half of the per-writer
// append-only @FED_VAULT manifest store, a `vault_rid`-KEYED HLC-LWW REGISTER
// (mirrors alias-ledger-read.ts foldAliases precisely).
//
// READ: enumerate every writer shard under `<podRoot>/ledger/vaults/` and walk
// each shard with walkLedger (REUSED). A shard is the set of files for one
// writerId: `<writerId>/YYYY-MM.yon` archives + `<writerId>.yon` current.
//
// FOLD (vault_rid-keyed HLC-LWW register): the convergence function over the
// union of all shards. The register KEY is `vault_rid` ALONE (every other field
// is the register VALUE the winning record carries). For each vault_rid the
// WINNER across all shards is the single record with the maximum
// `(hlc, writerId, seq)` total order (util/hlc compareHlcStamped — the writerId
// tiebreak means two writers never collide).
//   - winner is `active`     → the vault is LIVE → its VALUE fields materialize.
//   - winner is `tombstoned` → the vault is ABSENT from the live set.
//
// This fixes the three failures the OR-Set could not:
//   - RE-POINT / FIELD-UPDATE: a newer-hlc active supersedes the older (works
//     ACROSS shards), NOT left co-live.
//   - CROSS-MACHINE REMOVE (C-1): a foreign writer's active is RETRACTED by a
//     newer-hlc tombstone from ANY writer.
//   - RE-ADD-AFTER-REMOVE: a tombstone then a later-hlc active → the active wins.
//
// Resolution is by the `hlc` MERGE KEY, never by `registered_at` (audit only)
// and never by per-shard APPEND ORDER. Deterministic output: sorted by
// vault_name then vault_rid (the pod.yon renderer's order), so ≤1 live record
// per vault_rid makes the pair a total sort key.

export interface FedVaultLedgerRecord {
  vaultRid: string;
  vaultName: string;
  homeMeshRidHex: string | null; // `none` sentinel decodes to null (orphan)
  repo: string;
  visibility: FederationVisibility;
  status: FedVaultStatus;
  // The MERGE KEY — the HLC ordering this record in the LWW register. Null only
  // when the on-disk record predates the register migration / was hand-written
  // without an hlc; such records sort BELOW any hlc-bearing record (the minimum).
  hlc: Hlc | null;
  // The per-writer monotonic seq — the FINAL collision-proof tiebreaker in the
  // total order (wallMs, counter, writerId, seq). 0 for legacy records with no
  // `seq` field on disk.
  seq: number;
  registeredAt: string;
  state: FedVaultState;
  // The shard (writerId) the record came from — provenance + the total-order
  // tiebreak (compareHlcStamped breaks an exact hlc tie by writerId).
  writerId: string;
}

// The live materialized VALUE bundle of a winning `active` record — the shape
// the pod.yon derivation consumes (parallels FedVaultRecord in federation-write).
export interface LiveFedVault {
  vaultRid: string;
  vaultName: string;
  homeMeshRidHex: string | null;
  repo: string;
  visibility: FederationVisibility;
  status: FedVaultStatus;
  registeredAt: string;
}

// Enumerate the writerId shard names present under the vault ledger dir. A shard
// manifests as either a current file `<writerId>.yon` OR an archive subdir
// `<writerId>/`; we collect the union so a writer whose current file rotated
// into archives (leaving only the subdir) is still found.
export function listFedVaultShards(podRoot?: string): string[] {
  const dir = getFedVaultLedgerDir(podRoot);
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

// Read every @FED_VAULT record across all shards, in (shard-sorted, per-shard
// append) order. Non-@FED_VAULT records are ignored (the walker is
// vocabulary-agnostic).
export function readAllFedVaultRecords(podRoot?: string): FedVaultLedgerRecord[] {
  const dir = getFedVaultLedgerDir(podRoot);
  const out: FedVaultLedgerRecord[] = [];
  for (const writerId of listFedVaultShards(podRoot)) {
    const records = walkLedger(dir, writerId);
    for (const rec of records) {
      const parsed = toFedVaultLedgerRecord(rec, writerId);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

const VALID_STATUS: ReadonlySet<string> = new Set([
  "active",
  "disconnected",
  "missing",
  "access_lost",
]);

function toFedVaultLedgerRecord(rec: LedgerRecord, writerId: string): FedVaultLedgerRecord | null {
  if (rec.recordType !== "FED_VAULT") return null;
  const vaultRid = rec.fields.get("vault_rid");
  if (vaultRid === undefined || vaultRid.length === 0) return null;
  const vaultName = rec.fields.get("vault_name");
  if (vaultName === undefined || vaultName.length === 0) return null;

  const homeRaw = rec.fields.get("home_mesh_rid");
  const homeMeshRidHex = homeRaw === undefined || homeRaw === "none" ? null : homeRaw;

  const repo = rec.fields.get("repo") ?? "";
  const visibilityRaw = rec.fields.get("visibility");
  const visibility: FederationVisibility = visibilityRaw === "public" ? "public" : "private";

  // `status` is reachability-only (tombstoned is the CRDT `state` channel now).
  // An unknown/legacy value falls back to "active" so a record is never dropped
  // on a status typo — the retraction decision lives entirely in `state`.
  const statusRaw = rec.fields.get("status");
  const status: FedVaultStatus =
    statusRaw !== undefined && VALID_STATUS.has(statusRaw)
      ? (statusRaw as FedVaultStatus)
      : "active";

  const stateRaw = rec.fields.get("state");
  const state: FedVaultState = stateRaw === "tombstoned" ? "tombstoned" : "active";

  const hlcRaw = rec.fields.get("hlc");
  const hlc = hlcRaw !== undefined ? parseHlc(hlcRaw) : null;
  const seqRaw = rec.fields.get("seq");
  const seqParsed = seqRaw !== undefined ? Number(seqRaw) : NaN;
  const seq = Number.isSafeInteger(seqParsed) && seqParsed >= 0 ? seqParsed : 0;

  return {
    vaultRid,
    vaultName,
    homeMeshRidHex,
    repo,
    visibility,
    status,
    hlc,
    seq,
    registeredAt: rec.fields.get("registered_at") ?? "",
    state,
    writerId,
  };
}

// The total-order comparator over records: by (hlc, writerId, seq). A record
// with NO hlc (legacy / hand-written) sorts BELOW any hlc-bearing record. For
// two hlc-less LEGACY records the order is DELETE-WINS (state-aware): a
// `tombstoned` record dominates an `active` one, so a pre-migration remove can
// never be silently RESURRECTED by a legacy active that merely sorts higher by
// writerId. When states are equal we fall back to registered_at then writerId.
// (Hlc-bearing records are unaffected — their hlc already encodes causal order.)
function compareFedVaultRecords(a: FedVaultLedgerRecord, b: FedVaultLedgerRecord): number {
  if (a.hlc !== null && b.hlc !== null) {
    return compareHlcStamped(
      { hlc: a.hlc, writerId: a.writerId, seq: a.seq },
      { hlc: b.hlc, writerId: b.writerId, seq: b.seq },
    );
  }
  if (a.hlc === null && b.hlc !== null) return -1;
  if (a.hlc !== null && b.hlc === null) return 1;
  // Both hlc-less (legacy) → DELETE-WINS: a tombstone dominates an active.
  if (a.state !== b.state) {
    const aRank = a.state === "tombstoned" ? 1 : 0;
    const bRank = b.state === "tombstoned" ? 1 : 0;
    return aRank < bRank ? -1 : 1;
  }
  if (a.registeredAt !== b.registeredAt) return a.registeredAt < b.registeredAt ? -1 : 1;
  if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
  return 0;
}

// G4 (0.12.1 identity-safety, design §6.1 G4) — SAME-RID DIVERGENT-CONTENT RULE,
// named. This is a `vault_rid`-keyed HLC-LWW REGISTER: when two writers hold
// records for the SAME vault_rid with DIVERGENT content (different repo, home
// mesh, visibility, status, or state), they are NEVER co-live and per-shard
// APPEND ORDER is NEVER the authority. The single winner is the record with the
// maximum (hlc, writerId, seq) total order (compareFedVaultRecords) — last-writer
// -wins by the HLC merge key, writerId + seq breaking exact ties so two distinct
// writes can never collide. The forged-future-HLC flag (below) is the M-cell
// guard on this rule: a writer that forges a far-future wall clock would win this
// register indefinitely.
//
// The winning RECORD per vault_rid (carrying its writerId + state + hlc) across
// the union of shards — the pre-projection half of the fold. `foldFedVaults`
// projects the `active` winners to their VALUE bundle; callers that need the
// winner's ORIGIN (writerId) or `state` — e.g. the sync write-back's
// origin-writer null-home guard — consume this map directly. Same
// (hlc, writerId, seq) total order the value fold uses; ≤1 record per rid.
export function foldFedVaultWinners(
  records: readonly FedVaultLedgerRecord[],
): Map<string, FedVaultLedgerRecord> {
  const winnerByRid = new Map<string, FedVaultLedgerRecord>();
  for (const rec of records) {
    const cur = winnerByRid.get(rec.vaultRid);
    if (cur === undefined || compareFedVaultRecords(rec, cur) > 0) {
      winnerByRid.set(rec.vaultRid, rec);
    }
  }
  return winnerByRid;
}

// The vault_rid-keyed HLC-LWW register fold. Consolidates all shards → the
// deterministic live vault set.
//
//  1. Group ALL records by `vault_rid` (the register key).
//  2. For each vault_rid, the WINNER is the record with the greatest
//     (hlc, writerId, seq) total order across EVERY shard.
//  3. `active` winner → live (its VALUE fields materialize); `tombstoned`
//     winner → absent.
//  4. Output sorted by (vault_name, vault_rid) — the pod.yon renderer's order.
export function foldFedVaults(records: readonly FedVaultLedgerRecord[]): LiveFedVault[] {
  return projectLiveFedVaults(foldFedVaultWinners(records));
}

// FIX F (A2-R2 G4-N2 / A2-R3 MINOR-3) — the pure PROJECTION half (winners → the
// live VALUE set), extracted so `liveFedVaults` can fold the winners ONCE and reuse
// them for BOTH the forged-future check AND this projection (it previously folded
// twice: once for the forged check, once again inside foldFedVaults). The returned
// winner set is unchanged.
function projectLiveFedVaults(
  winnerByRid: ReadonlyMap<string, FedVaultLedgerRecord>,
): LiveFedVault[] {
  const live: LiveFedVault[] = [];
  for (const rec of winnerByRid.values()) {
    if (rec.state === "active") {
      live.push({
        vaultRid: rec.vaultRid,
        vaultName: rec.vaultName,
        homeMeshRidHex: rec.homeMeshRidHex,
        repo: rec.repo,
        visibility: rec.visibility,
        status: rec.status,
        registeredAt: rec.registeredAt,
      });
    }
  }
  return live.sort(compareLiveByName);
}

function compareLiveByName(a: LiveFedVault, b: LiveFedVault): number {
  if (a.vaultName < b.vaultName) return -1;
  if (a.vaultName > b.vaultName) return 1;
  if (a.vaultRid < b.vaultRid) return -1;
  if (a.vaultRid > b.vaultRid) return 1;
  return 0;
}

// G4 — the forged-future-HLC FLAG over the register's WINNERS. A winning record
// whose hlc wall-clock is implausibly ahead of `nowMs` is a candidate
// forged/skewed clock that would win LWW indefinitely (design §6.1 G4). PURE
// (nowMs injected); returns the flagged winners so a caller can surface them.
// 0.12.1 detects + flags only — it does NOT reject or clamp (that is the 0.12.x
// hardening lane).
export function forgedFutureFedVaultWinners(
  winners: ReadonlyMap<string, FedVaultLedgerRecord>,
  nowMs: number,
  toleranceMs?: number,
): FedVaultLedgerRecord[] {
  const flagged: FedVaultLedgerRecord[] = [];
  for (const rec of winners.values()) {
    if (rec.hlc !== null && isForgedFutureHlc(rec.hlc, nowMs, toleranceMs)) flagged.push(rec);
  }
  return flagged;
}

// Convenience: read + fold in one call. Also SURFACES the G4 forged-future flag:
// if any live winner carries an implausibly-future hlc, warn once (non-rejecting)
// so a forged/skewed clock winning the register is visible, not silent.
export function liveFedVaults(podRoot?: string): LiveFedVault[] {
  const records = readAllFedVaultRecords(podRoot);
  // FIX F — fold the winners ONCE and reuse for both the forged-check and the
  // projection (was double-folding). Winner set unchanged (observability-only).
  const winners = foldFedVaultWinners(records);
  const forged = forgedFutureFedVaultWinners(winners, Date.now());
  if (forged.length > 0) {
    // 0.12.x: warn-DEDUP (once-per-process for a repeatedly-derived pod) is OUT OF
    // SCOPE for this fix-pass — a per-derive warn is retained here.
    // eslint-disable-next-line no-console
    console.warn(
      `lyt: ${forged.length} live vault record(s) carry an implausibly-future HLC ` +
        `(forged/skewed clock — would win last-writer-wins indefinitely): ` +
        `${forged.map((r) => `vault:${r.vaultRid}@${r.writerId}`).join(", ")}`,
    );
  }
  return projectLiveFedVaults(winners);
}

// The HLC RECEIVE-RULE input for a new @FED_VAULT write: the max hlc observed
// across ALL shards (this writer's own AND every foreign writer's synced shard).
// Threaded into a new stamp so it seeds ABOVE everything observed — a
// lagging-wall-clock machine that already synced a higher remote hlc cannot
// stamp BELOW it and lose its causally-later write. Null when no hlc-bearing
// record exists yet (pure local-clock seed).
export function observedMaxFedVaultHlc(podRoot?: string): Hlc | null {
  return observedMaxHlcFromFedVaultRecords(readAllFedVaultRecords(podRoot));
}

// The PURE variant of observedMaxFedVaultHlc over an already-read record set.
// Lets a caller that ALSO needs allRids / the fold derive the receive-rule input
// from ONE ledger walk instead of re-reading the shards a second time (the F2
// per-derive dedup). Result-identical to observedMaxFedVaultHlc(podRoot) when
// `records === readAllFedVaultRecords(podRoot)` — same records, same max.
export function observedMaxHlcFromFedVaultRecords(
  records: readonly FedVaultLedgerRecord[],
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
