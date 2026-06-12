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

import type { Command } from "commander";

import { buildAuditCommand } from "./commands/audit.js";
import { buildAutomatorCommand } from "./commands/automator.js";
import { buildCaptureMetricCommand } from "./commands/capture-metric.js";
import { buildDoctorCommand } from "./commands/doctor.js";
import { buildFederationCommand } from "./commands/federation.js";
import { buildFrictionCommand } from "./commands/friction.js";
import { buildHelpCommand } from "./commands/help.js";
import { buildHousekeepCommand } from "./commands/housekeep.js";
import { buildIdentityCommand } from "./commands/identity.js";
import { buildMachineCommand } from "./commands/machine.js";
import { buildMeshCommand } from "./commands/mesh.js";
import { buildPatternCommand } from "./commands/pattern.js";
import { buildProvenanceCommand } from "./commands/provenance.js";
import { buildRegistrySubcommand, buildVaultSubcommand } from "./vault-command.js";

// release review + block-A.3 Commit 11 — single source of truth for
// the @younndai/lyt-vault verb surface. Both standalone CLI entry points
// (packages/lyt-vault/src/cli.ts and packages/lyt/src/cli.ts) call this
// so adding a new verb requires touching exactly one place. Order of
// addCommand calls is preserved from the prior duplicated registrations.
export function registerVaultVerbs(program: Command): void {
  program.addCommand(buildVaultSubcommand());
  program.addCommand(buildRegistrySubcommand());
  program.addCommand(buildIdentityCommand());
  program.addCommand(buildAuditCommand());
  program.addCommand(buildFrictionCommand());
  program.addCommand(buildProvenanceCommand());
  program.addCommand(buildCaptureMetricCommand());
  program.addCommand(buildMachineCommand());
  program.addCommand(buildFederationCommand());
  program.addCommand(buildMeshCommand());
  program.addCommand(buildAutomatorCommand());
  program.addCommand(buildHousekeepCommand());
  program.addCommand(buildHelpCommand());
  program.addCommand(buildDoctorCommand());
  program.addCommand(buildPatternCommand());
}
