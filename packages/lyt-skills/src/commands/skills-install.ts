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

import { symlinkSkillsTriRuntime, ALL_RUNTIMES, type Runtime } from "../symlink.js";

interface SkillsInstallCliOpts {
  runtime?: string;
  copy?: boolean;
  force?: boolean;
  source?: string;
  json?: boolean;
}

export function buildSkillsInstallSubcommand(): Command {
  const cmd = new Command("install");
  cmd
    .description("Symlink bundled Lyt skills into Claude Code / Codex / .agents runtimes")
    .addOption(
      new Option("--runtime <name>", "Target runtime")
        .choices(["claude", "codex", "agents", "all"])
        .default("all"),
    )
    .option("--copy", "Use recursive directory copy instead of symlink", false)
    .option("-f, --force", "Overwrite divergent symlinks or copied directories", false)
    .option("--source <dir>", "Override bundled skills source directory (test seam)")
    .option("--json", "Emit deterministic JSON shape", false)
    .action((opts: SkillsInstallCliOpts) => {
      const runtimes = resolveRuntimes(opts.runtime ?? "all");
      const result = symlinkSkillsTriRuntime({
        sourceDir: opts.source,
        runtimes,
        copy: opts.copy ?? false,
        force: opts.force ?? false,
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        printHuman(result);
      }

      const exitCode = pickExitCode(result);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
  return cmd;
}

function resolveRuntimes(name: string): readonly Runtime[] {
  if (name === "all") return ALL_RUNTIMES;
  return [name as Runtime];
}

function printHuman(result: ReturnType<typeof symlinkSkillsTriRuntime>): void {
  // eslint-disable-next-line no-console
  console.log(`Installed Lyt skills from ${result.sourceDir}`);
  for (const r of result.results) {
    const msg = r.message ? ` (${r.message})` : "";
    // eslint-disable-next-line no-console
    console.log(`  ${r.runtime}/${r.skill}\t${r.status}${msg}`);
  }
  // D30.4 / OD-1 — surface collision renames prominently. The install
  // SUCCEEDED (exit 0, heal never halts), but the handler must know a dir of
  // theirs was set aside so they can recover it if they want.
  const collisions = result.results.filter((r) => r.status === "renamed-collision");
  if (collisions.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n⚠ ${collisions.length} skill target(s) collided with a non-lyt directory and were set aside (nothing deleted):`,
    );
    for (const r of collisions) {
      // eslint-disable-next-line no-console
      console.warn(`  ${r.runtime}/${r.skill}: ${r.message ?? ""}`);
    }
  }
}

function pickExitCode(result: ReturnType<typeof symlinkSkillsTriRuntime>): number {
  let exit = 0;
  for (const r of result.results) {
    if (r.status === "target-not-a-directory") return 4;
    // `divergent-symlink` is a warn (a symlink points somewhere unexpected and
    // we did NOT touch it without --force). `renamed-collision` is NOT a warn
    // exit: it is a successful, collision-safe install — heal must stay exit 0
    // so a re-aligning `lyt init` never reports failure (D30 never-fail).
    if (r.status === "divergent-symlink") exit = 2;
  }
  return exit;
}
