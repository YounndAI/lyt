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

// YON-first audit_log writer — Lock 0.2 contract.
//
// Per master plan §0 Lock 0.2: every append-only journal is YON file (SoT) +
// auto-derived libSQL DB (cache). Block-A shipped audit_log as libSQL-only;
// v1.A.2 (this module) rebases it on YON SoT.
//
// Call site discipline: writers MUST go through `recordAudit` rather than
// calling `insertAuditLog` directly. `recordAudit`:
// 1. Appends a `@AUDIT ...` record + its `@STAMP` to
// `<vault>/.lyt/ledgers/audit.yon` (atomic tmp+rename per
// `yon/ledger-write.ts`)
// 2. Then `INSERT INTO audit_log` via the existing `insertAuditLog`
// helper. .db failure is logged + non-fatal (rebuild-index can
// reconstruct from YON). YON failure is fatal — throw.
//
// Sync post-pull (lyt-mesh sync.ts) walks the YON ledger + INSERT OR
// IGNOREs into audit_log so handlers who only pulled (didn't write) see
// other machines' audit entries.

import { existsSync, readdirSync, statSync } from "node:fs";
import type { Client } from "@libsql/client";
import { join } from "node:path";

import { newUuidv7Bytes } from "../util/uuid7.js";
import { parseLedgerFile, walkLedger, type LedgerRecord } from "../yon/ledger-read.js";
import { recordToLedger } from "./ledger-write-generic.js";
import { insertAuditLog, type InsertAuditLogArgs } from "./vault-db-repo.js";

export interface RecordAuditArgs extends InsertAuditLogArgs {
  // The flow / module name that triggered this write. Carried in the YON
  // record's @STAMP src= field. Conventionally a short kebab string like
  // "flows/automator-run" or "lyt-runner/pre-write-hook".
  stampSrc: string;
  // Test seam — override the writer id (defaults to getWriterId()).
  // Determines which per-writerId shard file this record lands in.
  writerId?: string;
}

export interface RecordAuditResult {
  // The YON ledger file path the record was appended to.
  ledgerPath: string;
  // The ISO timestamp the YON record + .db row both carry.
  ts: string;
  // The chain-hash from the YON @STAMP (`-` for the first record).
  ledgerHash: string;
  // True if the .db cache insert succeeded (false if it threw — YON write
  // already landed).
  cacheInserted: boolean;
}

// Slice 2b: the audit shard DIRECTORY (mirrors getSubscriptionsLedgerDir).
// New writes land in `<dir>/<writerId>.yon`; the legacy flat `audit.yon`
// is walked as a synthetic "legacy" shard on read (see walkAllAuditShards).
export function getAuditLedgerDir(vaultPath: string): string {
  return join(vaultPath, ".lyt", "ledgers", "audit");
}

// Returns the LEGACY single-file path `<vault>/.lyt/ledgers/audit.yon`.
// This path is still valid for read-tolerance (legacy shards) but new
// writes go to the shard dir. Callers that reference the old flat-file
// path should migrate to getAuditLedgerDir / walkAllAuditShards.
//
// @deprecated New writes use the per-writerId shard (Slice 2b).
// This path is kept for read-tolerance (legacy file present) and for
// audit-export / tests that inspect the on-disk shape.
export function getAuditLedgerPath(vaultPath: string): string {
  return join(vaultPath, ".lyt", "ledgers", "audit.yon");
}

// Enumerate the writerId shard names present under the audit shard directory.
// Mirrors listSubscriptionShards: a shard manifests as either a current file
// `<writerId>.yon` OR an archive subdir `<writerId>/`. Returns sorted list.
export function listAuditShards(vaultPath: string): string[] {
  const dir = getAuditLedgerDir(vaultPath);
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

// Walk ALL audit records across every shard + the legacy flat file.
// The shard dir is `<vault>/.lyt/ledgers/audit/` — each writerId is a shard
// named by walkLedger (current `<writerId>.yon` + archives `<writerId>/YYYY-MM.yon`).
// The legacy flat path `<vault>/.lyt/ledgers/audit.yon` is walked as a
// synthetic shard named "legacy" (read-tolerance for pre-2b data).
//
// This is the multi-shard union read that replaces the old single
// `walkLedger(ledgerDir, "audit")` calls.
export function walkAllAuditShards(vaultPath: string): LedgerRecord[] {
  const shardDir = getAuditLedgerDir(vaultPath);
  const out: LedgerRecord[] = [];
  // 1. Per-writerId shards under <vault>/.lyt/ledgers/audit/
  for (const writerId of listAuditShards(vaultPath)) {
    out.push(...walkLedger(shardDir, writerId));
  }
  // 2. Legacy flat file: <vault>/.lyt/ledgers/audit.yon treated as a shard.
  //    We walk it directly with parseLedgerFile (not walkLedger) because
  //    walkLedger would look for an archive subdir at the same path as the
  //    new shard directory — overlap risk. parseLedgerFile reads only the
  //    flat file, which is exactly what we want for legacy read-tolerance.
  const legacyPath = getAuditLedgerPath(vaultPath);
  if (existsSync(legacyPath)) {
    out.push(...parseLedgerFile(legacyPath));
  }
  return out;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Write an audit record YON-first, then upsert .db cache. Throws on YON
// write failure (fatal — SoT contract). Logs + continues on .db failure.
// v1.A.3 (CR-2): body collapses to a one-line delegate to recordToLedger
// (the Lock 0.2 dance now lives in ./ledger-write-generic.ts).
export async function recordAudit(
  vaultPath: string,
  db: Client,
  args: RecordAuditArgs,
): Promise<RecordAuditResult> {
  const tsIso = new Date(args.ts).toISOString();
  return recordToLedger({
    vaultPath,
    db,
    ledgerName: "audit",
    recordType: "AUDIT",
    fields: [
      ["ts", tsIso],
      ["actor", args.actor],
      ["action", args.action],
      ["target_type", args.targetType],
      ["target_id", args.targetId],
      ["result", args.result ?? "success"],
      ...(args.details !== undefined
        ? ([["details_json", JSON.stringify(args.details)]] as Array<readonly [string, string]>)
        : []),
    ],
    stampSrc: args.stampSrc,
    ts: tsIso,
    insertCache: (client) => insertAuditLog(client, args),
    writerId: args.writerId,
  });
}

// Bookkeeping shape used by `flows/sync-metadata` + `lyt sync` post-pull
// upsert paths. Mirrors `insertAuditLog`'s shape but tagged for ledger
// reconstruction so a future rebuilder can distinguish records sourced
// from YON-walk vs new writes.
export type AuditLedgerFields = Pick<
  InsertAuditLogArgs,
  "ts" | "actor" | "action" | "targetType" | "targetId" | "result" | "details"
>;

// Re-inject a YON-walked record into the .db cache. Idempotent on the
// natural key (ts, action, target_type, target_id).
//
// v1.A.3 (CR-4 / E2): single round-trip via INSERT ... SELECT ...
// WHERE NOT EXISTS pattern — replaces the prior 2-call probe + insert
// sequence. Returns true when a row was actually inserted (rowsAffected
// > 0), false when the WHERE NOT EXISTS branch filtered the no-op.
// No schema change required — application-enforced idempotency stays
// inside the single SQL statement.
export async function reinjectAuditRecord(db: Client, fields: AuditLedgerFields): Promise<boolean> {
  const detailsJson = fields.details === undefined ? null : JSON.stringify(fields.details);
  const res = await db.execute({
    sql:
      "INSERT INTO audit_log (id, ts, actor, action, target_type, target_id, result, details_json) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE ts = ? AND action = ? AND target_type = ? AND target_id = ?)",
    args: [
      newUuidv7Bytes(),
      fields.ts,
      fields.actor,
      String(fields.action),
      fields.targetType,
      fields.targetId,
      fields.result ?? "success",
      detailsJson,
      // WHERE NOT EXISTS clause args:
      fields.ts,
      String(fields.action),
      fields.targetType,
      fields.targetId,
    ],
  });
  return Number(res.rowsAffected) > 0;
}
