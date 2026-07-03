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

// `lyt vault backfill <name>` — Phase D (0.10.0 frontmatter-contract lane).
//
// The DEDICATED, purpose-named heal verb that runs the metadata-filler automator
// body against one vault: it walks every indexable figment, fills any MISSING
// mandatory frontmatter field with a deterministic default (dates from the file's
// REAL git-committer / fs-mtime date, NOT now; purpose/topic left BLANK + flagged;
// provenance-stamped src=automator:metadata-filler), and NEVER overwrites an
// existing value. Idempotent — a second run fills nothing.
//
// GIT POSTURE (release review / a review finding): a backfill WRITES to disk. By default
// it does NOT push (the automator commits LOCALLY only) — honoring this pod's
// push-gate discipline (a hygiene verb must never silently publish to origin).
// `--push` opts INTO the commit+push. `--dry-run` is a TRUE read-only preview: it
// reports which figments WOULD be filled and writes NOTHING (the previous mapping
// to the automator's `dryRun`, which still writes the body, was a foot-gun).
//
// WRITABLE-GATE GAP (release review, tracked follow-up #1): the underlying
// metadata-filler body has NO writable/subscriber gate — a whole-vault frontmatter
// write can land on a SUBSCRIBED / not-owned vault's local clone. This is a
// PRE-EXISTING Phase-C gap (see the WRITER note in lyt-vault util/indexable.ts), not
// introduced here; `--push` defaulting OFF caps the blast radius to the local clone.
// Wiring a `vault info` writable check into these verbs is the next follow-up.
//
// Lives in the meta @younndai/lyt CLI (not lyt-vault) because running an automator
// pulls in lyt-runner, which depends on lyt-vault — registering it inside lyt-vault
// would cycle. Attached to the lyt-vault-registered `vault` parent in cli.ts. C13:
// NOT `lyt repair` (repair stays registry/mesh-structure only, no content mutation).

import { Command } from "commander";

import { reconcileVaultScan } from "@younndai/lyt-vault";

import { runAutomator } from "../automator-run.js";

interface BackfillCliOpts {
  dryRun?: boolean;
  push?: boolean;
  json?: boolean;
}

interface MetadataFillerOutcomeShape {
  filesScanned: number;
  filesMutated: number;
  fieldsFilledTotal: number;
  filesWritten: string[];
}

// The metadata-filler body returns a MetadataFillerOutcome; runAutomator surfaces
// it as `result.body` (context.bodyResult, typed `unknown`). Narrow defensively so
// a body-shape drift degrades to zeros rather than throwing on the CLI surface.
function asOutcome(body: unknown): MetadataFillerOutcomeShape {
  const o = (body ?? {}) as Partial<MetadataFillerOutcomeShape>;
  return {
    filesScanned: typeof o.filesScanned === "number" ? o.filesScanned : 0,
    filesMutated: typeof o.filesMutated === "number" ? o.filesMutated : 0,
    fieldsFilledTotal: typeof o.fieldsFilledTotal === "number" ? o.fieldsFilledTotal : 0,
    filesWritten: Array.isArray(o.filesWritten) ? o.filesWritten : [],
  };
}

export function buildBackfillCommand(): Command {
  return new Command("backfill")
    .description(
      "Backfill missing frontmatter across a vault's figments (deterministic: real git/fs dates, purpose/topic left blank + flagged, provenance-stamped). Never overwrites existing values. Writes locally; use --push to also commit + push. NOT `lyt repair`.",
    )
    .argument("<name>", "Vault name to backfill (must be registered)")
    .option("--dry-run", "Preview which figments WOULD be filled — read-only, writes nothing")
    .option("--push", "Also git-commit + push the fills (default: write locally, run `lyt sync` to publish)")
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (name: string, opts: BackfillCliOpts) => {
      // --dry-run — TRUE read-only preview. Report what WOULD be filled (the
      // missing-frontmatter figments the scan finds); write nothing, run no automator.
      if (opts.dryRun === true) {
        let scan;
        try {
          scan = await reconcileVaultScan(name);
        } catch (err) {
          reportError(opts, name, err);
          process.exit(1);
        }
        const wouldFill = scan.missingFrontmatter;
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                dry_run: true,
                vault: { name: scan.vaultName, path: scan.vaultPath },
                scanned: scan.scanned,
                would_fill: wouldFill.length,
                figments: wouldFill,
              },
              null,
              2,
            ),
          );
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `backfill --dry-run ${scan.vaultName}: ${wouldFill.length}/${scan.scanned} figment(s) would be filled (nothing written).`,
          );
          for (const f of wouldFill.slice(0, 20)) {
            // eslint-disable-next-line no-console
            console.log(`  ${f.relPath} — missing: ${f.missing.join(", ")}`);
          }
          if (wouldFill.length > 20) {
            // eslint-disable-next-line no-console
            console.log(`  … and ${wouldFill.length - 20} more`);
          }
        }
        return;
      }

      // Real backfill. Default noPush (write + commit LOCALLY only); --push opts in.
      let result;
      try {
        result = await runAutomator({
          automator: "metadata-filler",
          vault: name,
          ...(opts.push !== true ? { noPush: true } : {}),
        });
      } catch (err) {
        reportError(opts, name, err);
        process.exit(1);
      }
      const outcome = asOutcome(result.body);

      const payload = {
        ok: result.ok,
        vault: { name: result.plan.vaultName, path: result.plan.vaultPath },
        automator_version: result.automatorVersion,
        status: result.status,
        error_summary: result.errorSummary,
        pushed: opts.push === true,
        files_scanned: outcome.filesScanned,
        files_mutated: outcome.filesMutated,
        fields_filled_total: outcome.fieldsFilledTotal,
        files_written: outcome.filesWritten,
      };

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `${result.ok ? "✓" : "✗"} backfill ${payload.vault.name}: ` +
            `${outcome.filesMutated}/${outcome.filesScanned} figment(s) filled ` +
            `(${outcome.fieldsFilledTotal} field(s))${opts.push === true ? " [pushed]" : " [local — run `lyt sync` to publish]"}` +
            `${payload.error_summary !== null ? ` — ${payload.error_summary}` : ""}`,
        );
        if (outcome.filesMutated === 0 && result.ok) {
          // eslint-disable-next-line no-console
          console.log("  all figments already carry contract-valid frontmatter (nothing to fill).");
        }
      }

      if (!result.ok) process.exit(1);
    });
}

function reportError(opts: BackfillCliOpts, name: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: false, vault: name, error: msg }, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`✗ backfill ${name}: ${msg}`);
  }
}
