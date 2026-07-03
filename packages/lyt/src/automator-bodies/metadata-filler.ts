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

// Metadata-filler automator body (block-B Commit 7; 0.10.0 lane, Phase C
// backfill — automator declaration bumped to v0.2.0 in metadata-filler.yon;
// Phase E bumped it to v0.3.0 for the tag/topic-enrichment substrate change
// — llm_capability none→embed, field_ownership +tags/+topic).
//
// Per arc-thoughts §6.13 Example 1 (LOCKED 2026-05-27) + the bundled
// declaration at packages/lyt-vault/src/scaffold/defaults/automators/
// metadata-filler.yon — archetype=filler, runtime=deterministic. Phase E bumped
// llm_capability none→embed + field_ownership +tags/+topic: the body now ENRICHES
// the missing `tags` (deterministic keyphrase — model-free) and `topic` (ranked
// against the vault's existing labels via the OPTIONAL local embedder, blank when
// the model is absent / low-confidence — read-never-fetches, zero network).
//
// HONEST SCOPE (Phase E release review, HONEST-SCOPED) — the two enriched fields do
// NOT have the same reach, do not overclaim:
//   - `tags`  enrich on ANY vault, INCLUDING a pure cold import: they are
//     model-free + index-free (deterministic keyphrase extraction over the body).
//   - `topic` enriches ONLY when the vault ALREADY HAS topics to classify against.
//     Phase E.1 FIX C: the label set is read from the CURRENT on-disk `topic:`
//     frontmatter (a disk scan over the same target files), NOT from the search
//     index — so a topic removed/renamed on disk is NEVER assignable, and the
//     enrich is deterministic w.r.t. the disk (independent of index staleness or
//     prior-run interleaving). On a PURE COLD IMPORT (no prior topics) topic stays
//     BLANK — there is nothing to rank against, and this body never SEEDS/invents a
//     topic. A topic-seed mechanism for cold-import vaults is a deferred FAST-FOLLOW,
//     not built here.
// So this lets an ADOPTED/IMPORTED vault get TAGS through the Phase-D backfill/
// reconcile path unconditionally, and TOPIC only once the vault is established
// (has existing topics). Walks the WHOLE vault (Phase C —
// KEEP-FLAT; was
// <vault>/notes/**/*.md), detects which of the 8 mandatory frontmatter fields
// (arc §3 contract — title, created, modified, tags, purpose, topic,
// mesh-visibility, weight) are missing, fills missing ones with deterministic
// defaults, and writes back via the pre-write @STAMP hook so provenance +
// audit_log + last_provenance: land per arc §11.4.
//
// PHASE C — DATE FIDELITY (0.10.0). This is a BACKFILL: legacy notes get their
// REAL historical `created`/`modified`, NOT today's date. Per file the date is
// sourced from the file's git committer date (epoch SECONDS → routed through
// gitCommitterDateToIso, which ×1000s to ms — the ONLY correct git path), with
// an fs-mtime fallback (mtimeMs is ALREADY milliseconds → new Date(ms) DIRECTLY,
// NO ×1000) when the vault is not a git repo, git is unavailable, or the file is
// untracked. Two distinct scaling paths — sending fs-ms through
// gitCommitterDateToIso double-scales (year ~+50000); forgetting the ×1000 on
// git seconds yields 1970. See resolveFaithfulDate below.
//
// Scope broadening reuses the SINGLE index funnel (walkVaultMarkdownFiles +
// isIndexable from @younndai/lyt-vault) so the immutable floor (.lyt / .obsidian
// / .git) AND the `lyt-scaffold: true` sentinel (g6) are excluded by the SAME
// mechanism the read/index tiers use — no bespoke exclusion. Never writes
// frontmatter into scaffold/system files.
//
// Why this lives in @younndai/lyt — and not lyt-runner — block-B v1:
// runFiveStep's `runBody` is body-shape-agnostic; the meta CLI is the
// single place that knows which archetype maps to which TS function for
// v1. Future archetypes (rollup, ingest, lane-builder) add their own
// modules here and get dispatched by automator-bodies/index.ts.

import { readFileSync, statSync } from "node:fs";
import { relative, sep, posix } from "node:path";

import type { Client } from "@libsql/client";
import { writeMarkdownWithStamp, type LytRunContext } from "@younndai/lyt-runner";
import {
  classifyTopic,
  embedderMemoized,
  gitCommitterDateToIso,
  isGitRepo,
  isIndexable,
  loadEmbedder,
  modelCachePresent,
  parseFigmentTopicTags,
  precomputeTopicLabelVectors,
  runGit,
  stripFrontmatter,
  suggestFigmentTags,
  walkVaultMarkdownFiles,
  type Embedder,
} from "@younndai/lyt-vault";

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
  // Phase C — KEEP-FLAT: walk the WHOLE vault (not <vault>/notes) via the
  // single index funnel, which excludes the immutable floor (.lyt/.obsidian/.git)
  // AND `lyt-scaffold: true` sentinel files (isIndexable g6). This is a pure
  // metadata backfill IN PLACE — no file is relocated or sharded.
  const targets = walkVaultMarkdownFiles(args.vaultPath, isIndexable);
  const outcome: MetadataFillerOutcome = {
    filesScanned: targets.length,
    filesMutated: 0,
    fieldsFilledTotal: 0,
    filesWritten: [],
  };

  // A single git-repo probe for the whole run — the per-file `git log -1` path
  // is only attempted when the vault root is a git repo (else every file uses
  // the fs-mtime fallback directly, avoiding N failed subprocess spawns).
  const vaultIsGitRepo = await isGitRepo(args.vaultPath);

  // Phase E — enrichment substrate resolved ONCE for the whole run (see
  // resolveEnrichmentContext): the vault's existing topic labels (the classify
  // label set) and a gated embedder (null when the model is absent — the
  // read-never-fetches gate below guarantees ZERO network in that case).
  // Phase E.1 FIX C: the label set is read from the CURRENT on-disk `topic:`
  // frontmatter of the walked targets — NOT the search index (listDistinctTopics),
  // which on `reconcile --apply` is STALE (backfill runs before the post-backfill
  // reindex). Reading disk severs that ordering hazard: a topic removed/renamed on
  // disk is not assignable, and the label set no longer depends on prior-run index
  // state (kills the interrupt-nondeterminism).
  const enrichCtx = await resolveEnrichmentContext(targets);

  for (const absPath of targets) {
    const raw = readFileSync(absPath, "utf8");
    // Phase E fix-pass (FIX 3 — perf) — CHEAP no-embed probe FIRST: a file that
    // needs no fill (or needs only non-enriched fields) must NEVER pay the
    // enrichFigment embed cost. Skip a no-op file before touching the model.
    const missing = detectMissingMandatoryFields(raw);
    // Phase E.1 FIX B — a present-but-BLANK `topic: ""` / `tags: []` is CONTRACT-
    // VALID (the key is present, so detectMissingMandatoryFields / hasField / the
    // doctor treat it PRESENT — we do NOT change that shared semantics), but it is a
    // placeholder, not an authored value, so enrichment SHOULD fill it. This
    // metadata-filler-LOCAL predicate finds those blank placeholders. A NON-blank
    // authored value is never in this set → the rail "never overwrite authored" holds.
    const blankEnrichable = detectBlankEnrichableFields(raw);
    if (missing.length === 0 && blankEnrichable.length === 0) continue;

    // Phase C backfill: source created/modified from the file's REAL historical
    // date (git committer date → fs-mtime fallback), NEVER ctx.startedAt.
    const faithfulDate = await resolveFaithfulDate(absPath, args.vaultPath, vaultIsGitRepo);
    // Phase E — compute the ENRICHED tags/topic for THIS figment, but ONLY when a
    // field that enrichment feeds (topic or tags) is actually missing OR present-
    // but-blank — otherwise the embed is pure waste (the enriched values would go
    // unused, and we must NOT touch a non-blank authored value). Blank-safe:
    // model-absent / low-confidence / no-labels / embed-fail all degrade to blank
    // exactly as the pre-E deterministic default did (a blank stays blank — no-op).
    const wantsTopic = missing.includes("topic") || blankEnrichable.includes("topic");
    const wantsTags = missing.includes("tags") || blankEnrichable.includes("tags");
    const enriched =
      wantsTopic || wantsTags
        ? await enrichFigment(raw, filenameSlug(absPath), enrichCtx)
        : undefined;
    // fillMissing fills ONLY the fields that are actually missing, PLUS replaces a
    // present-but-blank topic/tags with a NON-blank enriched value (FIX B). It never
    // overwrites a non-blank authored value — fill-missing-only + blank-only-replace
    // are enforced downstream. Its own detection MUST agree with the probes above
    // (shared walk); the earlier probes are an optimization, not the SoT.
    const filled = fillMissingMandatoryFields(raw, {
      filenameSlug: filenameSlug(absPath),
      now: faithfulDate,
      ...(enriched !== undefined ? { enriched } : {}),
    });
    if (filled.fieldsFilled.length === 0) continue;

    // Provenance/distinguishable (Risk Register — "machine fields provenance-
    // stamped + distinguishable"): the existing @STAMP hook writes a
    // `last_provenance:` scalar (src=automator:…, method=filler) AND a
    // provenance-table row with details.fields_filled — the same convention
    // created/modified/mesh-visibility already ride. We EXTEND details (not a
    // new frontmatter scheme) with which of the filled fields were SEMANTICALLY
    // enriched vs deterministic-default, so an auditor / search-recall path can
    // tell an embed-ranked topic from a handler-authored one via provenance.
    const enrichedFields =
      enriched !== undefined
        ? filled.fieldsFilled.filter(
            (f) =>
              (f === "topic" && enriched.topic !== null) ||
              (f === "tags" && enriched.tags.length > 0),
          )
        : [];
    // FIX 4 — the top-level `confidence` stays 1.0 (the filler's write-confidence,
    // which other consumers may rely on). We DON'T overload it with the embed
    // score; instead we record the classifier's ACTUAL cosine for an enriched
    // topic in `details.topic_confidence` so an auditor isn't misled into reading
    // 1.0 as "the topic is a certain match" (an embed-ranked topic can assign at
    // e.g. 0.51). Present only when a topic was actually enriched this write.
    const topicWasEnriched = enrichedFields.includes("topic");
    await writeMarkdownWithStamp(ctx, args.vaultDb, {
      path: absPath,
      content: filled.content,
      vaultRoot: args.vaultPath,
      stamp: {
        src: `automator:${args.automatorName}/v${args.automatorVersion}`,
        method: "filler",
        confidence: 1.0,
        details: {
          fields_filled: filled.fieldsFilled,
          ...(enrichedFields.length > 0 ? { enriched_fields: enrichedFields } : {}),
          ...(topicWasEnriched && enriched?.topicConfidence !== null && enriched?.topicConfidence !== undefined
            ? { topic_confidence: enriched.topicConfidence }
            : {}),
        },
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
// Phase E — tag/topic enrichment (the .yon v0.3.0 llm_capability=embed +
// field_ownership +tags/+topic contract made TRUE).
//
// Two enrichers, both blank-safe:
//   - tags  : suggestFigmentTags — model-FREE deterministic keyphrase extraction
//             (never needs the embedder). Empty → blank (= pre-E default).
//   - topic : classifyTopic against the vault's EXISTING topic labels via the
//             gated embedder. Blank when the model is absent OR the best cosine
//             is below the confidence floor OR there are no labels OR the embed
//             throws — NEVER a guessed topic across an imported vault (Risk
//             Register: "topic blank when low-confidence").
//
// MODEL GATE (read-never-fetches, mirrors rankVaultTopicsFlow verbatim): the
// embedder is loaded ONCE per run and only when the model is already cached on
// disk (modelCachePresent()) OR a live embedder is memoized in-process
// (embedderMemoized()). loadEmbedder() is called with NO opts → fetchAllowed=false
// → a model-absent run resolves unavailable with ZERO network. The automator
// therefore NEVER triggers a model download.
// ---------------------------------------------------------------------------

interface EnrichmentContext {
  /** The vault's existing distinct topic labels (classify label set), NORMALIZED
   *  (blank-dropped + case-insensitively de-duped) and ALIGNED with `labelVectors`
   *  — i.e. the pair `precomputeTopicLabelVectors` returns. */
  existingTopics: string[];
  /** Phase E fix-pass (FIX 3 — perf) — the label set embedded ONCE for the whole
   *  run, one unit vector per `existingTopics` entry, same order. Empty when the
   *  model is absent (embedder null) or there are no labels. Passed to
   *  classifyTopic({ labelVectors }) so each per-figment call embeds ONLY the
   *  figment text, not the run-constant label set again. */
  labelVectors: Float32Array[];
  /** A loaded embedder, or null when the model is absent (never-fetched). */
  embedder: Embedder | null;
}

interface FigmentEnrichment {
  /** The recommended existing topic (>= confidence floor), or null (blank). */
  topic: string | null;
  /** Phase E fix-pass (FIX 4 — provenance honesty) — the ACTUAL classifier cosine
   *  for the assigned `topic` (the best-label similarity that cleared the floor),
   *  null when no topic was assigned, or undefined when the value is unknown (a
   *  caller — e.g. a pure fillMissingMandatoryFields render test — that constructs
   *  an enrichment without running the classifier). Recorded in the provenance
   *  stamp's `details` so an auditor sees the real confidence of an embed-ranked
   *  topic (e.g. 0.51) — NOT the filler's blanket write-confidence of 1.0. */
  topicConfidence?: number | null;
  /** Suggested tags (may be empty → blank). */
  tags: string[];
}

// Resolve the run-wide enrichment substrate: existing topic labels + a gated
// embedder. Degrades to `{ existingTopics: [], embedder: null }` on ANY failure
// (unreadable file, model absent, embed-load error) so the backfill still fills the
// OTHER 6 fields and leaves tags/topic blank — never a hard-fail.
//
// Phase E.1 FIX C — the label set is scanned from the CURRENT on-disk `topic:`
// frontmatter of the walked targets, NOT read from the search index
// (listDistinctTopics over figment_meta). WHY: on `reconcile --apply` the index is
// STALE at this point — backfill runs BEFORE the load-bearing post-backfill reindex
// — so an index read could rank against a topic that was REMOVED/renamed on disk (a
// durable WRONG write, non-idempotent) and could vary with prior-run index state. A
// disk scan makes the invariant crisp: classify only ever ranks against a topic that
// is CURRENTLY present on disk, and the run is deterministic w.r.t. the disk. Cost is
// O(vault) reads, but the automator ALREADY reads every target's body in the main
// loop; here we only parse each file's frontmatter `topic:` (parseFigmentTopicTags —
// the SAME quote-decode the index parser uses, so labels match byte-for-byte).
async function resolveEnrichmentContext(targets: readonly string[]): Promise<EnrichmentContext> {
  const rawTopics: string[] = [];
  const seen = new Set<string>(); // case-insensitive de-dup of the raw disk labels
  for (const absPath of targets) {
    let topic: string | null = null;
    try {
      topic = parseFigmentTopicTags(readFileSync(absPath, "utf8")).topic;
    } catch {
      // Unreadable / mid-write file → skip it as a label source (never hard-fail).
      continue;
    }
    if (topic === null) continue;
    const trimmed = topic.trim();
    if (trimmed.length === 0) continue; // a blank topic is NOT a label
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rawTopics.push(trimmed);
  }

  // Read-never-fetches gate: only touch the model when it is already cached OR a
  // live embedder is memoized in-process. loadEmbedder() with NO opts →
  // fetchAllowed=false (belt-and-suspenders). Any load failure → null (lexical/
  // blank degrade), never a throw.
  let embedder: Embedder | null = null;
  if (modelCachePresent() || embedderMemoized()) {
    try {
      const load = await loadEmbedder();
      if (load.available) embedder = load.embedder;
    } catch {
      embedder = null;
    }
  }

  // Phase E fix-pass (FIX 3 — perf) — pre-embed the run-constant label set ONCE.
  // Returns the NORMALIZED labels aligned with their vectors (or empty pairs when
  // the model is absent / no labels / embed-fail). enrichFigment then embeds ONLY
  // the per-figment text on each call, not the whole label set N times.
  const { labels, vectors } = await precomputeTopicLabelVectors(rawTopics, embedder);
  return { existingTopics: labels, labelVectors: vectors, embedder };
}

// Compute the enriched tags/topic for one figment. NEVER throws — every failure
// path (empty body, no labels, model absent, embed error) degrades to blank.
async function enrichFigment(
  raw: string,
  slug: string,
  ctx: EnrichmentContext,
): Promise<FigmentEnrichment> {
  // Representative text = filename-derived title + the body (frontmatter stripped
  // so stale/placeholder frontmatter values don't pollute the semantic signal).
  const body = stripFrontmatter(raw);
  const title = slug.replace(/[-_]+/g, " ").trim();
  const figmentText = `${title}\n${body}`.trim();

  // tags — model-free, deterministic. Empty (no signal) degrades to blank.
  const tags = figmentText.length > 0 ? suggestFigmentTags(title, body) : [];

  // topic — embedder-gated; blank on model-absent / low-confidence / no-labels /
  // embed-fail (classifyTopic owns all of those degrade paths + never throws).
  // FIX 3: pass the run-precomputed label vectors so classifyTopic embeds ONLY the
  // figment text (the label set was embedded once in resolveEnrichmentContext).
  let topic: string | null = null;
  let topicConfidence: number | null = null;
  if (ctx.embedder !== null && ctx.existingTopics.length > 0 && figmentText.length > 0) {
    const result = await classifyTopic(figmentText, ctx.existingTopics, ctx.embedder, {
      labelVectors: ctx.labelVectors,
    });
    topic = result.topic;
    // FIX 4 — capture the assigned topic's ACTUAL cosine (the ranked entry that
    // matches result.topic; the recommended pick is the top-ranked label that
    // cleared the floor). null when no topic was assigned.
    if (topic !== null) {
      const hit = result.ranked.find((r) => r.topic === topic);
      topicConfidence = hit !== undefined ? hit.score : null;
    }
  }

  return { topic, topicConfidence, tags };
}

// ---------------------------------------------------------------------------
// Phase C — faithful-date resolution (THE ×1000 TRAP, two distinct paths).
//
// The backfill fills created/modified with a note's REAL historical date, not
// today's. Precedence per file:
//   1. GIT committer date — `git log -1 --format=%ct -- <file>` emits epoch
//      SECONDS. Route through gitCommitterDateToIso, which ×1000s SECONDS → ms
//      before `new Date(...)`. Forgetting the ×1000 yields ~1970.
//   2. FS mtime fallback — used when the vault is not a git repo, git is
//      unavailable, or the file is UNTRACKED (empty %ct). `statSync().mtimeMs`
//      is ALREADY milliseconds → `new Date(mtimeMs).toISOString()` DIRECTLY.
//      Do NOT feed fs-ms to gitCommitterDateToIso (double-scale → year ~+50000).
//
// Never returns ctx.startedAt, 1970, or today's date for a legacy note. The
// git subprocess is `allowFailure` + only attempted when the root is a repo, so
// a not-a-repo / git-missing vault falls cleanly to path 2.
// ---------------------------------------------------------------------------

async function resolveFaithfulDate(
  absPath: string,
  vaultPath: string,
  vaultIsGitRepo: boolean,
): Promise<string> {
  // Path 1 — git committer date (epoch SECONDS → gitCommitterDateToIso ×1000).
  if (vaultIsGitRepo) {
    try {
      const rel = relative(vaultPath, absPath).split(sep).join(posix.sep);
      // runGit passes args as an array (no shell) → paths with spaces are safe;
      // `--` terminates options so a leading-dash filename can't be misparsed.
      const r = await runGit(["log", "-1", "--format=%ct", "--", rel], {
        cwd: vaultPath,
        allowFailure: true,
      });
      if (r.code === 0) {
        const raw = r.stdout.trim();
        // Untracked / no-history files print empty stdout → fall through to fs.
        if (raw.length > 0) {
          const iso = gitCommitterDateToIso(raw);
          if (iso !== null) return iso;
        }
      }
    } catch {
      // git spawn/parse failure → fall through to the fs-mtime path.
    }
  }

  // Path 2 — fs mtime (ALREADY milliseconds → new Date(ms) DIRECTLY, NO ×1000).
  return new Date(statSync(absPath).mtimeMs).toISOString();
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
  // Phase E — pre-computed enrichment for the tags/topic fields. When a field is
  // among the MISSING ones, renderDefault emits the enriched value; when
  // enrichment is blank (model absent / low-confidence / no signal) it falls back
  // to the pre-E deterministic default ("[]" / '""'). Optional so the pure
  // frontmatter tests can call fillMissingMandatoryFields without an embedder.
  enriched?: FigmentEnrichment;
}

export function fillMissingMandatoryFields(raw: string, defaults: FillDefaults): FillResult {
  // BOM-safe: a leading UTF-8 BOM makes the exact `--- ` fence check miss an
  // existing frontmatter block, which would prepend a SECOND block (duplicate
  // keys — corruption). Strip it for processing and restore it on output so a
  // BOM-prefixed figment round-trips. (The read/index tiers already tolerate a
  // leading BOM via indexable.ts g6; the writer must too.)
  const BOM = String.fromCodePoint(0xfeff);
  const hasBom = raw.startsWith(BOM);
  const inner = fillMissingMandatoryFieldsInner(hasBom ? raw.slice(1) : raw, defaults);
  return hasBom ? { ...inner, content: BOM + inner.content } : inner;
}

function fillMissingMandatoryFieldsInner(raw: string, defaults: FillDefaults): FillResult {
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
    const line = lines[i]!;
    // Match ONLY top-level (indent-0) keys. A key indented under `meta:` (e.g.
    // `meta:\n  topic: x`) must NOT count the mandatory `topic` as present, or
    // the real top-level field stays unfilled. YAML top-level keys carry no
    // leading whitespace, so an indented line is never a top-level mandatory key.
    if (/^\s/.test(line)) continue;
    for (const f of MANDATORY_FIELDS) {
      if (line.startsWith(`${f}:`) || line.startsWith(`${f} :`)) {
        present.add(f);
        break;
      }
    }
  }
  const missing = MANDATORY_FIELDS.filter((f) => !present.has(f));

  // Phase E.1 FIX B — REPLACE a present-but-BLANK enrichable field (`topic: ""` /
  // `tags: []`) IN PLACE with a NON-blank enriched value. This is the ONLY case
  // where the filler rewrites an EXISTING line; every safeguard below preserves the
  // "never touch an authored value" rail:
  //   - only `topic` + `tags` are eligible (the two field_ownership enrich fields);
  //   - only when the current value is BLANK (isBlankEnrichableValue) — an authored
  //     non-blank value is NEVER matched, so it is byte-preserved;
  //   - only when enrichment produced a NON-blank replacement (renderDefault !== the
  //     blank default) — a blank stays blank (no-op), never churned;
  //   - top-level (indent-0) keys only, inside the LEADING block bounds — a `meta:`-
  //     nested `topic` or a body `---` can't be hit (same anchor as the walks above).
  const blankReplaced: MandatoryField[] = [];
  for (const field of ["topic", "tags"] as const) {
    if (!present.has(field)) continue; // absent → handled by the insertion path below
    const rendered = renderDefault(field, defaults);
    if (rendered === blankDefaultFor(field)) continue; // no non-blank enrichment → leave as-is
    for (let i = firstNonEmpty + 1; i < closeIdx; i++) {
      const line = lines[i]!;
      if (/^\s/.test(line)) continue; // top-level keys only
      if (!(line.startsWith(`${field}:`) || line.startsWith(`${field} :`))) continue;
      const value = line.slice(line.indexOf(":") + 1).trim();
      if (!isBlankEnrichableValue(field, value)) break; // authored non-blank → NEVER overwrite
      lines[i] = `${field}: ${rendered}`;
      blankReplaced.push(field);
      break;
    }
  }

  if (missing.length === 0 && blankReplaced.length === 0) {
    return { content: raw, fieldsFilled: [] };
  }

  // Insert the missing fields right before the closing delim, re-joining with
  // `\n`. NOTE: the downstream stamp hook (upsertLastProvenance) also splits on
  // /\r?\n/ and rejoins with `\n`, so a CRLF-authored figment is normalized to
  // LF on any mutation. That flattening is pre-existing hook behavior; Phase C
  // only broadens WHICH files reach it (whole vault vs `notes/`). Preserving
  // CRLF end-to-end is a tracked cross-cutting follow-up, not fixed here.
  // (closeIdx is still valid: blank-replace only rewrites lines in place, never
  // splices, so it does not shift the closing-delim index.)
  const insertions = missing.map((f) => `${f}: ${renderDefault(f, defaults)}`);
  if (insertions.length > 0) lines.splice(closeIdx, 0, ...insertions);
  return {
    content: lines.join("\n"),
    fieldsFilled: [...missing, ...blankReplaced],
  };
}

// Phase E.1 FIX B — is a present `topic`/`tags` value a BLANK placeholder (safe to
// fill) vs an AUTHORED value (never touch)? A blank value is the pre-E default the
// contract writer emits for an un-set field:
//   - topic : empty, `""`, or `''` (the renderTopicValue blank default).
//   - tags  : empty, `[]`, `""`, or `''` (the renderTagsValue blank default).
// ANY other value is authored → NOT blank → never overwritten. Whitespace-only and
// quote-only forms count as blank (they carry no author content).
function isBlankEnrichableValue(field: "topic" | "tags", value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (v === '""' || v === "''") return true;
  if (field === "tags" && v === "[]") return true;
  return false;
}

// The pre-E blank default renderDefault emits for an enrichable field when there is
// no non-blank enrichment (model-absent / low-confidence / no signal). Used to skip
// a no-op blank→blank rewrite (never churn a file for an unchanged value).
function blankDefaultFor(field: "topic" | "tags"): string {
  return field === "tags" ? "[]" : '""';
}

// Phase E fix-pass (release review FIX 3 — perf) — the CHEAP (no-embed) missing-field
// probe. Returns which mandatory fields a figment is missing, using the EXACT same
// frontmatter walk + top-level-key detection as fillMissingMandatoryFieldsInner, so
// the two can never disagree about "what is missing". The loop calls this FIRST so
// a no-fill file (or a file missing only non-enriched fields) never pays the
// enrichFigment embed cost — enrichment runs only when `topic` or `tags` is
// actually among the missing set. BOM-safe (mirrors fillMissingMandatoryFields).
export function detectMissingMandatoryFields(raw: string): MandatoryField[] {
  const BOM = String.fromCodePoint(0xfeff);
  const inner = raw.startsWith(BOM) ? raw.slice(1) : raw;
  const lines = inner.split(/\r?\n/);
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      firstNonEmpty = i;
      break;
    }
  }
  // No frontmatter, or a malformed (unclosed) block → ALL fields are "missing"
  // (fillMissingMandatoryFieldsInner prepends a fresh full block in both cases).
  if (firstNonEmpty === -1 || lines[firstNonEmpty] !== FRONTMATTER_DELIM) {
    return [...MANDATORY_FIELDS];
  }
  let closeIdx = -1;
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIM) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return [...MANDATORY_FIELDS];

  const present = new Set<MandatoryField>();
  for (let i = firstNonEmpty + 1; i < closeIdx; i++) {
    const line = lines[i]!;
    if (/^\s/.test(line)) continue;
    for (const f of MANDATORY_FIELDS) {
      if (line.startsWith(`${f}:`) || line.startsWith(`${f} :`)) {
        present.add(f);
        break;
      }
    }
  }
  return MANDATORY_FIELDS.filter((f) => !present.has(f));
}

// Phase E.1 FIX B — the CHEAP (no-embed) present-but-BLANK enrichable probe. Returns
// which of `topic`/`tags` are PRESENT in the frontmatter but hold a BLANK placeholder
// value (`topic: ""`, `tags: []`) — i.e. contract-valid (the key is there, so the
// shared contract / doctor / detectMissingMandatoryFields correctly count them
// PRESENT) yet un-authored, so enrichment should fill them. Uses the EXACT same
// leading-anchored, top-level-key walk as fillMissingMandatoryFieldsInner so the
// probe and the fill can never disagree. A NON-blank authored value is never
// returned → the "never overwrite authored" rail holds at the probe layer too.
// BOM-safe. Only inspects `topic`/`tags` (the two enrich fields); the other 6
// mandatory fields are absence-only (handled by detectMissingMandatoryFields).
export function detectBlankEnrichableFields(raw: string): ("topic" | "tags")[] {
  const BOM = String.fromCodePoint(0xfeff);
  const inner = raw.startsWith(BOM) ? raw.slice(1) : raw;
  const lines = inner.split(/\r?\n/);
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      firstNonEmpty = i;
      break;
    }
  }
  if (firstNonEmpty === -1 || lines[firstNonEmpty] !== FRONTMATTER_DELIM) return [];
  let closeIdx = -1;
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIM) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return [];

  const blank: ("topic" | "tags")[] = [];
  for (const field of ["topic", "tags"] as const) {
    for (let i = firstNonEmpty + 1; i < closeIdx; i++) {
      const line = lines[i]!;
      if (/^\s/.test(line)) continue; // top-level keys only
      if (!(line.startsWith(`${field}:`) || line.startsWith(`${field} :`))) continue;
      const value = line.slice(line.indexOf(":") + 1).trim();
      if (isBlankEnrichableValue(field, value)) blank.push(field);
      break; // first top-level occurrence wins (matches the fill walk)
    }
  }
  return blank;
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
      // Phase E — enriched keyword tags when present, else the empty-list
      // default (blank degrades cleanly to the pre-E behavior).
      return renderTagsValue(defaults.enriched?.tags ?? []);
    case "purpose":
      // RAIL — purpose is NEVER auto-filled (not in field_ownership). Always
      // blank; the handler supplies meaning later.
      return '""';
    case "topic":
      // Phase E — a confidently-ranked EXISTING topic when the embedder cleared
      // the confidence floor, else blank (never a guessed topic).
      return renderTopicValue(defaults.enriched?.topic ?? null);
    case "mesh-visibility":
      return "local";
    case "weight":
      return "3";
  }
}

// Render the `tags:` value. A non-empty enriched list becomes a YAML flow
// sequence of double-quoted scalars (`["a", "b"]`); an empty list is the
// pre-E `[]` default. Tags come from suggestFigmentTags (lowercased, deduped,
// tag-shaped) so they are simple content words — but we quote + escape
// defensively so an unexpected glyph can never break the flow sequence.
function renderTagsValue(tags: readonly string[]): string {
  if (tags.length === 0) return "[]";
  const items = tags.map((t) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `[${items.join(", ")}]`;
}

// Render the `topic:` value. A confidently-ranked existing topic becomes a
// double-quoted scalar; null (blank / low-confidence / model-absent) is the
// pre-E `""` default. The topic is an EXISTING vault label (already authored),
// but we quote + escape defensively.
function renderTopicValue(topic: string | null): string {
  if (topic === null || topic.trim().length === 0) return '""';
  return `"${topic.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

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
// Phase C — exposed for unit tests of the git-seconds vs fs-ms date paths.
export { resolveFaithfulDate as _resolveFaithfulDateForTests };
// Phase E — exposed for unit tests of the tag/topic enrichment + render paths.
export {
  enrichFigment as _enrichFigmentForTests,
  renderTagsValue as _renderTagsValueForTests,
  renderTopicValue as _renderTopicValueForTests,
};
export type { EnrichmentContext as _EnrichmentContext, FigmentEnrichment as _FigmentEnrichment };
