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

// `lyt automator run <rid|name>` subcommand.
//
// Lives in the meta @younndai/lyt CLI because runFiveStep pulls in lyt-runner
// and lyt-runner depends on lyt-vault — registering `run` inside lyt-vault
// would create a circular dep. Mirrors the lyt-mesh subcommand-attach pattern
// at packages/lyt/src/cli.ts.
//
// Per Lock 0.3 (SAI-compatible — brief §Conventions L191), --json emits a
// deterministic JSON envelope so SAIs / Claude Code / Codex can consume the
// invocation result without screen-scraping.

import { Command } from "commander";
import { uuid7BytesToDashedString } from "@younndai/lyt-vault";

import { runAutomator } from "./automator-run.js";

interface AutomatorRunCliOpts {
  vault?: string;
  dryRun?: boolean;
  // commander stores `--no-push` as push:false (negated-flag convention);
  // noPush is the direct-invocation shape test harnesses pass.
  push?: boolean;
  noPush?: boolean;
  json?: boolean;
}

// commander stores `--no-push` as push:false (negated-flag convention); the
// noPush key is only set by test harnesses invoking the action directly.
// Track C Wave 3 F9: reading only opts.noPush dropped the CLI flag entirely
// and the run pushed. Exported so the regression test locks the mapping.
export function resolveNoPushOpt(opts: { push?: boolean; noPush?: boolean }): boolean {
  return opts.push === false || opts.noPush === true;
}

export function buildAutomatorRunSubcommand(): Command {
  return new Command("run")
    .description(
      "Run a declared automator end-to-end (5-step protocol: lease → sync → body → commit → release).",
    )
    .argument(
      "<automator>",
      "Automator name or rid (e.g. 'metadata-filler' or 'automator:metadata-filler')",
    )
    .option(
      "--vault <name>",
      "Vault name to run against; required when more than one vault is registered",
    )
    .option(
      "--dry-run",
      "Skip lease acquisition + git pull/push (still invokes the body for inspection)",
    )
    .option("--no-push", "Run the commit step but skip `git push` (still commits locally)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (automator: string, opts: AutomatorRunCliOpts) => {
      const noPush = resolveNoPushOpt(opts);
      const result = await runAutomator({
        automator,
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        ...(opts.dryRun === true ? { dryRun: true } : {}),
        ...(noPush ? { noPush: true } : {}),
      });

      const payload = {
        ok: result.ok,
        automator: result.plan.automatorName,
        automator_version: result.automatorVersion,
        run_id_hex: uuid7BytesToDashedString(result.runId).replace(/-/g, ""),
        vault: {
          name: result.plan.vaultName,
          path: result.plan.vaultPath,
        },
        status: result.status,
        error_summary: result.errorSummary,
        dry_run: opts.dryRun === true,
        no_push: noPush,
        body: result.body ?? null,
      };

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `${result.ok ? "✓" : "✗"} automator:${payload.automator} ` +
            `→ status=${payload.status}${payload.error_summary !== null ? ` (${payload.error_summary})` : ""}`,
        );
      }

      if (!result.ok) process.exit(1);
    });
}
