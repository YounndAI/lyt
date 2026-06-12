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

// Lane V Workstream 2 — `lyt bench` orchestrator.
//
// Runs two phases, each in its OWN isolated temp pod (so the invariant corpus
// and the graded corpus never cross-contaminate each other's queries):
// D-core — pass/fail retrieval invariants (the regression canary)
// E-lite — a planted-relevance graded score (nDCG/recall/MRR/P@1 + cleanliness)
// Metrics-only output — no user content, by construction (synthetic corpora).
// `--quick` runs only the D-core invariants (the every-CI fast path).

import { gradedCorpus, GRADED_QUERIES } from "./graded-corpus.js";
import { INVARIANT_CORPUS, runInvariants, type InvariantResult } from "./invariant-corpus.js";
import {
  aggregateGraded,
  scoreGradedQuery,
  type GradedAggregate,
  type GradedQueryScore,
} from "./ir-metrics.js";
import { setupBenchPod } from "./pod-harness.js";

export interface GradedReport {
  queries: GradedQueryScore[];
  aggregate: GradedAggregate;
}

export interface BenchReport {
  invariants: InvariantResult[];
  graded: GradedReport;
  invariantsPassed: number;
  invariantsTotal: number;
  // True when only the D-core invariants ran (graded phase skipped).
  quick: boolean;
  // ok = all invariants pass AND no hygiene trap leaked. The graded nDCG is a
  // REPORTED metric, not a gate — a deliberately non-aced query keeps it < 1.0,
  // and absolute-number gating would be a re-blessing liability on every
  // intentional ranking change. CONSEQUENCE (release review R1-Q6 / R3-m2): a
  // within-relevant-set ranking regression that breaks no invariant and leaks no
  // trap lowers nDCG without flipping `ok`. So `lyt bench` is a regression CANARY
  // for the named Criticals (V-F5/V-F11/hygiene/scope/arc) + a quality DASHBOARD,
  // NOT a quality-floor gate. Read a green bench accordingly.
  ok: boolean;
  durationMs: number;
}

const EMPTY_GRADED: GradedReport = {
  queries: [],
  aggregate: { queries: 0, ndcg: 0, recall: 0, mrr: 0, pAt1: 0, cleanliness: 0 },
};

export interface RunBenchOptions {
  quick?: boolean;
}

async function runInvariantPhase(): Promise<InvariantResult[]> {
  const pod = setupBenchPod();
  try {
    for (const seed of INVARIANT_CORPUS) await pod.seedVault(seed.vault, seed.notes);
    for (const seed of INVARIANT_CORPUS) await pod.reindex(seed.vault);
    return await runInvariants(pod);
  } finally {
    pod.teardown();
  }
}

async function runGradedPhase(): Promise<GradedReport> {
  const pod = setupBenchPod();
  try {
    const seeds = gradedCorpus();
    for (const seed of seeds) await pod.seedVault(seed.vault, seed.notes);
    for (const seed of seeds) await pod.reindex(seed.vault);
    const queries: GradedQueryScore[] = [];
    for (const q of GRADED_QUERIES) {
      const res = await pod.search({
        query: q.query,
        scope: q.scope,
        ...(q.scopeTarget !== undefined ? { scopeTarget: q.scopeTarget } : {}),
        limit: 20,
      });
      queries.push(scoreGradedQuery(q, res.results));
    }
    return { queries, aggregate: aggregateGraded(queries) };
  } finally {
    pod.teardown();
  }
}

export async function runBench(opts: RunBenchOptions = {}): Promise<BenchReport> {
  const startedAt = Date.now();
  const quick = opts.quick === true;
  const invariants = await runInvariantPhase();
  const graded = quick ? EMPTY_GRADED : await runGradedPhase();
  const invariantsPassed = invariants.filter((i) => i.passed).length;
  const ok = invariantsPassed === invariants.length && graded.aggregate.cleanliness === 0;
  return {
    invariants,
    graded,
    invariantsPassed,
    invariantsTotal: invariants.length,
    quick,
    ok,
    durationMs: Date.now() - startedAt,
  };
}
