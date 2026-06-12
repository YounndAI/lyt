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

import { openVaultFlow } from "../flows/open.js";

export function buildOpenCommand(): Command {
  const cmd = new Command("open");
  cmd
    .description("Launch the OS default app (Obsidian) on the vault directory")
    .argument("<name>", "Registered vault name")
    .action(async (name: string) => {
      const result = await openVaultFlow(name);
      // eslint-disable-next-line no-console
      console.log(`Opening '${name}' at ${result.vault.path}`);
    });
  return cmd;
}
