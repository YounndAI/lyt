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

import { rebuildVaultFlow } from "../flows/rebuild-vault.js";
import { isEmbeddingsInteractive } from "../util/embeddings.js";
import { withSpinner } from "../util/spinner.js";

interface RebuildVaultCliOpts {
  vault?: string;
  threshold?: string;
  json?: boolean;
}

// Lane V Phase 0 (0.5 / C3) — `lyt vault rebuild`.
//
// One umbrella that rebuilds ALL content-tier caches for a vault in order
// (lanes → arcs → fts → rollup), instead of running the four `rebuild-*` verbs
// by hand. Distinct from `lyt vault rebuild-index` (that DROPs + recreates the
// DB schema — destructive; this rebuilds CONTENT into the existing schema).
export function buildRebuildVaultCommand(): Command {
  return new Command("rebuild")
    .description(
      "Rebuild ALL content-tier caches for a vault (lanes + arcs + fts + rollup) from the markdown SoT. The all-tiers umbrella over `rebuild-lanes`/`rebuild-arcs`/`rebuild-fts`/`rebuild-rollup`. NOT `rebuild-index` (which resets the DB schema). Use `lyt reindex` to rebuild across a mesh or the whole pod.",
    )
    .requiredOption("--vault <name>", "Vault name (must be registered)")
    .option("--threshold <n>", "Lane clustering threshold (default 2)")
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (opts: RebuildVaultCliOpts) => {
      try {
        const threshold =
          opts.threshold !== undefined ? Number.parseInt(opts.threshold, 10) : undefined;
        // C-1 — the build path may prompt + visibly fetch the one-time local model
        // ONLY from an interactive terminal: BOTH stdin AND stdout a real TTY,
        // AND not --json. stdin must be a TTY too — the prompt reads
        // process.stdin, so a redirected-stdin + TTY-stdout invocation must NOT
        // prompt nor fetch (release review Major fold).
        const embeddingsInteractive = isEmbeddingsInteractive({
          json: opts.json,
          stdinTTY: process.stdin.isTTY === true,
          stdoutTTY: process.stdout.isTTY === true,
        });
        const rebuildArgs = {
          vault: opts.vault!,
          ...(threshold !== undefined && Number.isFinite(threshold) ? { threshold } : {}),
          ...(embeddingsInteractive ? { embeddingsInteractive: true } : {}),
        };
        // V-DX-1 — liveness spinner over the all-tiers rebuild window.
        // --json stays spinner-free; non-TTY prints "Reindexing…" once.
        const result =
          opts.json !== true
            ? await withSpinner(opts.vault!, () => rebuildVaultFlow(rebuildArgs), {
                op: "reindex",
              })
            : await rebuildVaultFlow(rebuildArgs);
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Rebuilt all tiers for '${result.vaultName}' (${result.durationMs}ms):\n` +
            `  lanes:  ${result.lanes.lanesWritten} lane(s), ${result.lanes.membersWritten} member(s)\n` +
            `  arcs:   ${result.arcs.arcsWritten} arc(s)\n` +
            `  fts:    ${result.fts.ftsDocsInserted} figment(s)\n` +
            `  rollup: ${result.rollup.rollupRowsWritten} row(s)`,
        );
        // F15 — never heal silently (release review/R3-m1): same loud
        // quarantine line `lyt reindex` prints.
        if (result.indexQuarantinedTo !== null) {
          // eslint-disable-next-line no-console
          console.log(
            `  ⚠ corrupt index quarantined → ${result.indexQuarantinedTo}; rebuilt fresh.`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`lyt vault rebuild: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}
