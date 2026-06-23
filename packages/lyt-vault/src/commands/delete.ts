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

import { deleteVaultFlow } from "../flows/delete.js";

export function buildDeleteCommand(): Command {
  const cmd = new Command("delete");
  cmd
    .description(
      "Remove a vault's .lyt/ derived state. .md files are NEVER touched. By default leaves a tombstone in the registry (a 'closed path' marker); pass --no-tombstone to fully remove the row.",
    )
    .argument("<name>", "Registered vault name")
    .option("--no-tombstone", "Fully remove the registry row instead of tombstoning")
    .action(async (name: string, opts: { tombstone?: boolean }) => {
      const noTombstone = opts.tombstone === false;
      const result = await deleteVaultFlow(name, { noTombstone });
      // Phase E item 1 (#9) — surface the orphaned-then-dropped pod-local
      // aliases. delete has no interactive gate, so the warning is reported with
      // the outcome rather than before a prompt.
      if (result.orphanedAliases.length > 0) {
        const list = result.orphanedAliases.map((a) => `@${a}`).join(", ");
        // eslint-disable-next-line no-console
        console.log(
          `  dropped ${result.orphanedAliases.length} pod-local alias(es) that pointed here: ${list}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(`Deleted vault '${result.vault.name}' (${result.vault.ridHex}).`);
      // eslint-disable-next-line no-console
      console.log(`  ${result.removedLytDir ? "removed" : "skipped"}: ${result.lytDirPath}`);
      // eslint-disable-next-line no-console
      console.log(`  .md files at ${result.vault.path} were NOT touched.`);
      if (result.tombstoned) {
        // eslint-disable-next-line no-console
        console.log(`  registry row tombstoned (use --no-tombstone next time to fully remove)`);
      } else if (result.removedKnownPath) {
        // eslint-disable-next-line no-console
        console.log(`  removed from ~/lyt/known-paths.txt`);
      }
    });
  return cmd;
}
