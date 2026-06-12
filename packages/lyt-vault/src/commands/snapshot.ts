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

import { snapshotVaultFlow } from "../flows/snapshot.js";

export function buildSnapshotCommand(): Command {
  return new Command("snapshot")
    .description(
      "Create a local git-branch snapshot of a vault (lyt-snapshot/<ts>[-<label>]; local-only, not pushed). Captures the FULL working tree — uncommitted edits and not-yet-synced figments included (F11).",
    )
    .argument("<name>", "Vault name (must be registered)")
    .option("--label <text>", "Optional human-readable label (slugified into the branch name)")
    .action(async (name: string, opts: { label?: string }) => {
      const result = await snapshotVaultFlow({ name, label: opts.label });
      // eslint-disable-next-line no-console
      console.log(`Created snapshot branch '${result.branch}' at ${result.sha}.`);
      // F11 — say what the snapshot actually protects.
      if (result.workingTreeIncluded) {
        // eslint-disable-next-line no-console
        console.log(
          `  includes ${result.uncommittedPathCount} uncommitted path(s) from the working tree (not-yet-synced figments are covered).`,
        );
      }
    });
}
