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

// Hand-rolled walker for per-vault append-only ledger YON files.
// Counterpart to `yon/ledger-write.ts`. Returns records in append order:
// archived month files first (chronological), then the current-month file.
//
// Tolerates unknown record types (yields as-is via `recordType`). Ignores
// `@DOC` headers + `@META` lines + blank lines + comment lines (`#`).
// `@STAMP` records are paired with the immediately-preceding non-stamp
// record (per writer contract — every record is followed by its @STAMP).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { sha256, unescapeQuoted } from "./_helpers.js";

export interface LedgerRecord {
  // The tag without leading `@`.
  recordType: string;
  // Parsed field map (insertion order preserved via Map).
  fields: Map<string, string>;
  // The associated @STAMP fields (always emitted by appendLedgerRecord —
  // null only if the file was hand-edited and a record lost its stamp).
  stampSrc: string | null;
  stampTs: string | null;
  stampHash: string | null;
  // P5-D advisory chain-hash marker. Set to `true` when this record carries a
  // verifiable chain-hash (`stampHash` not `-`/null) but the recomputed hash of
  // the file bytes BEFORE this record's body does NOT match the stored
  // `stampHash` — i.e. some earlier record's payload was edited without
  // re-stamping, so this record's chain link is broken. ADVISORY ONLY — the fold
  // still proceeds; this is a recompute-and-warn down-payment, NOT a rejection gate.
  //
  // ABSENT/false does NOT mean "verified authentic". It also covers: a first-in-
  // file record (`hash="-"`, never checked), a record whose `@STAMP` was stripped
  // (`stampHash===null` — NOT flagged; the guard skips null), and "not yet checked".
  // A future consumer MUST NOT read `!tamper` as trust.
  //
  // NAMED RESIDUALS → S5 (the trust-spine), NOT closed here:
  //  - tip-edit: editing the LAST record is uncatchable (no successor commits to it).
  //  - dropped-stamp on a non-first record (`stampHash===null`) is locally
  //    detectable but NOT flagged today.
  //  - a fully-self-consistent hostile shard (foreign writer recomputes the whole
  //    chain) passes recompute by construction.
  //  - BOM / final-newline / mid-history EOL drift share the CRLF root (see the
  //    recompute site); read-side LF-normalization closes the dominant case only.
  // Cost: the recompute re-hashes the full prefix per record (O(N²) per parse) —
  // fine at monthly-rotation shard sizes; incremental/rolling hashing is the
  // optimization if a shard grows large.
  tamper?: boolean;
  // Which file the record came from. Useful for tamper-warning context.
  sourceFile: string;
}

export interface WalkLedgerOptions {
  // ISO 8601 timestamp (or YYYY-MM prefix). When provided, archive files
  // whose YYYY-MM month-key (derived from filename) is older than
  // `since`'s YYYY-MM prefix are skipped entirely — no file read, no
  // parse. The current-month file is always parsed regardless of
  // `since`; the caller filters records by `stampTs` when needed.
  // v1.A.3 (CR-4 / E4) optimisation — cuts cold-rebuild cost from O(all
  // archive bytes) to O(since-or-later bytes).
  since?: string;
}

// Walk the ledger in chronological order. `<ledgerDir>/<ledgerName>/*.yon`
// archive files first (sorted by filename = YYYY-MM lexicographic =
// chronological), then `<ledgerDir>/<ledgerName>.yon` (current month).
//
// Returns an array because v1.A.2 callsites consume the full set (rebuild,
// audit-export fallback) and an AsyncIterable adds no benefit here. Future
// large-ledger scenarios can swap to streaming without API breakage —
// callers iterate the result either way.
//
// v1.A.3 (CR-4 / E4) delta-mode: pass `{ since: "YYYY-MM[-...]" }` to
// skip archive files older than the since-month — useful for incremental
// rebuild flows that only need recent history.
export function walkLedger(
  ledgerDir: string,
  ledgerName: string,
  options: WalkLedgerOptions = {},
): LedgerRecord[] {
  const sinceMonth = options.since !== undefined ? options.since.slice(0, 7) : null;
  const results: LedgerRecord[] = [];
  const archiveDir = join(ledgerDir, ledgerName);
  if (existsSync(archiveDir) && safeIsDir(archiveDir)) {
    const archiveFiles = readdirSync(archiveDir)
      .filter((n) => n.endsWith(".yon"))
      .sort(); // YYYY-MM.yon lexicographic = chronological
    for (const name of archiveFiles) {
      // Archive filenames are YYYY-MM.yon — strip the .yon and compare
      // the lex-sorted YYYY-MM prefix against `since`. If sinceMonth is
      // strictly greater, skip the file entirely (no parse, no read).
      if (sinceMonth !== null) {
        const fileMonth = name.replace(/\.yon$/, "").slice(0, 7);
        if (fileMonth.length === 7 && fileMonth < sinceMonth) {
          continue;
        }
      }
      const filePath = join(archiveDir, name);
      results.push(...parseLedgerFile(filePath));
    }
  }
  const currentPath = join(ledgerDir, `${ledgerName}.yon`);
  if (existsSync(currentPath)) {
    results.push(...parseLedgerFile(currentPath));
  }
  return results;
}

// Parse a single ledger file. Block boundaries: a record starts at any
// line beginning with `@` (other than `@DOC` / `@META` / `@STAMP` —
// those are header/meta/stamp respectively). The block runs through every
// `  | ...` continuation line until the next `@` or EOF.
export function parseLedgerFile(filePath: string): LedgerRecord[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  // P5-D: char offset of the START of `lines[k]` within `content`. Built once so
  // the chain-hash recompute can slice `content` from offset 0 up to (not
  // including) each record body's first byte — byte-identical to what the writer
  // hashed (`prior` = the file text before the appended record). Tracking the
  // per-line offset is the only place that survives the `\r?\n` split (which
  // discards the exact newline run); `content.slice(0, off)` reproduces the
  // original bytes (incl. CR/LF) verbatim because `slice` works on the raw string.
  const lineOffsets = computeLineOffsets(content, lines);
  const out: LedgerRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.length === 0 || line.startsWith("#")) {
      i += 1;
      continue;
    }
    // Skip header/meta lines.
    if (line.startsWith("@DOC ") || line.startsWith("@META ")) {
      i += 1;
      continue;
    }
    // Skip stand-alone @STAMP lines that appear without a preceding record
    // (shouldn't happen in well-formed ledgers; tolerated for resilience).
    if (line.startsWith("@STAMP ")) {
      i += 1;
      continue;
    }
    // Record line.
    if (line.startsWith("@")) {
      // The byte offset where THIS record's body begins = the start of its
      // header line. `content.slice(0, recordStartOffset)` is the writer's
      // `prior` for this record's @STAMP chain-hash.
      const recordStartOffset = lineOffsets[i]!;
      const blockLines: string[] = [line];
      i += 1;
      while (i < lines.length) {
        const next = lines[i]!;
        // Continuation lines start with whitespace + `|`.
        if (next.startsWith("  | ") || next.startsWith("\t| ")) {
          blockLines.push(next);
          i += 1;
          continue;
        }
        break;
      }
      const recordType = parseRecordType(blockLines[0]!);
      const fields = parseFields(blockLines);
      // Look for the @STAMP immediately following (allowing blank lines).
      let stamp: { src: string; ts: string; hash: string } | null = null;
      while (i < lines.length) {
        const next = lines[i]!;
        if (next.length === 0) {
          i += 1;
          continue;
        }
        if (next.startsWith("@STAMP ")) {
          stamp = parseStampLine(next);
          i += 1;
          break;
        }
        break;
      }
      const stampHash = stamp?.hash ?? null;
      // P5-D recompute-AND-WARN: only meaningful when the record carries a real
      // chain-hash (not the first-in-file sentinel `-`, not a missing stamp).
      // Recompute sha256 of the file bytes BEFORE this record's body and compare;
      // a mismatch means an earlier record's payload was edited without
      // re-stamping (this record is the successor whose recorded `prior` no longer
      // matches the on-disk `prior`). Advisory only — we attach a marker, never
      // throw or drop the record.
      let tamper: boolean | undefined;
      if (stampHash !== null && stampHash !== "-") {
        // C1: normalize CRLF→LF before hashing. The writer ALWAYS emits LF, so
        // stored hashes are over LF bytes; a shard CRLF-converted in transit
        // (Windows core.autocrlf, an editor) must NOT false-flag. This neutralizes
        // ONLY the EOL encoding — a payload change still mismatches, so real tamper
        // is still caught. Closes the dominant cross-platform-sync case (LF-written
        // shard checked out CRLF). NOT fully closed (→ S5): a shard the writer
        // itself appended over while already CRLF (mid-history EOL drift), a BOM, or
        // an editor-added final newline — complete fix = writer-side normalization
        // and/or `.gitattributes eol=lf` baked into scaffolded vaults.
        const recomputed = sha256(content.slice(0, recordStartOffset).replace(/\r\n/g, "\n"));
        if (recomputed !== stampHash) tamper = true;
      }
      out.push({
        recordType,
        fields,
        stampSrc: stamp?.src ?? null,
        stampTs: stamp?.ts ?? null,
        stampHash,
        ...(tamper ? { tamper: true } : {}),
        sourceFile: filePath,
      });
      continue;
    }
    i += 1;
  }
  return out;
}

// Build the char offset of the start of each line in `lines` within `content`.
// `content.split(/\r?\n/)` discards the matched newline run (which may be `\n`
// or `\r\n`), so we cannot reconstruct offsets from line lengths alone. Instead
// we re-scan `content` once, advancing past each line + whatever newline run
// actually followed it in the original bytes. The result is byte-exact: for any
// line index k, `content.slice(0, lineOffsets[k])` is the original file text up
// to (not including) that line.
function computeLineOffsets(content: string, lines: string[]): number[] {
  const offsets: number[] = new Array(lines.length);
  let pos = 0;
  for (let k = 0; k < lines.length; k++) {
    offsets[k] = pos;
    pos += lines[k]!.length;
    // Consume the newline run that `split` removed (CR, LF, or CRLF). The final
    // line has no trailing newline → nothing to consume.
    if (content[pos] === "\r") pos += 1;
    if (content[pos] === "\n") pos += 1;
  }
  return offsets;
}

function parseRecordType(headerLine: string): string {
  // `@AUDIT ts="..." | ...` → "AUDIT"
  const m = headerLine.match(/^@(\w+)/);
  if (!m) return "";
  return m[1]!;
}

function parseFields(blockLines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  // First line: `@TAG key=value | key=value` OR `@TAG key=value` (single).
  // Continuation lines: `  | key=value`.
  const first = blockLines[0] ?? "";
  // Strip the leading `@TAG ` to get the rest of the field list.
  const firstRest = first.replace(/^@\w+\s*/, "");
  collectFields(firstRest, map);
  for (let i = 1; i < blockLines.length; i++) {
    const ln = blockLines[i]!;
    // Continuation line: `  | key=value` or `\t| key=value`.
    const stripped = ln.replace(/^\s*\|\s*/, "");
    collectFields(stripped, map);
  }
  return map;
}

function collectFields(segment: string, into: Map<string, string>): void {
  if (segment.length === 0) return;
  // Field pattern: key=<value>[|key=<value>...]
  // Values can be quoted strings (with escaped `\"` + `\\`) or bare tokens.
  // Walk character-by-character to preserve `|` inside quotes.
  let i = 0;
  while (i < segment.length) {
    // Skip leading whitespace + pipe separators.
    while (
      i < segment.length &&
      (segment[i] === " " || segment[i] === "\t" || segment[i] === "|")
    ) {
      i += 1;
    }
    if (i >= segment.length) break;
    // Read key (up to `=`).
    const keyStart = i;
    while (i < segment.length && segment[i] !== "=") i += 1;
    if (i >= segment.length) break;
    const key = segment.slice(keyStart, i).trim();
    // Allow `key:ts=...` and `key:float=...` shapes (yon type annotations).
    // The lookup key is everything before the first `:` for type-annotated
    // fields; ledger-read.ts callers don't distinguish (they consume the
    // string value).
    const lookupKey = key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
    i += 1; // consume `=`
    // Read value.
    if (segment[i] === '"') {
      // Quoted value: read until matching unescaped `"`.
      i += 1;
      const valStart = i;
      while (i < segment.length) {
        if (segment[i] === "\\") {
          i += 2;
          continue;
        }
        if (segment[i] === '"') break;
        i += 1;
      }
      const raw = segment.slice(valStart, i);
      i += 1; // consume closing `"`
      into.set(lookupKey, unescapeQuoted(raw));
    } else {
      // Bare value: read until ` |`, `\t|`, or end-of-segment.
      const valStart = i;
      while (i < segment.length) {
        if (segment[i] === "|") break;
        i += 1;
      }
      const raw = segment.slice(valStart, i).trimEnd();
      into.set(lookupKey, raw);
    }
  }
}

function parseStampLine(line: string): { src: string; ts: string; hash: string } {
  const map = new Map<string, string>();
  const rest = line.replace(/^@STAMP\s*/, "");
  collectFields(rest, map);
  return {
    src: map.get("src") ?? "",
    ts: map.get("ts") ?? "",
    hash: map.get("hash") ?? "",
  };
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
