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
// Field names — the canonical set, in order.
// ---------------------------------------------------------------------------

/** All 8 mandatory fields of the v1 yai.lyt frontmatter contract, plus `meta`. */
export const FRONTMATTER_FIELDS = [
  "title",
  "created",
  "modified",
  "tags",
  "purpose",
  "topic",
  "mesh-visibility",
  "weight",
  "meta",
] as const;

export type FrontmatterField = (typeof FRONTMATTER_FIELDS)[number];

// ---------------------------------------------------------------------------
// Mandatory tokens — fields that pattern templates MUST supply a non-empty
// value for (or resolve via defaults).
//
// SEE ALSO: `pattern-run.ts` imports this constant to replace its own
// inline definition. The values MUST stay in sync with the `buildTokens()`
// defaults in pattern-run.ts (DEFAULT_MESH_VISIBILITY + DEFAULT_WEIGHT).
// ---------------------------------------------------------------------------

/** Fields that pattern-run validates non-empty when a template uses them. */
export const MANDATORY_FRONTMATTER_TOKENS = [
  "purpose",
  "topic",
  "mesh-visibility",
  "weight",
] as const;

export type MandatoryFrontmatterToken = (typeof MANDATORY_FRONTMATTER_TOKENS)[number];

// ---------------------------------------------------------------------------
// Defaults — author-supplied fields have no default (must be non-empty).
// ---------------------------------------------------------------------------

/** Default value for `mesh-visibility` when not supplied by the author. */
export const DEFAULT_MESH_VISIBILITY = "local";

/** Default value for `weight` when not supplied by the author. */
export const DEFAULT_WEIGHT = "3";

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

  // Check each field in the canonical order is present.
  for (const field of FRONTMATTER_FIELDS) {
    if (field === "meta") continue; // meta is optional
    if (!hasField(block, field)) {
      errors.push({ field, message: `missing field: ${field}` });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the raw frontmatter block (between --- delimiters), or null. */
function extractFrontmatterBlock(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---") {
      if (start === -1) {
        start = i;
      } else {
        end = i;
        break;
      }
    }
  }
  if (start === -1 || end === -1) return null;
  return lines.slice(start + 1, end).join("\n");
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
