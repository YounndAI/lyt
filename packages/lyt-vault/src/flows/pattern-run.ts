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
import type { AccessProvider } from "../access/access-provider.js";
import { GhAccessProvider } from "../access/gh-access-provider.js";
import type { GhExecutor } from "../util/gh-discover.js";

// hardening pass (Cohort-1 fix-pass) — the actionable refusal a pure-subscriber WRITE
// attempt raises. A read-only subscribed vault has no push rights to its
// upstream, so ANY figment write into it (capture, decision, plan, AND `recall`
// — which writes a report Figment) strands a local-only stray that `lyt sync`
// can never push (the hardening pass sync-jam). Refuse BEFORE the write so nothing lands
// on disk; name the remedy (write into a home vault, or request write access).
//
// Cohort-1 fix-pass release review (Major) — the message is now VERB-AGNOSTIC. The
// gate fires for every `pattern run` verb, including `recall`; the prior wording
// ("Capture into one of your home vaults") was wrong for a non-capture verb. A
// generic "can't write into a subscribed read-only vault" phrasing reads
// correctly whatever the verb. Exported so the command layer + tests can assert
// on the message without string-matching.
export const SUBSCRIBER_CAPTURE_REFUSAL = (vaultName: string): string =>
  `vault '${vaultName}' is a subscribed read-only vault — you can't write into it ` +
  `(no push rights to its upstream; a write would strand a commit 'lyt sync' can never push). ` +
  `Use one of your home vaults instead, or request write access to '${vaultName}'.`;

// 0.9.3 — refusal when a subscribed vault's write access can't be
// VERIFIED (gh offline/unavailable → verdict "unknown"). Treating it as
// read-only is the safe default (the [lyt.gate] pause-and-ask, in flow form):
// refuse a write we can't confirm is pushable rather than strand a commit.
// Verb-agnostic (no "capture into"), and names the `lyt vault refresh` remedy.
export const UNVERIFIED_WRITE_REFUSAL = (vaultName: string): string =>
  `vault '${vaultName}' is a subscribed vault and its write access couldn't be verified ` +
  `(gh is offline or unavailable) — treating it as read-only so a write doesn't strand a ` +
  `commit 'lyt sync' can never push. Use one of your home vaults, or run ` +
  `'lyt vault refresh ${vaultName}' once you're online to re-check access.`;

export interface PatternRunArgs {
  patternName: string;
  verbId: string;
  vaultName: string;
  project?: string | undefined;
  slug?: string | undefined;
  vars?: Record<string, string> | undefined;
  // 0.9.3 — injectable gh executor for the writability probe at the
  // write-gate (deriveWriteGate). Defaults to the real `gh` CLI; tests inject a
  // fake to exercise the foreign-mesh-subscription verdict deterministically.
  // Only consulted for SUBSCRIPTION targets — own-vault captures never probe.
  gh?: GhExecutor | undefined;
  // keystone Phase B — injectable AccessProvider for the write gate.
  // Defaults to a GhAccessProvider built from `gh`; tests/callers may inject a
  // different provider. Behavior-preserving: the default exactly mirrors the
  // prior direct `deriveWriteGate(row, db, { gh })` call.
  accessProvider?: AccessProvider | undefined;
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
    // 0.9.3 — the SECOND gate at this chokepoint: refuse a content write
    // into a vault the user CAN'T PUSH to, keyed on the LIVE writability verdict
    // (what `vault info` reports), not the static role. The prior gate keyed on
    // `isPureSubscriberVault` (subscribed, not home), which a subscribe-to-a-
    // foreign-mesh vault does NOT satisfy (it gets a local `home` role via the
    // hardening pass external-mesh auto-register) — so the live cohort wrote a figment
    // into a `writable:false` subscribed vault, which then jammed the
    // outbox. deriveWriteGate keeps the hot path probe-free: an
    // OWN vault (no subscription signal) is allowed with NO gh probe; only a
    // subscription consults the (cached) verdict. Refuse BEFORE any write so
    // nothing lands on disk.
    const accessProvider =
      args.accessProvider ?? new GhAccessProvider(db, args.gh !== undefined ? { gh: args.gh } : {});
    const gate = await accessProvider.canWrite(row);
    if (gate.blocked) {
      throw new Error(
        gate.verdict.writable === "unknown"
          ? UNVERIFIED_WRITE_REFUSAL(row.name)
          : SUBSCRIBER_CAPTURE_REFUSAL(row.name),
      );
    }
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
      // Thread the same gh seam so the index gate resolves the write-gate verdict
      // consistently with the capture gate above (and so a granted-write
      // subscription that PASSED the gate also indexes — not just writes).
      ...(args.gh !== undefined ? { gh: args.gh } : {}),
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
    // Phase A — `content` is the capture body channel. The template's
    // `<content>` token renders `vars.content` when supplied (CLI `--vars
    // content=...` or the MCP `capture` tool). Defaults to the prior literal
    // stub line so a bare capture (no content var) is BYTE-IDENTICAL to the
    // pre-D67 template body — without this default the unresolved `<content>`
    // token would render literally (the regression guard). `content` is
    // optional at the flow level (NOT in MANDATORY_FRONTMATTER_TOKENS); the MCP
    // layer enforces it for generic clients.
    //
    // SEE ALSO — COUPLED CONSTANT: this default string is the empty-state body
    // rendered into the `<content>` token site at
    // `src/patterns/knowledge-capture/templates/capture.md` (line ~15). The two
    // MUST stay in sync — a bare capture (no `content` var) renders this exact
    // string into that token slot. The trail can only live HERE: capture.md is
    // rendered verbatim into every Figment, so a comment there would pollute
    // output. Parity is enforced by the bare-capture regression test in
    // `tests/flows-pattern.test.ts`; if you change this string, update that
    // test's expected body.
    content:
      "_(Body content — plain Obsidian-flavored markdown. Use `[[wikilinks]]` for cross-Figment references.)_",
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
