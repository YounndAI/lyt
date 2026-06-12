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

import { forgetVaultFlow } from "../flows/forget.js";

export function buildForgetCommand(): Command {
  const cmd = new Command("forget");
  cmd
    .description(
      "Remove a vault from the registry. Files are untouched; the vault can be re-joined later. Pass --tombstone to leave a 'closed path' marker row instead.",
    )
    .argument("<name>", "Registered vault name")
    .option("--tombstone", "Leave a tombstoned row in the registry instead of removing it")
    .action(async (name: string, opts: { tombstone?: boolean }) => {
      const tombstone = opts.tombstone === true;
      const result = await forgetVaultFlow(name, { tombstone });
      if (result.tombstoned) {
        // eslint-disable-next-line no-console
        console.log(
          `Vault '${result.vault.name}' (${result.vault.ridHex}) tombstoned. Files at ${result.vault.path} were NOT touched.`,
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Forgot vault '${result.vault.name}' (${result.vault.ridHex}).`);
      // eslint-disable-next-line no-console
      console.log(`  files at ${result.vault.path} were NOT touched.`);
      if (result.removedKnownPath) {
        // eslint-disable-next-line no-console
        console.log(`  removed from ~/lyt/known-paths.txt`);
      }
    });
  return cmd;
}
