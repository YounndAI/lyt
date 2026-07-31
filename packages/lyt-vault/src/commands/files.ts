/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Command } from "commander";

import { inventoryVaultFiles } from "../flows/vault-files.js";

interface FilesOptions {
  path?: string;
  json?: boolean;
}

export function buildFilesCommand(): Command {
  return new Command("files")
    .description(
      "Read-only Markdown inventory for one registered vault, with inclusion, index, and frontmatter-mutation reasons.",
    )
    .argument("<vault>", "Registered vault name or qualified address")
    .option("--path <subtree>", "Restrict inventory to one vault-relative subtree")
    .option("--json", "Emit the complete structured inventory")
    .action(async (vault: string, options: FilesOptions) => {
      const inventory = await inventoryVaultFiles(vault, options.path);
      if (options.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(inventory, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`vault files ${inventory.vault.name} [${inventory.scope}]`);
      for (const entry of inventory.entries) {
        // eslint-disable-next-line no-console
        console.log(
          `  ${entry.classification.padEnd(12)} ${entry.path} — ${entry.reason}` +
            `${entry.pendingRemoval ? " [pending cache removal]" : ""}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `totals: markdown=${inventory.totals.markdownFiles} ` +
          `figments=${inventory.totals.indexableFigments} ` +
          `indexed=${inventory.totals.indexedFigments} ` +
          `frontmatter-candidates=${inventory.totals.frontmatterMutationCandidates} ` +
          `pending-removals=${inventory.totals.pendingRemovals}`,
      );
    });
}
