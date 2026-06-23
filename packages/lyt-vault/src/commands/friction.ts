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

import {
  FRICTION_REPORT_DEFAULT_WINDOW_MS,
  FRICTION_TIER_A_THRESHOLD,
  frictionFalsePositiveFlow,
  frictionNoteFlow,
  frictionReportFlow,
  frictionResolveFlow,
} from "../flows/friction.js";
import { FRICTION_CATEGORIES, type FrictionCategory } from "../registry/vault-db-migrations.js";

interface NoteOpts {
  category?: string;
  vault?: string;
  json?: boolean;
}

interface ReportOpts {
  window?: string;
  excludeFalsePositive?: boolean;
  vault?: string;
  json?: boolean;
}

interface MutateOpts {
  note?: string;
  vault?: string;
  json?: boolean;
}

// Top-level `lyt friction` verb group (parallel to vault/mesh/sync) — per
// A.1 retro recommendation + plan Open Q4 lock. Operates on the per-vault
// audit_log; defaults to the only registered vault if --vault is omitted
// and unambiguous.
export function buildFrictionCommand(): Command {
  const cmd = new Command("friction").description(
    "Capture + triage cross-machine sync friction. Records to per-vault audit_log; `report` summarises the rolling window.",
  );

  cmd
    .command("note")
    .description(
      "Record a friction incident in the vault audit_log (default category: propagation.gap).",
    )
    .argument("<description>", "Short handler-authored description of the friction")
    .option(
      "--category <name>",
      `Friction category (one of: ${FRICTION_CATEGORIES.join(", ")}). Default: propagation.gap`,
    )
    .option("--vault <name>", "Target vault (default: the only non-tombstoned registered)")
    .option("--json", "Emit a JSON result")
    .action(async (description: string, opts: NoteOpts) => {
      const category = (opts.category ?? "propagation.gap") as FrictionCategory;
      const result = await frictionNoteFlow({
        description,
        category,
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `Logged friction (${result.action}) in vault '${result.vaultName}' as ${result.idHex} by ${result.actor}.`,
      );
    });

  cmd
    .command("report")
    .description(
      "Count unresolved sync.friction.* incidents in a rolling window (default 28d). Warns at Tier A threshold (≥3).",
    )
    .option("--window <duration>", "Window size as <N>d (days). Default 28d.")
    .option(
      "--exclude-false-positive",
      "Skip rows previously flagged via `lyt friction false-positive`",
    )
    .option("--vault <name>", "Restrict to one vault (default: every registered non-tombstoned)")
    .option("--json", "Emit a JSON result")
    .action(async (opts: ReportOpts) => {
      const windowMs = parseWindow(opts.window);
      const result = await frictionReportFlow({
        windowMs,
        ...(opts.excludeFalsePositive !== undefined
          ? { excludeFalsePositive: opts.excludeFalsePositive }
          : {}),
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const windowDays = Math.round(result.windowMs / (24 * 60 * 60 * 1000));
      // eslint-disable-next-line no-console
      console.log(
        `Friction report (${windowDays}d window across ${result.vaultsScanned.length} vault(s)):`,
      );
      if (result.totalUnresolved === 0) {
        // eslint-disable-next-line no-console
        console.log(`  No unresolved sync.friction.* incidents.`);
      } else {
        for (const [cat, count] of Object.entries(result.byCategory).sort()) {
          // eslint-disable-next-line no-console
          console.log(`  ${cat.padEnd(20)} ${count}`);
        }
        // eslint-disable-next-line no-console
        console.log(`  ${"TOTAL".padEnd(20)} ${result.totalUnresolved}`);
        if (result.tierATriggered) {
          // eslint-disable-next-line no-console
          console.log(
            `\n  ⚠ Tier A trigger reached (≥${FRICTION_TIER_A_THRESHOLD} unresolved incidents in window). Arc §10.1: ship a Tier A plugin within 1 week.`,
          );
        }
      }
    });

  cmd
    .command("resolve")
    .description(
      "Mark a friction row as resolved (merges {resolved, resolved_at, resolution_note} into details_json + emits sync.friction.fix.shipped).",
    )
    .argument("<id>", "audit_log row id (32-char hex or 8-4-4-4-12 dashed UUID)")
    .option("--note <text>", "Optional resolution note saved into details_json")
    .option("--vault <name>", "Target vault (default: the only non-tombstoned registered)")
    .option("--json", "Emit a JSON result")
    .action(async (id: string, opts: MutateOpts) => {
      const result = await frictionResolveFlow({
        idHex: id,
        ...(opts.note !== undefined ? { note: opts.note } : {}),
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `Resolved friction ${result.idHex} in vault '${result.vaultName}'. Companion fix.shipped row: ${result.shippedFixIdHex ?? "<none>"}.`,
      );
    });

  cmd
    .command("false-positive")
    .description(
      "Flag a friction row as false-positive (excluded from `report --exclude-false-positive`). Requires --note.",
    )
    .argument("<id>", "audit_log row id (hex)")
    .requiredOption("--note <text>", "Required justification stored in details_json")
    .option("--vault <name>", "Target vault (default: the only non-tombstoned registered)")
    .option("--json", "Emit a JSON result")
    .action(async (id: string, opts: MutateOpts) => {
      const result = await frictionFalsePositiveFlow({
        idHex: id,
        note: opts.note,
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `Marked friction ${result.idHex} in vault '${result.vaultName}' as false-positive.`,
      );
    });

  return cmd;
}

function parseWindow(raw: string | undefined): number {
  if (!raw) return FRICTION_REPORT_DEFAULT_WINDOW_MS;
  const m = raw.match(/^(\d+)d$/);
  if (!m) {
    throw new Error(`--window must be <N>d (days). Got ${JSON.stringify(raw)}.`);
  }
  return Number(m[1]!) * 24 * 60 * 60 * 1000;
}
