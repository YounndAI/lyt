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

import { adoptVaultFlow } from "../flows/adopt.js";

export function buildAdoptCommand(): Command {
  const cmd = new Command("adopt");
  cmd
    .description("Upgrade an existing Obsidian vault into a Lyt vault (additive; .md untouched)")
    .argument("<path>", "Path to the existing vault directory")
    .option(
      "--name <name>",
      "Override the vault name (e.g., alex/main). Defaults to owner/repo when the " +
        "path is under ~/lyt/vaults, otherwise the folder basename.",
    )
    .option("--parent <vault>", "Parent vault ref (e.g., vault:al0)")
    .option("--tier-hint <tier>", "Tier label hint")
    .action(async (path: string, opts: { name?: string; parent?: string; tierHint?: string }) => {
      const result = await adoptVaultFlow({
        vaultPath: path,
        name: opts.name,
        parent: opts.parent,
        tierHint: opts.tierHint,
      });
      // eslint-disable-next-line no-console
      console.log(`Adopted vault '${result.name}'`);
      // eslint-disable-next-line no-console
      console.log(`  path:     ${result.vaultPath}`);
      // eslint-disable-next-line no-console
      console.log(`  rid:      ${result.vaultRid}`);
      // eslint-disable-next-line no-console
      console.log(`  registry: registered`);
    });
  return cmd;
}
