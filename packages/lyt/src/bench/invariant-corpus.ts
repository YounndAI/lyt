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

// Lane V Workstream 2 — `lyt bench` D-core: the retrieval-invariant contract.
//
// A tiny DETERMINISTIC synthetic corpus that encodes the canonical retrieval
// shapes plus the two Lane-V regression Criticals, expressed as pass/fail
// INVARIANTS rather than absolute nDCG goldens. Invariants survive intentional
// ranking refactors (they only break on a real regression) and carry no user
// content. This is the install/version regression canary.
//
// INV-1 V-F5 a strong body hit outranks a tag-only lane hit
// INV-2 V-F11 a unique tag (no lane) is still findable (tags→FTS)
// INV-3 hygiene a term living only in a code fence is not indexed
// INV-4 determinism: identical query → identical ranked results
// INV-5 scope: vault scope does not leak other vaults
// INV-6 arc: tier-0 prior lifts arc members above an equal-relevance non-arc doc (boost-not-gate)

import type { BenchPod } from "./pod-harness.js";
import type { SearchCascadeResult } from "@younndai/lyt-vault";

export interface InvariantResult {
  id: string;
  name: string;
  passed: boolean;
  // Human-readable observation (always present, even on pass, for the report).
  detail: string;
}

export interface VaultSeed {
  vault: string;
  notes: { rel: string; frontmatter: string; body: string }[];
}

// Every figment shares a fixed authored-time so indexing is reproducible.
const TS = "created: 2026-01-01T00:00:00.000Z\nmodified: 2026-01-01T00:00:00.000Z";

export const INVARIANT_CORPUS: readonly VaultSeed[] = [
  {
    vault: "core",
    notes: [
      // INV-1 (V-F5): two off-topic notes tagged `turso` form a lane (tier-1);
      // a third has `turso` heavily in the BODY but is NOT tagged turso (tier-2).
      // The strong body hit must outrank the tag-only lane hits.
      {
        rel: "notes/turso-tag-a.md",
        frontmatter: `${TS}\ntags: [turso]`,
        body: "Meeting schedule and logistics for the offsite.",
      },
      {
        rel: "notes/turso-tag-b.md",
        frontmatter: `${TS}\ntags: [turso]`,
        body: "Quarterly planning notes and roadmap review.",
      },
      {
        rel: "notes/turso-body.md",
        frontmatter: `${TS}\ntags: [database]`,
        body: "turso turso turso turso turso embedded replica libsql on turso.",
      },

      // INV-2 (V-F11): a UNIQUE tag (one note → no lane). The token "singleton"
      // appears ONLY as a tag, never in the body, so tags→FTS is the only path.
      {
        rel: "notes/unique.md",
        frontmatter: `${TS}\ntags: [singleton]`,
        body: "A standalone one-off note about miscellaneous topics.",
      },

      // INV-3 (hygiene): "espresso" lives ONLY inside a fenced code block, which
      // FTS hygiene strips. A query for it must return zero hits.
      {
        rel: "notes/coffee-fence.md",
        frontmatter: `${TS}\ntags: [coffee]`,
        body: "Notes on tea and other beverages.\n\n```js\nfunction espresso() { return true; }\n```\n",
      },

      // INV-6 (arc primacy): an arc "Build Pipeline" with two members (tier-0).
      // A separate body-only note must NOT displace the arc members from the top.
      {
        rel: "notes/arc-decl.md",
        frontmatter: "t: arc-decl",
        body: '@ARC rid=arc:build-pipeline\n  | name="Build Pipeline"\n  | category="ops"\n  | last_touched:ts=2026-01-01T00:00:00.000Z\n',
      },
      {
        rel: "notes/pipeline-m1.md",
        frontmatter: `${TS}\narcs: [build-pipeline]`,
        body: "Stage one of the rollout.",
      },
      {
        rel: "notes/pipeline-m2.md",
        frontmatter: `${TS}\narcs: [build-pipeline]`,
        body: "Stage two of the rollout.",
      },
      {
        rel: "notes/pipeline-body.md",
        frontmatter: `${TS}\ntags: [misc]`,
        body: "pipeline pipeline throughput and latency pipeline.",
      },
    ],
  },
  {
    // INV-5 (vault-scope isolation): a second vault that ALSO matches "turso".
    // A scope:vault search of `core` must never surface this note.
    vault: "side",
    notes: [
      {
        rel: "notes/turso-side.md",
        frontmatter: `${TS}\ntags: [database]`,
        body: "turso replication notes from the side vault.",
      },
    ],
  },
];

export async function runInvariants(pod: BenchPod): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];

  // INV-1 — V-F5: strong body hit outranks tag-only lane hits.
  {
    const res = await pod.search({ query: "turso", scope: "federation", limit: 20 });
    const rankOf = (suffix: string): number =>
      res.results.findIndex((r) => r.figment_path.endsWith(suffix));
    const body = rankOf("turso-body.md");
    const tagA = rankOf("turso-tag-a.md");
    const tagB = rankOf("turso-tag-b.md");
    const passed = body >= 0 && tagA >= 0 && tagB >= 0 && body < tagA && body < tagB;
    results.push({
      id: "INV-1",
      name: "V-F5 — strong body hit outranks tag-only lane hits",
      passed,
      detail: `query "turso": body#${body} vs tag-a#${tagA}, tag-b#${tagB} (body must rank first)`,
    });
  }

  // INV-2 — V-F11: a unique tag (no lane) is still findable via tags→FTS.
  {
    const res = await pod.search({ query: "singleton", scope: "federation", limit: 20 });
    const found = res.results.some((r) => r.figment_path.endsWith("unique.md"));
    results.push({
      id: "INV-2",
      name: "V-F11 — unique tag is findable",
      passed: found,
      detail: `query "singleton": ${res.results.length} hit(s); unique.md ${found ? "found" : "MISSING"}`,
    });
  }

  // INV-3 — hygiene: a term that lives only in a code fence is not indexed.
  {
    const res = await pod.search({ query: "espresso", scope: "federation", limit: 20 });
    const passed = res.results.length === 0;
    results.push({
      id: "INV-3",
      name: "Hygiene — code-fence term is not FTS-indexed",
      passed,
      detail: `query "espresso": expected 0 hits, got ${res.results.length}`,
    });
  }

  // INV-5 — vault-scope isolation: scope:vault must not leak other vaults.
  {
    const res = await pod.search({
      query: "turso",
      scope: "vault",
      scopeTarget: "core",
      limit: 20,
    });
    const leaked = res.results.filter((r) => r.vault_name !== "core");
    const passed = res.results.length > 0 && leaked.length === 0;
    results.push({
      id: "INV-5",
      name: "Scope — vault scope does not leak other vaults",
      passed,
      detail: `scope=vault core "turso": ${res.results.length} hit(s), ${leaked.length} from other vaults`,
    });
  }

  // INV-6 — arc primacy: tier-0 arc members keep the top under the blend.
  {
    const res = await pod.search({
      query: "pipeline",
      scope: "vault",
      scopeTarget: "core",
      limit: 20,
    });
    const idxOf = (suffix: string): number =>
      res.results.findIndex((r) => r.figment_path.endsWith(suffix));
    const m1 = idxOf("pipeline-m1.md");
    const m2 = idxOf("pipeline-m2.md");
    const arcDecl = idxOf("arc-decl.md");
    // "tier = boost, NOT gate" (the soft-tier blend contract): a tier-0 arc member is
    // NOT guaranteed rank 0 — under the keyphrase-aboutness vein a doc
    // saturated with the query term legitimately takes the top. The tier-0
    // prior must still demonstrably LIFT the arc members: both present, both
    // in the top 3, and both ranked ABOVE an equal-relevance non-arc tier-2
    // doc (arc-decl). Fails if the blend stops boosting tier-0 (members sink to
    // or below the non-arc doc) — the regression this canary guards.
    const found = m1 >= 0 && m2 >= 0;
    const inTopThree = found && m1 < 3 && m2 < 3;
    const liftsAboveNonArc = found && arcDecl >= 0 && m1 < arcDecl && m2 < arcDecl;
    const passed = found && inTopThree && liftsAboveNonArc;
    results.push({
      id: "INV-6",
      name: "Arc primacy — tier-0 prior lifts arc members above equal-relevance non-arc (boost-not-gate)",
      passed,
      detail: `query "pipeline": m1#${m1}, m2#${m2}, non-arc arc-decl#${arcDecl} (members must be top-3 AND above arc-decl)`,
    });
  }

  // INV-4 — determinism: identical query → identical ranked results.
  {
    const a = await pod.search({ query: "turso", scope: "federation", limit: 20 });
    const b = await pod.search({ query: "turso", scope: "federation", limit: 20 });
    const key = (r: SearchCascadeResult): string =>
      JSON.stringify(
        r.results.map((x) => [x.figment_path, x.tier, x.confidence, x.blendedScore ?? null]),
      );
    const passed = key(a) === key(b);
    results.push({
      id: "INV-4",
      name: "Determinism — identical query yields identical ranked results",
      passed,
      detail: passed ? "two runs identical (mod durationMs)" : "two runs DIFFERED",
    });
  }

  return results;
}
