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

// Metadata-filler automator body.
//
// Per arc-thoughts §6.13 Example 1 (LOCKED 2026-05-27) + the bundled
// declaration at packages/lyt-vault/src/scaffold/defaults/automators/
// metadata-filler.yon — archetype=filler, runtime=deterministic,
// llm_capability=none. Walks <vault>/notes/**/*.md, detects which of the
// 8 mandatory frontmatter fields (arc §3 contract — title, created,
// modified, tags, purpose, topic, mesh-visibility, weight) are missing,
// fills missing ones with deterministic defaults, and writes back via
// the pre-write @STAMP hook so provenance + audit_log + last_provenance:
// land per arc §11.4.
//
// Why this lives in @younndai/lyt — and not lyt-runner — block-B v1:
// runFiveStep's `runBody` is body-shape-agnostic; the meta CLI is the
// single place that knows which archetype maps to which TS function for
// v1. Future archetypes (rollup, ingest, lane-builder) add their own
// modules here and get dispatched by automator-bodies/index.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";

import type { Client } from "@libsql/client";
import { writeMarkdownWithStamp, type LytRunContext } from "@younndai/lyt-runner";

const MANDATORY_FIELDS = [
  "title",
  "created",
  "modified",
  "tags",
  "purpose",
  "topic",
  "mesh-visibility",
  "weight",
] as const;

type MandatoryField = (typeof MANDATORY_FIELDS)[number];

export interface MetadataFillerArgs {
  vaultPath: string;
  vaultDb: Client;
  automatorName: string; // e.g. "metadata-filler"
  automatorVersion: string; // e.g. "0.1.0"
  // v1.A.5 OPT-1 caller-side — pre-opened audit + provenance clients passed
  // through to writeMarkdownWithStamp.ledgerClients (skips per-call open/close).
  ledgerClients?: {
    auditDb: Client;
    provenanceDb: Client;
  };
}

export interface MetadataFillerOutcome {
  filesScanned: number;
  filesMutated: number;
  fieldsFilledTotal: number;
  // Vault-relative posix paths of every file the body wrote to. Useful for
  // the integration smoke + the result artifact's @PRE_WRITE_HOOK_TRACE.
  filesWritten: string[];
}

export async function runMetadataFillerBody(
  ctx: LytRunContext,
  args: MetadataFillerArgs,
): Promise<MetadataFillerOutcome> {
  const notesRoot = join(args.vaultPath, "notes");
  const targets = walkMarkdownFiles(notesRoot);
  const outcome: MetadataFillerOutcome = {
    filesScanned: targets.length,
    filesMutated: 0,
    fieldsFilledTotal: 0,
    filesWritten: [],
  };

  for (const absPath of targets) {
    const raw = readFileSync(absPath, "utf8");
    const filled = fillMissingMandatoryFields(raw, {
      filenameSlug: filenameSlug(absPath),
      now: new Date(ctx.startedAt).toISOString(),
    });
    if (filled.fieldsFilled.length === 0) continue;

    await writeMarkdownWithStamp(ctx, args.vaultDb, {
      path: absPath,
      content: filled.content,
      vaultRoot: args.vaultPath,
      stamp: {
        src: `automator:${args.automatorName}/v${args.automatorVersion}`,
        method: "filler",
        confidence: 1.0,
        details: { fields_filled: filled.fieldsFilled },
      },
      ...(args.ledgerClients !== undefined ? { ledgerClients: args.ledgerClients } : {}),
    });

    outcome.filesMutated += 1;
    outcome.fieldsFilledTotal += filled.fieldsFilled.length;
    outcome.filesWritten.push(toVaultRel(absPath, args.vaultPath));
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Frontmatter mutation (line-based; no full YAML parse — same posture as
// lyt-runner/hooks/frontmatter.ts upsertLastProvenance).
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIM = "---";

interface FillResult {
  content: string;
  fieldsFilled: MandatoryField[];
}

interface FillDefaults {
  filenameSlug: string; // e.g. "legacy-note" from "legacy-note.md"
  now: string; // ISO 8601
}

export function fillMissingMandatoryFields(raw: string, defaults: FillDefaults): FillResult {
  const lines = raw.split(/\r?\n/);
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      firstNonEmpty = i;
      break;
    }
  }
  // No frontmatter at all — prepend a fresh block with every mandatory field.
  if (firstNonEmpty === -1 || lines[firstNonEmpty] !== FRONTMATTER_DELIM) {
    const fresh = renderFreshFrontmatter(defaults);
    return {
      content: `${fresh}\n${raw}`,
      fieldsFilled: [...MANDATORY_FIELDS],
    };
  }
  // Walk the open frontmatter looking for the closing delim.
  let closeIdx = -1;
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIM) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Malformed (open with no close). Mirror upsertLastProvenance: prepend
    // a fresh block and leave the broken doc untouched below it.
    const fresh = renderFreshFrontmatter(defaults);
    return {
      content: `${fresh}\n${raw}`,
      fieldsFilled: [...MANDATORY_FIELDS],
    };
  }

  // Detect which mandatory fields are already present (key-only check; we
  // never overwrite an existing handler-managed value).
  const present = new Set<MandatoryField>();
  for (let i = firstNonEmpty + 1; i < closeIdx; i++) {
    const lineNoIndent = lines[i]!.replace(/^\s+/, "");
    for (const f of MANDATORY_FIELDS) {
      if (lineNoIndent.startsWith(`${f}:`) || lineNoIndent.startsWith(`${f} :`)) {
        present.add(f);
        break;
      }
    }
  }
  const missing = MANDATORY_FIELDS.filter((f) => !present.has(f));
  if (missing.length === 0) {
    return { content: raw, fieldsFilled: [] };
  }

  // Insert the missing fields right before the closing delim. Preserve the
  // input's line ending shape best-effort by re-joining with `\n` — the
  // hook re-serializes the file anyway.
  const insertions = missing.map((f) => `${f}: ${renderDefault(f, defaults)}`);
  lines.splice(closeIdx, 0, ...insertions);
  return {
    content: lines.join("\n"),
    fieldsFilled: missing,
  };
}

function renderFreshFrontmatter(defaults: FillDefaults): string {
  const body = MANDATORY_FIELDS.map((f) => `${f}: ${renderDefault(f, defaults)}`).join("\n");
  return `---\n${body}\n---`;
}

function renderDefault(field: MandatoryField, defaults: FillDefaults): string {
  switch (field) {
    case "title":
      return `"${defaults.filenameSlug}"`;
    case "created":
      return defaults.now;
    case "modified":
      return defaults.now;
    case "tags":
      return "[]";
    case "purpose":
      return '""';
    case "topic":
      return '""';
    case "mesh-visibility":
      return "local";
    case "weight":
      return "3";
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function walkMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(root, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(p);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkMarkdownFiles(p));
    } else if (stat.isFile() && p.toLowerCase().endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

function filenameSlug(absPath: string): string {
  const parts = absPath.split(/[\\/]/);
  const base = parts[parts.length - 1]!;
  return base.replace(/\.md$/i, "");
}

function toVaultRel(absPath: string, vaultRoot: string): string {
  return relative(vaultRoot, absPath).split(sep).join(posix.sep);
}

// Re-export for tests + future archetype consumers.
export { MANDATORY_FIELDS };
export { walkMarkdownFiles as _walkMarkdownFilesForTests };
