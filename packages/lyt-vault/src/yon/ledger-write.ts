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

// Hand-rolled writer for append-only ledger YON files — e.g. the per-`writerId`
// audit/provenance shards `<vault>/.lyt/ledgers/{audit,provenance}/<writerId>.yon`
// (resharded from the former flat `audit.yon`/`provenance.yon` in Slice 2b).
// Generic across ledger types — the record
// shape is determined by `recordType` + `fields` at call time.
//
// Why hand-rolled: matches the `yon/federation-write.ts` + `yon/vault.ts`
// precedent. `@younndai/yon-parser` runtime dep is deferred to v1.A.3 per
// project posture.
//
// Atomicity contract: every `appendLedgerRecord` call writes the new tail
// (existing-content + record + @STAMP) to a tmp file in the same directory
// then `rename`s over the target — this is atomic on every supported OS
// per POSIX `rename(2)` + NTFS `MoveFileEx` MOVEFILE_REPLACE_EXISTING
// (rename within the same volume is metadata-only). A crash mid-write
// leaves either the prior file or the new file; never a partial file.
//
// Chain-hash contract: every `@STAMP` carries `hash="<sha256-of-prior-record-bytes>"`
// — for the first record in a file, `hash="-"`. Tamper detection lives at
// rebuild time: the walker re-computes the chain and warns on mismatch
// (cheap to compute, expensive to forge). Per arc §11.4 + brief
// clause (h).
//
// v1.A.2 ships @AUDIT + @PROVENANCE record types; new types are appended
// by passing `recordType="@MY_TYPE"` at the call site. The writer is
// vocabulary-agnostic.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { withDestinationPolicyLock } from "../flows/federation/destination-policy-lock.js";
import { assertNoReparsePointInPath } from "../util/write-path-guard.js";
import { escapeQuoted, sha256 } from "./_helpers.js";

// v1.A.3 (CR-4 / E1) per-process post-write cache. It is bookkeeping only:
// once the cross-process destination lock is held, every append re-reads the
// authoritative current bytes. File size is not a content discriminator — a
// same-length replacement must never let a stale cached preimage erase records.
//
// Memory: grows with total cached ledger content (bounded by monthly
// rotation = typically <1MB per active ledger per process). Cache is
// explicitly cleared on rotation via `clearLedgerCache`.
interface LedgerCacheEntry {
  // The full content of the ledger file as it was after our last successful
  // atomic replace. It is never authoritative for a later append.
  content: string;
  // sha256 hex of `content`. Used as the chain-hash for the next record.
  contentSha: string;
}

const LEDGER_CACHE = new Map<string, LedgerCacheEntry>();

// Public reset helper — invoked by `lyt housekeep` after a rotation
// renames the current-month file out from under us, and by tests that
// exercise multi-write scenarios across cache boundaries.
export function clearLedgerCache(ledgerPath?: string): void {
  if (ledgerPath === undefined) {
    LEDGER_CACHE.clear();
    return;
  }
  LEDGER_CACHE.delete(ledgerPath);
}

export interface AppendLedgerRecordArgs {
  // Absolute path to the current-month ledger file (e.g. a per-`writerId`
  // shard `<vault>/.lyt/ledgers/audit/<writerId>.yon`). Parent dir mkdir'd lazily.
  ledgerPath: string;
  // The ledger name used in the file's header line (e.g. "audit").
  ledgerName: string;
  // The record tag without the leading `@` (e.g. "AUDIT", "PROVENANCE").
  recordType: string;
  // Field key/value pairs emitted in declaration order. Values are scalars
  // (string/number); the writer quotes strings + emits numerics bare.
  fields: ReadonlyArray<readonly [string, string | number]>;
  // The src= identifier carried in the @STAMP record (e.g.
  // "flows/automator-run", "lyt-runner/pre-write-hook").
  stampSrc: string;
  // Optional ISO timestamp override for testing determinism. Defaults to
  // `new Date().toISOString()`.
  ts?: string;
}

export interface AppendLedgerRecordResult {
  // The ISO timestamp the @STAMP carries.
  ts: string;
  // The sha256 hex of the prior record's bytes (`-` for the first record).
  hash: string;
  // True if the writer initialised the file (was missing or empty).
  initialised: boolean;
}

export interface RotateLedgerFileArgs {
  ledgerPath: string;
  archivedPath: string;
  ledgerName: string;
  fromMonth: string;
  toMonth: string;
  stampSrc: string;
}

/** Rotate and recreate one shard while holding the exact lock used by append. */
export function rotateLedgerFile(args: RotateLedgerFileArgs): boolean {
  assertNoReparsePointInPath(args.ledgerPath);
  assertNoReparsePointInPath(args.archivedPath);
  return withDestinationPolicyLock(`${args.ledgerPath}.append.lock`, () => {
    assertNoReparsePointInPath(args.ledgerPath);
    assertNoReparsePointInPath(args.archivedPath);
    // Two housekeepers may make the same rotation decision before either gets
    // the append lock. The first archive generation is authoritative; a later
    // claimant must not replace it with the freshly recreated current shard.
    if (existsSync(args.archivedPath)) return false;
    mkdirSync(dirname(args.archivedPath), { recursive: true });
    renameSync(args.ledgerPath, args.archivedPath);
    const tmpPath = `${args.ledgerPath}.${process.pid}-${randomUUID()}.tmp`;
    assertNoReparsePointInPath(tmpPath);
    writeFileSync(tmpPath, renderHeader(args.ledgerName, args.toMonth), { encoding: "utf8", flag: "wx" });
    assertNoReparsePointInPath(args.ledgerPath);
    assertNoReparsePointInPath(args.archivedPath);
    assertNoReparsePointInPath(tmpPath);
    renameSync(tmpPath, args.ledgerPath);
    clearLedgerCache(args.ledgerPath);
    appendLedgerRecordLocked({
      ledgerPath: args.ledgerPath,
      ledgerName: args.ledgerName,
      recordType: "ROTATION",
      fields: [
        ["from_month", args.fromMonth],
        ["to_month", args.toMonth],
        ["archived_path", args.archivedPath],
      ],
      stampSrc: args.stampSrc,
    });
    return true;
  }, { acquireTimeoutMs: 5_000, leaseMs: 30_000, subject: args.ledgerPath });
}

// Append a single ledger record + its @STAMP to the current-month file.
// Atomic via tmp+rename. Initialises an empty file with a header on first
// write. Throws on I/O failure — callers MUST treat YON-write failure as
// fatal (it's the SoT contract per Lock 0.2).
//
// The authoritative preimage is always read fresh while holding the same-shard
// destination lock. The post-write cache is updated only after atomic replace.
export function appendLedgerRecord(args: AppendLedgerRecordArgs): AppendLedgerRecordResult {
  assertNoReparsePointInPath(args.ledgerPath);
  ensureParentDir(args.ledgerPath);
  assertNoReparsePointInPath(args.ledgerPath);
  return withDestinationPolicyLock(
    `${args.ledgerPath}.append.lock`,
    () => appendLedgerRecordLocked(args),
    { acquireTimeoutMs: 5_000, leaseMs: 30_000, subject: args.ledgerPath },
  );
}

function appendLedgerRecordLocked(args: AppendLedgerRecordArgs): AppendLedgerRecordResult {
  assertNoReparsePointInPath(args.ledgerPath);
  const ts = args.ts ?? new Date().toISOString();
  const monthKey = monthKeyFromIsoTs(ts);

  let prior = existsSync(args.ledgerPath) ? readFileSync(args.ledgerPath, "utf8") : "";
  let initialised = false;
  if (prior.length === 0) {
    prior = renderHeader(args.ledgerName, monthKey);
    initialised = true;
  }

  // Chain-hash: sha256 of the prior file's bytes (header-only on first
  // write → still produces a stable hash; tamper detection works from
  // record #1 forward).
  const hash = initialised ? "-" : sha256(prior);

  const recordBody = renderRecord(args.recordType, args.fields);
  const stampBody = renderStamp({ src: args.stampSrc, ts, hash });
  const appended = `${prior}${recordBody}\n${stampBody}\n`;

  // Atomic write: tmp + rename. The tmp suffix encodes pid + a counter so
  // concurrent appends in the same process can't collide on the tmp name.
  // (libSQL file-lock semantics on Windows further serialise — but the
  // YON layer is fs-only so we provide our own guard.)
  const tmpPath = `${args.ledgerPath}.${process.pid}-${tmpCounter()}.tmp`;
  assertNoReparsePointInPath(tmpPath);
  writeFileSync(tmpPath, appended, "utf8");
  assertNoReparsePointInPath(args.ledgerPath);
  renameSync(tmpPath, args.ledgerPath);

  // Post-write bookkeeping only. A later append still fresh-reads under lock.
  LEDGER_CACHE.set(args.ledgerPath, {
    content: appended,
    contentSha: sha256(appended),
  });

  return { ts, hash, initialised };
}

// Initialise an empty ledger file with a header (if missing or empty).
// Idempotent — re-running on a non-empty ledger is a no-op.
export function ensureLedgerHeader(
  ledgerPath: string,
  ledgerName: string,
  monthKey: string,
): boolean {
  assertNoReparsePointInPath(ledgerPath);
  ensureParentDir(ledgerPath);
  assertNoReparsePointInPath(ledgerPath);
  return withDestinationPolicyLock(`${ledgerPath}.append.lock`, () => {
    assertNoReparsePointInPath(ledgerPath);
    if (existsSync(ledgerPath)) {
      const existing = readFileSync(ledgerPath, "utf8");
      if (existing.length > 0) return false;
    }
    const tmpPath = `${ledgerPath}.${process.pid}-${tmpCounter()}.tmp`;
    writeFileSync(tmpPath, renderHeader(ledgerName, monthKey), "utf8");
    renameSync(tmpPath, ledgerPath);
    return true;
  }, { acquireTimeoutMs: 5_000, leaseMs: 30_000, subject: ledgerPath });
}

// Rendered as an opening @DOC + a `@META key=ledger_name | value=<name>`
// + `@META key=month | value=YYYY-MM`. The yon-parser tolerates this shape
// at `--profile full --lenient` (validated as part of v1.A.2 acceptance
// (m)).
function renderHeader(ledgerName: string, monthKey: string): string {
  return [
    `@DOC ver=2.0 | id=ledger:${ledgerName}:${monthKey} | domain=yai.lyt@1.0 | kind=cfg | profile=audit`,
    ``,
    `@META key=ledger_name | value=${ledgerName}`,
    `@META key=month | value=${monthKey}`,
    ``,
  ].join("\n");
}

function renderRecord(
  recordType: string,
  fields: ReadonlyArray<readonly [string, string | number]>,
): string {
  if (fields.length === 0) {
    return `@${recordType}\n`;
  }
  const lines: string[] = [];
  const [firstKey, firstVal] = fields[0]!;
  lines.push(`@${recordType} ${firstKey}=${formatValue(firstVal)}`);
  for (let i = 1; i < fields.length; i++) {
    const [k, v] = fields[i]!;
    lines.push(`  | ${k}=${formatValue(v)}`);
  }
  return lines.join("\n");
}

function renderStamp(args: { src: string; ts: string; hash: string }): string {
  // Stamp shape per arc §11 + yai-domain §3 @STAMP. v1.A.2 omits the
  // archetype-rich fields (method/confidence/tokens/cost/model) because
  // the ledger appender is the audit/provenance carrier; per-write hook
  // (lyt-runner) emits the rich form separately for note/declaration
  // writes.
  return `@STAMP ts:ts=${args.ts} | src="${escapeQuoted(args.src)}" | hash="${escapeQuoted(args.hash)}"`;
}

function formatValue(v: string | number): string {
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : `"${v}"`;
  }
  return `"${escapeQuoted(v)}"`;
}

function ensureParentDir(absPath: string): void {
  const parent = dirname(absPath);
  if (parent.length === 0) return;
  mkdirSync(parent, { recursive: true });
}

// Per-process counter for tmp filenames. Strictly monotonic so concurrent
// appends within the same ms can't collide.
let tmpCounterValue = 0;
function tmpCounter(): number {
  tmpCounterValue += 1;
  return tmpCounterValue;
}

export function monthKeyFromIsoTs(ts: string): string {
  // ISO 8601 ts → "YYYY-MM" (UTC). Pure-string slice — avoids Date timezone
  // round-trips that could land month-boundary records in the wrong file.
  return ts.slice(0, 7);
}
