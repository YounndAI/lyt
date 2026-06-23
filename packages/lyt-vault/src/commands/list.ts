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

import { formatHumanTable, listVaultsFlow } from "../flows/list.js";
import { ROLLUP_DISCONNECTED_DAYS } from "../flows/rebuild-rollup.js";
import { withSpinner } from "../util/spinner.js";

export function buildListCommand(): Command {
  const cmd = new Command("list");
  cmd
    .description("List all registered Lyt vaults on this machine (includes tombstoned by default)")
    .option("--json", "Emit machine-readable JSON instead of a human table")
    .option("--no-tombstones", "Hide hard-tombstoned vaults (status='tombstoned')")
    .option(
      "--include-tombstones",
      `Include soft-tombstoned rollup aggregate per vault (rows whose last_seen > ${ROLLUP_DISCONNECTED_DAYS} days). DISTINCT from --no-tombstones above, which filters vault.status='tombstoned' (hard tombstones).`,
    )
    .option(
      "--rollup-threshold <days>",
      `Soft-tombstone threshold in days (default ${ROLLUP_DISCONNECTED_DAYS}; only applies when --include-tombstones is set)`,
    )
    .action(
      async (opts: {
        json?: boolean;
        tombstones?: boolean;
        includeTombstones?: boolean;
        rollupThreshold?: string;
      }) => {
        const noTombstones = opts.tombstones === false;
        let rollupThresholdDays: number | undefined;
        if (opts.rollupThreshold !== undefined) {
          const parsed = Number.parseInt(opts.rollupThreshold, 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            // eslint-disable-next-line no-console
            console.error(
              `lyt vault list: --rollup-threshold must be a positive integer; got '${opts.rollupThreshold}'.`,
            );
            process.exitCode = 2;
            return;
          }
          rollupThresholdDays = parsed;
        }
        const listArgs = {
          noTombstones,
          ...(opts.includeTombstones === true ? { includeRollupTombstones: true } : {}),
          ...(rollupThresholdDays !== undefined ? { rollupThresholdDays } : {}),
        };
        // V-DX-1 — liveness spinner over the registry-open + rollup-aggregate
        // window. --json stays spinner-free (byte-clean machine output);
        // non-TTY prints "Listing…" once (zero escape codes).
        const result =
          opts.json !== true
            ? await withSpinner("", () => listVaultsFlow(listArgs), { op: "vault-list" })
            : await listVaultsFlow(listArgs);
        if (opts.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(formatHumanTable(result.vaults, result.rollupTombstones, result.displayNames));
      },
    );
  return cmd;
}
