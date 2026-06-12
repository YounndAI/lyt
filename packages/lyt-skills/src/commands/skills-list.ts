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

import { Command, Option } from "commander";

import { listSkillsTriRuntime, type ListSkillsResult } from "../list.js";
import { ALL_RUNTIMES, type Runtime } from "../symlink.js";

interface SkillsListCliOpts {
  runtime?: string;
  source?: string;
  json?: boolean;
}

export function buildSkillsListSubcommand(): Command {
  const cmd = new Command("list");
  cmd
    .description("Show per-runtime install state of bundled Lyt skills")
    .addOption(
      new Option("--runtime <name>", "Filter the report to a single runtime")
        .choices(["claude", "codex", "agents", "all"])
        .default("all"),
    )
    .option("--source <dir>", "Override bundled skills source directory (test seam)")
    .option("--json", "Emit deterministic JSON shape", false)
    .action((opts: SkillsListCliOpts) => {
      const runtimes = resolveRuntimes(opts.runtime ?? "all");
      const result = listSkillsTriRuntime({ sourceDir: opts.source, runtimes });

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        printTable(result);
      }
    });
  return cmd;
}

function resolveRuntimes(name: string): readonly Runtime[] {
  if (name === "all") return ALL_RUNTIMES;
  return [name as Runtime];
}

function symbol(state: string): string {
  switch (state) {
    case "symlink":
      return "✓ symlink";
    case "copy":
      return "✓ copy";
    case "missing":
      return "✗ missing";
    case "divergent":
      return "! divergent";
    case "not-a-dir":
      return "! not-a-dir";
    default:
      return state;
  }
}

function printTable(result: ListSkillsResult): void {
  const cols = ["Skill", "lyt-version", ...result.runtimes];
  const rows: string[][] = result.skills.map((row) => [
    row.name,
    row.lytVersion ?? "-",
    ...result.runtimes.map((rt) => symbol(row.runtimes[rt])),
  ]);

  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i]!.length)));

  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join(" ");

  // eslint-disable-next-line no-console
  console.log(fmt(cols));
  // eslint-disable-next-line no-console
  console.log(fmt(widths.map((w) => "-".repeat(w))));
  for (const row of rows) {
    // eslint-disable-next-line no-console
    console.log(fmt(row));
  }
}
