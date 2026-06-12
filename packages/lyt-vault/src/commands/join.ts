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

import { joinVaultFlow } from "../flows/join.js";
import { VaultHomeMeshNotRegisteredError } from "../flows/register.js";

export function buildJoinCommand(): Command {
  const cmd = new Command("join");
  cmd
    .description(
      "Register an already-Lyt-aware vault (e.g., cloned manually) into the local registry",
    )
    .argument("<path>", "Path to the existing Lyt-aware vault directory")
    .action(async (path: string) => {
      let result;
      try {
        result = await joinVaultFlow(path);
      } catch (err) {
        // joining a clone whose vault.yon declares a foreign home
        // mesh refuses actionably (FK guarded at the register chokepoint;
        // exit 2 mirrors clone's mesh-not-found contract).
        if (err instanceof VaultHomeMeshNotRegisteredError) {
          // eslint-disable-next-line no-console
          console.error(err.message);
          process.exitCode = 2;
          return;
        }
        throw err;
      }
      if (result.alreadyRegistered) {
        // eslint-disable-next-line no-console
        console.log(`Vault '${result.name}' is already registered (no change).`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`Joined vault '${result.name}'`);
      }
      // eslint-disable-next-line no-console
      console.log(`  path: ${result.path}`);
      // eslint-disable-next-line no-console
      console.log(`  rid:  ${result.ridHex}`);
    });
  return cmd;
}
