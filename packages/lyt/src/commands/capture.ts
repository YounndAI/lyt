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

// V-C-1 Phase E / V-C-2 (RATIFIED 2026-06-10) — `lyt capture "<text>"`.
//
// A TRUE top-level alias for `lyt pattern run knowledge-capture capture`: the
// frictionless command the wizard's "Next" steps advertise. It routes through
// the IDENTICAL capture ceremony — patternRunFlow renders the knowledge-capture
// template (the v1 8-field frontmatter contract), enforces mandatory
// purpose+topic (validateMandatoryFrontmatterTokens), and — via the Phase A
// index-on-write wiring inside patternRunFlow — indexes the figment so it's
// searchable immediately. It is NOT a lighter bypass: it cannot write a Figment
// that `pattern run` couldn't, and it cannot skip purpose/topic (it prompts on a
// TTY, else surfaces the same refusal). The guardrail the V-C-2 decision names.
//
// `--index-only <relpath>` is the seam the /lyt-capture skill uses: the skill
// fills the Figment body INLINE with its Write tool (its established convention),
// then calls `lyt capture --index-only notes/<file>.md --vault <name>` to index
// what it just wrote — the same captureIndexFlow the write path uses, so the
// skill path hits SC1 too without re-routing its body authoring through the CLI.

import { Command } from "commander";
import { createInterface } from "node:readline/promises";

import {
  captureIndexFlow,
  closeRegistry,
  getVaultByName,
  listVaults,
  openRegistry,
  patternRunFlow,
  type VaultRow,
} from "@younndai/lyt-vault";

const CAPTURE_PATTERN = "knowledge-capture";
const CAPTURE_VERB = "capture";
// The generated pod-map vault is generator-managed (writable=false) — never a
// capture target, so it is excluded from single-vault default resolution.
const POD_MAP_VAULT_NAME = "lyt-pod-map";

interface CaptureCliOpts {
  vault?: string;
  title?: string;
  purpose?: string;
  topic?: string;
  tags?: string;
  weight?: string;
  meshVisibility?: string;
  slug?: string;
  vars: Record<string, string>;
  json?: boolean;
  indexOnly?: string;
}

export function buildCaptureCommand(): Command {
  return new Command("capture")
    .description(
      "Capture a Figment — true alias for `pattern run knowledge-capture capture` (full v1 ceremony: mandatory purpose+topic, 8-field frontmatter). Indexes on write so it's searchable immediately.",
    )
    .argument("[text]", "The thought to capture (becomes the Figment title; slug derived from it)")
    .option("--vault <name>", "Target vault (default: the single user vault, else required)")
    .option("--title <title>", "Explicit title (overrides the positional text)")
    .option("--purpose <p>", "Why keep this? (author-supplied; prompted on a TTY if omitted)")
    .option("--topic <t>", "Semantic category (author-supplied; prompted on a TTY if omitted)")
    .option(
      "--tags <list>",
      "Comma-separated tags, e.g. a,b — seeds frontmatter tags (≥2 figments sharing a tag form a lane; also feeds the primer keyword fallback)",
    )
    .option("--weight <n>", "Importance 1-5 (default 3)")
    .option("--mesh-visibility <v>", "local | parent | public (default local)")
    .option("--slug <slug>", "Filename slug (default: derived from the title)")
    .option(
      "--vars <kv>",
      "Repeatable key=value override (advanced)",
      collectVars,
      {} as Record<string, string>,
    )
    .option(
      "--index-only <relpath>",
      "Index an already-written figment (the /lyt-capture skill uses this after its inline Write); requires --vault. Does NOT write.",
    )
    .option("--json", "Emit JSON")
    .action(async (text: string | undefined, opts: CaptureCliOpts) => {
      try {
        if (opts.indexOnly !== undefined) {
          await runIndexOnly(opts);
          return;
        }
        await runCapture(text, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({ error: "capture-error", message }, null, 2));
        } else {
          // eslint-disable-next-line no-console
          console.error(`lyt capture: ${message}`);
        }
        process.exitCode = 1;
      }
    });
}

// --index-only: index a figment the caller already wrote (the skill seam). No
// write, no ceremony (the skill already wrote the contract-compliant figment);
// this only refreshes the caches so search/recall/primer hit (SC1/SC3).
async function runIndexOnly(opts: CaptureCliOpts): Promise<void> {
  if (opts.vault === undefined) {
    throw new Error("--index-only requires --vault <name> (the vault the figment was written to).");
  }
  const relPath = opts.indexOnly!.replace(/\\/g, "/");
  const res = await captureIndexFlow({ vaultName: opts.vault, relPath });
  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          indexed: res.ftsIndexed,
          deferred: res.deferred,
          relPath,
          ...(res.note ? { note: res.note } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  // Key the message on whether the figment actually got into the index — covers
  // success, a deferred failure, AND the out-of-notes seam-guard (deferred:false
  // but not indexed), each of which carries an explanatory note.
  if (res.ftsIndexed) {
    // eslint-disable-next-line no-console
    console.log(`Indexed ${relPath} in ${res.vaultName} (searchable now).`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`⚠ ${res.note ?? "not indexed"}`);
  }
}

async function runCapture(text: string | undefined, opts: CaptureCliOpts): Promise<void> {
  const db = await openRegistry();
  let vaultName: string;
  try {
    vaultName = await resolveCaptureVault(opts.vault, db);
  } finally {
    await closeRegistry(db);
  }

  const title = (opts.title ?? text ?? "").trim();
  if (title.length === 0) {
    throw new Error(
      'provide a thought to capture, e.g. `lyt capture "my first thought"`, or pass --title.',
    );
  }
  const slug = opts.slug ?? slugify(title);

  // Resolve the mandatory ceremony fields. --purpose/--topic (or --vars) win;
  // else prompt on a TTY; else leave empty so patternRunFlow surfaces the same
  // refusal `pattern run` would (ceremony preserved — never silently bypassed).
  const purpose =
    opts.purpose ?? opts.vars["purpose"] ?? (await promptIfTty("Why keep this? (purpose): "));
  const topic =
    opts.topic ?? opts.vars["topic"] ?? (await promptIfTty("Topic (semantic category): "));

  // V-C-1 SC3 option-b — `--tags a,b` restored (the knowledge-capture template
  // regained its `tags: [<tags>]` token). Parsed to the inline-array INNER form
  // ("a, b") so the template renders `tags: [a, b]`; omitted → the template
  // default renders `tags: []`. The /lyt-capture skill's inline tag inference
  // stays the primary path; `--tags` is the bare-quick-path affordance that
  // seeds both the primer keyword fallback AND (at ≥2 shared) a real lane.
  const tags = parseTagsOpt(opts.tags);
  const vars: Record<string, string> = {
    title,
    ...(purpose !== undefined ? { purpose } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(opts.weight !== undefined ? { weight: opts.weight } : {}),
    ...(opts.meshVisibility !== undefined ? { "mesh-visibility": opts.meshVisibility } : {}),
    // Explicit --vars win last (advanced override seam, matches `pattern run`).
    ...opts.vars,
  };

  const r = await patternRunFlow({
    patternName: CAPTURE_PATTERN,
    verbId: CAPTURE_VERB,
    vaultName,
    slug,
    vars,
  });

  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          filePath: r.filePath,
          vault: r.vaultName,
          alreadyExisted: r.alreadyExisted,
          indexDeferred: r.indexDeferred === true,
          ...(r.indexNote ? { indexNote: r.indexNote } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`Captured to ${r.filePath}`);
  if (r.indexDeferred === true && r.indexNote !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ ${r.indexNote}`);
  }
}

// Default-vault resolution: --vault → the single user vault → require --vault.
// (LYT_ACTIVE_VAULT is the skill's PATH-based seam; the CLI alias is name-based
// via the registry, so it resolves the single registered user vault instead —
// which makes the wizard's no-flag `lyt capture "your first thought"` real on a
// fresh pod where personal/main is the only user vault.)
async function resolveCaptureVault(
  explicit: string | undefined,
  db: import("@libsql/client").Client,
): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) {
    const row = await getVaultByName(db, explicit);
    if (row === null) {
      throw new Error(`no vault registered with name '${explicit}'. See \`lyt vault list\`.`);
    }
    return row.name;
  }
  const userVaults = (await listVaults(db)).filter(
    (v: VaultRow) => v.status === "active" && v.name !== POD_MAP_VAULT_NAME,
  );
  if (userVaults.length === 1) {
    return userVaults[0]!.name;
  }
  if (userVaults.length === 0) {
    throw new Error("no writable vault found. Run `lyt init` first.");
  }
  throw new Error(
    `multiple vaults — pass --vault <name>. Available: ${userVaults.map((v) => v.name).join(", ")}.`,
  );
}

// Prompt on an interactive TTY only; return undefined on a non-TTY so the caller
// leaves the field empty and patternRunFlow surfaces the mandatory-field refusal
// (never hang a script waiting on stdin).
async function promptIfTty(question: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(question)).trim();
    return ans.length > 0 ? ans : undefined;
  } finally {
    rl.close();
  }
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || `untitled-capture`
  );
}

// Parse `--tags a,b , c` → the inline-array inner form "a, b, c" for the
// template's `tags: [<tags>]` token. Empty/whitespace-only entries are dropped;
// an all-empty value yields undefined (the template default `[]` then applies).
// Single-token tags are the supported quick-path form (the inline-array
// frontmatter parser splits on whitespace, so multi-word tags are not the
// intent here — the /lyt-capture skill authors richer tags inline).
//
// release review (+ committed-state pass C3-M1): per-token sanitize away the
// glyphs that break or type-drift the inline-array `tags: [<tags>]` flow scalar
// under a strict YAML reader (Obsidian properties), then collapse internal
// whitespace. Stripped: `[ ] " backtick` (structure/quote) AND `: { } & *`
// (flow-mapping / anchor / alias indicators — e.g. `--tags "a: b"` would else
// emit `tags: [a: b]`, a flow MAPPING not a string). lyt's own read-back
// (extractFrontmatterTags) is tolerant and never breaks the index regardless;
// this keeps the on-disk Figment well-formed for EXTERNAL strict readers too.
// NOTE: the `--vars tags=…` advanced seam bypasses this (matches --vars
// purpose=/topic=, unsanitized by design). Exported for unit test.
export function parseTagsOpt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((s) =>
      s
        .replace(/[[\]"`:{}&*]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function collectVars(value: string, previous: Record<string, string>): Record<string, string> {
  const m = value.match(/^([^=]+)=(.*)$/);
  if (!m) {
    throw new Error(`--vars must be 'key=value' (got '${value}')`);
  }
  return { ...previous, [m[1]!]: m[2]! };
}
