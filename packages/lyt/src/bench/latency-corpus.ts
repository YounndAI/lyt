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

// Lane V Workstream 2 — `lyt bench --latency` synthetic corpus generator.
//
// A DETERMINISTIC large markdown corpus for the LATENCY axis only (no oracle —
// quality is never scored against this). Productized from the dev-only
// tools/lane-v/gen-synthetic-corpus.mjs into the shipped package. Index-driven,
// no RNG / no wall-clock, so the same count reproduces byte-identical figments.

import type { VaultSeed } from "./invariant-corpus.js";

const TOPICS = [
  "turso",
  "libsql",
  "replica",
  "federation",
  "yon",
  "primer",
  "lane",
  "arc",
  "rollup",
  "vault",
  "mesh",
  "figment",
  "index",
  "decay",
  "snapshot",
  "edge",
];
const ADJ = [
  "embedded",
  "local",
  "remote",
  "transitive",
  "derived",
  "cached",
  "frozen",
  "stale",
  "fresh",
  "scoped",
];
const NOUN = [
  "design",
  "note",
  "log",
  "spec",
  "probe",
  "result",
  "trace",
  "plan",
  "review",
  "digest",
];

// Fixed base instant — authored-time spread is deterministic per index.
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

function word(i: number, pool: readonly string[]): string {
  return pool[i % pool.length] ?? pool[0]!;
}

// Small deterministic LCG so term frequency / body length vary without RNG.
function lcg(seed: number): number {
  return (seed * 1103515245 + 12345) & 0x7fffffff;
}

function makeNote(i: number): { rel: string; frontmatter: string; body: string } {
  const topic = word(i, TOPICS);
  const topic2 = word(i * 7 + 3, TOPICS);
  const tag = word(i * 3, TOPICS);
  const created = new Date(BASE_MS + (i % 150) * DAY_MS).toISOString();
  const r = lcg(i);
  const reps = 1 + (r % 6); // term frequency 1..6
  const fillerLines = 2 + (lcg(r) % 8); // body length 2..9 paragraphs
  const frontmatter = [
    `title: ${word(i, ADJ)} ${topic} ${word(i, NOUN)} ${String(i).padStart(5, "0")}`,
    `created: ${created}`,
    `modified: ${created}`,
    `tags: [${tag}, synthetic]`,
    "purpose: latency-corpus filler.",
    "topic: bench",
    "mesh-visibility: local",
    "weight: 3",
  ].join("\n");
  const lines = [
    `This ${word(i, NOUN)} is about ${topic}. ` +
      `${topic} `.repeat(reps).trim() +
      ` It also touches ${topic2}.`,
  ];
  for (let k = 0; k < fillerLines; k++) {
    lines.push(
      `Filler ${k}: ${word(i + k, ADJ)} ${word(i + k, NOUN)} regarding ${word(i + k, TOPICS)} and ${word(i + 2 * k, TOPICS)}.`,
    );
  }
  return {
    rel: `notes/syn-${String(i).padStart(5, "0")}.md`,
    frontmatter,
    body: lines.join("\n\n"),
  };
}

// Topic terms present in the corpus — used by the latency probe as queries.
export const LATENCY_PROBE_TERMS: readonly string[] = TOPICS;

export function generateLatencyCorpus(count: number): VaultSeed {
  const n = Math.max(1, Math.floor(count));
  const notes: { rel: string; frontmatter: string; body: string }[] = [];
  for (let i = 1; i <= n; i++) notes.push(makeNote(i));
  return { vault: "latency", notes };
}
