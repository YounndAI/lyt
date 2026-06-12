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

// Lane V Workstream 2 — `lyt bench --latency` probe.
//
// Stands up a temp pod, seeds a synthetic corpus of `count` figments into one
// vault, times the all-tier reindex, then runs a fixed set of queries (repeated)
// and reports query-time p50/p95. The latency axis the quality self-test can't
// give (a review finding). On-demand — default count is modest; pass a larger --count for a
// federation-scale reading before any scale claim.

import { generateLatencyCorpus, LATENCY_PROBE_TERMS } from "./latency-corpus.js";
import { setupBenchPod } from "./pod-harness.js";

export const DEFAULT_LATENCY_COUNT = 1000;
const REPEATS = 3;

export interface LatencyReport {
  corpusSize: number;
  indexMs: number;
  querySamples: number;
  queryP50Ms: number;
  queryP95Ms: number;
  queryMeanMs: number;
  durationMs: number;
}

// Nearest-rank percentile over an ascending-sorted array.
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, idx))] ?? 0;
}

export interface RunLatencyOptions {
  count?: number;
}

export async function runLatencyBench(opts: RunLatencyOptions = {}): Promise<LatencyReport> {
  const startedAt = Date.now();
  const corpusSize = Math.max(1, Math.floor(opts.count ?? DEFAULT_LATENCY_COUNT));
  const pod = setupBenchPod();
  try {
    const seed = generateLatencyCorpus(corpusSize);
    await pod.seedVault(seed.vault, seed.notes);

    const indexStart = Date.now();
    await pod.reindex(seed.vault);
    const indexMs = Date.now() - indexStart;

    const samples: number[] = [];
    for (let r = 0; r < REPEATS; r++) {
      for (const term of LATENCY_PROBE_TERMS) {
        const t = Date.now();
        await pod.search({ query: term, scope: "federation", limit: 20 });
        samples.push(Date.now() - t);
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;

    return {
      corpusSize,
      indexMs,
      querySamples: samples.length,
      queryP50Ms: percentile(sorted, 50),
      queryP95Ms: percentile(sorted, 95),
      queryMeanMs: Math.round(mean),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    pod.teardown();
  }
}
