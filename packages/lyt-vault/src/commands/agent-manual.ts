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

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import {
  AGENT_MANUAL_RUNTIMES,
  AgentManualMalformedMarkersError,
  AgentManualUnsafeRuntimeError,
  detectInstalledRuntimes,
  generateAgentManual,
  INSTALLABLE_RUNTIMES,
  replaceMarkerBlock,
  type AgentManualRuntime,
} from "../flows/agent-manual.js";

// v1.G.5 — `lyt agent-manual --runtime {claude|codex|agents|generic}
// [--install] [--dry-run]`.
//
// Top-level meta-CLI verb. Composed in `packages/lyt/src/cli.ts` via
// `program.addCommand(buildAgentManualCommand())` — mirrors the existing
// `lyt discover` / `lyt repair` / `lyt skills` attach pattern.
//
// Without `--install`: emit the generated manual to stdout (preview).
// With `--install`: write the version-tagged marker block to the
// runtime's global instructions file (claude → ~/.claude/CLAUDE.md,
// codex → ~/.codex/AGENTS.md, agents → ~/.agents/AGENTS.md, generic →
// always stdout regardless of --install).
// With `--install --dry-run`: print "would write to <path>" + the
// would-write content; no file system mutation.
//
// PG-8 shell-injection defenses:
// - `--runtime` arg validated via `coerceRuntime` against the
// AGENT_MANUAL_RUNTIMES literal enum at the parser layer; non-enum
// values raise InvalidArgumentError BEFORE the action callback runs.
// - No `child_process` / shell invocation anywhere in the action.
// - File writes go through `fs.writeFileSync` with an explicit string
// payload — no template-string concat into a shell, no exec(), no
// spawn().

interface AgentManualCliOpts {
  runtime?: AgentManualRuntime;
  install?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

function coerceRuntime(value: string): AgentManualRuntime {
  if ((AGENT_MANUAL_RUNTIMES as readonly string[]).includes(value)) {
    return value as AgentManualRuntime;
  }
  throw new InvalidArgumentError(`--runtime must be one of ${AGENT_MANUAL_RUNTIMES.join(" | ")}`);
}

export function buildAgentManualCommand(): Command {
  return new Command("agent-manual")
    .description(
      "v1.G.5 + GP F5: generate the Lyt agent manual and (with --install) inject it into agent-runtime global instructions files. Default (--install, no --runtime): auto-detect ALL installed runtimes (~/.claude, ~/.codex, ~/.agents) and inject into each (absent runtimes skipped with a note). Explicit --runtime <one> targets a single runtime; generic always prints to stdout. Path A3 hybrid: hand-curated mental-model + workflows + protocol-notes + auto-injected WHEN-USER-SAYS table from 11 SKILL.md files + curated CLI-verb list. update-path primitive: <!-- lyt-manual v<lyt-version> BEGIN -->...END --> markers (replace-between-markers on re-install; refuse on malformed; --force appends a fresh block on malformed with a visible warning).",
    )
    .option(
      "--runtime <name>",
      `Target a single agent runtime — one of ${AGENT_MANUAL_RUNTIMES.join(" | ")}. Omit with --install to auto-detect and inject into ALL installed runtimes.`,
      coerceRuntime,
    )
    .option(
      "--install",
      "Write the marker block to the runtime's global instructions file (omit to preview to stdout). With no --runtime, injects into every detected runtime.",
    )
    .option(
      "--dry-run",
      "With --install, print the target path + would-write content without modifying the file",
    )
    .option(
      "--force",
      "On a malformed-marker file, append a fresh block (with a visible warning) instead of refusing. Default (no --force) refuses to protect a hand-edited file.",
    )
    .action(async (opts: AgentManualCliOpts) => {
      const install = opts.install === true;
      const dryRun = opts.dryRun === true;
      const force = opts.force === true;

      // F5 — resolve the target runtime set.
      // - explicit --runtime <one> → that single runtime (unchanged).
      // - no --runtime + --install → all DETECTED installable runtimes.
      // - no --runtime + preview → claude (stdout preview default).
      // `generic` is only reachable via explicit --runtime generic (stdout).
      let runtimes: readonly AgentManualRuntime[];
      if (opts.runtime !== undefined) {
        runtimes = [opts.runtime];
      } else if (install) {
        const detected = detectInstalledRuntimes();
        if (detected.length === 0) {
          // eslint-disable-next-line no-console
          console.error(
            `lyt agent-manual: no agent runtime detected (looked for ~/.claude, ~/.codex, ~/.agents). Install one, or pass --runtime <name> explicitly.`,
          );
          process.exitCode = 6;
          return;
        }
        runtimes = detected;
        // Report which installable runtimes were skipped (absent).
        for (const rt of INSTALLABLE_RUNTIMES) {
          if (!detected.includes(rt)) {
            // eslint-disable-next-line no-console
            console.log(`  skipped: ~/.${rt} not present`);
          }
        }
      } else {
        // Preview with no --install and no --runtime → claude to stdout.
        runtimes = ["claude"];
      }

      let sawError = false;
      for (const runtime of runtimes) {
        const ok = await installOneRuntime(runtime, { install, dryRun, force });
        if (!ok) sawError = true;
      }
      if (sawError && process.exitCode === undefined) process.exitCode = 1;
    });
}

// Install (or preview) the manual for a SINGLE runtime. Returns false on a
// per-runtime failure so the loop can record it without aborting the other
// runtimes (one malformed ~/.claude shouldn't block ~/.codex injection).
async function installOneRuntime(
  runtime: AgentManualRuntime,
  flags: { install: boolean; dryRun: boolean; force: boolean },
): Promise<boolean> {
  const { install, dryRun, force } = flags;
  try {
    const result = await generateAgentManual({
      runtime,
      install,
      dryRun,
    });

    if (!install || result.destinationPath === null) {
      // Preview path: stdout, no write. Also covers `generic` (stdout).
      // eslint-disable-next-line no-console
      process.stdout.write(result.content);
      return true;
    }

    if (dryRun) {
      // eslint-disable-next-line no-console
      console.log(`# lyt agent-manual --install --dry-run (${runtime})`);
      // eslint-disable-next-line no-console
      console.log(`# would write to: ${result.destinationPath}`);
      // eslint-disable-next-line no-console
      console.log(`# marker status: ${result.markerStatus}`);
      // eslint-disable-next-line no-console
      console.log(
        `# would-replace-existing-block: ${result.wouldReplaceExistingBlock ? "yes" : "no"}`,
      );
      if (result.markerStatus === "malformed") {
        // eslint-disable-next-line no-console
        console.log(
          force
            ? "# WARNING: existing markers are malformed; --force would APPEND a fresh block (malformed region preserved)."
            : "# WARNING: existing markers are malformed; --install would refuse (pass --force to append a fresh block).",
        );
      }
      // eslint-disable-next-line no-console
      process.stdout.write(result.content);
      return true;
    }

    // Real install — replace-between-markers if the file exists with
    // a marker block; append if no marker block; refuse if markers
    // are malformed (BEGIN-count ≠ END-count or 2+ BEGINs) UNLESS --force.
    const dest = result.destinationPath;
    const dir = dirname(dest);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Release review Sec-M1 + Cor-M3 fix-pass (NEW family — destination-
    // write-symlink-follow): refuse install when the destination is
    // a symlink. fs.writeFileSync follows symlinks by default, so an
    // attacker-planted symlink at ~/.claude/CLAUDE.md → /etc/passwd
    // would silently overwrite the target. Brief PG-8 item 2
    // demanded an active check; this is it.
    if (existsSync(dest)) {
      const st = lstatSync(dest);
      if (st.isSymbolicLink()) {
        // eslint-disable-next-line no-console
        console.error(
          JSON.stringify(
            {
              status: "unsafe-destination",
              reason: "symlink-refused",
              destination: dest,
              message: `${dest} is a symlink; refusing to install agent manual through a symlink. Replace it with a regular file before retrying.`,
            },
            null,
            2,
          ),
        );
        process.exitCode = 5;
        return false;
      }
    }
    let existing = "";
    if (existsSync(dest)) existing = readFileSync(dest, "utf8");
    const {
      result: nextContent,
      replaced,
      forcedRepair,
    } = replaceMarkerBlock(existing, result.content, dest, force);
    writeFileSync(dest, nextContent, "utf8");
    if (forcedRepair === true) {
      // NEVER silent — surface that --force repaired a malformed file.
      // eslint-disable-next-line no-console
      console.warn(
        `  WARNING: ${dest} had malformed lyt-manual markers; --force appended a fresh block. The malformed region was preserved — review + remove it manually.`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `${replaced ? "Updated" : "Installed"} Lyt agent manual v${result.markerVersion} → ${dest}`,
    );
    return true;
  } catch (err) {
    if (err instanceof AgentManualMalformedMarkersError) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify(
          {
            status: err.status,
            file: err.file,
            begin_count: err.beginCount,
            end_count: err.endCount,
            message: err.message,
            hint: "pass --force to append a fresh block (malformed region preserved)",
          },
          null,
          2,
        ),
      );
      process.exitCode = 4;
      return false;
    }
    if (err instanceof AgentManualUnsafeRuntimeError) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify(
          { status: err.status, received: err.received, message: err.message },
          null,
          2,
        ),
      );
      process.exitCode = 2;
      return false;
    }
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`lyt agent-manual: ${message}`);
    process.exitCode = 1;
    return false;
  }
}
