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

// Positioning lint — Lane O Phase 0 (LYT).
//
// A pure, dependency-free scanner that flags banned brand-positioning phrases
// in shipped content or source. Built standalone + exported so the later GP-2
// leakage check can import `scanForbiddenPhrases` + `FORBIDDEN_PHRASES` and
// reuse / extend the same canonical list rather than re-deriving it.
//
// Canonical forbidden phrases come from the LYT brand Locked decisions :
// Lyt is positioned as the federation layer over the user's own markdown
// vaults ("pod"), NOT as a "second brain" / "exocortex" / "AI memory" product.
// Those phrases are off-message and must never leak into shipped copy.
//
// Matching rules:
// - case-insensitive ("Second Brain" == "second brain")
// - word-boundary aware at both ends, so "AI memory" does NOT match inside
// "AI memorystore" and "exocortex" does NOT match "exocortexual". Internal
// whitespace between words is treated flexibly (one-or-more spaces/tabs)
// so a phrase wrapped across runs of spaces still trips.
// - reports every occurrence (global scan), each with the matched text, the
// 0-based character index, and the 1-based line number.

/**
 * Canonical banned brand-positioning phrases (LYT Locked decisions).
 *
 * Exported as a readonly const so downstream consumers (GP-2 leakage check)
 * can import and extend the list from a single source of truth instead of
 * duplicating string literals. Phrases are stored lowercase; matching is
 * case-insensitive regardless.
 */
export const FORBIDDEN_PHRASES = [
  "second brain",
  "federated second brain",
  "exocortex",
  "AI memory",
  "federated memory",
] as const;

export type ForbiddenPhrase = (typeof FORBIDDEN_PHRASES)[number];

/** A single banned-phrase occurrence found by {@link scanForbiddenPhrases}. */
export interface Match {
  /** The canonical forbidden phrase that matched (from FORBIDDEN_PHRASES). */
  phrase: ForbiddenPhrase;
  /** The exact substring as it appeared in the input (original casing). */
  matched: string;
  /** 0-based character index of the match start within `text`. */
  index: number;
  /** 1-based line number of the match start within `text`. */
  line: number;
}

/** Escape a literal string for safe use inside a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a single case-insensitive, word-boundary-aware regex that matches any
 * of the forbidden phrases. Internal single spaces in a phrase become `\s+`
 * so multi-space / tab-separated occurrences still match.
 *
 * Word boundaries are applied with `\b` so substring-internal hits (e.g.
 * "exocortex" inside "exocortexual") are NOT flagged. Phrases are sorted
 * longest-first in the alternation so the more specific phrase (e.g.
 * "federated second brain") is preferred over a shorter overlap.
 */
function buildPattern(phrases: readonly string[]): RegExp {
  const alternation = [...phrases]
    .sort((a, b) => b.length - a.length)
    .map((p) => escapeRegExp(p).replace(/\s+/g, "\\s+"))
    .join("|");
  return new RegExp(`\\b(?:${alternation})\\b`, "gi");
}

/**
 * Map a matched substring back to its canonical FORBIDDEN_PHRASES entry.
 * Collapses internal whitespace + lowercases so a multi-space hit resolves
 * to its single-space canonical form.
 */
function canonicalize(matched: string): ForbiddenPhrase {
  const normalized = matched.toLowerCase().replace(/\s+/g, " ").trim();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (phrase.toLowerCase() === normalized) return phrase;
  }
  // Unreachable in practice — the regex is built only from FORBIDDEN_PHRASES —
  // but keep a defined fallback so the return type stays honest.
  return normalized as ForbiddenPhrase;
}

/**
 * Scan `text` for banned brand-positioning phrases.
 *
 * Pure and dependency-free: no I/O, no globals, deterministic. Returns every
 * occurrence in source order. An empty array means the text is clean.
 *
 * @param text Arbitrary content (markdown, source, plain prose).
 * @param phrases Override list (defaults to FORBIDDEN_PHRASES); GP-2 can pass
 * an extended list without re-implementing the scanner.
 */
export function scanForbiddenPhrases(
  text: string,
  phrases: readonly string[] = FORBIDDEN_PHRASES,
): Match[] {
  if (!text || phrases.length === 0) return [];

  const pattern = buildPattern(phrases);
  const matches: Match[] = [];

  for (const m of text.matchAll(pattern)) {
    const index = m.index ?? 0;
    // 1-based line number = count of newlines before the match + 1.
    let line = 1;
    for (let i = 0; i < index; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) line++;
    }
    matches.push({
      phrase: canonicalize(m[0]),
      matched: m[0],
      index,
      line,
    });
  }

  return matches;
}
