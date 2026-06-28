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

// Lyt op surface.
//
// Per arc-thoughts §6.11:443-450 lyt-runner registers 7 std ops with the
// underlying yon-runner:
//
// std:lease.acquire@v1 — real in C4; via createLeaseOps(runtime)
// std:lease.release@v1 — real in C4; via createLeaseOps(runtime)
// std:lease.refresh@v1 — real in C4; via createLeaseOps(runtime)
// std:vault.sync@v1 — real in C4; via createVaultOps(runtime)
// std:vault.commit@v1 — real in C4; via createVaultOps(runtime)
// std:mesh.pull@v1 — stub (block-C consumer); via createMeshOps()
// std:mesh.propagate@v1 — stub (block-C consumer); via createMeshOps()
//
// Plus the four LLM ops via createLlmOps(gateway):
//
// std:llm.generate@v1 — real when gateway present
// std:llm.embed@v1 — real when gateway present
// std:llm.stream@v1 — stub (block-D — stream method)
// std:llm.generate_object@v1 — stub (block-D — zod-schema)
//
// The factories close over the LytRuntime + LlmGateway so `(ctx, args)`
// handlers can reach the lyt-vault repos, the lyt-llm gateway, and the
// git helpers without touching yon-runner's ExecutionContext shape — the
// open-once seam (v1.A.1a fold #4) propagates cleanly into the runner.
//
// Back-compat: the old `LYT_OPS` constant kept its Commit-1 shape (7 stubs)
// so any external test or downstream consumer that imported it pre-Commit-4
// continues to work. New callers use createLytRunner() which composes the
// real ops via the factories.

import type { ExecutionContext, OpHandler } from "@younndai/yon-runner";

import { stdMeshPullV1, stdMeshPropagateV1 } from "./mesh.js";

export interface OpStubResult {
  status: "stub";
  op: string;
  warning: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Commit 1 back-compat stubs. These are unchanged in shape — every entry
// here is a `(_ctx, args) => structured-no-op-with-warning` handler. They
// are kept so any test or downstream import from Commit 1 that referenced
// `LYT_OPS` keeps working; new callers should use createLytRunner() which
// invokes the real factories from leases.ts / vault.ts / llm.ts.
// ---------------------------------------------------------------------------

function makeStub(op: string, deferredPhase: string): OpHandler {
  const handler: OpHandler = async (
    _ctx: ExecutionContext,
    args: Record<string, unknown>,
  ): Promise<OpStubResult> => {
    return {
      status: "stub",
      op,
      warning: `${op} is not implemented in the LYT_OPS stub bundle; use createLytRunner() with a configured LytRuntime to register the real impl (${deferredPhase})`,
      args,
    };
  };
  return handler;
}

export const stdLeaseAcquireV1 = makeStub("std:lease.acquire@v1", "via createLeaseOps(runtime)");
export const stdLeaseReleaseV1 = makeStub("std:lease.release@v1", "via createLeaseOps(runtime)");
export const stdLeaseRefreshV1 = makeStub("std:lease.refresh@v1", "via createLeaseOps(runtime)");
export const stdVaultSyncV1 = makeStub("std:vault.sync@v1", "via createVaultOps(runtime)");
export const stdVaultCommitV1 = makeStub("std:vault.commit@v1", "via createVaultOps(runtime)");

export const LYT_OPS: Record<string, OpHandler> = {
  "lease.acquire": stdLeaseAcquireV1,
  "lease.release": stdLeaseReleaseV1,
  "lease.refresh": stdLeaseRefreshV1,
  "vault.sync": stdVaultSyncV1,
  "vault.commit": stdVaultCommitV1,
  "mesh.pull": stdMeshPullV1,
  "mesh.propagate": stdMeshPropagateV1,
};

export const LYT_OPS_NAMESPACE = "std";
export const LYT_OPS_VERSION = "v1";

// Re-export the real-op factories so createLytRunner() can compose them.
export { createLeaseOps } from "./leases.js";
export { createVaultOps } from "./vault.js";
export { createLlmOps } from "./llm.js";
export { createMeshOps, stdMeshPullV1, stdMeshPropagateV1 } from "./mesh.js";

export type {
  LeaseAcquireOpArgs,
  LeaseAcquireOpResult,
  LeaseReleaseOpArgs,
  LeaseRefreshOpArgs,
  LeaseOpResult,
} from "./leases.js";
export type {
  VaultSyncOpArgs,
  VaultSyncOpResult,
  VaultCommitOpArgs,
  VaultCommitOpResult,
} from "./vault.js";
export type { LlmGenerateOpArgs, LlmEmbedOpArgs, LlmStubResult } from "./llm.js";
export type { MeshStubResult } from "./mesh.js";
