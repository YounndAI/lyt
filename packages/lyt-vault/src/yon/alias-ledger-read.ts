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

import { type Hlc, compareHlcStamped, parseHlc } from "../util/hlc.js";
import { walkLedger, type LedgerRecord } from "./ledger-read.js";
import { getAliasesLedgerDir, type AliasState } from "./alias-ledger-write.js";

// Fed-v2 convergence-hardening (Slice 1a) — the READ + FOLD half of the
// per-writer append-only ALIAS store, now a NAME-KEYED HLC-LWW REGISTER (it was
// an OR-Set keyed on (name, target_rid) — replaced here).
//
// READ: enumerate every writer shard under `<podRoot>/ledger/aliases/` and walk
// each shard with walkLedger (REUSED). A shard is the set of files for one
// writerId: `<writerId>/YYYY-MM.yon` archives + `<writerId>.yon` current.
//
// FOLD (name-keyed HLC-LWW register): the convergence function over the union
// of all shards. The register KEY is `name` ALONE (target_rid is the register
// VALUE, not part of the key). For each name, the WINNER across all shards is
// the single record with the maximum `(hlc, writerId)` total order (util/hlc
// compareHlcStamped — the writerId tiebreak means two writers never collide).
//   - winner is `active`    → the name is LIVE → its `target_rid` is the value.
//   - winner is `tombstoned`→ the name is ABSENT from the live set.
//
// This is a true register, so it fixes the OR-Set's three failures:
//   - RE-POINT: `ro→A` then `ro→B` with a newer hlc → B's active is the winner;
//     A's active is superseded (NOT left co-live). Works ACROSS shards too.
//   - CROSS-MACHINE REMOVE: a foreign writer's active `ro→A` is RETRACTED by a
//     newer-hlc tombstone `ro` from ANY writer — the OR-Set's add-wins could
//     never let a tombstone beat a foreign active; the register's max-hlc can.
//   - RE-ADD-AFTER-REMOVE: a tombstone `ro`@hlc1 then active `ro→C`@hlc2>hlc1 →
//     C wins (newer-hlc active beats the older tombstone).
//
// Resolution is by the `hlc` MERGE KEY, never by `created_at` (audit only) and
// never by per-shard APPEND ORDER (the old OR-Set merge authority — gone).
// Deterministic output: sorted by name.

export interface AliasRecord {
  name: string;
  targetRid: string;
  kind: string;
  // The MERGE KEY — the HLC ordering this record in the LWW register. Null only
  // when the on-disk record predates Slice 1a / was hand-written without an hlc;
  // such records sort BELOW any hlc-bearing record (treated as the minimum).
  hlc: Hlc | null;
  // The per-writer monotonic seq — the FINAL collision-proof tiebreaker in the
  // total order (wallMs, counter, writerId, seq). 0 for legacy records with no
  // `seq` field on disk (they predate the tiebreaker).
  seq: number;
  createdAt: string;
  state: AliasState;
  // The shard (writerId) the record came from — provenance + the total-order
  // tiebreak (compareHlcStamped breaks an exact hlc tie by writerId).
  writerId: string;
}

export interface LiveAlias {
  name: string;
  targetRid: string;
  // The kind carried by the winning `active` record. Informational.
  kind: string;
}

// Enumerate the writerId shard names present under the aliases ledger dir. A
// shard manifests as either a current file `<writerId>.yon` OR an archive
// subdir `<writerId>/`. We collect the union of both so a writer whose current
// file rotated into archives (leaving only the subdir) is still found.
export function listAliasShards(podRoot?: string): string[] {
  const dir = getAliasesLedgerDir(podRoot);
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

// Read every @ALIAS record across all shards, in (shard-sorted, per-shard
// append) order. Non-@ALIAS records (should not occur in an alias shard, but
// the walker is vocabulary-agnostic) are ignored.
export function readAllAliasRecords(podRoot?: string): AliasRecord[] {
  const dir = getAliasesLedgerDir(podRoot);
  const out: AliasRecord[] = [];
  for (const writerId of listAliasShards(podRoot)) {
    const records = walkLedger(dir, writerId);
    for (const rec of records) {
      const parsed = toAliasRecord(rec, writerId);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

function toAliasRecord(rec: LedgerRecord, writerId: string): AliasRecord | null {
  if (rec.recordType !== "ALIAS") return null;
  const name = rec.fields.get("name");
  if (name === undefined || name.length === 0) return null;
  const targetRid = rec.fields.get("target_rid");
  if (targetRid === undefined || targetRid.length === 0) return null;
  const stateRaw = rec.fields.get("state");
  const state: AliasState = stateRaw === "tombstoned" ? "tombstoned" : "active";
  const hlcRaw = rec.fields.get("hlc");
  const hlc = hlcRaw !== undefined ? parseHlc(hlcRaw) : null;
  const seqRaw = rec.fields.get("seq");
  const seqParsed = seqRaw !== undefined ? Number(seqRaw) : NaN;
  const seq = Number.isSafeInteger(seqParsed) && seqParsed >= 0 ? seqParsed : 0;
  return {
    name,
    targetRid,
    kind: rec.fields.get("kind") ?? "vault",
    hlc,
    seq,
    createdAt: rec.fields.get("created_at") ?? "",
    state,
    writerId,
  };
}

// The total-order comparator over alias records: by (hlc, writerId, seq). A
// record with NO hlc (legacy / hand-written) sorts BELOW any hlc-bearing record.
// For two hlc-less LEGACY records the order is DELETE-WINS (state-aware), NOT
// writerId alone: a `tombstoned` record dominates an `active` one, so a
// pre-migration remove can never be silently RESURRECTED by a legacy active that
// merely sorts higher by writerId. When states are equal we fall back to
// created_at then writerId for a deterministic total order. (Hlc-bearing records
// are unaffected — their hlc already encodes causal order, including re-add.)
function compareAliasRecords(a: AliasRecord, b: AliasRecord): number {
  if (a.hlc !== null && b.hlc !== null) {
    return compareHlcStamped(
      { hlc: a.hlc, writerId: a.writerId, seq: a.seq },
      { hlc: b.hlc, writerId: b.writerId, seq: b.seq },
    );
  }
  if (a.hlc === null && b.hlc !== null) return -1; // a (no hlc) sorts below b
  if (a.hlc !== null && b.hlc === null) return 1; // b (no hlc) sorts below a
  // Both hlc-less (legacy) → DELETE-WINS: a tombstone dominates an active so a
  // legacy remove is not resurrected. `tombstoned` ranks ABOVE `active`.
  if (a.state !== b.state) {
    // The greater record is the tombstone. Map state → rank (tombstoned=1 > active=0).
    const aRank = a.state === "tombstoned" ? 1 : 0;
    const bRank = b.state === "tombstoned" ? 1 : 0;
    return aRank < bRank ? -1 : 1;
  }
  // Equal state → created_at (audit ts, lexicographic ISO-8601) then writerId.
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
  return 0;
}

// The name-keyed HLC-LWW register fold. Consolidates all shards → the
// deterministic live alias set, sorted by name.
//
// Algorithm:
//  1. Group ALL records by `name` (the register key — target_rid is NOT part
//     of the key; it is the value the winning record carries).
//  2. For each name, the WINNER is the single record with the greatest
//     (hlc, writerId) total order across EVERY shard (compareAliasRecords).
//  3. If the winner is `active` → the name is live → emit (name, target_rid,
//     kind). If `tombstoned` → the name is absent.
//  4. Output sorted by name ASC for determinism.
//
// Append order is NOT consulted (that was the OR-Set's merge authority); the
// hlc merge key is. created_at is never consulted (audit only).
export function foldAliases(records: readonly AliasRecord[]): LiveAlias[] {
  // name -> the current winning record (greatest (hlc, writerId)) seen so far.
  const winnerByName = new Map<string, AliasRecord>();
  for (const rec of records) {
    const cur = winnerByName.get(rec.name);
    if (cur === undefined || compareAliasRecords(rec, cur) > 0) {
      winnerByName.set(rec.name, rec);
    }
  }

  const live: LiveAlias[] = [];
  for (const rec of winnerByName.values()) {
    // The winner decides the name's liveness. An `active` winner → live; a
    // `tombstoned` winner → the name is retracted (absent), regardless of any
    // older active in any shard (LWW: the max-hlc record is authoritative).
    if (rec.state === "active") {
      live.push({ name: rec.name, targetRid: rec.targetRid, kind: rec.kind });
    }
  }
  // Output sorted by name ASC. The register guarantees ≤1 live record per name,
  // so name alone is a total sort key (no target_rid secondary needed).
  return live.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Convenience: read + fold in one call.
export function liveAliases(podRoot?: string): LiveAlias[] {
  return foldAliases(readAllAliasRecords(podRoot));
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
