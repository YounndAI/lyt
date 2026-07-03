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

// Phase A — Frontmatter Schema-of-Truth (contract.ts)
//
// This file is the SINGLE canonical definition of the yai.lyt v1 8-field
// frontmatter contract. It centralises:
//   - The canonical field order (matches Obsidian display convention).
//   - Which fields are author-supplied (purpose, topic) vs. default-capable
//     (mesh-visibility, weight).
//   - MANDATORY_FRONTMATTER_TOKENS and FRONTMATTER_FIELDS — the CONSTANTS that
//     are the live Source-of-Truth, consumed by pattern-run.ts TODAY.
//   - buildFrontmatter / validateFrontmatterBlock — the FORWARD path wired into
//     scaffold writers in Phase B (not yet in production callers).
//
// WHAT IS LIVE NOW vs. FORWARD PATH:
//   CONSTANTS (MANDATORY_FRONTMATTER_TOKENS, DEFAULT_MESH_VISIBILITY,
//   DEFAULT_WEIGHT, FRONTMATTER_FIELDS) — consumed by pattern-run.ts
//   buildTokens() in Phase A. These are live and active today.
//
//   buildFrontmatter / validateFrontmatterBlock — scaffolded in Phase A for
//   the forward path. Today, only `knowledge-capture/templates/capture.md`
//   exercises the full emit path via tests; the 13 other pattern templates use
//   a different schema and buildFrontmatter has no production caller yet.
//   Phase B wires these into the scaffold writers (initVault lyt-overview.md /
//   agents.md). Until then they are tested utilities, not live production paths.
//
// WHY: before Phase A, `MANDATORY_FRONTMATTER_TOKENS` lived inline in
// `pattern-run.ts`. Centralising here ensures a single bump point when the
// contract evolves.
//
// SCOPE: governs READ/WRITE frontmatter for user Figments only. YON
// system files (vault.yon, memscope.yon, etc.) are NOT Figments and have
// their own renderers in src/yon/.
//
// COUPLED CONSTANT SEE ALSO: DEFAULT_MESH_VISIBILITY + DEFAULT_WEIGHT
// are echoed in `pattern-run.ts:buildTokens()` as the default token
// values injected when a template uses those tokens. The coupling is
// intentional and enforced via the contract round-trip test in
// tests/flows/phase-a-scaffold-exclusion.test.ts.

// ---------------------------------------------------------------------------
// Version constants — bumped here when the schema evolves; referenced in
// scaffold/init.ts to stamp vault.yon and in tests to pin the baseline.
// ---------------------------------------------------------------------------

/**
 * Phase A baseline contract version. Increment whenever FRONTMATTER_FIELDS
 * or MANDATORY_FRONTMATTER_TOKENS change semantics.
 */
export const FRONTMATTER_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// FRONTMATTER_CONTRACT — the single machine-readable descriptor (Phase B SoT).
//
// This is the ONE bump point for the yai.lyt v1 frontmatter contract. Every
// other constant in this file (FRONTMATTER_FIELDS, MANDATORY_FRONTMATTER_TOKENS,
// DEFAULT_MESH_VISIBILITY, DEFAULT_WEIGHT) is DERIVED from this descriptor — so a
// change here propagates and the two cannot silently diverge. The `lyt contract`
// verb surfaces this descriptor verbatim (`--json`) so downstream slices (capture
// --dir, topic picker, MCP schema, agent-manual generation) can CONSUME a single
// SoT instead of re-hand-coding the field list.
//
// A field's `source` classifies how its value is produced:
//   - "auto"      — structural, machine-supplied (title inferred, created/
//                   modified stamped, tags inferred). Not an author prompt.
//   - "author"    — AUTHOR-SUPPLIED, no default; capture PROMPTS when absent
//                   (purpose, topic). These are the mandatory non-defaultable ones.
//   - "default"   — default-capable; author MAY override, else the `defaultValue`
//                   is used (mesh-visibility → "local", weight → "3").
//   - "structural"— the `meta` container: optional, not one of the 8, no default.
// ---------------------------------------------------------------------------

/** How a field's value is produced. See FRONTMATTER_CONTRACT header. */
export type FrontmatterFieldSource = "auto" | "author" | "default" | "structural";

/** One field's contract row in the machine-readable SoT. */
export interface FrontmatterContractField {
  /** Canonical YAML key. */
  readonly name: string;
  /** 1-based canonical emit order (matches Obsidian display convention). */
  readonly order: number;
  /** How the value is produced (auto | author | default | structural). */
  readonly source: FrontmatterFieldSource;
  /** True for the 8 mandatory contract fields; false for `meta`. */
  readonly mandatory: boolean;
  /** True when pattern-run validates this token non-empty (or via default). */
  readonly mandatoryToken: boolean;
  /** Default value applied when absent; null when the field has no default. */
  readonly defaultValue: string | null;
  /** One-line human description. */
  readonly description: string;
}

/**
 * The canonical machine-readable frontmatter contract — the SINGLE
 * Source-of-Truth for the yai.lyt v1 8-field figment frontmatter, plus `meta`.
 * Ordered by `order`. Do NOT hand-maintain a parallel field list elsewhere:
 * derive from this (see the DERIVED constants below).
 */
export const FRONTMATTER_CONTRACT: readonly FrontmatterContractField[] = [
  {
    name: "title",
    order: 1,
    source: "auto",
    mandatory: true,
    mandatoryToken: false,
    defaultValue: null,
    description: "Inferred 5-8 word noun-phrase title, or explicitly supplied.",
  },
  {
    name: "created",
    order: 2,
    source: "auto",
    mandatory: true,
    mandatoryToken: false,
    defaultValue: null,
    description: "Auto ISO-8601 creation timestamp; equal to `modified` at capture.",
  },
  {
    name: "modified",
    order: 3,
    source: "auto",
    mandatory: true,
    mandatoryToken: false,
    defaultValue: null,
    description: "Auto ISO-8601 last-modified timestamp; maintained on regen.",
  },
  {
    name: "tags",
    order: 4,
    source: "auto",
    mandatory: true,
    mandatoryToken: false,
    defaultValue: null,
    description: "Inferred tag list; renders as an inline YAML array (`[]` when empty).",
  },
  {
    name: "purpose",
    order: 5,
    source: "author",
    mandatory: true,
    mandatoryToken: true,
    defaultValue: null,
    description: "AUTHOR-SUPPLIED: why this Figment is worth keeping. Prompted if absent.",
  },
  {
    name: "topic",
    order: 6,
    source: "author",
    mandatory: true,
    mandatoryToken: true,
    defaultValue: null,
    description: "AUTHOR-SUPPLIED: semantic category (e.g. planning, insight). Prompted if absent.",
  },
  {
    name: "mesh-visibility",
    order: 7,
    source: "default",
    mandatory: true,
    mandatoryToken: true,
    defaultValue: "local",
    description: "Visibility in the mesh (local | parent | public). Defaults to `local`.",
  },
  {
    name: "weight",
    order: 8,
    source: "default",
    mandatory: true,
    mandatoryToken: true,
    defaultValue: "3",
    description: "Relevance weight 1-5. Defaults to `3`.",
  },
  {
    name: "meta",
    order: 9,
    source: "structural",
    mandatory: false,
    mandatoryToken: false,
    defaultValue: null,
    description: "Optional extra key=value pairs the 8 fields don't cover; `{}` when unused.",
  },
] as const;

// ---------------------------------------------------------------------------
// Field names — the canonical set, in order. DERIVED from FRONTMATTER_CONTRACT
// (no parallel definition). Kept as a `readonly string[]` typed alias so
// existing consumers (validate loop, FTS parsers) keep the same import surface.
// ---------------------------------------------------------------------------

/** All 8 mandatory fields of the v1 yai.lyt frontmatter contract, plus `meta`. */
export const FRONTMATTER_FIELDS: readonly string[] = FRONTMATTER_CONTRACT.map((f) => f.name);

export type FrontmatterField = (typeof FRONTMATTER_CONTRACT)[number]["name"];

// ---------------------------------------------------------------------------
// Mandatory tokens — fields that pattern templates MUST supply a non-empty
// value for (or resolve via defaults). DERIVED from FRONTMATTER_CONTRACT
// (`mandatoryToken === true`), so it cannot drift from the descriptor.
//
// SEE ALSO: `pattern-run.ts` imports this constant to replace its own
// inline definition. The values MUST stay in sync with the `buildTokens()`
// defaults in pattern-run.ts (DEFAULT_MESH_VISIBILITY + DEFAULT_WEIGHT).
// ---------------------------------------------------------------------------

/** Fields that pattern-run validates non-empty when a template uses them. */
export const MANDATORY_FRONTMATTER_TOKENS: readonly string[] = FRONTMATTER_CONTRACT.filter(
  (f) => f.mandatoryToken,
).map((f) => f.name);

export type MandatoryFrontmatterToken =
  | "purpose"
  | "topic"
  | "mesh-visibility"
  | "weight";

// ---------------------------------------------------------------------------
// Defaults — author-supplied fields have no default (must be non-empty).
// DERIVED from FRONTMATTER_CONTRACT so the descriptor is the single bump point.
// `contractDefault` reads the descriptor's `defaultValue` for a field; a missing
// row / null default is a hard error (a build-time guarantee the descriptor and
// these consts stay coherent — no silent fallback).
// ---------------------------------------------------------------------------

function contractDefault(fieldName: string): string {
  const field = FRONTMATTER_CONTRACT.find((f) => f.name === fieldName);
  if (field === undefined || field.defaultValue === null) {
    throw new Error(
      `contract.ts: FRONTMATTER_CONTRACT has no default for "${fieldName}" — descriptor/const drift.`,
    );
  }
  return field.defaultValue;
}

/** Default value for `mesh-visibility` when not supplied by the author. */
export const DEFAULT_MESH_VISIBILITY = contractDefault("mesh-visibility");

/** Default value for `weight` when not supplied by the author. */
export const DEFAULT_WEIGHT = contractDefault("weight");

// ---------------------------------------------------------------------------
// FrontmatterFields type — the structured input for `buildFrontmatter`.
// ---------------------------------------------------------------------------

export interface FrontmatterInput {
  title: string;
  created: string;
  modified: string;
  /** Tags list. Renders as YAML inline array `[a, b]` or `[]` if empty. */
  tags?: readonly string[];
  /** Author-supplied: why this Figment is worth keeping. */
  purpose: string;
  /** Author-supplied: semantic category (e.g. "planning", "insight"). */
  topic: string;
  /** Visibility in the mesh. Default: "local". */
  "mesh-visibility"?: string;
  /** Relevance weight 1-5. Default: 3. */
  weight?: number | string;
  /** Extra key=value pairs rendered after `weight`. May be empty. */
  meta?: Record<string, string>;
  /** When true, emits `lyt-scaffold: true` after the standard 8 fields.
   *  Used by Lyt-authored seed Figments to opt out of FTS/primer indexing. */
  lytScaffold?: boolean;
}

// ---------------------------------------------------------------------------
// buildFrontmatter — the canonical frontmatter renderer.
//
// Renders a valid YAML frontmatter block (--- delimiters included).
// Field order matches `FRONTMATTER_FIELDS`; all fields are emitted even
// when empty (opinionated: a sparse frontmatter is harder to fill in later).
// ---------------------------------------------------------------------------

/**
 * Render a complete YAML frontmatter block for a Lyt Figment.
 *
 * @example
 * ```ts
 * const block = buildFrontmatter({
 *   title: "Planning session",
 *   created: "2026-06-25T10:00:00.000Z",
 *   modified: "2026-06-25T10:00:00.000Z",
 *   purpose: "Capture weekly plan",
 *   topic: "planning",
 * });
 * // → "---\ntitle: Planning session\ncreated: ...\n..."
 * ```
 */
export function buildFrontmatter(fields: FrontmatterInput): string {
  const meshVisibility = fields["mesh-visibility"] ?? DEFAULT_MESH_VISIBILITY;
  const weight = fields.weight ?? DEFAULT_WEIGHT;
  const tags = fields.tags ?? [];
  const tagsYaml =
    tags.length === 0 ? "[]" : `[${tags.map((t) => yamlScalar(t)).join(", ")}]`;

  const lines: string[] = [
    "---",
    `title: ${yamlScalar(fields.title)}`,
    `created: ${fields.created}`,
    `modified: ${fields.modified}`,
    `tags: ${tagsYaml}`,
    `purpose: ${yamlScalar(fields.purpose)}`,
    `topic: ${yamlScalar(fields.topic)}`,
    `mesh-visibility: ${yamlScalar(meshVisibility)}`,
    `weight: ${weight}`,
  ];

  // meta block — extra key=value pairs
  if (fields.meta !== undefined) {
    for (const [k, v] of Object.entries(fields.meta)) {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }

  // scaffold sentinel — must be the last field before the closing ---
  if (fields.lytScaffold === true) {
    lines.push("lyt-scaffold: true");
  }

  lines.push("---");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Validator — lightweight structural check used in tests + pattern-run.
// Returns a list of violated invariants (empty = valid).
// ---------------------------------------------------------------------------

export interface FrontmatterValidationError {
  field: FrontmatterField | "lyt-scaffold";
  message: string;
}

/**
 * Check that a rendered frontmatter block satisfies the v1 contract.
 * Parses the leading `---...---` block and checks each mandatory field.
 * Does NOT require author-supplied values — validates structure only.
 *
 * @returns Empty array if valid; array of errors otherwise.
 */
export function validateFrontmatterBlock(raw: string): FrontmatterValidationError[] {
  const errors: FrontmatterValidationError[] = [];
  const block = extractFrontmatterBlock(raw);
  if (block === null) {
    return [{ field: "title", message: "no frontmatter block found (missing --- delimiters)" }];
  }

  // Check each field in the canonical order is present. FRONTMATTER_FIELDS is
  // derived from FRONTMATTER_CONTRACT (typed `readonly string[]`); every name it
  // yields is by construction a FrontmatterField, so the cast on push is sound.
  for (const field of FRONTMATTER_FIELDS) {
    if (field === "meta") continue; // meta is optional
    if (!hasField(block, field)) {
      errors.push({ field: field as FrontmatterField, message: `missing field: ${field}` });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Phase A (UNIT 2) — date read-back.
//
// These are the FORWARD-path date utilities the scaffold regen (preserve-on-
// regen, C3) and the git-date consumers (migration / Phase C) consume. They
// read ONLY the `created` / `modified` fields of an existing frontmatter block;
// every other field (and the body) is preserved byte-for-byte. Never throw — a
// malformed figment must not break regen/index (resilience is a core objective).
// ---------------------------------------------------------------------------

export interface FrontmatterDates {
  /** ISO-8601 `created` (verbatim from frontmatter), or null when absent. */
  created: string | null;
  /** ISO-8601 `modified` (verbatim from frontmatter), or null when absent. */
  modified: string | null;
}

/**
 * Read the `created` / `modified` values verbatim from a figment's leading
 * frontmatter block. Returns `{ created: null, modified: null }` when there is
 * no frontmatter block or the fields are absent. Values are returned EXACTLY as
 * written (no normalization) so a preserve-on-regen re-emit is byte-stable.
 */
export function readFrontmatterDates(raw: string): FrontmatterDates {
  const block = extractFrontmatterBlock(raw);
  if (block === null) return { created: null, modified: null };
  return {
    created: fieldValue(block, "created"),
    modified: fieldValue(block, "modified"),
  };
}

/**
 * Rewrite ONLY the `modified` field of a figment's LEADING frontmatter block to
 * `iso`, preserving `created` and every other field/line. Idempotent when the
 * current `modified` already equals `iso`. Returns the input UNCHANGED when the
 * figment has no leading frontmatter block, or no `modified` field inside it
 * (this maintainer never fabricates a field the contract writer didn't emit —
 * that is the scaffold/capture writer's job). Never throws.
 *
 * CR-1 (Critical): the block is located via the SAME leading-anchored bounds as
 * the FTS parser (findFrontmatterBounds) — the rewrite scans ONLY lines strictly
 * between the opening and closing `---` of the LEADING block, so a body `---`
 * (thematic break) or a document with no leading frontmatter can never have its
 * content rewritten.
 *
 * Minor (quote-stripping asymmetry): the idempotence check compares the desired
 * `iso` against the UNQUOTED current value (matching readFrontmatterDates /
 * fieldValue), so a quoted `modified: "…"` that already holds `iso` is a no-op
 * rather than being needlessly rewritten to the bare form.
 *
 * Minor (CRLF uniform-normalization): the whole document is re-joined with a
 * SINGLE newline convention (`\r\n` iff the input contained any `\r\n`, else
 * `\n`). This keeps the emitted file uniform — it does not mix line endings —
 * and matches the split(/\r?\n/) read path so a round-trip is stable.
 */
export function stampModifiedFrontmatter(raw: string, iso: string): string {
  const lines = raw.split(/\r?\n/);
  const bounds = findFrontmatterBounds(lines);
  if (bounds === null) return raw;

  const modifiedRe = /^(\s*modified\s*:\s*)(.*?)(\s*)$/i;
  let touched = false;
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const m = lines[i]!.match(modifiedRe);
    if (!m) continue;
    // Compare against the UNQUOTED value so a quoted current value that already
    // equals `iso` is treated as already-current (quote-stripping symmetry).
    const currentUnquoted = m[2]!.replace(/^["']|["']$/g, "").trim();
    if (currentUnquoted === iso) return raw; // already current — idempotent no-op
    lines[i] = `${m[1]}${iso}`;
    touched = true;
    break;
  }
  if (!touched) return raw;

  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  return lines.join(nl);
}

/**
 * Convert a git committer/author epoch value into a normalized ISO-8601 string.
 *
 * THE ×1000 TRAP (Risk Register, HIGH): git's `%ct` / `%at` placeholders emit
 * epoch **SECONDS**, but JavaScript's `new Date(n)` expects **MILLISECONDS**.
 * Passing raw git seconds to `new Date()` yields a timestamp in ~1970 (the
 * seconds are interpreted as milliseconds — a ~1000× underscale). This helper
 * is the SINGLE conversion chokepoint: it multiplies epoch seconds by 1000
 * before constructing the Date, so every git-date consumer (Phase A `modified`
 * maintenance and, forward, Phase C's metadata-filler) shares one correct
 * conversion instead of re-deriving it and re-introducing 1970.
 *
 * @param epochSeconds git epoch SECONDS (e.g. the integer from `git log
 *   -1 --format=%ct`). Accepts a number or the raw string git prints.
 * @returns ISO-8601 UTC string, or null when the input is not a finite number.
 */
export function gitCommitterDateToIso(epochSeconds: number | string): string | null {
  const secs = typeof epochSeconds === "string" ? Number(epochSeconds.trim()) : epochSeconds;
  if (!Number.isFinite(secs)) return null;
  // ×1000: git SECONDS → JS MILLISECONDS. This multiplication IS the fix.
  return new Date(secs * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * First top-level `key: value` scalar from a frontmatter block, with a single
 * pair of surrounding quotes trimmed. Returns null when absent/empty. Mirrors
 * the lightweight regex scan used by the FTS index parsers (no heavyweight YAML
 * parse), so a value read here round-trips identically.
 */
function fieldValue(block: string, key: string): string | null {
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*:\\s*(.+?)\\s*$`, "im");
  const m = block.match(re);
  if (!m) return null;
  const v = m[1]!.replace(/^["']|["']$/g, "").trim();
  return v.length > 0 ? v : null;
}

/**
 * Extract the raw LEADING frontmatter block (between --- delimiters), or null.
 *
 * CR-1 (Critical) — LEADING-ANCHORED, byte-for-byte matching the FTS
 * `frontmatterBlock` parser in upsert-fts-cache.ts: the FIRST non-empty line
 * must be exactly `---`; otherwise there is NO frontmatter block (null). This
 * is NOT a scan for the first `---` anywhere in the file. A document with a
 * `---` horizontal rule / thematic break in its BODY (but no leading
 * frontmatter) therefore returns null here — so `stampModifiedFrontmatter`
 * (which locates the block the same leading-anchored way) can never latch onto
 * a body `---` and rewrite figment content. The read utilities
 * (readFrontmatterDates / validateFrontmatterBlock) share this anchor for the
 * same reason and to stay consistent with what the index actually reads.
 */
function findFrontmatterBounds(lines: readonly string[]): { start: number; end: number } | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  // BOM-tolerant open-fence check (release review): a leading UTF-8 BOM makes
  // the first line "﻿---", which a strict === "---" misses → the whole block
  // reads as absent and a fully-valid BOM-prefixed figment is mis-flagged as
  // "no frontmatter". Strip a leading BOM for the fence compare so this reader
  // agrees with the BOM-aware metadata-filler (fillMissingMandatoryFields) and the
  // g6 scaffold sentinel (indexable.ts) — otherwise a BOM figment the detect flags
  // can never be cleared by the heal (the filler sees it complete → writes nothing).
  const BOM = String.fromCodePoint(0xfeff);
  const firstLine = lines[first]!.startsWith(BOM) ? lines[first]!.slice(1) : lines[first]!;
  if (firstLine !== "---") return null;
  for (let i = first + 1; i < lines.length; i++) {
    if (lines[i] === "---") return { start: first, end: i };
  }
  return null;
}

function extractFrontmatterBlock(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  const bounds = findFrontmatterBounds(lines);
  if (bounds === null) return null;
  return lines.slice(bounds.start + 1, bounds.end).join("\n");
}

/** Check if a YAML key exists in the frontmatter block. */
function hasField(block: string, field: string): boolean {
  const re = new RegExp(`^${escapeRegex(field)}\\s*:`, "m");
  return re.test(block);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Emit a YAML scalar value. Wraps in double-quotes if the value contains
 * characters that would break plain YAML scalars. Handles the empty string.
 */
function yamlScalar(value: string): string {
  if (value.length === 0) return '""';
  // Needs quoting if it starts with special YAML chars or contains `: ` or `#`.
  if (/^[:{[>|&*!%@`'"\-?,]/.test(value) || /:\s/.test(value) || /#/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
