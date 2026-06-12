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

// Lane V Workstream 2 — `lyt bench` E-lite: the planted-relevance graded corpus.
//
// A small DETERMINISTIC corpus whose relevance is planted BY CONSTRUCTION: each
// query's relevant docs are authored with known graded relevance, so the oracle
// falls out of generation (no after-the-fact, author-as-verifier judging). Three
// queries are "aced" (BM25 frequency tracks the grade); Q-replica is a DELIBERATE
// non-aced case (raw BM25 frequency inverts the graded order — the known
// "BM25 ≠ graded relevance" residual, fixable only by v2 rank-fusion) so the
// headline nDCG is honestly < 1.0 rather than a suspicious, self-flattering 1.0.

import type { VaultSeed } from "./invariant-corpus.js";
import type { GradedQuery } from "./ir-metrics.js";

const TS = "created: 2026-02-01T00:00:00.000Z\nmodified: 2026-02-01T00:00:00.000Z";

interface Doc {
  vault: string;
  rel: string;
  body: string;
}

// Planted graded docs live in `graded-main`; topic terms are isolated per query
// so BM25 frequency cleanly tracks the intended grade (except Q-replica).
const PLANTED: Doc[] = [
  // Q-turso — aced. turso-1 (×5) > turso-2 (×2) > turso-3 (×1) ⇒ grade order 3,2,1.
  {
    vault: "graded-main",
    rel: "notes/turso-1.md",
    body: "turso is an edge database. turso turso turso scales globally with turso.",
  },
  {
    vault: "graded-main",
    rel: "notes/turso-2.md",
    body: "We evaluated turso for production. turso handles writes.",
  },
  { vault: "graded-main", rel: "notes/turso-3.md", body: "A passing mention of turso here." },
  // Q-libsql — aced.
  {
    vault: "graded-main",
    rel: "notes/libsql-1.md",
    body: "libsql is a sqlite fork. libsql client and libsql server libsql.",
  },
  { vault: "graded-main", rel: "notes/libsql-2.md", body: "built on libsql internally." },
  // Q-federation — aced.
  {
    vault: "graded-main",
    rel: "notes/fed-1.md",
    body: "federation connects vaults. federation edges and federation subscriptions federation.",
  },
  { vault: "graded-main", rel: "notes/fed-2.md", body: "the federation layer spans vaults." },
  // Q-replica — NON-ACED. replica-rep (×6, grade 1) outranks replica-design
  // (×3, grade 3) by raw BM25 ⇒ nDCG ≈ 0.71 for this query. Intentional.
  {
    vault: "graded-main",
    rel: "notes/replica-design.md",
    body: "Embedded replica design. The replica model is the canonical local-first replica approach.",
  },
  {
    vault: "graded-main",
    rel: "notes/replica-rep.md",
    body: "replica replica replica replica replica replica shards.",
  },
  // Cleanliness trap — "turso" appears ONLY inside a code fence (stripped by FTS
  // hygiene). If it surfaces for Q-turso, cleanliness > 0 and the bench fails.
  {
    vault: "graded-main",
    rel: "notes/fence-trap.md",
    body: "Tea notes and beverages.\n\n```\nturso()\n```\n",
  },
];

// Off-topic filler (a second vault) — realistic noise; shares no query term.
const FILLER_TOPICS = [
  "recipe brunch",
  "travel itinerary",
  "meeting agenda",
  "garden notes",
  "book review",
  "budget summary",
];

function fillerDocs(): Doc[] {
  return FILLER_TOPICS.map((t, i) => ({
    vault: "graded-side",
    rel: `notes/filler-${String(i + 1).padStart(2, "0")}.md`,
    body: `Notes on ${t}. ${t} details and ${t} follow-ups.`,
  }));
}

export function gradedCorpus(): VaultSeed[] {
  const byVault = new Map<string, VaultSeed>();
  for (const d of [...PLANTED, ...fillerDocs()]) {
    let seed = byVault.get(d.vault);
    if (seed === undefined) {
      seed = { vault: d.vault, notes: [] };
      byVault.set(d.vault, seed);
    }
    seed.notes.push({ rel: d.rel, frontmatter: TS, body: d.body });
  }
  return [...byVault.values()];
}

export const GRADED_QUERIES: readonly GradedQuery[] = [
  {
    id: "Q-turso",
    query: "turso",
    scope: "federation",
    grades: { "turso-1.md": 3, "turso-2.md": 2, "turso-3.md": 1 },
    traps: ["fence-trap.md"],
  },
  {
    id: "Q-libsql",
    query: "libsql",
    scope: "federation",
    grades: { "libsql-1.md": 3, "libsql-2.md": 1 },
  },
  {
    id: "Q-federation",
    query: "federation",
    scope: "federation",
    grades: { "fed-1.md": 3, "fed-2.md": 2 },
  },
  {
    id: "Q-replica",
    query: "replica",
    scope: "federation",
    grades: { "replica-design.md": 3, "replica-rep.md": 1 },
  },
];
