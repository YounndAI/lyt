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

// LytRunContext — per-call state for one 5-step protocol invocation.
//
// Per arc-thoughts §6.6:201-216 each automator run owns:
// - runId — the future automator_runs.id (block-B Commit 5 writes
// the row; this commit just tracks the value for trace
// plumbing)
// - leaseId — populated after step 1; consumed by step 5
// - startedAt — wall-clock ms; used for run-duration metrics
// - durationsMs — per-step millisecond budget for the trace surface
// - status — final disposition; mirrors automator_runs.status
//
// This module is deliberately data-only. The orchestrator in
// `five-step.ts` mutates the context across steps; tests assert on
// observable shape rather than reaching into internals. The
// `endedAt`-then-finalize pattern lets a failed step still produce a
// well-formed final context (no missing fields, no NaN durations).

export type LytRunStatus =
  | "pending"
  | "lease_acquired"
  | "synced"
  | "body_running"
  | "body_completed"
  | "committed"
  | "completed"
  | "failed_lease"
  | "failed_sync"
  | "failed_body"
  | "failed_commit"
  | "failed_release";

export interface LytRunStepTiming {
  step: "acquire" | "sync" | "body" | "commit" | "release";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  ok: boolean | null;
  errorSummary: string | null;
}

export interface LytRunContext {
  runId: Uint8Array; // BLOB UUIDv7
  automatorRid: Uint8Array;
  vaultRid: Uint8Array;
  vaultPath: string;
  machineId: string;
  leaseId: Uint8Array | null;
  startedAt: number;
  endedAt: number | null;
  status: LytRunStatus;
  steps: LytRunStepTiming[];
  errorSummary: string | null;
  // Output of the automator body's runner.run() call — the orchestrator
  // surfaces it on the result so callers can inspect step outputs +
  // stamps without re-running.
  bodyResult: unknown;
}

export function createRunContext(args: {
  runId: Uint8Array;
  automatorRid: Uint8Array;
  vaultRid: Uint8Array;
  vaultPath: string;
  machineId: string;
  startedAt: number;
}): LytRunContext {
  return {
    runId: args.runId,
    automatorRid: args.automatorRid,
    vaultRid: args.vaultRid,
    vaultPath: args.vaultPath,
    machineId: args.machineId,
    leaseId: null,
    startedAt: args.startedAt,
    endedAt: null,
    status: "pending",
    steps: [],
    errorSummary: null,
    bodyResult: undefined,
  };
}

export function startStep(
  ctx: LytRunContext,
  step: LytRunStepTiming["step"],
  now: number,
): LytRunStepTiming {
  const timing: LytRunStepTiming = {
    step,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    ok: null,
    errorSummary: null,
  };
  ctx.steps.push(timing);
  return timing;
}

export function finishStep(
  timing: LytRunStepTiming,
  now: number,
  ok: boolean,
  errorSummary: string | null = null,
): void {
  timing.endedAt = now;
  timing.durationMs = Math.max(0, now - timing.startedAt);
  timing.ok = ok;
  timing.errorSummary = errorSummary;
}

export function finalizeContext(
  ctx: LytRunContext,
  now: number,
  status: LytRunStatus,
  errorSummary: string | null = null,
): void {
  ctx.endedAt = now;
  ctx.status = status;
  if (errorSummary !== null) ctx.errorSummary = errorSummary;
}
