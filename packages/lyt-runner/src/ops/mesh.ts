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

// Mesh op stubs (block-B Commit 4 → block-C consumer).
//
// Per brief clause (3) and arc-thoughts §6.11:449-450:
// std:mesh.pull@v1 — block-C: Pattern B pull from child vault
// std:mesh.propagate@v1 — block-C: tag/metadata propagation
//
// Both ship as structured no-op-with-warning in block-B. The warning text
// names the deferred phase explicitly so an automator body that touches
// these ops in block-B gets a clean "expected" signal rather than a hard
// failure. Block-C swaps these factories for real handlers.

import type { ExecutionContext, OpHandler } from "@younndai/yon-runner";

export interface MeshStubResult {
  status: "stub";
  op: string;
  warning: string;
  args: Record<string, unknown>;
}

function makeMeshStub(op: string): OpHandler {
  const handler: OpHandler = async (
    _ctx: ExecutionContext,
    args: Record<string, unknown>,
  ): Promise<MeshStubResult> => {
    return {
      status: "stub",
      op,
      warning: `${op} is not yet implemented; a real handler is planned for a future release (mesh automator core)`,
      args,
    };
  };
  return handler;
}

export const stdMeshPullV1 = makeMeshStub("std:mesh.pull@v1");
export const stdMeshPropagateV1 = makeMeshStub("std:mesh.propagate@v1");

export function createMeshOps(): Record<string, OpHandler> {
  return {
    "mesh.pull": stdMeshPullV1,
    "mesh.propagate": stdMeshPropagateV1,
  };
}
