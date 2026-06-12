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

import { cloneAllFlow } from "../flows/clone-all.js";

export function buildCloneAllCommand(): Command {
  const cmd = new Command("clone-all");
  cmd
    .description(
      "Walk every configured vault source, clone each accessible Vault into ~/lyt/vaults/, and register it via join. Skips repos already registered. Requires `gh` CLI on PATH for GitHub sources.",
    )
    .option("--source <name>", "Restrict to one configured source by name")
    .option("--dry-run", "Show what would be cloned; touch nothing")
    .action(async (opts: { source?: string; dryRun?: boolean }) => {
      const result = await cloneAllFlow({
        sourceFilter: opts.source,
        dryRun: opts.dryRun === true,
      });
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.log(result.message);
        return;
      }
      const o = result.outcome;
      if (o.dry_run) {
        // eslint-disable-next-line no-console
        console.log(
          `[dry-run] Would clone ${o.dry_run_plan.length} repo(s) from ${o.source_count} source(s); ${o.walk_duplicates} duplicates deduped.`,
        );
        for (const p of o.dry_run_plan) {
          // eslint-disable-next-line no-console
          console.log(`  ${p.sourceName} :: ${p.cloneUrl} → ${p.destPath}`);
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `Cloned ${o.cloned.length}; skipped ${o.skipped_already_registered.length} already-registered; errored ${o.errored.length}; deduped ${o.walk_duplicates}.`,
        );
        for (const c of o.cloned) {
          // eslint-disable-next-line no-console
          console.log(`  cloned: ${c.name} → ${c.path}`);
        }
        for (const s of o.skipped_already_registered) {
          // eslint-disable-next-line no-console
          console.log(`  skip:   ${s.name} (already at ${s.path})`);
        }
      }
      for (const s of o.skipped_sources) {
        // eslint-disable-next-line no-console
        console.warn(`  source skipped: ${s.name} — ${s.reason}`);
      }
      for (const e of o.errored) {
        // eslint-disable-next-line no-console
        console.error(`  error: ${e.name} (${e.cloneUrl}) — ${e.reason}`);
      }
    });
  return cmd;
}
