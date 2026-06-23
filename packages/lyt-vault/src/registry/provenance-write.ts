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

// YON-first provenance writer — Lock 0.2 contract mirror of audit-write.ts.
//
// Same shape: append `@PROVENANCE` + `@STAMP` to
// `<vault>/.lyt/ledgers/provenance.yon` (atomic tmp+rename), then upsert
// the `provenance` table in `.lyt/indexes/provenance.db` (post-v1.A.2c DB
// SPLIT) via the existing `insertProvenance` helper. YON failure is fatal;
// .db failure is logged + non-fatal.

import { existsSync, readdirSync, statSync } from "node:fs";
import type { Client } from "@libsql/client";
import { join } from "node:path";

import { newUuidv7Bytes } from "../util/uuid7.js";
import { parseLedgerFile, walkLedger, type LedgerRecord } from "../yon/ledger-read.js";
import { recordToLedger } from "./ledger-write-generic.js";
import {
  insertProvenance,
  type InsertProvenanceArgs,
  type ProvenanceWriteTargetType,
} from "./vault-db-repo.js";

export interface RecordProvenanceArgs extends InsertProvenanceArgs {
  // The flow / module name that triggered the write — carried in @STAMP.
  // Distinct from `src` which is the provenance-domain attribution
  // (`automator:metadata-filler/v0.1.0` etc.) and survives into the
  // libSQL `provenance.src` column.
  stampSrc: string;
  // Test seam — override the writer id (defaults to getWriterId()).
  // Determines which per-writerId shard file this record lands in.
  writerId?: string;
}

export interface RecordProvenanceResult {
  ledgerPath: string;
  ts: string;
  ledgerHash: string;
  cacheInserted: boolean;
}

// Slice 2b: the provenance shard DIRECTORY.
// New writes land in `<dir>/<writerId>.yon`; the legacy flat `provenance.yon`
// is walked as a synthetic "legacy" shard on read (see walkAllProvenanceShards).
export function getProvenanceLedgerDir(vaultPath: string): string {
  return join(vaultPath, ".lyt", "ledgers", "provenance");
}

// Returns the LEGACY single-file path `<vault>/.lyt/ledgers/provenance.yon`.
// @deprecated New writes use the per-writerId shard (Slice 2b).
export function getProvenanceLedgerPath(vaultPath: string): string {
  return join(vaultPath, ".lyt", "ledgers", "provenance.yon");
}

// Enumerate the writerId shard names present under the provenance shard directory.
// Mirrors listAuditShards in audit-write.ts.
export function listProvenanceShards(vaultPath: string): string[] {
  const dir = getProvenanceLedgerDir(vaultPath);
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

// Walk ALL provenance records across every shard + the legacy flat file.
// Mirrors walkAllAuditShards in audit-write.ts.
export function walkAllProvenanceShards(vaultPath: string): LedgerRecord[] {
  const shardDir = getProvenanceLedgerDir(vaultPath);
  const out: LedgerRecord[] = [];
  for (const writerId of listProvenanceShards(vaultPath)) {
    out.push(...walkLedger(shardDir, writerId));
  }
  // Legacy flat file read-tolerance.
  const legacyPath = getProvenanceLedgerPath(vaultPath);
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

// v1.A.3 (CR-2): body delegates to recordToLedger. Optional-field
// inclusion order matches the v1.A.2 emit shape (target_type, target_id,
// ts, src, then optional method/confidence/hash/tokens/cost_usd/model/
// approver/details_json) to preserve byte-stable provenance.yon output
// for downstream tooling (audit-export, rebuild-index walker).
export async function recordProvenance(
  vaultPath: string,
  db: Client,
  args: RecordProvenanceArgs,
): Promise<RecordProvenanceResult> {
  const tsIso = new Date(args.ts).toISOString();
  const fields: Array<readonly [string, string | number]> = [
    ["target_type", args.targetType],
    ["target_id", args.targetId],
    ["ts", tsIso],
    ["src", args.src],
  ];
  if (args.method !== undefined) fields.push(["method", args.method]);
  if (args.confidence !== undefined) fields.push(["confidence", args.confidence]);
  if (args.hash !== undefined) fields.push(["hash", args.hash]);
  if (args.tokens !== undefined) fields.push(["tokens", args.tokens]);
  if (args.costUsd !== undefined) fields.push(["cost_usd", args.costUsd]);
  if (args.model !== undefined) fields.push(["model", args.model]);
  if (args.approver !== undefined) fields.push(["approver", args.approver]);
  if (args.details !== undefined) fields.push(["details_json", JSON.stringify(args.details)]);

  return recordToLedger({
    vaultPath,
    db,
    ledgerName: "provenance",
    recordType: "PROVENANCE",
    fields,
    stampSrc: args.stampSrc,
    ts: tsIso,
    insertCache: (client) => insertProvenance(client, args),
    writerId: args.writerId,
  });
}

export type ProvenanceLedgerFields = Pick<
  InsertProvenanceArgs,
  | "targetType"
  | "targetId"
  | "ts"
  | "src"
  | "method"
  | "confidence"
  | "hash"
  | "tokens"
  | "costUsd"
  | "model"
  | "approver"
  | "details"
>;

// Re-inject a YON-walked provenance record into the .db cache. Idempotent
// on the natural key (ts, target_type, target_id, src).
//
// v1.A.3 (CR-4 / E2): single round-trip via INSERT ... SELECT ...
// WHERE NOT EXISTS pattern. Returns true on actual insert, false on
// no-op (filtered by WHERE NOT EXISTS). Symmetric with
// reinjectAuditRecord; application-enforced idempotency stays inside
// the single SQL statement.
export async function reinjectProvenanceRecord(
  db: Client,
  fields: ProvenanceLedgerFields,
): Promise<boolean> {
  const detailsJson = fields.details === undefined ? null : JSON.stringify(fields.details);
  const res = await db.execute({
    sql:
      "INSERT INTO provenance (id, target_type, target_id, ts, src, method, confidence, hash, tokens, cost_usd, model, approver, details_json) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM provenance WHERE ts = ? AND target_type = ? AND target_id = ? AND src = ?)",
    args: [
      newUuidv7Bytes(),
      fields.targetType,
      fields.targetId,
      fields.ts,
      fields.src,
      fields.method ?? null,
      fields.confidence ?? null,
      fields.hash ?? null,
      fields.tokens ?? null,
      fields.costUsd ?? null,
      fields.model ?? null,
      fields.approver ?? null,
      detailsJson,
      // WHERE NOT EXISTS clause args:
      fields.ts,
      fields.targetType,
      fields.targetId,
      fields.src,
    ],
  });
  return Number(res.rowsAffected) > 0;
}

export type { ProvenanceWriteTargetType };
