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

import { patternForkFlow } from "../flows/pattern-fork.js";
import { patternInstallFlow } from "../flows/pattern-install.js";
import { patternLinkFlow } from "../flows/pattern-link.js";
import { patternListFlow } from "../flows/pattern-list.js";
import { patternRunFlow } from "../flows/pattern-run.js";
import { patternUninstallFlow } from "../flows/pattern-uninstall.js";
import { patternUnlinkFlow } from "../flows/pattern-unlink.js";
import { patternVerbsFlow } from "../flows/pattern-verbs.js";

export function buildPatternCommand(): Command {
  const cmd = new Command("pattern");
  cmd.description(
    "Manage Lyt patterns at ~/lyt/patterns/ (list/install/uninstall/link/unlink/fork/verbs/run).",
  );

  cmd.addCommand(buildListSub());
  cmd.addCommand(buildInstallSub());
  cmd.addCommand(buildUninstallSub());
  cmd.addCommand(buildLinkSub());
  cmd.addCommand(buildUnlinkSub());
  cmd.addCommand(buildForkSub());
  cmd.addCommand(buildVerbsSub());
  cmd.addCommand(buildRunSub());
  return cmd;
}

function buildListSub(): Command {
  const c = new Command("list");
  c.description(
    "List installed patterns at ~/lyt/patterns/. Pass --vault to see link status per vault.",
  )
    .option("--vault <name>", "Show whether each pattern is linked into this vault")
    .option("--json", "Emit JSON instead of a human table")
    .action(async (opts: { vault?: string; json?: boolean }) => {
      const result = await patternListFlow(opts.vault);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Patterns at ${result.patternsDir} (${result.entries.length}):`);
      for (const e of result.entries) {
        const linked =
          e.linkedToVault === null ? "" : e.linkedToVault ? " [linked]" : " [not linked]";
        // eslint-disable-next-line no-console
        console.log(`  ${e.id}@${e.version}  (${e.verbCount} verbs)${linked}`);
      }
    });
  return c;
}

function buildInstallSub(): Command {
  const c = new Command("install");
  c.description(
    "Install a pattern. v1 supports --from <local-dir>; git URL + npm package come later.",
  )
    .argument("[source]", "Pattern name or source (currently informational; pass --from <dir>)")
    .option("--from <dir>", "Install from a local directory containing pattern.yon")
    .option("--as <name>", "Override the installed name")
    .option("--force", "Overwrite an existing installation")
    .action(
      async (
        _source: string | undefined,
        opts: { from?: string; as?: string; force?: boolean },
      ) => {
        if (!opts.from) {
          throw new Error(
            "pattern install: v1 requires --from <local-dir>. Git URL + npm package install are post-v1.",
          );
        }
        const r = await patternInstallFlow({
          fromDir: opts.from,
          ...(opts.as !== undefined ? { asName: opts.as } : {}),
          force: opts.force === true,
        });
        // eslint-disable-next-line no-console
        console.log(`pattern install: ${r.status}: ${r.name} -> ${r.targetDir}`);
      },
    );
  return c;
}

function buildUninstallSub(): Command {
  const c = new Command("uninstall");
  c.description(
    "Remove a pattern from ~/lyt/patterns/. Refuses if any vault has it linked unless --force.",
  )
    .argument("<name>", "Pattern name")
    .option("--force", "Unlink from vaults first, then remove the master")
    .action(async (name: string, opts: { force?: boolean }) => {
      const r = await patternUninstallFlow({ name, force: opts.force === true });
      if (!r.removed) {
        // eslint-disable-next-line no-console
        console.error(`pattern uninstall: ${name} — ${r.reason}`);
        process.exit(1);
      }
      // eslint-disable-next-line no-console
      console.log(`pattern uninstall: removed ${name}`);
    });
  return c;
}

function buildLinkSub(): Command {
  const c = new Command("link");
  c.description("Symlink <vault>/Patterns/<name> -> ~/lyt/patterns/<name>.")
    .argument("<name>", "Pattern name")
    .requiredOption("--vault <vault-name>", "Target vault")
    .action(async (name: string, opts: { vault: string }) => {
      const r = await patternLinkFlow({ patternName: name, vaultName: opts.vault });
      // eslint-disable-next-line no-console
      console.log(`pattern link: ${r.status}: ${r.linkPath} -> ~/lyt/patterns/${name}`);
    });
  return c;
}

function buildUnlinkSub(): Command {
  const c = new Command("unlink");
  c.description("Remove <vault>/Patterns/<name>.")
    .argument("<name>", "Pattern name")
    .requiredOption("--vault <vault-name>", "Target vault")
    .action(async (name: string, opts: { vault: string }) => {
      const r = await patternUnlinkFlow({ patternName: name, vaultName: opts.vault });
      // eslint-disable-next-line no-console
      console.log(
        `pattern unlink: ${r.removed ? "removed" : "not-present"}: ${name} in ${opts.vault}`,
      );
    });
  return c;
}

function buildForkSub(): Command {
  const c = new Command("fork");
  c.description("Copy ~/lyt/patterns/<source>/ to ~/lyt/patterns/<asName>/ for customization.")
    .argument("<source>", "Source pattern name")
    .requiredOption("--as <name>", "New pattern name")
    .action(async (source: string, opts: { as: string }) => {
      const r = await patternForkFlow({ source, asName: opts.as });
      // eslint-disable-next-line no-console
      console.log(`pattern fork: ${r.sourceDir} -> ${r.targetDir}`);
    });
  return c;
}

function buildVerbsSub(): Command {
  const c = new Command("verbs");
  c.description("List verbs declared in <pattern>/pattern.yon.")
    .argument("<name>", "Pattern name")
    .option("--json", "Emit JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      const r = await patternVerbsFlow(name);
      if (opts.json) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`${r.patternId}@${r.patternVersion} verbs (${r.verbs.length}):`);
      for (const v of r.verbs) {
        // eslint-disable-next-line no-console
        console.log(`  ${v.id}  ->  ${v.pathGlob}  (template: ${v.template})`);
      }
    });
  return c;
}

function buildRunSub(): Command {
  const c = new Command("run");
  c.description(
    "Execute a verb: read the template, fill frontmatter (date, slug, project, owner), resolve the path-glob, write the file.",
  )
    .argument("<pattern>", "Pattern name")
    .argument("<verb>", "Verb id")
    .requiredOption("--vault <vault-name>", "Target vault")
    .option("--project <name>", "Project token for path-glob substitution")
    .option("--slug <slug>", "Slug for the filename (kebab-case recommended)")
    .option(
      "--vars <kv>",
      "Repeatable key=value override (e.g., --vars title='X')",
      collectVars,
      {} as Record<string, string>,
    )
    .action(
      async (
        pattern: string,
        verb: string,
        opts: { vault: string; project?: string; slug?: string; vars: Record<string, string> },
      ) => {
        const r = await patternRunFlow({
          patternName: pattern,
          verbId: verb,
          vaultName: opts.vault,
          ...(opts.project !== undefined ? { project: opts.project } : {}),
          ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
          vars: opts.vars,
        });
        // eslint-disable-next-line no-console
        console.log(
          `pattern run: ${r.alreadyExisted ? "ALREADY-EXISTS" : "wrote"}: ${r.filePath}\n  template: ${r.filledFrom}`,
        );
        // V-C-1 (L1) — surface a deferred-index soft note so capture never
        // fails silently. The figment is saved; only the search-index update
        // was deferred (it self-heals on the next search / `lyt reindex`).
        if (r.indexDeferred === true && r.indexNote !== undefined) {
          // eslint-disable-next-line no-console
          console.log(`  ⚠ ${r.indexNote}`);
        }
      },
    );
  return c;
}

function collectVars(value: string, previous: Record<string, string>): Record<string, string> {
  const m = value.match(/^([^=]+)=(.*)$/);
  if (!m) {
    throw new Error(`--vars must be 'key=value' (got '${value}')`);
  }
  return { ...previous, [m[1]!]: m[2]! };
}
