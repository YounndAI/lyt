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

// 5-step protocol orchestrator (block-B Commit 4).
//
// Per arc-thoughts §6.6:201-216 (LOCKED 2026-05-27) every automator run
// follows the same five-step shape regardless of archetype:
//
// 1. Acquire machine lease (libSQL row with TTL)
// 2. Sync own vault (git pull --ff-only)
// 3. Run automator body (the @AUTOMATOR @STEPs after yai.lyt expansion)
// 4. Commit + push vault changes (gated --no-push for tests + dry-runs)
// 5. Release lease (clean status) OR mark released_reason='error' on
// failure path
//
// This orchestrator implements the protocol in TypeScript rather than as a
// YON document because the protocol IS framework: every automator inherits
// it. Per arc §6.6 "5-step covers ~95% of automators"; 6-step (cross-vault
// writes) is v3. v1 transaction_mode is `none` (arc §6.8) — failed body
// step leaves the vault in whatever state the body got it to, with
// automator_runs.status='failed' carrying the error trail.
//
// Crash recovery: any error in steps 2-4 produces a `failed_*` status,
// surfaces an error summary, and best-effort releases the lease with
// reason='error'. Step 5 release failure is non-fatal — the auto-expiry
// sweep on the next acquireLease() call collects the orphan.
//
// Block-B Commit 5 wires this into the `automator_runs` + `provenance` +
// `audit_log` per-vault libSQL tables. Commit 4's orchestrator is the
// stable skeleton those writes hook into.

import {
  acquireLease,
  insertAutomatorRun,
  insertAutomatorRunEvent,
  newUuidv7Bytes,
  releaseLease,
  updateAutomatorRunStatus,
} from "@younndai/lyt-vault";
import type { Client } from "@libsql/client";

import type { LytRuntime } from "../runtime.js";
import { createVaultOps } from "../ops/vault.js";
import {
  createRunContext,
  finalizeContext,
  finishStep,
  startStep,
  type LytRunContext,
  type LytRunStepTiming,
} from "./run-context.js";

export interface FiveStepOptions {
  automatorRid: Uint8Array;
  vaultRid: Uint8Array;
  vaultPath: string;
  // Per-vault libSQL client. Block-B Commit 5 wires the automator_runs +
  // automator_run_events writes against this; previously the protocol
  // only persisted into the per-machine registry (leases). When omitted,
  // the protocol still executes the 5 steps + leases (if not dryRun) but
  // skips automator_runs writes — useful for unit-test paths that don't
  // care about the run ledger.
  vaultDb?: Client;
  // Automator display name for automator_runs.automator_name. Block-B
  // Commit 5 — required when vaultDb is supplied so the ledger row has
  // a meaningful name; ignored otherwise.
  automatorName?: string;
  // Function that runs the automator body. Called between step 2 (sync)
  // and step 4 (commit). Receives the in-progress context so the body
  // can record provenance against the active runId; returns whatever
  // shape the body produced (typed `unknown` because the orchestrator
  // is body-shape-agnostic).
  runBody: (ctx: LytRunContext) => Promise<unknown>;
  ttlMs?: number; // lease TTL; default lyt-vault leases-repo DEFAULT_TTL_MS
  commitMessage?: string;
  noPush?: boolean;
  dryRun?: boolean; // when true, skips lease acquisition + git pull/push
  // For traceability on the runId. The orchestrator INSERTs automator_runs
  // with this id when vaultDb is supplied; otherwise the bytes are
  // carried forward in the context only.
  runIdOverride?: Uint8Array;
}

export interface FiveStepResult {
  context: LytRunContext;
  ok: boolean;
}

export async function runFiveStep(
  runtime: LytRuntime,
  opts: FiveStepOptions,
): Promise<FiveStepResult> {
  if (runtime.db === undefined && opts.dryRun !== true) {
    throw new Error(
      "runFiveStep: LytRuntime.db is undefined; either pass config.db to createLytRunner() or invoke with { dryRun: true }",
    );
  }
  const startedAt = runtime.getNow();
  const runId = opts.runIdOverride ?? newUuidv7Bytes();
  const ctx = createRunContext({
    runId,
    automatorRid: opts.automatorRid,
    vaultRid: opts.vaultRid,
    vaultPath: opts.vaultPath,
    machineId: runtime.machineId,
    startedAt,
  });

  // Block-B Commit 5: INSERT automator_runs row at orchestrator entry so
  // every event written downstream (incl. body-side @STAMP audit rows) has
  // a parent row to FK-reference. Skipped when no vault-side DB has been
  // supplied (unit-test path) or when dryRun is set (no-write contract).
  const vaultDb = opts.vaultDb;
  const persistRunLedger = vaultDb !== undefined && opts.dryRun !== true;
  if (persistRunLedger) {
    await insertAutomatorRun(vaultDb!, {
      id: runId,
      automatorName: opts.automatorName ?? "automator:unknown",
      vaultRid: opts.vaultRid,
      startedAt,
      status: "pending",
    });
  }

  // Steps 1 + 5 use leases-repo directly. Step 2 + 4 reuse the registered
  // vault ops so the protocol invokes the same code path as an
  // automator-body @STEP that references `std:vault.sync@v1` /
  // `std:vault.commit@v1`. Single source of truth for the git shell.
  const vaultOps = createVaultOps({ ...runtime, vaultPath: opts.vaultPath });
  const vaultSync = vaultOps["vault.sync"]!;
  const vaultCommit = vaultOps["vault.commit"]!;
  // Dummy ExecutionContext for the in-protocol direct invocation. Runtime
  // ops only read .args; the other fields aren't touched. Cast through
  // unknown to satisfy the structural contract without inventing a sandbox.
  const dummyCtx = {
    sandboxRoot: opts.vaultPath,
    env: {},
    blocks: {
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      keys: () => [],
    },
    args: {},
    inputs: new Map(),
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof vaultSync>[0];

  // ---- Step 1 — acquire lease ----------------------------------------
  const stepAcquire = startStep(ctx, "acquire", runtime.getNow());
  await recordStepStarted(persistRunLedger ? vaultDb! : null, runId, stepAcquire, runtime.getNow());
  if (opts.dryRun === true) {
    // Skip — record the step as ok so the trace still shows 5 entries.
    finishStep(stepAcquire, runtime.getNow(), true);
    ctx.status = "lease_acquired";
  } else {
    try {
      const lease = await acquireLease(runtime.db!, {
        automatorRid: opts.automatorRid,
        vaultRid: opts.vaultRid,
        machineId: runtime.machineId,
        ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
        now: runtime.getNow(),
      });
      ctx.leaseId = lease.leaseId;
      finishStep(stepAcquire, runtime.getNow(), true);
      ctx.status = "lease_acquired";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finishStep(stepAcquire, runtime.getNow(), false, msg);
      await recordStepFinished(
        persistRunLedger ? vaultDb! : null,
        runId,
        stepAcquire,
        runtime.getNow(),
      );
      finalizeContext(ctx, runtime.getNow(), "failed_lease", msg);
      await recordTerminalStatus(persistRunLedger ? vaultDb! : null, ctx);
      return { context: ctx, ok: false };
    }
  }
  await recordStepFinished(
    persistRunLedger ? vaultDb! : null,
    runId,
    stepAcquire,
    runtime.getNow(),
  );

  // ---- Step 2 — vault sync -------------------------------------------
  const stepSync = startStep(ctx, "sync", runtime.getNow());
  await recordStepStarted(persistRunLedger ? vaultDb! : null, runId, stepSync, runtime.getNow());
  if (opts.dryRun === true) {
    finishStep(stepSync, runtime.getNow(), true);
    ctx.status = "synced";
  } else {
    try {
      await vaultSync(dummyCtx, { vault_path: opts.vaultPath });
      finishStep(stepSync, runtime.getNow(), true);
      ctx.status = "synced";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finishStep(stepSync, runtime.getNow(), false, msg);
      await recordStepFinished(
        persistRunLedger ? vaultDb! : null,
        runId,
        stepSync,
        runtime.getNow(),
      );
      await releaseOnError(runtime, ctx, "sync_failed");
      finalizeContext(ctx, runtime.getNow(), "failed_sync", msg);
      await recordTerminalStatus(persistRunLedger ? vaultDb! : null, ctx);
      return { context: ctx, ok: false };
    }
  }
  await recordStepFinished(persistRunLedger ? vaultDb! : null, runId, stepSync, runtime.getNow());

  // ---- Step 3 — run body ---------------------------------------------
  const stepBody = startStep(ctx, "body", runtime.getNow());
  await recordStepStarted(persistRunLedger ? vaultDb! : null, runId, stepBody, runtime.getNow());
  ctx.status = "body_running";
  try {
    ctx.bodyResult = await opts.runBody(ctx);
    finishStep(stepBody, runtime.getNow(), true);
    ctx.status = "body_completed";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishStep(stepBody, runtime.getNow(), false, msg);
    await recordStepFinished(persistRunLedger ? vaultDb! : null, runId, stepBody, runtime.getNow());
    await releaseOnError(runtime, ctx, "body_failed");
    finalizeContext(ctx, runtime.getNow(), "failed_body", msg);
    await recordTerminalStatus(persistRunLedger ? vaultDb! : null, ctx);
    return { context: ctx, ok: false };
  }
  await recordStepFinished(persistRunLedger ? vaultDb! : null, runId, stepBody, runtime.getNow());

  // ---- Step 4 — vault commit -----------------------------------------
  const stepCommit = startStep(ctx, "commit", runtime.getNow());
  await recordStepStarted(persistRunLedger ? vaultDb! : null, runId, stepCommit, runtime.getNow());
  if (opts.dryRun === true) {
    finishStep(stepCommit, runtime.getNow(), true);
    ctx.status = "committed";
  } else {
    try {
      const commitArgs: Record<string, unknown> = { vault_path: opts.vaultPath };
      if (opts.commitMessage !== undefined) commitArgs["message"] = opts.commitMessage;
      if (opts.noPush === true) commitArgs["no_push"] = true;
      await vaultCommit(dummyCtx, commitArgs);
      finishStep(stepCommit, runtime.getNow(), true);
      ctx.status = "committed";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finishStep(stepCommit, runtime.getNow(), false, msg);
      await recordStepFinished(
        persistRunLedger ? vaultDb! : null,
        runId,
        stepCommit,
        runtime.getNow(),
      );
      await releaseOnError(runtime, ctx, "commit_failed");
      finalizeContext(ctx, runtime.getNow(), "failed_commit", msg);
      await recordTerminalStatus(persistRunLedger ? vaultDb! : null, ctx);
      return { context: ctx, ok: false };
    }
  }
  await recordStepFinished(persistRunLedger ? vaultDb! : null, runId, stepCommit, runtime.getNow());

  // ---- Step 5 — release lease ----------------------------------------
  const stepRelease = startStep(ctx, "release", runtime.getNow());
  await recordStepStarted(persistRunLedger ? vaultDb! : null, runId, stepRelease, runtime.getNow());
  if (opts.dryRun === true || ctx.leaseId === null) {
    finishStep(stepRelease, runtime.getNow(), true);
    finalizeContext(ctx, runtime.getNow(), "completed");
    await recordStepFinished(
      persistRunLedger ? vaultDb! : null,
      runId,
      stepRelease,
      runtime.getNow(),
    );
    await recordTerminalStatus(persistRunLedger ? vaultDb! : null, ctx);
    return { context: ctx, ok: true };
  }
  try {
    await releaseLease(runtime.db!, {
      leaseId: ctx.leaseId,
      reason: "completed",
      now: runtime.getNow(),
    });
    finishStep(stepRelease, runtime.getNow(), true);
    finalizeContext(ctx, runtime.getNow(), "completed");
    await recordStepFinished(
      persistRunLedger ? vaultDb! : null,
      runId,
      stepRelease,
      runtime.getNow(),
    );
    await recordTerminalStatus(persistRunLedger ? vaultDb! : null, ctx);
    return { context: ctx, ok: true };
  } catch (err) {
    // Release failure is non-fatal — the auto-expiry sweep on the next
    // acquireLease() call collects the orphan. Surface the error but
    // declare the run completed (body + commit succeeded).
    const msg = err instanceof Error ? err.message : String(err);
    finishStep(stepRelease, runtime.getNow(), false, msg);
    await recordStepFinished(
      persistRunLedger ? vaultDb! : null,
      runId,
      stepRelease,
      runtime.getNow(),
    );
    finalizeContext(ctx, runtime.getNow(), "failed_release", msg);
    await recordTerminalStatus(persistRunLedger ? vaultDb! : null, ctx);
    return { context: ctx, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Block-B Commit 5 — per-vault automator_runs ledger helpers. All three
// are no-ops when `vaultDb` is null (no per-vault DB supplied, or dryRun).
// Each catches its own errors and logs to stderr rather than propagating
// — the goal is observability, not blocking the protocol path on a logged
// event write failure. The five-step contract surface (lease + git + body)
// already drives the user-visible status.
// ---------------------------------------------------------------------------

async function recordStepStarted(
  vaultDb: Client | null,
  runId: Uint8Array,
  step: LytRunStepTiming,
  ts: number,
): Promise<void> {
  if (vaultDb === null) return;
  try {
    await insertAutomatorRunEvent(vaultDb, {
      id: newUuidv7Bytes(),
      runId,
      ts,
      level: "info",
      message: `step.${step.step}.started`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `runFiveStep: recordStepStarted(${step.step}) failed`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function recordStepFinished(
  vaultDb: Client | null,
  runId: Uint8Array,
  step: LytRunStepTiming,
  ts: number,
): Promise<void> {
  if (vaultDb === null) return;
  try {
    const outcome = step.ok === true ? "completed" : "failed";
    await insertAutomatorRunEvent(vaultDb, {
      id: newUuidv7Bytes(),
      runId,
      ts,
      level: step.ok === true ? "info" : "error",
      message: `step.${step.step}.${outcome}`,
      data: {
        duration_ms: step.durationMs ?? 0,
        ...(step.errorSummary !== null ? { error: step.errorSummary } : {}),
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `runFiveStep: recordStepFinished(${step.step}) failed`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function recordTerminalStatus(vaultDb: Client | null, ctx: LytRunContext): Promise<void> {
  if (vaultDb === null) return;
  try {
    await updateAutomatorRunStatus(vaultDb, {
      id: ctx.runId,
      status: ctx.status,
      ...(ctx.endedAt !== null ? { endedAt: ctx.endedAt } : {}),
      ...(ctx.errorSummary !== null ? { errorSummary: ctx.errorSummary } : {}),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "runFiveStep: recordTerminalStatus failed",
      err instanceof Error ? err.message : err,
    );
  }
}

async function releaseOnError(
  runtime: LytRuntime,
  ctx: LytRunContext,
  reason: string,
): Promise<void> {
  if (runtime.db === undefined || ctx.leaseId === null) return;
  try {
    await releaseLease(runtime.db, {
      leaseId: ctx.leaseId,
      reason,
      now: runtime.getNow(),
    });
  } catch {
    // Best-effort cleanup; the auto-expiry sweep is the safety net.
  }
}
