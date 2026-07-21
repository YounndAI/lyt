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

import {
  symlinkSkillsTriRuntime,
  ALL_RUNTIMES,
  getBundledSkillsDir,
  listBundledSkills,
  type Runtime,
} from "../symlink.js";

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
    .argument("[names...]", "Install only the named bundled skills")
    .addOption(
      new Option("--runtime <name>", "Target runtime")
        .choices(["claude", "codex", "agents", "all"])
        .default("all"),
    )
    .option("--copy", "Use recursive directory copy instead of symlink", false)
    .option("-f, --force", "Overwrite divergent symlinks or copied directories", false)
    .option("--source <dir>", "Override bundled skills source directory (test seam)")
    .option("--json", "Emit deterministic JSON shape", false)
    .action((names: string[], opts: SkillsInstallCliOpts) => {
      const runtimes = resolveRuntimes(opts.runtime ?? "all");
      const sourceDir = opts.source ?? getBundledSkillsDir();
      const validNames = [...listBundledSkills(sourceDir)].sort();
      const validNameSet = new Set(validNames);
      const unknownNames = [...new Set(names.filter((name) => !validNameSet.has(name)))].sort();
      if (unknownNames.length > 0) {
        printUnknownSkills(unknownNames, validNames, opts.json ?? false);
        process.exitCode = 1;
        return;
      }
      const result = symlinkSkillsTriRuntime({
        sourceDir: opts.source,
        runtimes,
        skillNames: names.length > 0 ? names : undefined,
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

function printUnknownSkills(
  unknownNames: readonly string[],
  validNames: readonly string[],
  json: boolean,
): void {
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          error: "unknown-skill",
          unknownSkills: unknownNames,
          validSkills: validNames,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.error(
    `Unknown Lyt skill name(s): ${unknownNames.join(", ")}\nValid skill names: ${validNames.join(", ")}`,
  );
}

function resolveRuntimes(name: string): readonly Runtime[] {
  if (name === "all") return ALL_RUNTIMES;
  return [name as Runtime];
}

function printHuman(result: ReturnType<typeof symlinkSkillsTriRuntime>): void {
  const allRefused =
    result.results.length > 0 &&
    result.results.every((entry) => entry.status === "refused-incompatible");
  // eslint-disable-next-line no-console
  console.log(
    allRefused
      ? `Checked Lyt skills from ${result.sourceDir}; none installed`
      : `Installed Lyt skills from ${result.sourceDir}`,
  );
  for (const r of result.results) {
    const msg = r.message ? ` (${r.message})` : "";
    // eslint-disable-next-line no-console
    console.log(`  ${r.runtime}/${r.skill}\t${r.status}${msg}`);
  }
  const refused = result.results.filter((r) => r.status === "refused-incompatible");
  if (refused.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`\n${refused.length} incompatible skill target(s) were not changed:`);
    for (const r of refused) {
      const next = r.refusal?.nextAction;
      // eslint-disable-next-line no-console
      console.warn(
        `  ${r.runtime}/${r.skill}: ${r.refusal?.code ?? "incompatible"}; ` +
          `next: ${next?.command ?? "lyt update"}`,
      );
    }
  }
  // surface collision renames prominently. The install
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
    if (r.status === "refused-incompatible") return 3;
    if (r.status === "target-not-a-directory") return 4;
    // `divergent-symlink` is a warn (a symlink points somewhere unexpected and
    // we did NOT touch it without --force). `renamed-collision` is NOT a warn
    // exit: it is a successful, collision-safe install — heal must stay exit 0
    // so a re-aligning `lyt init` never reports failure (never-fail).
    if (r.status === "divergent-symlink") exit = 2;
  }
  return exit;
}
