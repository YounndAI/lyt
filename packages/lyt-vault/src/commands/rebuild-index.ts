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

import { rebuildVaultIndexFlow } from "../flows/rebuild-index.js";
import { KNOWN_LEDGERS, type LedgerName } from "../flows/housekeep.js";

interface RebuildIndexCliOpts {
  force?: boolean;
  json?: boolean;
  ledger?: string;
}

export function buildRebuildIndexCommand(): Command {
  return new Command("rebuild-index")
    .description(
      "Rebuild per-vault libSQL projection from markdown YON source-of-truth (arc §8.5). Without --ledger: drops `.lyt/indexes/{lyt,audit,provenance}.db` + recreates schema + cached bundled YON record count (DESTRUCTIVE for block-B+ data — use --force). With --ledger <name>: surgically truncates only that ledger's cache table + re-injects from `.lyt/ledgers/<name>.yon` SoT via idempotent natural-key probe (non-destructive; YON-as-SoT per Lock 0.2).",
    )
    .argument("<name>", "Vault name (must be registered)")
    .option(
      "--force",
      "Rebuild even if the vault is frozen, and discard non-trivial provenance / audit_log history (block-A.3 row-count guard per release review)",
    )
    .option(
      "--ledger <name>",
      `v1.A.2: rebuild only the named ledger's cache from YON SoT (known: ${KNOWN_LEDGERS.join(", ")})`,
    )
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (name: string, opts: RebuildIndexCliOpts) => {
      if (
        opts.ledger !== undefined &&
        !(KNOWN_LEDGERS as readonly string[]).includes(opts.ledger)
      ) {
        // eslint-disable-next-line no-console
        console.error(
          `lyt vault rebuild-index: unknown --ledger '${opts.ledger}'. Known: ${KNOWN_LEDGERS.join(", ")}`,
        );
        process.exitCode = 2;
        return;
      }
      const result = await rebuildVaultIndexFlow({
        name,
        force: opts.force === true,
        ...(opts.ledger !== undefined ? { ledger: opts.ledger as LedgerName } : {}),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.ledgerReinjected !== undefined) {
        // eslint-disable-next-line no-console
        console.log(
          `Rebuilt --ledger ${opts.ledger} cache for '${result.vaultName}': re-injected ${result.ledgerReinjected} record(s) from YON SoT; ${result.durationMs}ms.`,
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `Rebuilt index for '${result.vaultName}' at ${result.vaultPath}\n` +
          `  Dropped ${result.droppedDbBytes} byte(s); created ${result.tablesCreated} table(s); cached ${result.recordsCached} bundled YON record(s); ${result.durationMs}ms.`,
      );
    });
}
