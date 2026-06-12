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

// Per-run cost tracker.
//
// Per arc-thoughts §6.7 ("cost-shape lock") + brief Open Decision #3 default
// (recommended: hard-stop on per-run, warn-on-monthly). The CostTracker
// accumulates per-call cost across the current run; the gateway calls
// `assertWithin()` BEFORE invoking the adapter so a known-over-budget call
// never even reaches the network.
//
// Implementation is in-memory + per-gateway-instance; block-B Commit 4 hands
// the gateway a fresh CostTracker at 5-step protocol step 3 start and reads
// `totalCostUsd()` at step 4 commit to populate `automator_runs.llm_cost_usd`.

import { CostBudgetExceededError, type CostBudget } from "./types.js";

export interface CostTracker {
  // Record an executed call's cost. Increments accumulated total + call count.
  record(usd: number): void;
  // Guard BEFORE the call. Throws CostBudgetExceededError if accumulating
  // `estimatedUsd` would push the total above `budget.perRunUsd`. Passing
  // zero is allowed and is a no-op when budget is undefined.
  assertWithin(estimatedUsd: number): void;
  totalUsd(): number;
  callCount(): number;
  reset(): void;
  // Snapshot of the configured budget (or null for unbounded). Surface for
  // diagnostics and the audit trail.
  budget(): CostBudget | null;
}

export function createCostTracker(budget?: CostBudget): CostTracker {
  let accumulated = 0;
  let calls = 0;
  const snapshot: CostBudget | null = budget
    ? {
        perRunUsd: budget.perRunUsd,
        ...(budget.monthlyUsd !== undefined ? { monthlyUsd: budget.monthlyUsd } : {}),
      }
    : null;

  return {
    record(usd: number) {
      if (!Number.isFinite(usd) || usd < 0) {
        throw new RangeError(
          `CostTracker.record() requires a non-negative finite number; got ${usd}`,
        );
      }
      accumulated += usd;
      calls += 1;
    },
    assertWithin(estimatedUsd: number) {
      if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) {
        throw new RangeError(
          `CostTracker.assertWithin() requires a non-negative finite number; got ${estimatedUsd}`,
        );
      }
      if (!snapshot) return;
      const projected = accumulated + estimatedUsd;
      if (projected > snapshot.perRunUsd) {
        throw new CostBudgetExceededError(snapshot.perRunUsd, accumulated, estimatedUsd);
      }
    },
    totalUsd() {
      return accumulated;
    },
    callCount() {
      return calls;
    },
    reset() {
      accumulated = 0;
      calls = 0;
    },
    budget() {
      return snapshot;
    },
  };
}
