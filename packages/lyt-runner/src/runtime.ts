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

// LytRuntime — the config bag op factories close over.
//
// Per arc-thoughts §6.11 Pattern A (LOCKED 2026-05-27), lyt-runner's std ops
// need three external dependencies at registration time:
// - db — per-machine registry libSQL client (lease ops + future
// provenance writers in block-B Commit 5)
// - vaultPath — filesystem path the vault.sync / vault.commit ops run git in
// - llmGateway — optional @younndai/lyt-llm gateway for the four llm.* ops
//
// yon-runner's ExecutionContext shape (yon-runner/src/types.ts:105-126) has no
// extension slot — op handlers get `(ctx, args)` only — so the lyt ops close
// over a LytRuntime instance instead. This preserves the open-once registry
// seam (v1.A.1a fold #4): ops never embed SQL or git invocations directly,
// they delegate to lyt-vault's leases-repo / util/git-run and to the lyt-llm
// gateway, with `db` threaded through at construction.
//
// `machineId` is a required field — every lease row in machine_leases is
// scoped to a machine; an op handler that tried to acquire a lease without
// knowing which machine to claim from would corrupt cross-machine arbitration.
// Callers typically pass `${os.hostname()}:${cwd-hash}` (see lyt-vault's
// machine_state.roles row for the conventional shape).

import type { Client } from "@libsql/client";
import type { LlmGateway } from "@younndai/lyt-llm";

export interface LytRuntime {
  db: Client | undefined;
  vaultPath: string | undefined;
  machineId: string;
  llmGateway: LlmGateway | undefined;
  getNow: () => number;
}

export interface LytRuntimeConfig {
  db?: Client;
  vaultPath?: string;
  machineId: string;
  llmGateway?: LlmGateway;
  // Injectable clock for tests. Production callers omit; the runtime defaults
  // to Date.now(). Mirrors the leases-repo `now?: number` arg pattern.
  getNow?: () => number;
}

export function createLytRuntime(config: LytRuntimeConfig): LytRuntime {
  if (typeof config.machineId !== "string" || config.machineId.length === 0) {
    throw new Error("createLytRuntime: machineId is required and must be non-empty");
  }
  return {
    db: config.db,
    vaultPath: config.vaultPath,
    machineId: config.machineId,
    llmGateway: config.llmGateway,
    getNow: config.getNow ?? (() => Date.now()),
  };
}
