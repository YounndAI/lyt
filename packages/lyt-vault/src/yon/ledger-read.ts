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

import { unescapeQuoted } from "./_helpers.js";

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
      out.push({
        recordType,
        fields,
        stampSrc: stamp?.src ?? null,
        stampTs: stamp?.ts ?? null,
        stampHash: stamp?.hash ?? null,
        sourceFile: filePath,
      });
      continue;
    }
    i += 1;
  }
  return out;
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
