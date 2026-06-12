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

// Minimal frontmatter mutator — upserts `last_provenance:` into a markdown
// document's YAML frontmatter block.
//
// Scope: line-based, no full YAML parse. The hook never mutates user-managed
// frontmatter fields — it only inserts/replaces the single `last_provenance:`
// scalar at the top of the block, per arc-thoughts §11.4 step 3 + §11.6
// ("Don't materialize full chain in every markdown frontmatter — only the
// most-recent stamp via `last_provenance:` per arc §11.1"). Full chain stays
// in the libSQL `provenance` table per arc §11.2.
//
// Three cases:
// 1. No frontmatter block → prepend a fresh `---\nlast_provenance: …\n---\n`
// 2. Frontmatter contains an existing `last_provenance:` line → replace it
// 3. Frontmatter without `last_provenance:` → insert before the closing `---`
//
// `last_provenance:` value shape:
// "automator:metadata-filler/v0.1.0 ts=2026-05-29T...Z method=filler conf=1.0 hash=sha256:..."
// — a single-line scalar (no YAML maps) per arc §11.6 frontmatter ergonomics.

const FRONTMATTER_DELIM = "---";

export interface FrontmatterStampLine {
  src: string;
  ts: string; // ISO 8601
  method?: string;
  confidence?: number;
  hash?: string;
}

export function formatLastProvenanceValue(stamp: FrontmatterStampLine): string {
  // Single-line scalar; YAML-safe per ergonomics target. Quote the whole
  // value to keep colons in src/hash from confusing line-based downstream
  // tooling (e.g. grep / sed scripts).
  const parts: string[] = [`${stamp.src} ts=${stamp.ts}`];
  if (stamp.method !== undefined) parts.push(`method=${stamp.method}`);
  if (stamp.confidence !== undefined) parts.push(`conf=${stamp.confidence}`);
  if (stamp.hash !== undefined) parts.push(`hash=${stamp.hash}`);
  const joined = parts.join(" ");
  return `"${joined.replace(/"/g, '\\"')}"`;
}

export function upsertLastProvenance(content: string, stamp: FrontmatterStampLine): string {
  const value = formatLastProvenanceValue(stamp);
  const lineToInsert = `last_provenance: ${value}`;

  const lines = content.split(/\r?\n/);

  // Detect frontmatter: first non-empty line must be `---`.
  let firstNonEmptyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      firstNonEmptyIdx = i;
      break;
    }
  }

  if (firstNonEmptyIdx === -1 || lines[firstNonEmptyIdx] !== FRONTMATTER_DELIM) {
    // Case 1: no frontmatter — prepend a fresh block.
    const trailing = content.length > 0 && !content.startsWith("\n") ? content : content;
    return `---\n${lineToInsert}\n---\n${trailing}`;
  }

  // Find the closing delimiter.
  let closeIdx = -1;
  for (let i = firstNonEmptyIdx + 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIM) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Malformed frontmatter (open but no close) — treat as "no frontmatter"
    // and prepend a fresh block. The handler's broken doc isn't our fix.
    return `---\n${lineToInsert}\n---\n${content}`;
  }

  // Case 2: replace existing last_provenance: line, if present.
  for (let i = firstNonEmptyIdx + 1; i < closeIdx; i++) {
    if (lines[i]!.startsWith("last_provenance:") || lines[i]!.startsWith("last_provenance :")) {
      lines[i] = lineToInsert;
      return lines.join("\n");
    }
  }

  // Case 3: insert before the closing `---`.
  lines.splice(closeIdx, 0, lineToInsert);
  return lines.join("\n");
}
