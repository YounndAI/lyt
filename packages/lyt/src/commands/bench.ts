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

import { Command } from "commander";

import { DEFAULT_LATENCY_COUNT, runLatencyBench } from "../bench/latency-bench.js";
import { runBench } from "../bench/run-bench.js";

interface BenchCliOpts {
  json?: boolean;
  quick?: boolean;
  latency?: boolean;
  count?: string;
}

// Lane V Workstream 2 — `lyt bench`: a privacy-trivial retrieval self-test.
// Stands up TEMP throwaway pods under os.tmpdir (never the user's ~/lyt), seeds
// tiny deterministic synthetic corpora, indexes them, and reports:
// • (default) D-core invariants + E-lite graded quality
// • --quick invariants only (the fast every-CI path)
// • --latency index + query p50/p95 on a synthetic corpus (--count to scale)
// No user content is read, by construction — safe to run anywhere.
export function buildBenchCommand(): Command {
  return new Command("bench")
    .description(
      "Self-test Lyt's retrieval engine against synthetic corpora (privacy-trivial — reads no user content). Asserts the retrieval invariants and reports a graded quality score; exits non-zero if an invariant or hygiene trap regressed.",
    )
    .option("--json", "Emit a JSON report instead of the human-readable summary")
    .option("--quick", "Run only the pass/fail invariants (skip the graded-quality phase — faster)")
    .option(
      "--latency",
      "Run the latency benchmark (index + query p50/p95) instead of the quality self-test",
    )
    .option(
      "--count <n>",
      `Latency corpus size (default ${DEFAULT_LATENCY_COUNT}; use 5000+ for a federation-scale reading)`,
    )
    .action(async (opts: BenchCliOpts) => {
      try {
        if (opts.latency === true) {
          const parsed = opts.count !== undefined ? Number.parseInt(opts.count, 10) : undefined;
          const report = await runLatencyBench(
            parsed !== undefined && Number.isFinite(parsed) ? { count: parsed } : {},
          );
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          // eslint-disable-next-line no-console
          console.log(
            [
              `lyt bench --latency — synthetic corpus (${report.durationMs}ms)`,
              `  index:  ${report.indexMs}ms  (${report.corpusSize} figments, all tiers)`,
              `  query:  p50 ${report.queryP50Ms}ms   p95 ${report.queryP95Ms}ms   mean ${report.queryMeanMs}ms   (${report.querySamples} samples)`,
            ].join("\n"),
          );
          return;
        }

        const report = await runBench({ quick: opts.quick === true });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(report, null, 2));
          if (!report.ok) process.exitCode = 1;
          return;
        }

        const lines = [
          `lyt bench — retrieval self-test${report.quick ? " (quick)" : ""} (${report.durationMs}ms)`,
          "",
          `Invariants (${report.invariantsPassed}/${report.invariantsTotal} passed):`,
        ];
        for (const inv of report.invariants) {
          lines.push(`  ${inv.passed ? "✓" : "✗"} ${inv.id}  ${inv.name}`);
          if (!inv.passed) lines.push(`        ${inv.detail}`);
        }

        if (!report.quick) {
          const g = report.graded.aggregate;
          lines.push(
            "",
            `Quality (synthetic graded oracle, ${g.queries} queries):`,
            `  nDCG@10 ${g.ndcg}   recall ${g.recall}   MRR ${g.mrr}   P@1 ${g.pAt1}   cleanliness ${g.cleanliness}`,
          );
          for (const q of report.graded.queries) {
            lines.push(`    ${q.id.padEnd(14)} nDCG ${q.ndcg}  recall ${q.recall}  MRR ${q.mrr}`);
          }
          lines.push(
            "  (nDCG < 1.0 is expected — Q-replica is a deliberate non-aced case: raw BM25 ≠ graded relevance, the known v2 rank-fusion residual.)",
          );
        }

        lines.push(
          "",
          report.ok
            ? "PASS — invariants hold and no hygiene trap leaked."
            : "FAIL — an invariant or hygiene trap regressed.",
        );
        // eslint-disable-next-line no-console
        console.log(lines.join("\n"));
        if (!report.ok) process.exitCode = 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`lyt bench: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}
