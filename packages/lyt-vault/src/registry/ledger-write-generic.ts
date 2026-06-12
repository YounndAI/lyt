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

// Generic YON-first ledger writer — Lock 0.2 contract carrier.
//
// v1.A.3 (CR-2) consolidation: `recordAudit` (audit-write.ts) and
// `recordProvenance` (provenance-write.ts) were structural mirrors —
// both appended a typed record + chained @STAMP to a vault-local YON
// ledger (fatal-on-failure) then upserted a libSQL cache row
// (best-effort, recoverable via `lyt vault rebuild-index --ledger <name>`).
// This module owns the shared dance; the typed wrappers now delegate.
//
// Lock 0.2 contract (preserved verbatim from v1.A.2):
// 1. YON write via `appendLedgerRecord` is the source-of-truth.
// Throws on I/O failure → caller MUST treat as fatal.
// 2. DB cache upsert via the caller-supplied `insertCache` closure
// is best-effort. Failure is logged + non-fatal; the caller's
// `rebuild-index --ledger <name>` re-derives the cache from YON.
//
// Asymmetry note: `reinjectAuditRecord` and `reinjectProvenanceRecord`
// (the sync-side natural-key idempotency probes) are NOT collapsed here.
// Their natural keys differ:
// audit_log: (ts, action, target_type, target_id)
// provenance: (ts, target_type, target_id, src)
// Generalising over the natural-key tuple would add abstraction without
// removing meaningful duplication. They stay in their respective
// {audit,provenance}-write modules. v1.A.3 Phase 4 (E2 round-trip
// collapse) will rewrite both as single-trip INSERT OR IGNORE + RETURNING
// independently.

import type { Client } from "@libsql/client";

import { appendLedgerRecord } from "../yon/ledger-write.js";

// The cache surface the per-ledger DB row write lives behind. v1.A.3
// ships AUDIT + PROVENANCE; v1.A.5+ extends by appending entries.
export type LedgerRecordKind = "AUDIT" | "PROVENANCE";

export interface RecordToLedgerArgs {
  // Absolute path to the vault root — `<vault>/.lyt/ledgers/<ledgerName>.yon`
  // is the ledger file the record appends to.
  vaultPath: string;
  // Per-ledger libSQL client (audit.db | provenance.db post-v1.A.2c SPLIT).
  // Threaded through to the `insertCache` closure.
  db: Client;
  // The ledger's name (e.g. "audit", "provenance"). Determines the YON
  // file path under `<vault>/.lyt/ledgers/` and the message text in
  // the cache-failure console.error.
  ledgerName: string;
  // The YON record tag without leading `@` (e.g. "AUDIT", "PROVENANCE").
  recordType: string;
  // Field key/value pairs emitted in declaration order. Values are
  // scalars; the ledger writer quotes strings + emits numerics bare.
  fields: ReadonlyArray<readonly [string, string | number]>;
  // The src= identifier carried in the @STAMP record (e.g.
  // "flows/init", "lyt-runner/pre-write-hook").
  stampSrc: string;
  // ISO 8601 timestamp carried in BOTH the YON record's `ts` field
  // AND the chained @STAMP. Pre-formatted so caller controls the
  // canonical form (the audit/provenance wrappers normalise via
  // `new Date(args.ts).toISOString()` before calling).
  ts: string;
  // Best-effort cache upsert. Throws → recordToLedger logs + continues
  // (YON SoT remains the source of truth). Resolves → cacheInserted=true.
  insertCache: (db: Client) => Promise<void>;
}

export interface RecordToLedgerResult {
  // The YON ledger file the record was appended to.
  ledgerPath: string;
  // The ISO timestamp the YON record + chained @STAMP carry.
  ts: string;
  // The chain-hash from the @STAMP (`-` for the first record in a file).
  ledgerHash: string;
  // True if `insertCache` resolved; false if it threw (already logged).
  cacheInserted: boolean;
}

import { join } from "node:path";

// YON-first append → cache upsert. The Lock 0.2 contract carrier.
// Throws on YON-write failure (fatal — SoT). Logs + continues on
// cache-write failure (rebuild reconstructs).
export async function recordToLedger(args: RecordToLedgerArgs): Promise<RecordToLedgerResult> {
  const ledgerPath = join(args.vaultPath, ".lyt", "ledgers", `${args.ledgerName}.yon`);

  // Step 1 — YON SoT append (fatal on failure).
  const ledgerRes = appendLedgerRecord({
    ledgerPath,
    ledgerName: args.ledgerName,
    recordType: args.recordType,
    fields: args.fields,
    stampSrc: args.stampSrc,
    ts: args.ts,
  });

  // Step 2 — .db cache upsert (log on failure; non-fatal).
  let cacheInserted = false;
  try {
    await args.insertCache(args.db);
    cacheInserted = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `recordToLedger(${args.ledgerName}): YON write succeeded but .db cache insert failed: ${msg}. ` +
        `Run \`lyt vault rebuild-index --ledger ${args.ledgerName} <vault>\` to reconcile.`,
    );
  }

  return { ledgerPath, ts: args.ts, ledgerHash: ledgerRes.hash, cacheInserted };
}
