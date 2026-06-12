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

import { reconnectVaultFlow } from "../flows/reconnect.js";

export function buildReconnectCommand(): Command {
  const cmd = new Command("reconnect");
  cmd
    .description(
      "Heal a missing or disconnected vault by repointing the registry row to a new filesystem path. Validates .lyt/vault.yon rid matches the registry row.",
    )
    .argument("<name>", "Registered vault name")
    .requiredOption("--path <newPath>", "New filesystem path containing the vault")
    .action(async (name: string, opts: { path: string }) => {
      const result = await reconnectVaultFlow({ name, newPath: opts.path });
      // eslint-disable-next-line no-console
      console.log(
        `Vault '${result.vault.name}' reconnected at ${result.newPath}${
          result.pathChanged ? "" : " (path unchanged)"
        }. Status: active.`,
      );
    });
  return cmd;
}
