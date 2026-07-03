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

// Phase E (0.10.0 frontmatter-contract lane) — UNIT 3: in-vault suggested-links
// (auto-edge v1). MODEL-FREE.
//
// NOT YET WIRED — pending capture-surface integration (fast-follow); intentionally
// NOT barrel-exported (see packages/lyt-vault/src/index.ts). The proposal functions
// below (`suggestInVaultLinks`, `acceptedLinksToEdges`) + their weight constants are
// correct and unit-tested (tests import this module by its relative path), but have
// ZERO production callers today. A fast-follow will wire the ACCEPT→edge write into
// the `lyt capture` surface (its own UX + review); until then this stays out of the
// public API so no dead public surface ships. Do NOT re-add to the barrel without
// wiring a real caller.
//
// At capture (or on demand), propose OTHER figments in the same vault that share
// the new figment's `topic` and/or `tags` as `[[wikilink]]` candidates the user
// can ACCEPT. An accepted candidate becomes a REAL authored edge via
// figment-edges-repo (replaceEdgesForFigment) — i.e. the human/agent stays in
// the loop; nothing is auto-linked. This is the v1, in-vault, deterministic slice
// of the v2 "semantic + cross-vault auto-edges" headliner (that one needs the
// model + cross-vault trust handling and is explicitly out of scope here).
//
// SCORING (pure, deterministic, no model): a candidate's affinity to the source
// figment is `TOPIC_WEIGHT` when they share the (non-blank) topic, plus
// `TAG_WEIGHT` per shared tag. Candidates with zero affinity are dropped. Ranked
// score DESC, then figment path ASC (stable). This mirrors the figment_meta
// signals the primer already trusts (topic is the stronger signal, ranked ahead
// of tags — same posture as loadKeywordSignals).
//
// WHY here (lyt-vault, pure) and not the CLI: like reconcile-frontmatter's DETECT
// primitives, the PROPOSAL is a pure function over already-parsed figment_meta
// rows; the ACCEPT→edge WRITE is a thin figment-edges-repo call the caller (the
// `lyt capture` surface / an MCP tool) drives once the user picks. Keeping the
// proposal pure makes it unit-testable model-free and reusable by any surface.
//
// TARGET SHAPE: a candidate's wikilink target is its Obsidian link text — the
// basename WITHOUT the `.md` extension (Obsidian resolves `[[name]]` by
// basename/title, no path, no extension), matching the `target` shape
// extractWikilinks records into figment_edges. This means an accepted suggestion
// round-trips: the edge it writes has the same target the FTS extractor would
// have parsed had the user typed the `[[wikilink]]` by hand.

import type { FigmentEdge } from "../registry/figment-edges-repo.js";

/** Affinity weight for a shared (non-blank) topic — the stronger signal. */
export const TOPIC_WEIGHT = 3;

/** Affinity weight per shared tag. */
export const TAG_WEIGHT = 1;

/** Default cap on the number of suggested links returned. */
export const DEFAULT_MAX_SUGGESTED_LINKS = 5;

/** One in-vault figment's semantic metadata — the proposal's input rows. Shape
 *  matches figment_meta (figment path + topic + tags). */
export interface FigmentMetaLite {
  /** Vault-relative POSIX path (the figment_meta / figment_fts key shape). */
  figmentPath: string;
  /** Frontmatter topic (trimmed), or null/blank when none. */
  topic: string | null;
  /** Frontmatter tags (already a string[]; empty when none). */
  tags: readonly string[];
}

/** A proposed in-vault link the user can accept. */
export interface SuggestedLink {
  /** The candidate figment's vault-relative POSIX path. */
  targetPath: string;
  /** The `[[wikilink]]` target text (basename, no `.md`) — what an accepted
   *  edge stores + what a hand-typed `[[...]]` would resolve to. */
  wikilinkTarget: string;
  /** Affinity score (TOPIC_WEIGHT if topic shared + TAG_WEIGHT × shared tags). */
  score: number;
  /** The shared topic (when the topics matched), else null. */
  sharedTopic: string | null;
  /** The tags both figments carry. */
  sharedTags: string[];
}

export interface SuggestLinksOptions {
  /** Cap on returned suggestions. Default DEFAULT_MAX_SUGGESTED_LINKS. `<= 0` →
   *  returns `[]` (a clean "suggestions off" degrade with no code fork). */
  maxLinks?: number;
}

// Obsidian link text for a candidate: basename with `.md` stripped. NOT the full
// path — Obsidian's default `[[name]]` is basename-only, and that is the shape
// extractWikilinks records, so an accepted suggestion's edge target matches a
// hand-typed one. (A same-basename collision across folders is an accepted v1
// limitation — the same ambiguity Obsidian itself has; a path-qualified target is
// a v2 refinement alongside the cross-vault work.)
function wikilinkTargetForPath(figmentPath: string): string {
  const base = figmentPath.split("/").pop() ?? figmentPath;
  return base.replace(/\.md$/i, "");
}

// Case-folded, trimmed, de-duped tag set for affinity comparison.
function normTagSet(tags: readonly string[]): Set<string> {
  const s = new Set<string>();
  for (const t of tags) {
    const n = t.trim().toLowerCase();
    if (n.length > 0) s.add(n);
  }
  return s;
}

function normTopic(topic: string | null): string | null {
  if (topic === null) return null;
  const t = topic.trim();
  return t.length > 0 ? t : null;
}

/**
 * Propose in-vault `[[wikilink]]` candidates for `source` from the other
 * figments in the vault, ranked by shared-topic + shared-tag affinity. Pure +
 * deterministic + model-free. Never proposes the source figment itself, and
 * never proposes a candidate already linked (`alreadyLinkedTargets`).
 *
 * @param source the figment being captured/enriched (its own path, topic, tags).
 * @param candidates every OTHER figment_meta row in the vault. The source row (by
 *   path) is filtered out defensively even if present.
 * @param alreadyLinkedTargets wikilink targets the source ALREADY links (from its
 *   figment_edges) — suppressed so we never re-propose an existing edge. Compared
 *   case-insensitively against each candidate's wikilink target.
 * @returns ranked SuggestedLink[] (score DESC, path ASC), capped at maxLinks.
 *   Empty when nothing shares topic/tags (or maxLinks <= 0).
 */
export function suggestInVaultLinks(
  source: FigmentMetaLite,
  candidates: readonly FigmentMetaLite[],
  alreadyLinkedTargets: readonly string[] = [],
  opts: SuggestLinksOptions = {},
): SuggestedLink[] {
  const maxLinks = opts.maxLinks ?? DEFAULT_MAX_SUGGESTED_LINKS;
  if (maxLinks <= 0) return [];

  const srcTopic = normTopic(source.topic);
  const srcTags = normTagSet(source.tags);
  const linkedLower = new Set(alreadyLinkedTargets.map((t) => t.trim().toLowerCase()));

  const out: SuggestedLink[] = [];
  for (const cand of candidates) {
    if (cand.figmentPath === source.figmentPath) continue; // never self-link

    const candTopic = normTopic(cand.topic);
    const topicMatch =
      srcTopic !== null && candTopic !== null && srcTopic.toLowerCase() === candTopic.toLowerCase();

    const candTags = normTagSet(cand.tags);
    const sharedTags: string[] = [];
    for (const t of srcTags) if (candTags.has(t)) sharedTags.push(t);

    const score = (topicMatch ? TOPIC_WEIGHT : 0) + sharedTags.length * TAG_WEIGHT;
    if (score === 0) continue; // no affinity → not a suggestion

    const wikilinkTarget = wikilinkTargetForPath(cand.figmentPath);
    // Suppress a candidate the source already links (dedupe against existing
    // edges) so accepting suggestions is idempotent with the current link set.
    if (linkedLower.has(wikilinkTarget.trim().toLowerCase())) continue;

    out.push({
      targetPath: cand.figmentPath,
      wikilinkTarget,
      score,
      sharedTopic: topicMatch ? (srcTopic as string) : null,
      sharedTags: sharedTags.sort(),
    });
  }

  out.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.targetPath < b.targetPath
        ? -1
        : a.targetPath > b.targetPath
          ? 1
          : 0,
  );
  return out.slice(0, maxLinks);
}

/**
 * Convert accepted suggestions into the FigmentEdge[] shape figment-edges-repo
 * writes. The caller passes the suggestions the user ACCEPTED (a subset of
 * suggestInVaultLinks' output); this maps each to a `wikilink` edge whose target
 * matches the hand-typed `[[...]]` shape. The caller then persists them via
 * `replaceEdgesForFigment(db, source.figmentPath, [...existingEdges, ...these])`
 * — this helper deliberately does NOT touch the db (keeps the proposal layer
 * pure + testable; the write is the caller's one-line, gated step).
 */
export function acceptedLinksToEdges(accepted: readonly SuggestedLink[]): FigmentEdge[] {
  return accepted.map((s) => ({ target: s.wikilinkTarget, kind: "wikilink" as const }));
}
