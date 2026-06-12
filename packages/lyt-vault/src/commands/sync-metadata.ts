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

import { syncMetadataFlow } from "../flows/sync-metadata.js";

export function buildSyncMetadataCommand(): Command {
  const cmd = new Command("sync-metadata");
  cmd
    .description(
      "Push vault.yon metadata (description + topics) to GitHub. Dry-run is the default; `--apply` is required to write. Scope is mandatory (`--vault`, `--vaults`, `--mesh`, or `--from-manifest`); `--all` is intentionally not a flag.",
    )
    .option("--vault <name>", "Single registered vault to sync")
    .option(
      "--vaults <list>",
      "Comma-separated glob patterns matching registered vault names (e.g., 'cats-*,dogs-*')",
      collectVaultPatterns,
    )
    .option(
      "--mesh <root>",
      "Sync every vault reachable from <root> via parent + share_with edges (depth-bounded; --depth to extend)",
    )
    .option("--depth <n>", "Depth bound for --mesh traversal (default 5)", (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      "--from-manifest <file>",
      "Parse the YON manifest, extract @VAULT names (applying gh-prefix), sync those vaults",
    )
    .option("--apply", "Actually write to GitHub (default: dry-run only)")
    .option("--no-confirm", "Skip the interactive confirm before applying (required on non-TTY)")
    .option("--audit-log <file>", "Append a JSON line per write to this file")
    .action(async (opts: SyncMetadataCliOpts) => {
      const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
      const mode = opts.apply === true ? "apply" : "dry-run";

      const result = await syncMetadataFlow({
        scope: {
          vault: opts.vault,
          vaults: opts.vaults,
          mesh: opts.mesh,
          meshDepth: opts.depth,
          fromManifest: opts.fromManifest,
        },
        mode,
        noConfirm: opts.confirm === false,
        auditLog: opts.auditLog,
        isTty,
      });

      // eslint-disable-next-line no-console
      console.log(`sync-metadata: mode=${result.mode}`);
      for (const r of result.reports) {
        if (r.skipped) {
          // eslint-disable-next-line no-console
          console.log(`  - ${r.vaultName}: SKIPPED (${r.skipReason})`);
          continue;
        }
        if (!r.changed) {
          // eslint-disable-next-line no-console
          console.log(`  - ${r.vaultName}: up-to-date`);
          continue;
        }
        // eslint-disable-next-line no-console
        console.log(`  - ${r.vaultName}: ${r.ghOwner}/${r.ghRepo}`);
        if (r.before && r.after) {
          // eslint-disable-next-line no-console
          console.log(`      description: "${r.before.description}" -> "${r.after.description}"`);
          // eslint-disable-next-line no-console
          console.log(`      topics:      [${r.before.topics.join(", ")}] -> [${r.after.topics.join(", ")}]`);
        }
        if (r.agentsMdBumped) {
          // eslint-disable-next-line no-console
          console.log(`      agents.md:   bumped to template v1`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `  summary: applied=${result.appliedCount} skipped=${result.skippedCount} unchanged=${result.unchangedCount}`,
      );
    });
  return cmd;
}

interface SyncMetadataCliOpts {
  vault?: string;
  vaults?: string[];
  mesh?: string;
  depth?: number;
  fromManifest?: string;
  apply?: boolean;
  confirm?: boolean;
  auditLog?: string;
}

function collectVaultPatterns(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
