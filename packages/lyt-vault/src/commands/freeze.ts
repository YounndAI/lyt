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

import { freezeVaultFlow } from "../flows/freeze.js";
import { formatRemaining } from "../util/duration.js";

export function buildFreezeCommand(): Command {
  return new Command("freeze")
    .description("Freeze a vault: refuse mutations + sync until unfrozen or `frozen_until` passes")
    .argument("<name>", "Vault name (must be registered)")
    .option(
      "--until <duration>",
      "Auto-unfreeze after this duration (e.g. 1h, 24h, 7d, 30d) or at this ISO date. Default 24h.",
    )
    .action(async (name: string, opts: { until?: string }) => {
      const result = await freezeVaultFlow({ name, until: opts.until });
      const remaining = formatRemaining(result.frozenUntil);
      // eslint-disable-next-line no-console
      console.log(
        `Frozen vault '${name}' until ${result.frozenUntil} (${remaining} from now). Run 'lyt vault unfreeze ${name}' to release early.`,
      );
    });
}
