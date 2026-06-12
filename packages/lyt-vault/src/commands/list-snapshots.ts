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

import { listSnapshotsFlow } from "../flows/list-snapshots.js";

export function buildListSnapshotsCommand(): Command {
  return new Command("list-snapshots")
    .description("Enumerate snapshot branches for a vault (lyt-snapshot/*)")
    .argument("<name>", "Vault name (must be registered)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (name: string, opts: { json?: boolean }) => {
      const result = await listSnapshotsFlow({ name });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result.snapshots, null, 2));
        return;
      }
      if (result.snapshots.length === 0) {
        // eslint-disable-next-line no-console
        console.log(`No snapshots found for '${name}'.`);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Snapshots for '${name}' (${result.snapshots.length}):`);
      for (const s of result.snapshots) {
        const labelPart = s.label ? `  [${s.label}]` : "";
        // eslint-disable-next-line no-console
        console.log(`  ${s.branch}  ${s.sha}${labelPart}  ${s.subject}`);
      }
    });
}
