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

export { buildMeshSubcommand } from "./mesh-command.js";

export {
  addSource,
  listSources,
  getSourceByName,
  removeSource,
  withRegistry,
} from "./source/repo.js";
export type { AddSourceArgs } from "./source/repo.js";
export { parseScope, serializeScope } from "./source/types.js";
export type { VaultSource, VaultSourceScope, VaultSourceRow } from "./source/types.js";

export { walkGithub } from "./discovery/github.js";
export type { DiscoveredRepo, GhExecutor, WalkGithubOptions } from "./discovery/github.js";

export { walk, buildDefaultAdapters } from "./discovery/walk.js";
export type {
  SourceAdapter,
  MeshDiscoveryResult,
  WalkOptions,
  WalkResult,
} from "./discovery/walk.js";

export { cloneAllFlow } from "./flows/clone-all.js";
export type {
  CloneAllOptions,
  CloneAllOutcome,
  CloneAllResult,
  CloneAllNoSources,
  GitCloneFn,
} from "./flows/clone-all.js";

export { buildCloneAllCommand } from "./commands/clone-all.js";
export { buildSourceCommand } from "./commands/source.js";
export { buildValidateCommand } from "./commands/validate.js";
export { buildStatusCommand } from "./commands/status.js";
// Brief B (B.4) — the top-level `lyt status` publish-drift trust surface
// (distinct from `lyt mesh status`, the mesh-graph renderer above).
export { buildPodStatusCommand } from "./commands/pod-status.js";
export { podStatusFlow } from "./flows/pod-status.js";
export type {
  PodStatusResult,
  PodStatusArgs,
  VaultDriftReport,
  VaultDriftStatus,
  PodDriftReport,
  PodDriftStatus,
} from "./flows/pod-status.js";

export { validateFlow } from "./flows/validate.js";
export type {
  ValidateFinding,
  ValidateOutcome,
  ValidateOptions,
  ValidateIssueStatus,
  ValidateEdgeKind,
} from "./flows/validate.js";

export { statusFlow } from "./flows/status.js";
export type { StatusOutcome, StatusOptions, StatusCluster } from "./flows/status.js";

export { meshInitFlow, traverseMeshFromRoot } from "./flows/mesh-init.js";
export type {
  MeshInitOptions,
  MeshInitOutcome,
  MeshInitResult,
  MeshInitBlocked,
  MeshInitVaultResult,
  MeshInitEdgeResult,
} from "./flows/mesh-init.js";

export { validateMeshInit } from "./flows/mesh-init-validate.js";
export type {
  ValidateIssue,
  ValidateOutcome as MeshInitValidateOutcome,
  ValidateOptions as MeshInitValidateOptions,
  ValidateSeverity,
} from "./flows/mesh-init-validate.js";

export { buildMeshInitCommand } from "./commands/mesh-init.js";

export { syncFlow, classifyCheckStatus } from "./flows/sync.js";
export type {
  SyncFlowArgs,
  SyncFlowResult,
  SyncFrictionHint,
  VaultSyncReport,
  VaultSyncStatus,
} from "./flows/sync.js";

export { syncCheckFlow } from "./flows/sync-check.js";
export type { SyncCheckArgs, SyncCheckResult, VaultCheckReport } from "./flows/sync-check.js";

export { syncWatchFlow, DEFAULT_COMMIT_DEBOUNCE_MS } from "./flows/sync-watch.js";
export type { SyncWatchHandle, SyncWatchOptions } from "./flows/sync-watch.js";

export { buildSyncCommand } from "./commands/sync.js";
