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

// Keyphrase extraction — deterministic, pure-statistical "aboutness" scorer.
//
// Ported verbatim (algorithm + constants) from the proven prototype
// `.scratch/keyphrase-eval.mts`, which measured a post-hoc keyphrase-match
// boost at β=0.2 lifting the A2 oracle nDCG@5 0.296→0.452 (+53%, zero
// regressions). This module makes that lever real: it is the SINGLE
// keyphrase-extraction entry point both the index build (rebuild-keyphrases
// full-walk) AND the query-side tokenizer (search-cascade boost) consume — so
// what the cache stores and what the query matches against tokenize identically.
//
// Determinism contract (Lock 0.2 cache posture): NO LLM, NO Date.now(), NO
// random. The output token set for a given (title, body, topK) is byte-stable —
// re-running rebuild-keyphrases over the same markdown produces the identical
// cache rows, exactly like rebuild-lanes / rebuild-fts.
//
// YAKE-flavored scorer (single-word + 2/3-gram phrases):
//  - title/heading membership: big boost (intentional aboutness signals)
//  - body frequency: log-damped term frequency
//  - dispersion: spread across the doc (std of normalized positions)
//  - early position: first occurrence near the top
// Top-K terms (mix of words + phrases) are kept; phrases are split into their
// member words so the stored set + `keyphraseMatch` are token-level.

export const DEFAULT_KEYPHRASE_TOP_K = 10;

// Stopword set — verbatim from the prototype. Function words + the
// instruction/question words that dominate natural-language queries, so neither
// the indexed keyphrase set nor the query tokens carry noise.
const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when", "at", "by", "for", "with",
  "about", "against", "between", "into", "through", "during", "before", "after", "above", "below",
  "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further", "once",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "having", "do", "does", "did",
  "doing", "of", "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they", "them",
  "his", "her", "its", "our", "their", "my", "your", "me", "him", "us", "what", "which", "who", "whom",
  "as", "so", "than", "too", "very", "can", "will", "just", "not", "no", "nor", "only", "own", "same",
  "such", "more", "most", "some", "any", "each", "few", "other", "all", "both", "because", "while",
  "how", "why", "where", "there", "here", "also", "via", "per", "etc", "vs", "use", "using", "used",
  "get", "got", "one", "two", "new", "now", "into", "onto", "upon", "within", "without",
]);

// Tokenize to lowercase content tokens. Keep alphanum incl. internal digits
// (uuidv7), drop pure numbers and punctuation. Keep hyphenated as a single token
// AND strip surrounding hyphens. Verbatim from the prototype.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_#>[\]()]/g, " ")
    .split(/[^a-z0-9-]+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

export function isContentWord(t: string): boolean {
  return t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t);
}

interface Candidate {
  term: string;
  score: number;
}

// Extract the top-K keyphrase TOKENS for a figment from its title + body.
// Returns a deterministic, lexicographically-sorted token array (the cache
// stores one row per token; sorting keeps the row set + any debug dump stable).
export function extractKeyphraseTokens(
  title: string,
  body: string,
  topK: number = DEFAULT_KEYPHRASE_TOP_K,
): string[] {
  const titleTokens = new Set(tokenize(title).filter(isContentWord));
  // headings = lines starting with #
  const headingText = body
    .split(/\r?\n/)
    .filter((l) => /^#{1,6}\s/.test(l))
    .join(" ");
  const headingTokens = new Set(tokenize(headingText).filter(isContentWord));

  const tokens = tokenize(body);
  const N = tokens.length || 1;

  // per content-word positions
  const positions = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    if (!isContentWord(t)) return;
    const arr = positions.get(t);
    if (arr) arr.push(i);
    else positions.set(t, [i]);
  });

  const scoreWord = (term: string, pos: number[]): number => {
    const tf = pos.length;
    const freqScore = Math.log2(1 + tf); // log-damped frequency
    // dispersion: normalized-position std (0..~0.5). Higher = spread out.
    const norm = pos.map((p) => p / N);
    const mean = norm.reduce((a, b) => a + b, 0) / norm.length;
    const variance = norm.reduce((a, b) => a + (b - mean) ** 2, 0) / norm.length;
    const dispersion = Math.sqrt(variance); // 0 if single occurrence
    const dispScore = tf >= 2 ? 0.5 + dispersion : 0.0; // need >=2 to be "spread"
    // early position bonus: first occurrence in top 15% of doc
    const first = pos[0]! / N;
    const earlyScore = first < 0.15 ? 1.0 : first < 0.4 ? 0.4 : 0.0;
    // membership boosts
    const titleBoost = titleTokens.has(term) ? 3.0 : 0.0;
    const headingBoost = headingTokens.has(term) ? 1.5 : 0.0;
    return freqScore + dispScore + earlyScore + titleBoost + headingBoost;
  };

  const wordCands: Candidate[] = [];
  for (const [term, pos] of positions) {
    // require term to appear at least twice OR be in title/heading (single-
    // mention body words are noise; title/heading words are intentional
    // aboutness signals).
    if (pos.length < 2 && !titleTokens.has(term) && !headingTokens.has(term)) continue;
    wordCands.push({ term, score: scoreWord(term, pos) });
  }

  // 2-3 word phrases: adjacent runs of content words (no stopword break).
  // Score = sum of member word scores · phrase-length bonus, require freq>=2.
  const phraseCounts = new Map<string, { count: number; firstPos: number; members: string[] }>();
  let runStart = -1;
  const wordScoreOf = new Map<string, number>();
  for (const c of wordCands) wordScoreOf.set(c.term, c.score);
  for (let i = 0; i <= tokens.length; i++) {
    const t = tokens[i];
    const ok = t !== undefined && isContentWord(t);
    if (ok) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0) {
        const run = tokens.slice(runStart, i).filter(isContentWord);
        // emit 2- and 3-grams from the run
        for (let len = 2; len <= 3; len++) {
          for (let s = 0; s + len <= run.length; s++) {
            const members = run.slice(s, s + len);
            const phrase = members.join(" ");
            const cur = phraseCounts.get(phrase);
            if (cur) cur.count++;
            else phraseCounts.set(phrase, { count: 1, firstPos: runStart + s, members });
          }
        }
        runStart = -1;
      }
    }
  }
  const titleJoined = tokenize(title).join(" ");
  const phraseCands: Candidate[] = [];
  for (const [phrase, info] of phraseCounts) {
    const inTitle = titleJoined.includes(phrase);
    if (info.count < 2 && !inTitle) continue;
    const memberSum = info.members.reduce(
      (a, m) => a + (wordScoreOf.get(m) ?? Math.log2(1 + info.count)),
      0,
    );
    const lenBonus = info.members.length === 3 ? 1.4 : 1.2;
    const titleBoost = inTitle ? 3.0 : 0.0;
    phraseCands.push({ term: phrase, score: memberSum * lenBonus + titleBoost });
  }

  // Deterministic ordering: by score DESC, then term ASC on ties (the prototype
  // relied on Map insertion order for ties; an explicit term tiebreak makes the
  // top-K cut byte-stable regardless of iteration order).
  const all = [...wordCands, ...phraseCands].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.term < b.term ? -1 : a.term > b.term ? 1 : 0,
  );
  const kept = all.slice(0, topK);
  const set = new Set<string>();
  for (const c of kept) {
    for (const w of c.term.split(" ")) set.add(w);
  }
  return [...set].sort();
}

// keyphraseMatch: count of query content-tokens present in the doc's keyphrase
// token set. Verbatim semantics from the prototype's boost term.
export function keyphraseMatch(queryTokens: readonly string[], kpSet: ReadonlySet<string>): number {
  let n = 0;
  for (const qt of queryTokens) if (kpSet.has(qt)) n++;
  return n;
}

// Query-side token extraction: lowercase content tokens of the query, stripped
// to content words. The SAME tokenizer the index used, so a query token can only
// match a stored keyphrase token when they tokenize the same way.
export function queryKeyphraseTokens(query: string): string[] {
  return tokenize(query).filter(isContentWord);
}
