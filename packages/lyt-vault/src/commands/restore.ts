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

import { restoreVaultFlow } from "../flows/restore.js";

export function buildRestoreCommand(): Command {
  return new Command("restore")
    .description(
      "Restore a vault's working tree from a snapshot branch (commits onto default branch)",
    )
    .argument("<name>", "Vault name (must be registered)")
    .requiredOption(
      "--from-snapshot <label>",
      "Snapshot label (or full branch name like 'lyt-snapshot/2026-05-27T14-30-00-pre-merge')",
    )
    .option("--force", "Discard uncommitted changes in the working tree")
    .action(async (name: string, opts: { fromSnapshot: string; force?: boolean }) => {
      const result = await restoreVaultFlow({
        name,
        fromSnapshot: opts.fromSnapshot,
        force: opts.force === true,
      });
      if (result.commitCreated) {
        // eslint-disable-next-line no-console
        console.log(
          `Restored vault '${name}' from '${result.restoredFrom}' (commit ${result.commitSha} on ${result.branch}).`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `Restore from '${result.restoredFrom}' produced no changes on ${result.branch} (working tree already matched).`,
        );
      }
    });
}
