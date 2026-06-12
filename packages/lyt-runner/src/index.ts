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

// @younndai/lyt-runner — public entry point.
//
// Pattern A (arc-thoughts §6.11 LOCKED 2026-05-27): a thin wrapper on
// @younndai/yon-runner. createLytRunner() composes:
// 1. yon-runner's createRunner(config) — base runtime with 39 std ops
// 2. The yai.lyt expander (Commit 1) — `lytExpand(doc)` is the public
// surface; the runner does NOT auto-apply it on every run() — callers
// invoke it explicitly when they have an @AUTOMATOR-bearing doc
// 3. (Commit 4) LytRuntime + ops registration:
// - createLeaseOps(runtime) → std:lease.acquire / .release / .refresh
// - createVaultOps(runtime) → std:vault.sync / .commit
// - createMeshOps() → std:mesh.pull / .propagate (stubs;
// block-C consumers)
// - createLlmOps(gateway) → std:llm.generate / .embed (real when
// gateway present); std:llm.stream /
// .generate_object (stubs; block-D)
//
// If `config.runtime` is omitted the runner registers the Commit-1 fallback
// stubs (`LYT_OPS`) so legacy callers + the expander-only test suite still
// build green. The 5-step protocol orchestrator (`runFiveStep`) is exported
// separately — it takes its own LytRuntime + automatorRid/vaultRid and
// orchestrates lease → sync → body → commit → release in TS.
//
// Reference: zen-runner/src/index.ts L202-294 is the canonical Pattern A
// composition template; lyt-runner mirrors its createRunner + registerPlugin
// shape, extended with conditional real-op registration when a LytRuntime
// is supplied.

import { createRunner, type Runner, type RunnerConfig } from "@younndai/yon-runner";

import { createLeaseOps } from "./ops/leases.js";
import { createLlmOps } from "./ops/llm.js";
import { createMeshOps } from "./ops/mesh.js";
import { createVaultOps } from "./ops/vault.js";
import { LYT_OPS, LYT_OPS_NAMESPACE, LYT_OPS_VERSION } from "./ops/index.js";
import type { LytRuntime } from "./runtime.js";

export interface LytRunnerConfig extends RunnerConfig {
  // The runtime config bag. When supplied, createLytRunner registers the
  // real lease/vault/mesh/llm op set. When omitted, the Commit-1 fallback
  // stubs are registered (every op returns structured no-op-with-warning).
  //
  // Construction-side helpers:
  // - `createLytRuntime({ db, vaultPath, machineId, llmGateway })` is the
  // supported factory; it validates machineId and applies the default
  // clock. Callers can construct LytRuntime objects directly for tests.
  runtime?: LytRuntime;
}

export function createLytRunner(config: LytRunnerConfig = {}): Runner {
  const { runtime, ...runnerConfig } = config;

  // 1. Construct the base yon-runner. Per zen-runner/src/index.ts:233 the
  // canonical pattern is `createRunner(config)` with no plugins yet;
  // registerPlugin happens immediately after construction.
  const runner = createRunner(runnerConfig);

  // 2. Register the lyt op set. Per yon-runner/src/ops/registry.ts L50-56,
  // registerPlugin iterates plugin.ops and registers each as
  // `${namespace}:${name}@${version}` (e.g. `std:lease.acquire@v1`).
  if (runtime !== undefined) {
    // Commit-4 path: real ops bound to a LytRuntime + optional LlmGateway.
    runner.registerPlugin({
      namespace: LYT_OPS_NAMESPACE,
      ops: {
        ...createLeaseOps(runtime),
        ...createVaultOps(runtime),
        ...createMeshOps(),
        ...createLlmOps(runtime.llmGateway),
      },
      version: LYT_OPS_VERSION,
    });
  } else {
    // Commit-1 fallback: stub bundle. New callers should pass a runtime.
    runner.registerPlugin({
      namespace: LYT_OPS_NAMESPACE,
      ops: LYT_OPS,
      version: LYT_OPS_VERSION,
    });
  }

  return runner;
}

// Re-export the expander surface so external consumers (test harnesses,
// future @younndai/lyt-llm, the lyt automator CLI verb group from Commit 6)
// can reach them without deep-importing from /expander/.
export {
  lytExpand,
  parseAutomator,
  parseDirective,
  automatorToAgentRecords,
  ExpanderError,
} from "./expander/index.js";

export type {
  ExpandOptions,
  ExpandResult,
  AutomatorRecord,
  DirectiveRecord,
  AutomatorArchetype,
  AutomatorRuntime,
  AutomatorScope,
  AutomatorSource,
  AutomatorTransactionMode,
} from "./expander/index.js";

// Re-export the op surface — back-compat stubs plus the new real-op
// factories. Callers can compose ops manually if they need to mix
// real + stub for a particular test scenario.
export {
  LYT_OPS,
  LYT_OPS_NAMESPACE,
  LYT_OPS_VERSION,
  stdLeaseAcquireV1,
  stdLeaseReleaseV1,
  stdLeaseRefreshV1,
  stdVaultSyncV1,
  stdVaultCommitV1,
  stdMeshPullV1,
  stdMeshPropagateV1,
  createLeaseOps,
  createVaultOps,
  createLlmOps,
  createMeshOps,
} from "./ops/index.js";

export type {
  OpStubResult,
  LeaseAcquireOpArgs,
  LeaseAcquireOpResult,
  LeaseReleaseOpArgs,
  LeaseRefreshOpArgs,
  LeaseOpResult,
  VaultSyncOpArgs,
  VaultSyncOpResult,
  VaultCommitOpArgs,
  VaultCommitOpResult,
  LlmGenerateOpArgs,
  LlmEmbedOpArgs,
  LlmStubResult,
  MeshStubResult,
} from "./ops/index.js";

// Runtime + protocol surface (Commit 4 new).
export { createLytRuntime } from "./runtime.js";
export type { LytRuntime, LytRuntimeConfig } from "./runtime.js";

export { runFiveStep } from "./protocol/five-step.js";
export type { FiveStepOptions, FiveStepResult } from "./protocol/five-step.js";

export {
  createRunContext,
  finalizeContext,
  finishStep,
  startStep,
} from "./protocol/run-context.js";
export type { LytRunContext, LytRunStatus, LytRunStepTiming } from "./protocol/run-context.js";

// Block-B Commit 5: pre-write @STAMP hook surface (arc-thoughts §11.4).
export {
  writeMarkdownWithStamp,
  writeYonWithStamp,
  formatYonStampRecord,
} from "./hooks/stamp-on-write.js";
export type {
  StampMeta,
  WriteWithStampArgs,
  WriteWithStampResult,
  YonStampRecordArgs,
  ProvenanceWriteTargetType,
} from "./hooks/stamp-on-write.js";

export { upsertLastProvenance, formatLastProvenanceValue } from "./hooks/frontmatter.js";
export type { FrontmatterStampLine } from "./hooks/frontmatter.js";
