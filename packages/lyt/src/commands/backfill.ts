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

import { runAutomator } from "../automator-run.js";
import {
  createMutationPreview,
  prepareMutationApply,
  type MutationApplySession,
  type MutationPreviewReceipt,
} from "./mutation-preview-receipt.js";

interface BackfillCliOpts {
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
  receipt?: string;
  path?: string;
  push?: boolean;
  json?: boolean;
}

interface MetadataFillerOutcomeShape {
  filesScanned: number;
  filesMutated: number;
  fieldsFilledTotal: number;
  filesWritten: string[];
}

function asOutcome(body: unknown): MetadataFillerOutcomeShape {
  const value = (body ?? {}) as Partial<MetadataFillerOutcomeShape>;
  return {
    filesScanned: typeof value.filesScanned === "number" ? value.filesScanned : 0,
    filesMutated: typeof value.filesMutated === "number" ? value.filesMutated : 0,
    fieldsFilledTotal:
      typeof value.fieldsFilledTotal === "number" ? value.fieldsFilledTotal : 0,
    filesWritten: Array.isArray(value.filesWritten) ? value.filesWritten : [],
  };
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function emitPreviewCompatibilityWarnings(opts: BackfillCliOpts): void {
  if (opts.dryRun === true) {
    // eslint-disable-next-line no-console
    console.error("warning: --dry-run is deprecated; preview is now the default and remains read-only");
  }
  if (opts.push === true) {
    // eslint-disable-next-line no-console
    console.error("warning: preview only; --push binds the receipt but nothing changes until --apply");
  }
}

function receiptSummary(receipt: MutationPreviewReceipt): Record<string, unknown> {
  return {
    receipt_id: receipt.plan.id,
    lifecycle: receipt.lifecycle.state,
    created_at: receipt.plan.createdAt,
    expires_at: receipt.plan.expiresAt,
    vault: receipt.plan.vault,
    scope: receipt.plan.scope,
    push: receipt.plan.push,
    candidate_count: receipt.plan.candidateCount,
    exclusion_count: receipt.plan.exclusionCount,
    exclusion_counts: receipt.plan.exclusionCounts,
    pending_removal_count: receipt.plan.pendingRemovalCount,
    candidates: receipt.plan.candidates,
  };
}

export function buildBackfillCommand(): Command {
  return new Command("backfill")
    .description(
      "Preview missing-frontmatter additions for one registered vault. Mutation requires --apply with the exact sealed --receipt; non-interactive apply also requires --yes.",
    )
    .argument("<name>", "Registered vault name to inspect or backfill")
    .option("--path <subtree>", "Restrict preview/apply to one vault-relative subtree")
    .option("--dry-run", "One-release compatibility alias for the default sealed preview")
    .option("--apply", "Apply the exact sealed preview")
    .option("--receipt <uuidv7>", "Exact preview receipt identifier required by --apply")
    .option("--yes", "Required confirmation for non-interactive --apply")
    .option("--push", "Bind the preview/apply to commit-and-push rather than local commit only")
    .option("--json", "Emit structured JSON")
    .action(async (name: string, opts: BackfillCliOpts) => {
      if (opts.apply === true && opts.dryRun === true) {
        return reportError(opts, name, new Error("--apply and --dry-run are mutually exclusive"));
      }
      if (opts.apply !== true) {
        if (opts.receipt !== undefined) {
          return reportError(opts, name, new Error("--receipt is consumed only with --apply"));
        }
        try {
          emitPreviewCompatibilityWarnings(opts);
          const receipt = await createMutationPreview({
            operation: "backfill",
            vault: name,
            ...(opts.path !== undefined ? { subtree: opts.path } : {}),
            push: opts.push === true,
          });
          emitPreview(opts, receipt);
        } catch (error) {
          reportError(opts, name, error);
        }
        return;
      }

      if (opts.receipt === undefined) {
        return reportError(opts, name, new Error("--apply requires --receipt <uuidv7>"));
      }
      if (!isInteractive() && opts.yes !== true) {
        return reportError(opts, name, new Error("non-interactive --apply requires --yes"));
      }

      let session: MutationApplySession | undefined;
      try {
        session = await prepareMutationApply({
          operation: "backfill",
          vault: name,
          ...(opts.path !== undefined ? { subtree: opts.path } : {}),
          push: opts.push === true,
          receiptId: opts.receipt,
        });
        if (session.getReceipt().plan.candidateCount > 0) session.markMutationStarted();
        const result = await runAutomator({
          automator: "metadata-filler",
          vault: session.inventory.vault.name,
          skipSync: true,
          ...(opts.push !== true ? { noPush: true } : {}),
          metadataFillerScope: {
            candidates: session.getReceipt().plan.candidates,
            validateBeforeMutation: session.revalidateBeforeMutation,
            onCandidateCompleted: session.markCandidateCompleted,
            missingOnly: true,
          },
        });
        if (!result.ok) {
          throw new Error(result.errorSummary ?? `metadata-filler ended in ${result.status}`);
        }
        const outcome = asOutcome(result.body);
        if (outcome.filesMutated !== session.getReceipt().plan.candidateCount) {
          throw new Error(
            `sealed apply wrote ${outcome.filesMutated} candidate(s), expected ${session.getReceipt().plan.candidateCount}`,
          );
        }
        session.complete();
        emitApplied(opts, session.getReceipt(), outcome);
      } catch (error) {
        if (session !== undefined) {
          try {
            session.fail(error);
          } catch {
            /* report the original product failure; receipt persistence is checked by doctor */
          }
        }
        reportError(opts, name, error);
      }
    });
}

function emitPreview(opts: BackfillCliOpts, receipt: MutationPreviewReceipt): void {
  const payload = { ok: true, operation: "backfill", applied: false, ...receiptSummary(receipt) };
  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `backfill preview ${receipt.plan.vault.name} [${receipt.plan.scope}]: ` +
      `${receipt.plan.candidateCount} candidate(s), ${receipt.plan.exclusionCount} excluded.`,
  );
  // eslint-disable-next-line no-console
  console.log(`  receipt: ${receipt.plan.id} (expires ${receipt.plan.expiresAt})`);
  for (const candidate of receipt.plan.candidates.slice(0, 20)) {
    // eslint-disable-next-line no-console
    console.log(`  ${candidate.path} — add: ${candidate.plannedMutations.join(", ")}`);
  }
  if (receipt.plan.candidates.length > 20) {
    // eslint-disable-next-line no-console
    console.log(`  … and ${receipt.plan.candidates.length - 20} more`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `  apply: lyt vault backfill '${receipt.plan.vault.name}' --apply --receipt ${receipt.plan.id}` +
      `${opts.push === true ? " --push" : ""}`,
  );
}

function emitApplied(
  opts: BackfillCliOpts,
  receipt: MutationPreviewReceipt,
  outcome: MetadataFillerOutcomeShape,
): void {
  const payload = {
    ok: true,
    operation: "backfill",
    applied: true,
    ...receiptSummary(receipt),
    files_mutated: outcome.filesMutated,
    fields_filled_total: outcome.fieldsFilledTotal,
    files_written: outcome.filesWritten,
  };
  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `backfill applied ${receipt.plan.vault.name} [${receipt.plan.scope}]: ` +
      `${outcome.filesMutated}/${receipt.plan.candidateCount} candidate(s), ` +
      `${outcome.fieldsFilledTotal} field(s); receipt ${receipt.plan.id} completed.`,
  );
}

function reportError(opts: BackfillCliOpts, name: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: false, operation: "backfill", vault: name, error: message }, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`backfill refused ${name}: ${message}`);
  }
}
