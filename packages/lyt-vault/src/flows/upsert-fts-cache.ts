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

// v1.D.3a `upsertFtsCache` — post-pull / post-rebuild FTS5 cache
// refresh. Walks `<vault>/notes/**/*.md` and reflects each figment's
// body into lyt.db's figment_fts virtual table.
//
// Posture (Lock 0.2): the SoT is the markdown file on disk; the FTS5
// table is a regenerable cache. The upsert truncates before re-
// inserting so deletions on disk (notes removed; frontmatter changes
// that shift section structure are not relevant — full bodies feed
// FTS5) propagate. Idempotent: a second call on the same vault state
// produces the same row set.
//
// Distinct from upsertLanesCache + upsertArcsCache: those flows read
// a YON SoT file (`.lyt/indexes/{lanes,arcs}.yon`) and reflect into a
// cache. The FTS5 cache has NO intermediate YON SoT — the markdown
// files themselves ARE the SoT, and FTS5 is the search-time cache
// directly over them. There's no `figment_fts.yon` to render.
//
// Called from:
// 1. `rebuildFtsFlow` (manual `lyt vault rebuild-fts` verb) — the
// manual verb IS this flow plus a vault-resolution prelude.
// 2. `lyt-mesh/src/flows/sync.ts` post-pull hook, as the FOURTH
// upsert (ledger → lanes → arcs → fts). Best-effort + non-fatal
// per existing 3-call precedent.
//
// Open-once seam (v1.A.5 CR-B1): optional `lytDb?: Client`; when
// supplied, the caller owns lifecycle; when omitted, the flow opens +
// closes its own client.

import { readFileSync } from "node:fs";
import { posix, relative, sep } from "node:path";

import type { Client } from "@libsql/client";

import { isIndexable, walkVaultMarkdownFiles } from "../util/indexable.js";
import { closeVaultDb, openLytDb } from "../registry/vault-db.js";
import { deleteAllFts, insertFtsDoc } from "../registry/fts-repo.js";
import {
  deleteAllEdges,
  replaceEdgesForFigment,
  type FigmentEdge,
} from "../registry/figment-edges-repo.js";
import { deleteAllMeta, upsertFigmentMeta } from "../registry/figment-meta-repo.js";

export interface UpsertFtsCacheResult {
  vaultPath: string;
  // True when the vault had at least one note and the cache was
  // refreshed. False when the `notes/` directory is missing or empty
  // — caller treats as a no-op.
  ran: boolean;
  ftsDocsUpserted: number;
  durationMs: number;
}

export interface UpsertFtsCacheOpts {
  // Open-once seam (v1.A.5 CR-B1 pattern). When supplied, the flow
  // uses the caller's lyt.db client and does NOT close it. When
  // omitted, the flow opens + closes its own.
  lytDb?: Client;
  // B-4 / Decision-B (B2): when true, write ONLY the figment_fts tier — skip
  // figment_edges + figment_meta (neither deleted nor rebuilt). Used by
  // indexScaffoldFtsOnCreate so a freshly-scaffolded vault's scaffold figments
  // satisfy doctor's index-fts-smoke (reads figment_fts) WITHOUT populating
  // figment_meta — which the primer's "Top keywords" fallback reads, and which
  // a 0-figment vault MUST keep empty to honor the SC3-b honest-empty-placeholder
  // contract. Confines scaffold to search (the accepted nDCG cost); keeps the
  // primer honest. A later full reindex rebuilds all three tiers consistently.
  ftsOnly?: boolean;
}

export async function upsertFtsCache(
  vaultPath: string,
  opts: UpsertFtsCacheOpts = {},
): Promise<UpsertFtsCacheResult> {
  const startedAt = Date.now();
  // B-4: root the FTS walk at the VAULT ROOT (not notes/) via the shared
  // isIndexable predicate — content under any semantic folder is now indexed,
  // while the immutable floor (.lyt/.obsidian/.git), scaffold index.md, and
  // size/binary skips are enforced uniformly. Skipped markdown files surface a
  // reason on a real (non-dry-run) reindex via console.warn (skip = warned).
  const noteFiles = walkVaultMarkdownFiles(vaultPath, isIndexable, {
    onSkip: (relPath, reason) => {
      console.warn(`[reindex] skipped ${relPath}: ${reason}`);
    },
  });
  if (noteFiles.length === 0) {
    return {
      vaultPath,
      ran: false,
      ftsDocsUpserted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const callerSupplied = opts.lytDb !== undefined;
  const db = opts.lytDb ?? (await openLytDb(vaultPath));
  let ftsDocsUpserted = 0;
  try {
    // Truncate first so every cache reflects the SoT verbatim — drops any
    // figment (and its edges + meta) that disappeared on disk between rebuilds.
    // ftsOnly (B2) touches the figment_fts tier ALONE — edges + meta are left
    // untouched (a fresh vault keeps them empty → primer stays honest).
    await deleteAllFts(db);
    if (opts.ftsOnly !== true) {
      await deleteAllEdges(db);
      await deleteAllMeta(db);
    }

    for (const abs of noteFiles) {
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      // Lane V 0.3 hygiene: strip frontmatter + code fences, and pull
      // [[wikilink]] targets out of the FTS body (recorded as edges instead).
      const { body, links } = extractFtsBody(content);
      const relPath = toVaultRelPosix(abs, vaultPath);
      await insertFtsDoc(db, { figmentPath: relPath, body });
      if (opts.ftsOnly !== true) {
        // Lane V 0.4 temporal truth: index the figment's frontmatter authored time.
        const { createdIso, modifiedIso } = parseFigmentDates(content);
        // V-C-1 SC3 option-b: also index topic + tags for the primer keyword
        // fallback. Same lightweight frontmatter scan as parseFigmentDates (no
        // heavyweight YAML parse); tags reuse extractFrontmatterTags (identical to
        // the list folded into the FTS body above → no drift).
        const { topic, tags } = parseFigmentTopicTags(content);
        await replaceEdgesForFigment(db, relPath, links);
        await upsertFigmentMeta(db, { figmentPath: relPath, createdIso, modifiedIso, topic, tags });
      }
      ftsDocsUpserted += 1;
    }
  } finally {
    if (!callerSupplied) await closeVaultDb(db);
  }

  return {
    vaultPath,
    ran: true,
    ftsDocsUpserted,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// B-4 / Decision-B (B2 — ratified 2026-06-24): index a freshly-scaffolded
// vault's figments into FTS at CREATION time, so FTS == on-disk-indexable from
// the first moment (the 3 vault-root scaffold figments README.md /
// lyt-overview.md / agents.md the scaffold writes). B-4 re-rooted every
// READ/index tier off `notes/` onto the vault root, so those scaffold figments
// are now indexable-on-disk; the creation paths wrote them but left FTS empty,
// so doctor's `vaults.index-fts-smoke` canary false-warned ("index EMPTY though
// the vault has 3 figment(s) on disk") on EVERY freshly-created vault —
// including the auto-created `<mesh>/main` vault — flipping `lyt doctor` to exit
// 2. Indexing here keeps the doctor honesty check UNTOUCHED (no blind spot for a
// real wiped index). The Decision-B primary "discriminate on captured/registered
// figments" was ruled out: `figment_meta` is a same-walk rebuildable cache keyed
// on the figment path, NOT a capture registry, so no clean captured-vs-walked
// signal exists; the proper exclude-generated-scaffold-from-indexing fix needs a
// generated-by marker and is a deferred fast-follow.
//
// FTS-ONLY (ftsOnly: true) is deliberate: it satisfies doctor's index-fts-smoke
// (which reads figment_fts) WITHOUT writing figment_meta — the tier the primer's
// "Top keywords" fallback reads. A 0-figment vault MUST keep figment_meta empty
// to honor the SC3-b honest-empty-placeholder contract ("a 0-figment pod keeps
// the honest empty placeholder; fallback does NOT mask it"); writing scaffold
// meta here would surface fake scaffold-derived keywords on a brand-new vault —
// the primer analogue of the fresh-vault-warns UX this whole fix removes. So the
// scaffold lands in SEARCH only (the accepted nDCG cost), never the primer.
//
// SHARED SEAM — call from EVERY fresh-scaffold creation path (right after
// `initVaultDbs`). Currently: flows/init.ts (user `lyt init`) + flows/mesh-init.ts
// (the auto-created `<mesh>/main`). Best-effort: a failure leaves FTS empty and
// doctor will honestly warn (the backstop), so a fresh index hiccup never fails
// the create itself. Idempotent, so safe if a caller is later reindexed (a full
// reindex then rebuilds all three tiers consistently). Do NOT inline this
// `try/catch` per-call-site — keep the one definition so the seams can't drift.
// ---------------------------------------------------------------------------
export async function indexScaffoldFtsOnCreate(vaultPath: string): Promise<void> {
  try {
    await upsertFtsCache(vaultPath, { ftsOnly: true });
  } catch {
    /* non-fatal — doctor's index-fts-smoke remains the honest backstop */
  }
}

// ---------------------------------------------------------------------------
// B-4 (figment-roots): the FTS walk is now THE shared `walkVaultMarkdownFiles`
// from src/util/indexable.ts, rooted at the VAULT ROOT and gated by the single
// `isIndexable` predicate. The pre-B-4 private `walkMarkdownFiles` copy (notes/-
// rooted, with its own sort + scaffold exclusion) is DELETED — its behavior is
// subsumed by the shared walker's uniform sort + the predicate's scaffold/floor
// gates. See the Phase-0 walker-semantics audit for the superset rationale.
// ---------------------------------------------------------------------------

// feat/keyphrase-boost — exported full-walk over `<vault>/**/*.md` for the
// keyphrases cache (and the embeddings + rebuild-vault delegators), so they walk
// the IDENTICAL file set the FTS index walks (same scaffold exclusion, same
// floor, same sort order). B-4: now rooted at the vault root, not notes/.
export function walkVaultFigmentFiles(vaultPath: string): string[] {
  return walkVaultMarkdownFiles(vaultPath, isIndexable);
}

// Exported (Lane M Wave 0) so the incremental per-write reconcile path
// (flows/reconcile-figment-write.ts) computes the SAME vault-relative
// POSIX FTS key as this full-walk reconcile — divergence would let a
// per-write upsert and a later full-walk index the same figment under
// two different rids.
export function toVaultRelPosix(absPath: string, vaultPath: string): string {
  return relative(vaultPath, absPath).split(sep).join(posix.sep);
}

// Strip YAML frontmatter block at the start of a markdown file so the
// FTS5 body column reflects user-facing text. Mirrors the lightweight
// extraction in rebuild-arcs / rebuild-lanes parseFrontmatter helpers
// — full structural parse is unnecessary here (we only need the body
// after the second `---` delimiter).
// Exported (Lane M Wave 0) so the per-write reconcile path strips
// frontmatter identically to this full-walk reconcile — keeps the FTS
// body byte-identical whether a figment was indexed incrementally
// (capture) or via a full rebuild.
export function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      firstNonEmpty = i;
      break;
    }
  }
  if (firstNonEmpty === -1 || lines[firstNonEmpty] !== "---") {
    return raw;
  }
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Lane V 0.3 — content hygiene + figment_edges extraction.
//
// `extractFtsBody` is the SINGLE body-extraction entry point both index paths
// MUST use (the full-walk here; the per-write reconcile-figment-write.ts) so
// the FTS body + edge set are byte-identical regardless of how a figment was
// indexed. Diverging the two paths re-introduces the pollution this fixes.
// ---------------------------------------------------------------------------

// True for LYT-authored scaffold files by basename:
//   - `index.md`   — the auto-generated starter Figment written by scaffold/init.ts
//                    into notes/index.md (any directory level). Not a user Figment.
//                    (V-F12; a user-authored index.md is rare — revisit with a
//                    generated-by marker check if that case ever matters.)
//   - `README.md`  — the GitHub landing file written by scaffold/init.ts at the vault
//                    root. MUST NOT carry frontmatter (GitHub renders it badly); the
//                    Phase A `lyt-scaffold: true` frontmatter gate cannot apply to
//                    it, so we exclude it by basename instead.
//
// Phase A: extend the basename match to cover README.md at any vault level.
// The `lyt-scaffold: true` content gate (in indexable.ts) handles seed Figments
// with frontmatter; this basename gate handles README.md which has no frontmatter.
export function isScaffoldNote(nameOrRelPath: string): boolean {
  const base = (nameOrRelPath.split(/[\\/]/).pop() ?? nameOrRelPath).toLowerCase();
  return base === "index.md" || base === "readme.md";
}

// Remove fenced code blocks (``` or ~~~, 3+ markers) — delimiters, language
// tag, and fenced content — so code-only terms (e.g. a CLI name in a shell
// snippet) are not treated as searchable prose (Qmsg-1). Inline code spans
// (`x`) are left intact: usually real prose terms a user searches for. An
// unterminated fence drops to end-of-doc (rare; safe).
export function stripCodeFences(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  for (const line of lines) {
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceChar === null) {
      if (open) {
        fenceChar = open[1]![0] as "`" | "~";
        continue; // drop the opening fence line
      }
      out.push(line);
    } else {
      // inside a fence: a line of >=3 of the SAME marker closes it
      if (open && open[1]![0] === fenceChar) fenceChar = null;
      // drop fence content + the closing line
    }
  }
  return out.join("\n");
}

export interface ExtractedFtsBody {
  // FTS-ready body: frontmatter, code fences, and wikilink targets removed.
  body: string;
  // Parsed outbound links (wikilink/embed targets) for the figment_edges cache.
  links: FigmentEdge[];
}

// Pull `[[wikilink]]` / `![[embed]]` references out of the body. A target with
// no alias is removed from the FTS body entirely (so `[[turso-deep-dive]]` no
// longer FTS-matches "turso" — Qmsg-2). A piped alias `[[t|shown]]` keeps the
// visible alias text ("shown") as prose while still recording the target as an
// edge. The edge target drops any `#heading` / `^block` fragment.
export function extractWikilinks(body: string): ExtractedFtsBody {
  const links: FigmentEdge[] = [];
  const stripped = body.replace(
    /(!?)\[\[([^[\]]+?)\]\]/g,
    (_m: string, bang: string, inner: string) => {
      const pipe = inner.indexOf("|");
      const rawTarget = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
      const target = rawTarget.replace(/[#^].*$/, "").trim();
      if (target.length > 0) {
        links.push({ target, kind: bang === "!" ? "embed" : "wikilink" });
      }
      return alias; // "" when no alias → link fully removed from FTS body
    },
  );
  return { body: stripped, links };
}

// The single body-extraction pipeline: frontmatter → code fences → wikilinks,
// then frontmatter `tags` folded back in. Order matters: strip fences before
// wikilinks so a `[[link]]` inside a code fence is not recorded as a real edge.
export function extractFtsBody(raw: string): ExtractedFtsBody {
  const noFrontmatter = stripFrontmatter(raw);
  const noCode = stripCodeFences(noFrontmatter);
  const extracted = extractWikilinks(noCode);
  // Frontmatter `tags` are otherwise dropped with the frontmatter, so a UNIQUE
  // tag forms no lane (lanes need ≥2 vault members sharing a tag) and is
  // unfindable (V-F11). Appending the tag terms to the FTS body lets them
  // MATCH directly. Lane-forming tags are unaffected — they still surface at
  // tier-1 first; this only rescues the singleton / rare tags that never
  // formed a lane.
  const tags = extractFrontmatterTags(raw);
  if (tags.length > 0) {
    extracted.body =
      extracted.body.length > 0 ? `${extracted.body}\n${tags.join(" ")}` : tags.join(" ");
  }
  return extracted;
}

// Pull frontmatter `tags` values so they fold into the FTS body (V-F11 fix).
// Handles inline arrays (`tags: [a, b]`), block lists (`tags:` then ` - a`),
// and single scalars (`tags: a`). Strips leading '#', surrounding quotes, and
// array brackets. Returns [] when there is no tags field. Never throws —
// resilience is a core objective: a malformed note must not break the index.
export function extractFrontmatterTags(raw: string): string[] {
  const block = frontmatterBlock(raw);
  if (block === null) return [];
  const lines = block.split(/\r?\n/);
  const out: string[] = [];
  const clean = (s: string): string =>
    s
      .replace(/^#/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^tags\s*:\s*(.*)$/i);
    if (!m) continue;
    const inline = m[1]!.trim();
    if (inline.length > 0 && inline !== "|" && inline !== ">") {
      // inline-array (`tags: [a, b]`) or scalar (`tags: a`) form.
      for (const t of inline.replace(/^\[|\]$/g, "").split(/[,\s]+/)) {
        const c = clean(t);
        if (c.length > 0) out.push(c);
      }
    } else {
      // block-list form (`tags:` then ` - tag` lines) — ONLY when there is no
      // inline value, so a sibling key's list right after an inline `tags:`
      // value can't be misread as tags (release review).
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j]!.match(/^\s*-\s*(.+?)\s*$/);
        if (!item) break;
        const c = clean(item[1]!);
        if (c.length > 0) out.push(c);
      }
    }
    break; // only the first `tags:` key
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lane V 0.4 — frontmatter authored-time extraction (figment_meta source).
// ---------------------------------------------------------------------------

export interface FigmentDates {
  createdIso: string | null;
  modifiedIso: string | null;
}

// Parse the figment's frontmatter authored timestamps into normalized ISO-8601
// (or null). `modified` falls back to `created` when absent so a note carrying
// only `created` still has a recency signal; both null when there is no
// parseable frontmatter date (no frontmatter, missing field, or malformed
// value). Never throws — resilience is a core objective (a malformed note must
// not break the index).
export function parseFigmentDates(raw: string): FigmentDates {
  const block = frontmatterBlock(raw);
  if (block === null) return { createdIso: null, modifiedIso: null };
  const created = normalizeIso(frontmatterField(block, "created"));
  const modified = normalizeIso(frontmatterField(block, "modified"));
  return { createdIso: created, modifiedIso: modified ?? created };
}

// ---------------------------------------------------------------------------
// V-C-1 SC3 option-b — frontmatter topic + tags extraction (figment_meta
// keyword-fallback source). REUSES the existing parsers (frontmatterBlock +
// frontmatterField for the scalar `topic`; extractFrontmatterTags for `tags`),
// so it shares the same lightweight regex frontmatter scan as parseFigmentDates
// — NOT a second heavyweight YAML parse — and the tags it returns are
// byte-identical to the tags folded into the FTS body by extractFtsBody (one
// parser, no drift). Never throws — a malformed note must not break the index.
// ---------------------------------------------------------------------------

export interface FigmentTopicTags {
  topic: string | null;
  tags: string[];
}

export function parseFigmentTopicTags(raw: string): FigmentTopicTags {
  const block = frontmatterBlock(raw);
  const topic = block === null ? null : frontmatterField(block, "topic");
  const tags = extractFrontmatterTags(raw);
  return { topic, tags };
}

// Raw frontmatter block (between the opening and closing `---`), or null when
// the file has no leading frontmatter. Mirrors stripFrontmatter's delimiters.
function frontmatterBlock(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      first = i;
      break;
    }
  }
  if (first === -1 || lines[first] !== "---") return null;
  for (let i = first + 1; i < lines.length; i++) {
    if (lines[i] === "---") return lines.slice(first + 1, i).join("\n");
  }
  return null;
}

// First top-level `key: value` scalar match (surrounding quotes trimmed).
function frontmatterField(block: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "im");
  const m = block.match(re);
  if (!m) return null;
  const v = m[1]!.replace(/^["']|["']$/g, "").trim();
  return v.length > 0 ? v : null;
}

function normalizeIso(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}
