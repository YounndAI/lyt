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

import { provenanceTraceFlow, type ProvenanceEntry } from "../flows/provenance-trace.js";

interface ProvenanceTraceCliOpts {
  vault?: string;
  json?: boolean;
}

export function buildProvenanceCommand(): Command {
  const cmd = new Command("provenance").description(
    "Trace the chronological chain of @STAMP records for a file or rid (arc §11.5).",
  );

  cmd
    .command("trace")
    .description(
      "Render the per-vault provenance chain for a target. Auto-detects file path vs rid.",
    )
    .argument(
      "<target>",
      "Either a file path (contains '/', '\\', or ends in '.md') or a rid (vault:|automator:|directive:|memscope:|rollup:|skill:|machine:|pattern:)",
    )
    .option("--vault <name>", "Target vault (default: the only non-tombstoned registered)")
    .option("--json", "Emit a JSON result instead of the human-readable chain")
    .action(async (target: string, opts: ProvenanceTraceCliOpts) => {
      const result = await provenanceTraceFlow({
        target,
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const { entries } = result;
      // eslint-disable-next-line no-console
      console.log(
        `Provenance for ${result.targetType}:${result.targetId} (vault: ${result.vaultName})`,
      );
      if (entries.length === 0) {
        // eslint-disable-next-line no-console
        console.log(`  No provenance recorded yet.`);
      } else {
        for (const e of entries) {
          // eslint-disable-next-line no-console
          console.log(formatEntryLine(e));
        }
      }
      // eslint-disable-next-line no-console
      console.log(`\n  Frontmatter last_provenance: ${result.frontmatterLastProvenance ?? "—"}`);
      // eslint-disable-next-line no-console
      console.log(`  ${result.frontmatterMessage}`);
    });

  return cmd;
}

function formatEntryLine(e: ProvenanceEntry): string {
  const ts = new Date(e.ts).toISOString();
  const bits: string[] = [`  - **${ts}** src=\`${e.src}\``];
  if (e.method) bits.push(`method=\`${e.method}\``);
  if (e.confidence !== null) bits.push(`confidence=${e.confidence}`);
  if (e.costUsd !== null) bits.push(`cost_usd=${e.costUsd}`);
  if (e.model) bits.push(`model=\`${e.model}\``);
  return bits.join(" · ");
}
