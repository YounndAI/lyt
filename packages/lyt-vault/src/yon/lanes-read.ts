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

// Hand-rolled parser for `lanes.yon`. Counterpart to lanes-write.ts.
// Same precedent rationale as federation-read.ts: matches the line-walk
// shape; tolerates unknown @-prefixed records for forward-compatibility.
//
// Robustness: malformed @LANE / @LANE_MEMBER records (missing rid, missing
// mandatory fields) are SKIPPED rather than throwing — lanes.yon is
// regenerable via `lyt vault rebuild-lanes`, so a partial parse plus a
// surfaced warning beats hard-failing a sync.

import type { LaneMemberRecord, LaneRecord, LanesDoc } from "./lanes-write.js";
import { unescapeQuoted } from "./_helpers.js";

export function parseLanesFile(content: string): LanesDoc {
  const vaultName = parseVaultNameFromDoc(content) ?? "";
  const { lanes, members } = parseBlocks(content);
  return { vaultName, lanes, members };
}

interface ParsedBlocks {
  lanes: LaneRecord[];
  members: LaneMemberRecord[];
}

// Line-walk block extractor — same shape as federation-read.parseFedMeshes.
// Each @-prefixed line opens a block that runs through subsequent
// continuation lines (`  | ...`) and blanks until the next `@`-prefixed
// line. Unknown record types are walked but discarded.
function parseBlocks(content: string): ParsedBlocks {
  const lines = content.split(/\r?\n/);
  const lanes: LaneRecord[] = [];
  const members: LaneMemberRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("@")) {
      i++;
      continue;
    }
    const blockLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.length > 0 && next.startsWith("@")) break;
      blockLines.push(next);
      i++;
    }
    const block = blockLines.join("\n");
    if (line.startsWith("@LANE ") || line.startsWith("@LANE\t")) {
      const parsed = parseLaneBlock(block);
      if (parsed !== null) lanes.push(parsed);
    } else if (line.startsWith("@LANE_MEMBER ") || line.startsWith("@LANE_MEMBER\t")) {
      const parsed = parseLaneMemberBlock(block);
      if (parsed !== null) members.push(parsed);
    }
    // Other @-prefixed records (@DOC, future @META) are intentionally
    // skipped — forward-compat for richer doc headers.
  }
  return { lanes, members };
}

function parseLaneBlock(block: string): LaneRecord | null {
  const ridMatch = block.match(/^@LANE\s+rid=lane:([A-Za-z0-9._-]+)/m);
  if (!ridMatch) return null;
  const ridSlug = ridMatch[1]!;
  const name = readQuotedField(block, "name");
  const sourceKeywords = readQuotedList(block, "source_keywords");
  const memCount = readIntField(block, "mem_count");
  const lastBuilt = readTimestampField(block, "last_built");
  if (name === null || sourceKeywords === null || memCount === null || lastBuilt === null) {
    return null;
  }
  return {
    ridSlug,
    name,
    sourceKeywords,
    memCount,
    lastBuilt,
  };
}

function parseLaneMemberBlock(block: string): LaneMemberRecord | null {
  const laneRidMatch = block.match(/^@LANE_MEMBER\s+lane_rid=lane:([A-Za-z0-9._-]+)/m);
  if (!laneRidMatch) return null;
  const figmentPath = readQuotedField(block, "figment_rid");
  if (figmentPath === null) return null;
  return {
    laneRidSlug: laneRidMatch[1]!,
    figmentPath,
  };
}

function parseVaultNameFromDoc(content: string): string | null {
  const m = content.match(/^@DOC[^\n]*\sid=lanes:([^\s|]+)/m);
  return m ? m[1]! : null;
}

function readQuotedField(content: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}="((?:\\\\.|[^"\\\\])*)"`);
  const m = content.match(re);
  if (!m) return null;
  return unescapeQuoted(m[1]!);
}

function readQuotedList(content: string, key: string): string[] | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}=\\[([^\\]]*)\\]`);
  const m = content.match(re);
  if (!m) return null;
  const body = m[1]!.trim();
  if (body.length === 0) return [];
  const out: string[] = [];
  // Split on `,` between top-level quoted strings. Quoted values may
  // contain escaped commas via `\,` in YON's quoted-string contract; the
  // escapeQuoted/unescapeQuoted pair handles `"` and `\\` — commas inside
  // a quoted value just live there without escaping. Walk char-by-char.
  let buf = "";
  let inQuote = false;
  let escape = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (ch === "," && !inQuote) {
      out.push(unwrap(buf.trim()));
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(unwrap(buf.trim()));
  return out;
}

function unwrap(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return unescapeQuoted(token.slice(1, -1));
  }
  return token;
}

function readIntField(content: string, key: string): number | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}:int=(-?\\d+)`);
  const m = content.match(re);
  if (!m) return null;
  return Number.parseInt(m[1]!, 10);
}

function readTimestampField(content: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}:ts=(\\S+)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1]!;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type { LaneMemberRecord, LaneRecord, LanesDoc };
