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

import { ROLLUP_DISCONNECTED_DAYS, rebuildRollupFlow } from "../flows/rebuild-rollup.js";

interface RebuildRollupCliOpts {
  vault?: string;
  threshold?: string;
  json?: boolean;
}

// v1.E.2 — `lyt vault rebuild-rollup --vault <name>`.
//
// Manual entry point for transitive rollup propagation per master-plan
// §v1.E.2:892-908. Walks the named vault's descendant chain (via
// `mesh_edges` where ref_vault_rid = vault), reads each descendant's
// `lanes` cache, and UPSERTs rollup rows into the target vault's
// rollup table (`<vault>/.lyt/indexes/lyt.db`).
//
// Lock 0.3 deterministic --json mode mirrors `lyt vault rebuild-lanes`.
export function buildRebuildRollupCommand(): Command {
  return new Command("rebuild-rollup")
    .description(
      `v1.E.2: rebuild transitive keyword rollup for a vault. Walks descendants via @MESH_EDGE chains (ref=parent, home=child); aggregates each descendant's lanes keywords into this vault's rollup cache. Disconnected descendants surface as soft-tombstones (default threshold ${ROLLUP_DISCONNECTED_DAYS} days) via 'lyt vault list --include-tombstones'.`,
    )
    .requiredOption("--vault <name>", "Vault name (must be registered)")
    .option(
      "--threshold <days>",
      `Soft-tombstone threshold in days (default ${ROLLUP_DISCONNECTED_DAYS})`,
    )
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (opts: RebuildRollupCliOpts) => {
      let thresholdDays: number | undefined;
      if (opts.threshold !== undefined) {
        const parsed = Number.parseInt(opts.threshold, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          // eslint-disable-next-line no-console
          console.error(
            `lyt vault rebuild-rollup: --threshold must be a positive integer; got '${opts.threshold}'.`,
          );
          process.exitCode = 2;
          return;
        }
        thresholdDays = parsed;
      }
      try {
        const result = await rebuildRollupFlow({
          ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
          ...(thresholdDays !== undefined ? { thresholdDays } : {}),
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Rebuilt rollup for '${result.vaultName}' (vault:${result.vaultRidHex})\n` +
            `  ${result.rollupRowsWritten} row(s) upserted; ${result.descendantsVisited} descendant(s) visited` +
            ` (${result.descendantsSkipped} skipped); threshold=${result.thresholdDays} days; ${result.durationMs}ms.` +
            (result.cycleDetected
              ? `\n  ⚠ cycle detected: ${result.cycleWarnings.length} warning(s)`
              : ""),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({ error: "rebuild-rollup-error", message }, null, 2));
        } else {
          // eslint-disable-next-line no-console
          console.error(`lyt vault rebuild-rollup: ${message}`);
        }
        process.exitCode = 1;
      }
    });
}
