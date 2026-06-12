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

// @younndai/lyt is primarily a CLI meta package. For programmatic access,
// import from @younndai/lyt-vault, lyt-mesh, or lyt-mcp directly. This module
// re-exports the unified subcommand factories so consumers can compose them.

export {
  buildVaultSubcommand,
  buildRegistrySubcommand,
  buildHelpCommand,
  buildDoctorCommand,
  buildPatternCommand,
} from "@younndai/lyt-vault";
export { buildMeshSubcommand, buildSyncCommand } from "@younndai/lyt-mesh";
export { buildMcpSubcommand } from "@younndai/lyt-mcp";
export { buildSearchCommand } from "./commands/search.js";
export { buildPrimerCommand } from "./commands/primer.js";
export { buildLytInitCommand } from "./commands/init.js";
export { healPod, summarizeHeal } from "./flows/heal.js";
export type {
  HealResult,
  HealPodOptions,
  ManualHealAction,
  ManualHealEntry,
} from "./flows/heal.js";
export { initBootstrapFlow } from "./flows/init-bootstrap.js";
export type {
  DiscoveredRepo,
  DiscoveredRepoKind,
  DiscoveryProbe,
  DiscoveryProbeResult,
  InitBootstrapArgs,
  InitBootstrapBranch,
  InitBootstrapCustomOverrides,
  InitBootstrapFederation,
  InitBootstrapMeshAssignment,
  InitBootstrapMode,
  InitBootstrapResult,
  IntegrityIssue,
  IntegrityStatus,
} from "./flows/init-bootstrap.js";
