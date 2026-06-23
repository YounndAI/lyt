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

import { Command } from "commander";

import {
  MACHINE_ROLES,
  machineRegionConfigFlow,
  machineRoleDisableFlow,
  machineRoleEnableFlow,
  machineStatusFlow,
} from "../flows/machine-state.js";

interface MachineCliOpts {
  json?: boolean;
}

// Per arc §7 — stance = role composition, not a discrete mode. Per arc
// §7.10 — data residency is handler-declared via `lyt machine config region`.
// block-B's automator runtime reads from this table for requires_role checks.
export function buildMachineCommand(): Command {
  const cmd = new Command("machine").description(
    "Inspect + configure per-machine state — roles (client | automator-runner | mesh-syncer | llm-host) + region (handler-declared).",
  );

  const role = new Command("role").description(
    "Enable / disable a machine role (4-role enum).",
  );
  role
    .command("enable")
    .description(`Add a role. Valid: ${MACHINE_ROLES.join(", ")}`)
    .argument("<role>", "Role name")
    .action(async (roleName: string) => {
      const r = await machineRoleEnableFlow({ role: roleName });
      // eslint-disable-next-line no-console
      console.log(`Machine roles: ${r.roles.join(", ")}`);
    });
  role
    .command("disable")
    .description(`Remove a role. Valid: ${MACHINE_ROLES.join(", ")}`)
    .argument("<role>", "Role name")
    .action(async (roleName: string) => {
      const r = await machineRoleDisableFlow({ role: roleName });
      // eslint-disable-next-line no-console
      console.log(`Machine roles: ${r.roles.join(", ") || "(none)"}`);
    });
  cmd.addCommand(role);

  const config = new Command("config").description(
    "Per-machine handler-declared configuration. Currently: region.",
  );
  config
    .command("region")
    .description("Set the machine's region (handler-declared). Empty string clears.")
    .argument("<region>", 'Region tag, e.g. "EU", "US", "APAC"')
    .action(async (region: string) => {
      const r = await machineRegionConfigFlow({ region });
      // eslint-disable-next-line no-console
      console.log(`Machine region: ${r.region.length === 0 ? "(unset)" : r.region}`);
    });
  cmd.addCommand(config);

  cmd
    .command("status")
    .description("Print machine identity + active roles + region. --json emits structured output.")
    .option("--json", "Emit a JSON status object instead of the human-readable summary")
    .action(async (opts: MachineCliOpts) => {
      const s = await machineStatusFlow();
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`identity: ${s.identity}`);
      // eslint-disable-next-line no-console
      console.log(`roles:    ${s.roles.join(", ")}`);
      // eslint-disable-next-line no-console
      console.log(`region:   ${s.region.length === 0 ? "(unset)" : s.region}`);
    });

  return cmd;
}
