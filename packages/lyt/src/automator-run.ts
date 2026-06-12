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

// Meta CLI automator-run composition (block-B Commit 7).
//
// This is the single function the `lyt automator run` CLI subcommand and
// the metadata-filler end-to-end integration test both consume. It glues
// together the lyt-vault `buildAutomatorRunPlan` (plan + opened DB clients),
// the meta-CLI archetype dispatcher (`resolveAutomatorBody`), and the
// lyt-runner `runFiveStep` orchestrator into one entry point.
//
// Composition pattern mirrors meshCmd at packages/lyt/src/cli.ts:38-47 —
// lyt-vault registers the `automator` parent (commands/automator.ts ships
// list/log/status); the meta CLI attaches the `run` subcommand here so the
// runFiveStep call site lives in a package that depends on both lyt-vault
// and lyt-runner. lyt-vault must not depend on lyt-runner (the reverse
// already holds), and this seam preserves that invariant.

import { hostname } from "node:os";
import { readFileSync } from "node:fs";

import type { Client } from "@libsql/client";
import { createLytRuntime, runFiveStep, type LytRunContext } from "@younndai/lyt-runner";
import {
  buildAutomatorRunPlan,
  closeAutomatorRunPlan,
  newUuidv7Bytes,
  recordCliInvocation,
  type AutomatorRunPlan,
} from "@younndai/lyt-vault";

import { resolveAutomatorBody, type AutomatorBodyFn } from "./automator-bodies/index.js";

export interface RunAutomatorArgs {
  // Automator name (e.g. "metadata-filler") OR its full rid
  // (e.g. "automator:metadata-filler"). buildAutomatorRunPlan strips the
  // `automator:` prefix when resolving the .yon file.
  automator: string;
  vault?: string;
  // Test seam — bypasses resolveSingleVault and routes through the plan's
  // vaultPathOverride. Mirrors the buildAutomatorRunPlan public surface.
  vaultPathOverride?: string;
  dryRun?: boolean;
  noPush?: boolean;
  // Test seam — override machineId for deterministic assertions. Production
  // callers omit; the runtime defaults to `${os.hostname()}:lyt`.
  machineId?: string;
  // Test seam — inject a clock for deterministic timestamps.
  getNow?: () => number;
  // Test seam — override the registry client. When omitted, the LytRuntime
  // uses the registryDb returned by buildAutomatorRunPlan.
  registryDb?: Client;
}

export interface RunAutomatorResult {
  ok: boolean;
  runId: Uint8Array;
  plan: AutomatorRunPlan;
  body: unknown;
  context: LytRunContext;
  status: string;
  errorSummary: string | null;
  automatorVersion: string;
}

// ---------------------------------------------------------------------------
// Single-entry composition. The CLI invokes this and forwards exit codes;
// the integration test invokes it and inspects the result + side effects.
// ---------------------------------------------------------------------------

export async function runAutomator(args: RunAutomatorArgs): Promise<RunAutomatorResult> {
  const plan = await buildAutomatorRunPlan({
    automator: args.automator,
    ...(args.vault !== undefined ? { vault: args.vault } : {}),
    ...(args.vaultPathOverride !== undefined ? { vaultPathOverride: args.vaultPathOverride } : {}),
  });
  try {
    const body = resolveAutomatorBody(plan.automatorName);
    if (body === null) {
      throw new Error(
        `lyt automator run: no v1 body registered for automator '${plan.automatorName}'. ` +
          "Known v1 archetypes: metadata-filler, lane-builder, arc-builder. Future archetypes " +
          "(rollup, ingest, log-compactor) ship in later phases.",
      );
    }

    const automatorVersion = extractAutomatorVersion(plan.automatorYonPath);
    const machineId = args.machineId ?? `${hostname()}:lyt`;
    const registryDb = args.registryDb ?? plan.registryDb;
    const runtime = createLytRuntime({
      db: registryDb,
      vaultPath: plan.vaultPath,
      machineId,
      ...(args.getNow !== undefined ? { getNow: args.getNow } : {}),
    });

    const runId = newUuidv7Bytes();
    const startTs = runtime.getNow();

    const bodyFn: AutomatorBodyFn = body;
    const result = await runFiveStep(runtime, {
      automatorRid: plan.automatorRid,
      vaultRid: plan.vaultRid,
      vaultPath: plan.vaultPath,
      vaultDb: plan.vaultDb,
      automatorName: `automator:${plan.automatorName}`,
      runIdOverride: runId,
      runBody: async (ctx) =>
        bodyFn(ctx, {
          vaultPath: plan.vaultPath,
          vaultDb: plan.vaultDb,
          automatorName: plan.automatorName,
          automatorVersion,
          // v1.A.5 OPT-1 caller-side: thread pre-opened audit + provenance
          // clients to skip per-write open/close inside the @STAMP hook.
          ledgerClients: {
            auditDb: plan.auditDb,
            provenanceDb: plan.provenanceDb,
          },
        }),
      ...(args.dryRun === true ? { dryRun: true } : {}),
      ...(args.noPush === true ? { noPush: true } : {}),
    });

    // cli.invoked event is logged AFTER runFiveStep returns so the
    // automator_runs row (inserted at the start of runFiveStep when
    // persistRunLedger is true) satisfies the automator_run_events.run_id
    // FK constraint. The event's `ts` is the captured startTs so the
    // chronological log still shows cli.invoked BEFORE step.acquire.*
    // (events sort by ts, not by insertion order). Skipped on dryRun
    // because runFiveStep skips the parent INSERT in that mode.
    if (args.dryRun !== true) {
      await recordCliInvocation(plan, {
        runId,
        ts: startTs,
        dryRun: false,
        noPush: args.noPush === true,
        automatorVersion,
      });
    }

    return {
      ok: result.ok,
      runId,
      plan,
      body: result.context.bodyResult,
      context: result.context,
      status: result.context.status,
      errorSummary: result.context.errorSummary,
      automatorVersion,
    };
  } finally {
    await closeAutomatorRunPlan(plan);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal hand-rolled version extractor — mirrors the rid-only extractor in
// flows/automator-run.ts:88-92. Looks for `version=<token>` within the first
// @AUTOMATOR block and returns the token (no quote stripping needed; YON
// version fields are bare per arc §6.13 Example 1). Falls back to "0.0.0"
// if the field is absent so the stamp src still renders deterministically.
function extractAutomatorVersion(yonPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(yonPath, "utf8");
  } catch {
    return "0.0.0";
  }
  const m = raw.match(/@AUTOMATOR[^@]*?\sversion=([^\s|]+)/);
  return m !== null && m[1] !== undefined ? m[1] : "0.0.0";
}

export { resolveAutomatorBody };
