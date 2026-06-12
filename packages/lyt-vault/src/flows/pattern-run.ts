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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName } from "../registry/repo.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { getIdentity } from "../util/identity.js";
import { getUserPatternsDir } from "../util/pattern-paths.js";
import { parsePatternYon, type VerbRecord } from "../yon/pattern.js";
import { captureIndexFlow } from "./capture-index.js";

export interface PatternRunArgs {
  patternName: string;
  verbId: string;
  vaultName: string;
  project?: string | undefined;
  slug?: string | undefined;
  vars?: Record<string, string> | undefined;
}

export interface PatternRunResult {
  patternName: string;
  verbId: string;
  vaultName: string;
  vaultPath: string;
  filePath: string;
  filledFrom: string;
  alreadyExisted: boolean;
  // V-C-1 (L1 index-on-write): true when the figment was written but its
  // search-index update was deferred (an index failure that did NOT lose the
  // write). Undefined when no indexing was attempted (already-existed, or the
  // write landed outside the indexed `notes/` tree).
  indexDeferred?: boolean;
  // Soft, agent-visible note set alongside indexDeferred — surfaced by the CLI
  // so capture never fails silently (brief §0.5 #4).
  indexNote?: string;
}

const TOKEN_RE = /<([a-zA-Z][a-zA-Z0-9_-]*)>/g;

// Per yai.lyt v1 frontmatter contract (arc §3) — when a pattern template
// uses any of these tokens, the resolved value must be non-empty after
// substitution. `purpose` + `topic` are author-supplied; `mesh-visibility`
// and `weight` have defaults applied in buildTokens(). The mandatory list
// is checked AGAINST the actual template — patterns that do not opt into
// the contract are unaffected.
const MANDATORY_FRONTMATTER_TOKENS = ["purpose", "topic", "mesh-visibility", "weight"] as const;
const DEFAULT_MESH_VISIBILITY = "local";
const DEFAULT_WEIGHT = "3";

export async function patternRunFlow(args: PatternRunArgs): Promise<PatternRunResult> {
  const patternDir = join(getUserPatternsDir(), args.patternName);
  const yonPath = join(patternDir, "pattern.yon");
  if (!existsSync(yonPath)) {
    throw new Error(`pattern run: pattern '${args.patternName}' not installed.`);
  }
  const parsed = parsePatternYon(readFileSync(yonPath, "utf8"));
  const verb = parsed.verbs.find((v) => v.id === args.verbId);
  if (!verb) {
    throw new Error(
      `pattern run: pattern '${args.patternName}' has no verb '${args.verbId}'. Known: ${parsed.verbs.map((v) => v.id).join(", ")}`,
    );
  }

  const db = await openRegistry();
  let vaultPath: string;
  try {
    const row = await getVaultByName(db, args.vaultName);
    if (!row) {
      throw new Error(`pattern run: no vault named '${args.vaultName}' in registry.`);
    }
    vaultPath = row.path;
    // Track C Wave 3 F13 — every pattern-run verb is a content WRITE into the
    // vault (capture, decision, plan, …); the freeze gate was enforced on
    // add-edge/delete/forget but not here, so `lyt capture` wrote into a
    // frozen vault. Gate at the shared chokepoint: covers `lyt capture`,
    // `lyt pattern run`, and every /lyt-* skill that wraps them.
    await enforceNotFrozen(row.path, row.name);
  } finally {
    await closeRegistry(db);
  }

  const tokens = buildTokens({
    vaultPath,
    project: args.project,
    slug: args.slug,
    vars: args.vars,
  });
  const filePath = resolveFilePath(verb.pathGlob, tokens);
  if (existsSync(filePath)) {
    return {
      patternName: args.patternName,
      verbId: args.verbId,
      vaultName: args.vaultName,
      vaultPath,
      filePath,
      filledFrom: join(patternDir, "templates", verb.template),
      alreadyExisted: true,
    };
  }

  const templatePath = join(patternDir, "templates", verb.template);
  if (!existsSync(templatePath)) {
    throw new Error(
      `pattern run: template '${verb.template}' missing in pattern '${args.patternName}'.`,
    );
  }
  const templateBody = readFileSync(templatePath, "utf8");
  validateMandatoryFrontmatterTokens(templateBody, tokens, args.patternName, args.verbId);
  const rendered = renderTemplate(templateBody, tokens);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, rendered, "utf8");

  // V-C-1 (L1 index-on-write) — the figment is now on disk; index it so a
  // subsequent `lyt search` / `recall` / `primer` hits with NO manual reindex
  // (SC1/SC3). Gated to the indexed `notes/` tree: the FTS + lanes/arcs caches
  // scan `notes/**` only, so indexing a write that lands elsewhere (e.g. a
  // work-management figment under Projects/) would drift the incremental cache
  // from the full rebuild. captureIndexFlow NEVER throws — a failure returns
  // `deferred` (the markdown is already saved) which we surface as a soft note.
  const relPath = relative(vaultPath, filePath).split(sep).join(posix.sep);
  let indexDeferred: boolean | undefined;
  let indexNote: string | undefined;
  if (isUnderNotes(relPath)) {
    const idx = await captureIndexFlow({
      vaultName: args.vaultName,
      vaultPath,
      relPath,
    });
    if (idx.deferred) {
      indexDeferred = true;
      indexNote = idx.note;
    }
  }

  return {
    patternName: args.patternName,
    verbId: args.verbId,
    vaultName: args.vaultName,
    vaultPath,
    filePath,
    filledFrom: templatePath,
    alreadyExisted: false,
    ...(indexDeferred !== undefined ? { indexDeferred } : {}),
    ...(indexNote !== undefined ? { indexNote } : {}),
  };
}

// True when a vault-relative POSIX path is inside the indexed `notes/` tree
// (the FTS + lanes + arcs caches scan `notes/**` only). Index-on-write fires
// only for these, keeping the incremental cache consistent with full rebuild.
function isUnderNotes(relPath: string): boolean {
  return relPath === "notes" || relPath.startsWith("notes/");
}

interface TokensInput {
  vaultPath: string;
  project: string | undefined;
  slug: string | undefined;
  vars: Record<string, string> | undefined;
}

function buildTokens(input: TokensInput): Record<string, string> {
  const date = new Date().toISOString().slice(0, 10);
  const owner = getIdentity();
  const out: Record<string, string> = {
    vault: input.vaultPath,
    date,
    owner,
    session: `${date}-${input.slug ?? "session"}`,
    project: input.project ?? "general",
    slug: input.slug ?? `untitled-${Date.now()}`,
    title: titleFromSlug(input.slug ?? "Untitled"),
    // Defaults per yai.lyt v1 frontmatter contract (arc §3). Overridable via
    // --vars. Templates that do not use these tokens are unaffected.
    "mesh-visibility": DEFAULT_MESH_VISIBILITY,
    weight: DEFAULT_WEIGHT,
    // V-C-1 SC3 option-b — `tags` defaults to empty so the capture template's
    // restored `tags: [<tags>]` token renders `tags: []` on a bare capture and
    // `tags: [a, b]` when `--tags a,b` (or `--vars tags=...`) supplies a value.
    // Without a default the unresolved `<tags>` token would render literally.
    tags: "",
  };
  for (const [k, v] of Object.entries(input.vars ?? {})) out[k] = v;
  return out;
}

function validateMandatoryFrontmatterTokens(
  template: string,
  tokens: Record<string, string>,
  patternName: string,
  verbId: string,
): void {
  const used = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) used.add(m[1] as string);
  const missing: string[] = [];
  for (const tok of MANDATORY_FRONTMATTER_TOKENS) {
    if (!used.has(tok)) continue;
    const value = tokens[tok];
    if (value === undefined || value.trim().length === 0) {
      missing.push(tok);
    }
  }
  if (missing.length > 0) {
    // V-C-7: `--vars` is a REPEATABLE single key=value flag (see collectVars in
    // commands/pattern.ts), NOT a comma-joined list. The prior message suggested
    // the comma form (`--vars 'purpose=<v>,topic=<v>'`), which collectVars parses
    // as a single key with a comma-laden value — silently wrong. Emit the working
    // repeatable form: `--vars purpose=<v> --vars topic=<v>`.
    throw new Error(
      `pattern run: template '${patternName}/${verbId}' requires non-empty value(s) for mandatory frontmatter token(s): ${missing.join(", ")}. ` +
        "Per the lyt v1 frontmatter contract (arc §3), 'purpose' + 'topic' are author-supplied; 'mesh-visibility' defaults to 'local'; 'weight' defaults to 3. " +
        `Re-invoke with ${missing.map((m) => `--vars ${m}=<value>`).join(" ")} or have /lyt-capture prompt for them.`,
    );
  }
}

function resolveFilePath(pathGlob: string, tokens: Record<string, string>): string {
  let path = pathGlob.replace(TOKEN_RE, (_, key: string) => tokens[key] ?? `<${key}>`);
  // path-glob always starts with <vault> per convention; resolve via path.join so the
  // separator on Windows matches the platform.
  if (path.startsWith(tokens["vault"]!)) return path;
  return join(tokens["vault"]!, path);
}

function renderTemplate(content: string, tokens: Record<string, string>): string {
  return content.replace(TOKEN_RE, (_, key: string) => tokens[key] ?? `<${key}>`);
}

function titleFromSlug(slug: string): string {
  return slug.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export type { VerbRecord };
