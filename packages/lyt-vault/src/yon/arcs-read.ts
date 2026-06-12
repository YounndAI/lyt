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

// Hand-rolled parser for `arcs.yon`. Counterpart to arcs-write.ts.
// Same precedent rationale as lanes-read.ts: matches the line-walk
// shape; tolerates unknown @-prefixed records for forward-compatibility.
//
// In addition to `parseArcsFile` (which parses a whole `arcs.yon`
// document), this module exports `extractArcRecordsFromMarkdownBody` —
// used by `flows/rebuild-arcs.ts` to harvest embedded `@ARC` +
// `@ARC_MEMBER` records from inside Figment markdown bodies (per
// master-plan §v1.D.2a). Both call sites share the same block-walk +
// record-parser pair so the embedded vs file-level shapes can't drift.
//
// Robustness: malformed @ARC / @ARC_MEMBER records (missing rid, missing
// mandatory fields) are SKIPPED rather than throwing — arcs.yon is
// regenerable via `lyt vault rebuild-arcs`, so a partial parse plus a
// surfaced warning beats hard-failing a sync. Same posture as
// lanes-read's tolerance of unknown record types.

import type { ArcMemberRecord, ArcRecord, ArcsDoc } from "./arcs-write.js";
import { unescapeQuoted } from "./_helpers.js";

export function parseArcsFile(content: string): ArcsDoc {
  const vaultName = parseVaultNameFromDoc(content) ?? "";
  const { arcs, members } = parseBlocks(content);
  return { vaultName, arcs, members };
}

// Extract @ARC + @ARC_MEMBER records from a markdown body. The body
// argument should be the full markdown including any frontmatter (the
// walker just looks for `@`-prefixed lines, so the YAML frontmatter
// lines don't match and are walked past). Used by rebuild-arcs.ts's
// detection of two-source records (frontmatter `arcs:` array OR
// embedded YON block — per master-plan §v1.D.2a + brief OD-9).
export function extractArcRecordsFromMarkdownBody(body: string): {
  arcs: ArcRecord[];
  members: ArcMemberRecord[];
} {
  return parseBlocks(body);
}

interface ParsedBlocks {
  arcs: ArcRecord[];
  members: ArcMemberRecord[];
}

// Line-walk block extractor — same shape as lanes-read.parseBlocks.
// Each @-prefixed line opens a block that runs through subsequent
// continuation lines (`  | ...`) and blanks until the next `@`-prefixed
// line. Unknown record types are walked but discarded.
function parseBlocks(content: string): ParsedBlocks {
  const lines = content.split(/\r?\n/);
  const arcs: ArcRecord[] = [];
  const members: ArcMemberRecord[] = [];
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
    if (line.startsWith("@ARC ") || line.startsWith("@ARC\t")) {
      const parsed = parseArcBlock(block);
      if (parsed !== null) arcs.push(parsed);
    } else if (line.startsWith("@ARC_MEMBER ") || line.startsWith("@ARC_MEMBER\t")) {
      const parsed = parseArcMemberBlock(block);
      if (parsed !== null) members.push(parsed);
    }
    // Other @-prefixed records (@DOC, future @META, embedded @TASK /
    // @CLAIM from other domains) are intentionally skipped — forward-
    // compat for richer doc headers + embedded multi-domain blocks.
  }
  return { arcs, members };
}

function parseArcBlock(block: string): ArcRecord | null {
  const ridMatch = block.match(/^@ARC\s+rid=arc:([A-Za-z0-9._-]+)/m);
  if (!ridMatch) return null;
  const ridSlug = ridMatch[1]!;
  const name = readQuotedField(block, "name");
  const category = readQuotedField(block, "category");
  const lastTouched = readTimestampField(block, "last_touched");
  if (name === null || category === null || lastTouched === null) {
    return null;
  }
  return {
    ridSlug,
    name,
    category,
    lastTouched,
  };
}

function parseArcMemberBlock(block: string): ArcMemberRecord | null {
  const arcRidMatch = block.match(/^@ARC_MEMBER\s+arc_rid=arc:([A-Za-z0-9._-]+)/m);
  if (!arcRidMatch) return null;
  const figmentPath = readQuotedField(block, "figment_rid");
  const position = readIntField(block, "position");
  if (figmentPath === null || position === null) return null;
  return {
    arcRidSlug: arcRidMatch[1]!,
    figmentPath,
    position,
  };
}

function parseVaultNameFromDoc(content: string): string | null {
  const m = content.match(/^@DOC[^\n]*\sid=arcs:([^\s|]+)/m);
  return m ? m[1]! : null;
}

function readQuotedField(content: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}="((?:\\\\.|[^"\\\\])*)"`);
  const m = content.match(re);
  if (!m) return null;
  return unescapeQuoted(m[1]!);
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

export type { ArcMemberRecord, ArcRecord, ArcsDoc };
