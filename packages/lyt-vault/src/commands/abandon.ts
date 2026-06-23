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

import { abandonVaultFlow } from "../flows/abandon.js";

export function buildAbandonCommand(): Command {
  const cmd = new Command("abandon");
  cmd
    .description(
      "Leave LYT cleanly — remove only the local .lyt/ adoption (the inverse of `adopt`); " +
        "your markdown and GitHub repo are untouched. Requires --yes.",
    )
    .argument("<name>", "Registered vault name")
    .option("--yes", "Confirm abandoning the vault")
    .option("--json", "Emit machine-readable JSON")
    .action(async (name: string, opts: { yes?: boolean; json?: boolean }) => {
      try {
        const result = await abandonVaultFlow(name, { confirmed: opts.yes === true });
        if (opts.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`Abandoned vault '${result.vault.name}' (${result.vault.ridHex}).`);
        // eslint-disable-next-line no-console
        console.log(`  ${result.removedLytDir ? "removed" : "skipped"}: ${result.lytDirPath}`);
        // eslint-disable-next-line no-console
        console.log(`  .md files at ${result.vault.path} were NOT touched.`);
        // eslint-disable-next-line no-console
        console.log(`  your GitHub repo was NOT touched.`);
        if (result.removedKnownPath) {
          // eslint-disable-next-line no-console
          console.log(`  removed from ~/lyt/known-paths.txt`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(msg);
        process.exitCode = 1;
      }
    });
  return cmd;
}
