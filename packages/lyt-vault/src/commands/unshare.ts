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

import { unshareVaultFlow } from "../flows/share.js";

export function buildUnshareCommand(): Command {
  const cmd = new Command("unshare");
  cmd
    .description(
      "Revoke a GitHub handle's access to a vault (remove the gh repo-collaborator). Requires --yes.",
    )
    .argument("<name>", "Registered vault name")
    .requiredOption("--with <handle>", "GitHub handle to unshare from")
    .option("--yes", "Confirm the access change")
    .option("--json", "Emit machine-readable JSON")
    .action(async (name: string, opts: { with: string; yes?: boolean; json?: boolean }) => {
      try {
        const result = await unshareVaultFlow({
          vaultName: name,
          withHandle: opts.with,
          confirmed: opts.yes === true,
        });
        if (opts.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`Unshared '${result.vault}' from '${result.grantee}'.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(msg);
        process.exitCode = 1;
      }
    });
  return cmd;
}
