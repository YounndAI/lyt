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

import { unfreezeVaultFlow } from "../flows/unfreeze.js";

export function buildUnfreezeCommand(): Command {
  return new Command("unfreeze")
    .description("Unfreeze a vault: remove frozen state + sentinel lock (idempotent)")
    .argument("<name>", "Vault name (must be registered)")
    .action(async (name: string) => {
      const result = await unfreezeVaultFlow({ name });
      if (result.wasFrozen) {
        // eslint-disable-next-line no-console
        console.log(`Unfroze vault '${name}'.`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`Vault '${name}' was not frozen (no-op).`);
      }
    });
}
