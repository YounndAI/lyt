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

import {
  DEFAULT_TOMBSTONE_THRESHOLD,
  TOMBSTONE_THRESHOLD_ENV,
  verifyVaultsFlow,
} from "../flows/verify.js";

export function buildVerifyCommand(): Command {
  const cmd = new Command("verify");
  cmd
    .description(
      `Walk the registry, stat each path, flip missing vaults to status='missing'. Read-only on files. Auto-promotes 'missing' rows to 'tombstoned' after ${DEFAULT_TOMBSTONE_THRESHOLD} consecutive failures (override via env ${TOMBSTONE_THRESHOLD_ENV}).`,
    )
    .option("--json", "Emit structured JSON output")
    .action(async (opts: { json?: boolean }) => {
      const result = await verifyVaultsFlow();
      if (opts.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Verified ${result.checked} vaults (threshold=${result.threshold}):`);
      // eslint-disable-next-line no-console
      console.log(`  active_unchanged:   ${result.active_unchanged}`);
      // eslint-disable-next-line no-console
      console.log(`  missing_new:        ${result.missing_new}`);
      // eslint-disable-next-line no-console
      console.log(`  recovered:          ${result.recovered}`);
      // eslint-disable-next-line no-console
      console.log(`  tombstoned_new:     ${result.tombstoned_new}`);
      // eslint-disable-next-line no-console
      console.log(`  skipped_tombstoned: ${result.skipped_tombstoned}`);
      // eslint-disable-next-line no-console
      console.log(`  errored:            ${result.errored}`);
      const interesting = result.transitions.filter((t) => t.from !== t.to);
      if (interesting.length > 0) {
        // eslint-disable-next-line no-console
        console.log("Transitions:");
        for (const t of interesting) {
          // eslint-disable-next-line no-console
          console.log(`  ${t.name}: ${t.from} → ${t.to} (${t.reason}) at ${t.path}`);
        }
      }
    });
  return cmd;
}
