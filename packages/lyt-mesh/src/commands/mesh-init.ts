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

import { meshInitFlow, type MeshInitOptions } from "../flows/mesh-init.js";

export function buildMeshInitCommand(): Command {
  const cmd = new Command("init");
  cmd
    .description(
      "Stand up a mesh from a YON manifest. Validates uniqueness, parent refs, DAG, and (when pushing) gh-org accessibility before any side effects.",
    )
    .requiredOption("--from <manifest.yon>", "Path to the YON manifest file")
    .option("--dry-run", "Preview: list vaults + edges that would be created; touch nothing")
    .option("--only <glob>", "Initialize only vaults matching this glob (e.g., 'cats-eng-*')")
    .option("--no-push", "Skip 'gh repo create' calls; local stand-up only")
    .option(
      "--override <field=value>",
      "Override a single field: '<vault>.<field>=<value>'. Repeatable.",
      collectOverride,
      [] as string[],
    )
    .action(async (opts: MeshInitCliOpts) => {
      const args: MeshInitOptions = {
        manifestPath: opts.from,
        dryRun: opts.dryRun === true,
        ...(opts.only !== undefined ? { only: opts.only } : {}),
        noPush: opts.push === false,
        overrides: opts.override ?? [],
      };
      const result = await meshInitFlow(args);

      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error("mesh init: validation failed; no side effects taken.");
        for (const issue of result.issues) {
          // eslint-disable-next-line no-console
          console.error(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
        }
        process.exit(1);
      }

      const o = result.outcome;
      // eslint-disable-next-line no-console
      console.log(
        `mesh init: ${o.dryRun ? "[dry-run] " : ""}${o.vaults.length} vault(s), ${o.edges.length} edge entr(ies); topo order: ${o.topoOrder.join(", ")}`,
      );
      for (const issue of o.validation.issues) {
        // eslint-disable-next-line no-console
        console.warn(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
      }
      for (const v of o.vaults) {
        // eslint-disable-next-line no-console
        console.log(
          `  ${o.dryRun ? "[plan] " : ""}vault ${v.vaultName} -> gh repo '${v.ghRepoName}'${v.pushed ? ` (pushed: ${v.pushUrl})` : ""}`,
        );
      }
      for (const e of o.edges) {
        // eslint-disable-next-line no-console
        console.log(
          `  ${o.dryRun ? "[plan] " : ""}edge ${e.kind}: ${e.source} -> ${e.target}${e.applied ? "" : " (skip)"}`,
        );
      }
      if (o.regenedContexts.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  regen-context (batched): ${o.regenedContexts.length} vault(s)`);
      }
    });
  return cmd;
}

interface MeshInitCliOpts {
  from: string;
  dryRun?: boolean;
  only?: string;
  push?: boolean;
  override?: string[];
}

function collectOverride(value: string, previous: string[]): string[] {
  return [...previous, value];
}
