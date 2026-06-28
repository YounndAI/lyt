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

import { listAutomatorsFlow, type AutomatorListEntry } from "../flows/automator-list.js";
import { automatorLogFlow, type AutomatorLogArgs } from "../flows/automator-log.js";
import { automatorStatusFlow } from "../flows/automator-status.js";
import type { AutomatorRunEventLevel } from "../registry/vault-db-repo.js";

// block-B Commit 6 — `lyt automator` verb group.
//
// This module ships the data-only subcommands (list, log, status) that
// don't require @younndai/lyt-runner. The `run` subcommand lives in the
// meta @younndai/lyt CLI (packages/lyt/src/cli.ts) because runFiveStep
// pulls in lyt-runner, and lyt-runner depends on lyt-vault — registering
// run here would create a circular dep. Same composition pattern as
// v1.B.1 mesh, where lyt-vault registers the `mesh` parent and the meta
// CLI attaches lyt-mesh's clone-all / source / validate / status.
//
// Per Lock 0.3 (SAI-compatible), every subcommand has deterministic
// `--json` mode.

export function buildAutomatorCommand(): Command {
  const cmd = new Command("automator").description(
    "Inspect declared automators and their run history. The `run` subcommand is attached by the meta `lyt` CLI.",
  );
  cmd.addCommand(buildAutomatorListSubcommand());
  cmd.addCommand(buildAutomatorLogSubcommand());
  cmd.addCommand(buildAutomatorStatusSubcommand());
  return cmd;
}

// ---- list ------------------------------------------------------------

interface AutomatorListCliOpts {
  vault?: string;
  archetype?: string;
  json?: boolean;
}

function buildAutomatorListSubcommand(): Command {
  return new Command("list")
    .description(
      "List declared automators in the active vault (reads <vault>/.lyt/automators/*.yon).",
    )
    .option(
      "--vault <name>",
      "Vault name to inspect; required when more than one vault is registered",
    )
    .option("--archetype <a>", "Filter by archetype (e.g. filler, rollup, ingest)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: AutomatorListCliOpts) => {
      const result = await listAutomatorsFlow({
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        ...(opts.archetype !== undefined ? { archetype: opts.archetype } : {}),
      });

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              vault: { name: result.vaultName, path: result.vaultPath },
              automators: result.automators.map((a) => ({
                file: a.fileName,
                rid: a.rid,
                name: a.name,
                archetype: a.archetype,
                version: a.version,
                runtime: a.runtime,
                schedule: a.schedule,
                transaction_mode: a.transactionMode,
                description: a.description,
                parse_error: a.parseError,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }

      if (result.automators.length === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `No automators declared in vault '${result.vaultName}' (looked at: ${result.vaultPath}/.lyt/automators/).`,
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Automators in vault '${result.vaultName}':`);
      for (const a of result.automators) {
        renderAutomatorListEntry(a);
      }
    });
}

function renderAutomatorListEntry(a: AutomatorListEntry): void {
  if (a.parseError !== null) {
    // eslint-disable-next-line no-console
    console.log(`  ! ${a.fileName} — parse error: ${a.parseError}`);
    return;
  }
  const head = `${a.name ?? a.fileName}${a.version !== null ? ` (v${a.version})` : ""}`;
  // eslint-disable-next-line no-console
  console.log(
    `  • ${head}${a.archetype !== null ? `  [${a.archetype}]` : ""}${a.runtime !== null ? `  runtime=${a.runtime}` : ""}${a.schedule !== null ? `  schedule=${a.schedule}` : ""}`,
  );
  if (a.description !== null && a.description.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`      ${a.description}`);
  }
}

// ---- log -------------------------------------------------------------

interface AutomatorLogCliOpts {
  vault?: string;
  since?: string;
  level?: string;
  limit?: string;
  json?: boolean;
}

function buildAutomatorLogSubcommand(): Command {
  return new Command("log")
    .description("Show automator_run_events for a given automator (joins on automator_runs.id).")
    .argument(
      "<automator>",
      "Automator name or rid (e.g. 'metadata-filler' or 'automator:metadata-filler')",
    )
    .option("--vault <name>", "Vault name to inspect")
    .option("--since <iso>", "Filter events with ts >= the given ISO 8601 timestamp")
    .option("--level <level>", "Filter by event level: debug|info|warn|error")
    .option("--limit <n>", "Max events to return (default 500)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (automator: string, opts: AutomatorLogCliOpts) => {
      const sinceMs = opts.since !== undefined ? Date.parse(opts.since) : undefined;
      if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
        throw new Error(`--since: invalid ISO 8601 timestamp '${opts.since}'`);
      }
      const level = opts.level !== undefined ? (opts.level as AutomatorRunEventLevel) : undefined;
      const limit = opts.limit !== undefined ? parseInt(opts.limit, 10) : undefined;
      const flowArgs: AutomatorLogArgs = {
        automator,
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        ...(level !== undefined ? { level } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      const result = await automatorLogFlow(flowArgs);

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              vault: { name: result.vaultName, path: result.vaultPath },
              automator: result.automator,
              events: result.events.map((e) => ({
                run_id_hex: e.runIdHex,
                ts: e.ts,
                level: e.level,
                message: e.message,
                data_json: e.dataJson,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (result.events.length === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `No events for automator '${result.automator}' in vault '${result.vaultName}'.`,
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Events for automator '${result.automator}' in vault '${result.vaultName}':`);
      for (const e of result.events) {
        // eslint-disable-next-line no-console
        console.log(`  [${new Date(e.ts).toISOString()}] ${e.level.padEnd(5)} ${e.message}`);
      }
    });
}

// ---- status ----------------------------------------------------------

interface AutomatorStatusCliOpts {
  vault?: string;
  limit?: string;
  json?: boolean;
}

function buildAutomatorStatusSubcommand(): Command {
  return new Command("status")
    .description("Snapshot running / leased / failed / completed automator runs for the vault.")
    .option("--vault <name>", "Vault name to inspect")
    .option("--limit <n>", "Max recent runs to consider per bucket (default 50)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: AutomatorStatusCliOpts) => {
      const limit = opts.limit !== undefined ? parseInt(opts.limit, 10) : undefined;
      const result = await automatorStatusFlow({
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              vault: { name: result.vaultName, path: result.vaultPath },
              running: result.running,
              leased: result.leased,
              failed: result.failed,
              completed: result.completed,
            },
            null,
            2,
          ),
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Automator status — vault '${result.vaultName}':`);
      // eslint-disable-next-line no-console
      console.log(`  running:   ${result.running.length}`);
      // eslint-disable-next-line no-console
      console.log(`  leased:    ${result.leased.length}`);
      // eslint-disable-next-line no-console
      console.log(`  failed:    ${result.failed.length}`);
      // eslint-disable-next-line no-console
      console.log(`  completed: ${result.completed.length}`);
      if (result.leased.length > 0) {
        // eslint-disable-next-line no-console
        console.log("  active leases:");
        for (const l of result.leased) {
          // eslint-disable-next-line no-console
          console.log(
            ` - ${l.automatorRidHex} on ${l.machineId} expires ${new Date(l.expiresAt).toISOString()}`,
          );
        }
      }
    });
}
