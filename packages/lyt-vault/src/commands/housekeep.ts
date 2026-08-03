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

import { KNOWN_LEDGERS, housekeepFlow, type LedgerName } from "../flows/housekeep.js";
import { DEFAULT_LYT_CONFIG } from "../util/config.js";
import { resolvePublishedMachineAuthorityForHousekeep } from "../flows/federation/sync-pod-ledger.js";

interface HousekeepCliOpts {
  vault?: string;
  ledger?: string;
  rotateNow?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
  retention?: string;
}

export function buildHousekeepCommand(dependencies: {
  housekeepFlow?: typeof housekeepFlow;
  resolvePublishedMachineAuthority?: typeof resolvePublishedMachineAuthorityForHousekeep;
} = {}): Command {
  return new Command("housekeep")
    .description(
      "Preview month-boundary rotation for per-vault YON ledger files. Default: every active vault, every known ledger (audit, provenance). Pass --apply to mutate. Deterministic --json.",
    )
    .option("--vault <name>", "Restrict to one vault by name")
    .option("--ledger <name>", `Restrict to one ledger (known: ${KNOWN_LEDGERS.join(", ")})`)
    .option(
      "--rotate-now",
      "Force rotation regardless of month boundary (for testing or manual archive cuts)",
    )
    .option("--dry-run", "Report proposed rotations without mutating any files")
    .option("--apply", "Apply the proposed rotations and eligible retention deletions")
    .option(
      "--retention <days|never>",
      `Sync archive retention (default: ${DEFAULT_LYT_CONFIG.syncLedgerRetentionDays} days; 'never' disables GC)`,
    )
    .option("--json", "Emit a deterministic JSON result instead of human-readable text")
    .action(async (opts: HousekeepCliOpts) => {
      if (opts.apply === true && opts.dryRun === true) {
        throw new Error("Choose either --apply or --dry-run, not both.");
      }
      if (
        opts.ledger !== undefined &&
        !(KNOWN_LEDGERS as readonly string[]).includes(opts.ledger)
      ) {
        // eslint-disable-next-line no-console
        console.error(
          `lyt housekeep: unknown --ledger '${opts.ledger}'. Known: ${KNOWN_LEDGERS.join(", ")}`,
        );
        process.exitCode = 2;
        return;
      }
      const retentionDays = opts.retention === undefined ? undefined : parseRetention(opts.retention);
      const authority = opts.ledger !== undefined && opts.ledger !== "sync" || retentionDays === "never"
        ? undefined
        : await (dependencies.resolvePublishedMachineAuthority ?? resolvePublishedMachineAuthorityForHousekeep)();
      const result = await (dependencies.housekeepFlow ?? housekeepFlow)({
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        ...(opts.ledger !== undefined ? { ledger: opts.ledger as LedgerName } : {}),
        ...(opts.rotateNow === true ? { rotateNow: true } : {}),
        dryRun: opts.apply !== true,
        ...(retentionDays === undefined ? {} : { retentionDays }),
        ...(authority === undefined ? {} : {
          publishedMachineSnapshot: authority.snapshot,
          verifyPublishedSnapshot: authority.revalidate,
        }),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const rotatedCount = result.rotations.filter((r) => r.outcome === "rotated").length;
      const wouldCount = result.rotations.filter(
        (r) => r.outcome === "would-rotate" || r.outcome === "would-rotate-now",
      ).length;
      const skippedCount = result.rotations.length - rotatedCount - wouldCount;
      // eslint-disable-next-line no-console
      console.log(
        `lyt housekeep: scanned ${result.scannedVaults.length} vault(s) × ${result.scannedLedgers.length} ledger(s).\n` +
          `  ${rotatedCount} rotated, ${wouldCount} would-rotate (dry-run), ${skippedCount} skipped.`,
      );
      for (const r of result.rotations) {
        if (
          r.outcome === "rotated" ||
          r.outcome === "would-rotate" ||
          r.outcome === "would-rotate-now"
        ) {
          // eslint-disable-next-line no-console
          console.log(
            `  [${r.outcome}] ${r.vaultName}/${r.ledger}: ${r.fromMonth} → ${r.toMonth} ${r.archivedPath ? `(archive: ${r.archivedPath})` : ""}`,
          );
        }
      }
      for (const entry of result.gc) {
        // eslint-disable-next-line no-console
        console.log(
          `  [gc:${entry.outcome}] ${entry.vaultName}: ${entry.path}${entry.reason ? ` (${entry.reason})` : ""}`,
        );
      }
    });
}

function parseRetention(value: string): number | "never" {
  if (value === "never") return value;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error("--retention must be a non-negative integer or 'never'.");
  }
  return days;
}
