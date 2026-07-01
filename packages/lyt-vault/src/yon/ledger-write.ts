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

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { escapeQuoted, sha256 } from "./_helpers.js";

// v1.A.3 (CR-4 / E1) per-process content-and-hash cache. The prior shape
// read the full ledger file on every append to compute the chain-hash
// (sha256 of prior bytes) — O(N) per write. Cache caps the read cost to
// once-per-process per ledgerPath, with size-based invalidation when
// another process appends concurrently between writes.
//
// Memory: grows with total cached ledger content (bounded by monthly
// rotation = typically <1MB per active ledger per process). Cache is
// invalidated on size mismatch detected via stat (cheap) before each
// append, and explicitly cleared on rotation via `clearLedgerCache`.
//
// Single-process correctness: writes within one process serialize via
// node's event loop — cache is always consistent. Cross-process: stat
// catches divergence; falls back to full re-read on mismatch.
interface LedgerCacheEntry {
  // The full content of the ledger file as it was after our last write.
  // Used as `prior` in the next append (avoiding the readFileSync call).
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

// Append a single ledger record + its @STAMP to the current-month file.
// Atomic via tmp+rename. Initialises an empty file with a header on first
// write. Throws on I/O failure — callers MUST treat YON-write failure as
// fatal (it's the SoT contract per Lock 0.2).
//
// v1.A.3 (CR-4 / E1): chain-hash is computed against a per-process content
// cache (LEDGER_CACHE) when fresh — drops the O(N) readFileSync + sha256
// to O(1) cache lookup per same-process write. Cache invalidates on
// size-mismatch detected via stat (cheap), or when housekeep rotation
// fires `clearLedgerCache`. Tamper detection unchanged: rebuild-index
// walker re-derives the chain from scratch as the authority.
export function appendLedgerRecord(args: AppendLedgerRecordArgs): AppendLedgerRecordResult {
  ensureParentDir(args.ledgerPath);
  const ts = args.ts ?? new Date().toISOString();
  const monthKey = monthKeyFromIsoTs(ts);

  let prior = "";
  let priorSha: string | null = null;
  let initialised = false;

  const cached = LEDGER_CACHE.get(args.ledgerPath);
  if (cached !== undefined && existsSync(args.ledgerPath)) {
    // Size-based cache validation — cheap stat call. If another process
    // appended between our writes, file size diverges from cached
    // content length → fall through to full re-read.
    const onDisk = statSync(args.ledgerPath).size;
    if (onDisk === Buffer.byteLength(cached.content, "utf8")) {
      prior = cached.content;
      priorSha = cached.contentSha;
    } else {
      LEDGER_CACHE.delete(args.ledgerPath);
    }
  }

  if (prior.length === 0) {
    if (existsSync(args.ledgerPath)) {
      prior = readFileSync(args.ledgerPath, "utf8");
    }
    if (prior.length === 0) {
      prior = renderHeader(args.ledgerName, monthKey);
      initialised = true;
    }
  }

  // Chain-hash: sha256 of the prior file's bytes (header-only on first
  // write → still produces a stable hash; tamper detection works from
  // record #1 forward).
  const hash = initialised ? "-" : (priorSha ?? sha256(prior));

  const recordBody = renderRecord(args.recordType, args.fields);
  const stampBody = renderStamp({ src: args.stampSrc, ts, hash });
  const appended = `${prior}${recordBody}\n${stampBody}\n`;

  // Atomic write: tmp + rename. The tmp suffix encodes pid + a counter so
  // concurrent appends in the same process can't collide on the tmp name.
  // (libSQL file-lock semantics on Windows further serialise — but the
  // YON layer is fs-only so we provide our own guard.)
  const tmpPath = `${args.ledgerPath}.${process.pid}-${tmpCounter()}.tmp`;
  writeFileSync(tmpPath, appended, "utf8");
  renameSync(tmpPath, args.ledgerPath);

  // E1 cache update — the next same-process append uses these without
  // re-reading or re-hashing the file.
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
  ensureParentDir(ledgerPath);
  if (existsSync(ledgerPath)) {
    const existing = readFileSync(ledgerPath, "utf8");
    if (existing.length > 0) return false;
  }
  writeFileSync(ledgerPath, renderHeader(ledgerName, monthKey), "utf8");
  return true;
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
