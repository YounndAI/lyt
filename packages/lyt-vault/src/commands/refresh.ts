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

import { formatWritable } from "./info.js";
import { refreshVaultWritableFlow } from "../flows/vault-refresh.js";

// 0.9.3 — `lyt vault refresh <name>`: force a live gh re-probe of a
// vault's write access and refresh the cached writability verdict. Use after an
// owner grants/revokes push access to a vault you subscribe to, so the
// capture/sync gate sees the new verdict without waiting for the cache to expire.
export function buildRefreshCommand(): Command {
  return new Command("refresh")
    .description(
      "Re-probe a vault's write access (gh) and refresh the cached writability verdict (use after gaining/losing push access to a subscribed vault)",
    )
    .argument("<name>", "Registered vault name")
    .option("--json", "Emit machine-readable JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const result = await refreshVaultWritableFlow(name);
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`Refreshed write access for '${result.name}'`);
        // eslint-disable-next-line no-console
        console.log(`  writable: ${formatWritable(result.writable, result.reason)}`);
      } catch (err) {
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.error(
            JSON.stringify(
              { error: "refresh-failed", message: err instanceof Error ? err.message : String(err) },
              null,
              2,
            ),
          );
        } else {
          // eslint-disable-next-line no-console
          console.error(`lyt vault refresh: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exitCode = 2;
      }
    });
}
