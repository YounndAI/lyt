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
  CaptureOperation,
  captureIndexFlow,
  closeOpLog,
  closeRegistry,
  closeVaultDb,
  getVaultByName,
  listVaults,
  openAuditDb,
  openOpLog,
  rankVaultTopicsFlow,
  openRegistry,
  patternRunFlow,
  recordOperationAudit,
  type PatternRunResult,
  type TopicCount,
  type VaultRow,
} from "@younndai/lyt-vault";
import type { Client } from "@libsql/client";

const CAPTURE_PATTERN = "knowledge-capture";
const CAPTURE_VERB = "capture";

interface CaptureCliOpts {
  vault?: string;
  title?: string;
  purpose?: string;
  topic?: string;
  tags?: string;
  weight?: string;
  meshVisibility?: string;
  slug?: string;
  dir?: string;
  topicFolder?: boolean;
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
      "--dir <vault-relative>",
      "Destination directory inside the vault (default: notes/). Fail-closed: rejects '..', absolute paths, and the reserved .lyt/.obsidian/.git trees.",
    )
    .option(
      "--topic-folder",
      "Route the capture into a topic-named folder (topics/<topic-slug>/) instead of notes/. Opt-in; ignored when --dir is given (explicit wins). The topic still sets the `topic:` field either way.",
    )
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
  // C10 topic picker: on a TTY with no explicit --topic, surface the vault's
  // existing topics for reuse (recommended-first) with an "other" free-text
  // escape; on a non-TTY leave it empty so patternRunFlow surfaces the same
  // mandatory-topic refusal `pattern run` would (never hang a script on stdin).
  const topic =
    opts.topic ?? opts.vars["topic"] ?? (await resolveTopicInteractive(vaultName, `${title}\n${text ?? ""}`));

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

  // C10 destination resolution (explicit --dir → topic-folder → notes/ default):
  // an explicit --dir always wins; else --topic-folder opts the figment into
  // topics/<topic-slug>/; else the template's notes/ default stands. The
  // resulting dir is fail-closed-guarded inside patternRunFlow (resolveCaptureDir).
  const dir = resolveTopicFolderDir(opts.dir, opts.topicFolder, topic);
  // A.3 — route the write through the capture Operation so it records an
  // undoable op in the pod-level op-log (`lyt undo`). Best-effort: if the op-log
  // can't be opened, fall back to a direct capture — the write is load-bearing;
  // undoability is a bonus, never a reason to fail a capture.
  const r = await captureThroughOp(title, vaultName, slug, dir, vars);

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

// A.3 — perform the capture through the CaptureOperation (which records an
// undoable op) when the pod-level op-log is available, else fall back to a direct
// pattern-run. Either way returns the SAME PatternRunResult the caller renders —
// the Operation adds the op-log write, not a new output shape. The op-log is
// opened+closed per capture (its cost is what makes `lyt undo` possible).
async function captureThroughOp(
  title: string,
  vaultName: string,
  slug: string,
  dir: string | undefined,
  vars: Record<string, string>,
): Promise<PatternRunResult> {
  const runArgs = {
    patternName: CAPTURE_PATTERN,
    verbId: CAPTURE_VERB,
    vaultName,
    slug,
    ...(dir !== undefined ? { dir } : {}),
    vars,
  };
  let opLogDb: Client | null = null;
  try {
    opLogDb = await openOpLog();
  } catch {
    opLogDb = null; // op-log unavailable → capture still works, just not undoable this run
    // Surface the degraded state to stderr (never stdout / --json), mirroring the
    // indexDeferred soft-note posture — else the capture is silently non-undoable.
    // eslint-disable-next-line no-console
    console.error("  ⚠ undo is unavailable for this capture (couldn't open the local history).");
  }
  if (opLogDb === null) {
    return patternRunFlow(runArgs);
  }
  try {
    const op = new CaptureOperation(
      { vaultName, title, slug, ...(dir !== undefined ? { dir } : {}), vars },
      {
        opLogDb,
        // a review finding fix-pass — record the op-level audit entry into the vault's own
        // audit ledger (`op.capture`, target = the figment path). Previously this
        // seam existed but no caller passed it, so the entry was dark. Best-effort:
        // a capture must NEVER fail because its audit note didn't land, so the sink
        // opens/closes the vault's audit db itself and swallows its own errors.
        audit: async (operation, receipt, ctx) => {
          let auditDb: Client | null = null;
          try {
            auditDb = await openAuditDb(ctx.vaultPath);
            await recordOperationAudit(ctx.vaultPath, auditDb, operation, receipt, {
              targetType: "figment",
              targetId: ctx.relPath,
            });
          } catch {
            // audit is a bonus; never block or fail the capture on it
          } finally {
            if (auditDb !== null) await closeVaultDb(auditDb);
          }
        },
      },
    );
    await op.apply();
    // apply() always sets lastResult before any non-throwing return.
    return op.lastResult!;
  } finally {
    await closeOpLog(opLogDb);
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
    (v: VaultRow) => v.status === "active",
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

// C10 topic resolution when no explicit --topic was given. On a non-TTY: return
// undefined (the flow then surfaces the mandatory-topic refusal — never hang a
// script). On a TTY: surface the vault's existing topics as a numbered picker
// (recommended-first) so the author REUSES an established topic instead of
// coining a near-duplicate; if the vault has no topics yet (or the lookup
// fails), fall back to the plain free-text prompt.
async function resolveTopicInteractive(
  vaultName: string,
  figmentText?: string,
): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  let topics: TopicCount[] = [];
  let recommendedTopic: string | null = null;
  try {
    // Phase E (Unit 2) — semantic upgrade of the C10 picker: rankVaultTopicsFlow
    // re-ranks the vault's existing topics by similarity to the figment when the
    // local embedding model is present, and returns the plain frequency order
    // (byte-identical to C10 today) when it is absent / no text / embed fails. It
    // NEVER fetches the model on this read path (read-never-fetches gate inside
    // the flow), so a base pod / Codex / non-TTY capture is unaffected.
    const ranked = await rankVaultTopicsFlow({
      vaultName,
      ...(figmentText !== undefined ? { figmentText } : {}),
    });
    topics = ranked.topics;
    // Phase E release review fold — surface (not auto-select) the confidence-gated
    // recommendation. Previously discarded; now it HIGHLIGHTS the matching row in
    // the picker. It never auto-commits: the author still types the number (empty
    // Enter re-prompts, per the no-reflexive-Enter posture below).
    recommendedTopic = ranked.recommendedTopic;
  } catch {
    // A missing/corrupt index (or any enrichment failure) must not block capture
    // — degrade to free text.
    topics = [];
    recommendedTopic = null;
  }
  if (topics.length === 0) {
    return promptIfTty("Topic (semantic category): ");
  }
  return pickTopicTty(topics, recommendedTopic);
}

// Pure branch-mapping for the topic picker's answer — extracted from the
// readline glue so the pick logic is unit-testable without stdin (release review
// T-BLOCK). `count` = the number of listed topics; the menu shows rows 1..count
// plus an "other" row at count+1. Discriminated result:
//   - reprompt : empty input OR an out-of-range number → ask again. Empty is
//     NOT a silent default to the modal topic — that reflexive-Enter mis-tag was
// the release review foot-gun; `topic:` is the queryable dimension, so a wrong
//     one is a real (quiet) data cost.
//   - existing : a valid 1..count pick → reuse that topic (0-based index).
//   - new      : the "other" row (count+1) → prompt for a free-text topic.
//   - typed    : a non-numeric, non-empty answer → take it verbatim (the
//     "just type it" affordance).
export type TopicPick =
  | { kind: "reprompt" }
  | { kind: "existing"; index: number }
  | { kind: "new" }
  | { kind: "typed"; value: string };

export function interpretTopicPick(answer: string, count: number): TopicPick {
  const ans = answer.trim();
  if (ans.length === 0) return { kind: "reprompt" };
  const n = Number(ans);
  if (Number.isInteger(n)) {
    if (n >= 1 && n <= count) return { kind: "existing", index: n - 1 };
    if (n === count + 1) return { kind: "new" };
    return { kind: "reprompt" }; // out-of-range number
  }
  return { kind: "typed", value: ans };
}

// The numbered topic picker (TTY glue over interpretTopicPick). Shows up to 9
// existing topics + an "other" escape, then maps the answer. A bounded re-prompt
// loop replaces the old silent Enter→modal-topic default; giving up after a few
// tries returns undefined → the mandatory-topic refusal (never spin forever).
async function pickTopicTty(
  topics: TopicCount[],
  recommendedTopic: string | null = null,
): Promise<string | undefined> {
  const top = topics.slice(0, 9);
  const otherIdx = top.length + 1;
  // Only mark the recommendation if it is actually one of the shown rows (it is,
  // by construction — it's an existing label — but guard against a >9 truncation).
  const recommendedShown =
    recommendedTopic !== null && top.some((t) => t.topic === recommendedTopic);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-console
    console.log("Topic (semantic category) — existing topics in this vault:");
    top.forEach((t, i) => {
      // Phase E — HIGHLIGHT the semantic recommendation (★ recommended) without
      // auto-selecting it: the author still types the number to choose it.
      const mark = recommendedShown && t.topic === recommendedTopic ? "  ★ recommended" : "";
      // eslint-disable-next-line no-console
      console.log(`  ${i + 1}. ${t.topic} (${t.figmentCount})${mark}`);
    });
    // eslint-disable-next-line no-console
    console.log(`  ${otherIdx}. (other — type a new topic)`);
    for (let attempt = 0; attempt < 5; attempt++) {
      const pick = interpretTopicPick(await rl.question("Pick a number, or type a new topic: "), top.length);
      if (pick.kind === "existing") return top[pick.index]!.topic;
      if (pick.kind === "typed") return pick.value;
      if (pick.kind === "new") {
        const free = (await rl.question("New topic: ")).trim();
        if (free.length > 0) return free;
      }
      // reprompt (or an empty "other" entry) → loop
    }
    return undefined;
  } finally {
    rl.close();
  }
}

// C10 destination resolution: explicit --dir → topic-folder → notes/ (default).
// Pure + exported for unit tests. An explicit --dir always wins (the user named
// it). Else, when --topic-folder is opted in AND a non-blank topic resolved,
// route into topics/<topic-slug>/. Else undefined → the template's notes/
// default stands. The returned dir is fail-closed-guarded downstream by
// resolveCaptureDir (topics/<slug> is a plain safe subpath).
export function resolveTopicFolderDir(
  explicitDir: string | undefined,
  topicFolder: boolean | undefined,
  topic: string | undefined,
): string | undefined {
  if (explicitDir !== undefined) return explicitDir;
  if (topicFolder === true && topic !== undefined && topic.trim().length > 0) {
    return `topics/${topicToFolderName(topic)}`;
  }
  return undefined;
}

// Turn a human topic string into a stable, safe folder-name segment for
// --topic-folder routing. Same slug family as slugify() (lowercase, non-alnum →
// '-', trim dashes) but without the title-length cap — a topic is short. A
// value that slugifies to empty (e.g. punctuation-only) falls back to
// "untitled-topic" (defensive; topic is mandatory so this is unreachable on the
// happy path). Exported for unit tests.
export function topicToFolderName(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      // Cap the segment length (symmetry with slugify) so a pathological topic
      // can't produce an ENAMETOOLONG directory name (release review R2-a); re-trim
      // a trailing dash the slice may have exposed.
      .slice(0, 60)
      .replace(/-+$/g, "") || "untitled-topic"
  );
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
