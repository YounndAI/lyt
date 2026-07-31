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
  inventoryVaultFiles,
  reindexFlow,
  type VaultFileInventoryEntry,
  type VaultFilesInventory,
} from "@younndai/lyt-vault";

import { runAutomator } from "../automator-run.js";
import {
  createMutationPreview,
  prepareMutationApply,
  type MutationApplySession,
  type MutationPreviewReceipt,
} from "./mutation-preview-receipt.js";

interface ReconcileCliOpts {
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
  receipt?: string;
  path?: string;
  push?: boolean;
  json?: boolean;
}

interface MetadataFillerOutcomeShape {
  filesMutated: number;
  fieldsFilledTotal: number;
  filesWritten: string[];
}

function asOutcome(body: unknown): MetadataFillerOutcomeShape {
  const value = (body ?? {}) as Partial<MetadataFillerOutcomeShape>;
  return {
    filesMutated: typeof value.filesMutated === "number" ? value.filesMutated : 0,
    fieldsFilledTotal:
      typeof value.fieldsFilledTotal === "number" ? value.fieldsFilledTotal : 0,
    filesWritten: Array.isArray(value.filesWritten) ? value.filesWritten : [],
  };
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function emitPreviewCompatibilityWarnings(opts: ReconcileCliOpts): void {
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
    unindexed_count: receipt.plan.unindexedCount,
    reindex_required: receipt.plan.reindexRequired,
    reindex_scope: receipt.plan.reindexScope,
    candidates: receipt.plan.candidates,
  };
}

export function buildReconcileCommand(): Command {
  return new Command("reconcile")
    .description(
      "Preview disk/index and frontmatter reconciliation for one registered vault. Mutation requires --apply with the exact sealed --receipt; non-interactive apply also requires --yes.",
    )
    .argument("<name>", "Registered vault name to inspect or reconcile")
    .option("--path <subtree>", "Restrict frontmatter candidates to one vault-relative subtree")
    .option("--dry-run", "One-release compatibility alias for the default sealed preview")
    .option("--apply", "Apply the exact sealed preview")
    .option("--receipt <uuidv7>", "Exact preview receipt identifier required by --apply")
    .option("--yes", "Required confirmation for non-interactive --apply")
    .option("--push", "Bind the preview/apply to commit-and-push rather than local commit only")
    .option("--json", "Emit structured JSON")
    .action(async (name: string, opts: ReconcileCliOpts) => {
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
            operation: "reconcile",
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
          operation: "reconcile",
          vault: name,
          ...(opts.path !== undefined ? { subtree: opts.path } : {}),
          push: opts.push === true,
          receiptId: opts.receipt,
        });
        const plan = session.getReceipt().plan;
        let outcome: MetadataFillerOutcomeShape = {
          filesMutated: 0,
          fieldsFilledTotal: 0,
          filesWritten: [],
        };

        if (plan.candidateCount > 0) {
          const result = await runAutomator({
            automator: "metadata-filler",
            vault: session.inventory.vault.name,
            skipSync: true,
            ...(opts.push !== true ? { noPush: true } : {}),
            metadataFillerScope: {
              candidates: plan.candidates,
              validateBeforeMutation: session.revalidateBeforeMutation,
              onCandidateCompleted: session.markCandidateCompleted,
              missingOnly: true,
            },
          });
          if (!result.ok) {
            throw new Error(result.errorSummary ?? `metadata-filler ended in ${result.status}`);
          }
          outcome = asOutcome(result.body);
          if (outcome.filesMutated !== plan.candidateCount) {
            throw new Error(
              `sealed apply wrote ${outcome.filesMutated} candidate(s), expected ${plan.candidateCount}`,
            );
          }
          await assertPostBackfillProjection(session.inventory, name, opts.path);
        }

        if (plan.reindexRequired) {
          if (plan.candidateCount === 0) await session.revalidateBeforeMutation();
          session.markMutationStarted();
          await reindexFlow({ scope: "vault", target: session.inventory.vault.name });
        }

        const finalInventory = await inventoryVaultFiles(name, opts.path);
        const remainingCandidates = finalInventory.entries.filter(
          (entry) => entry.frontmatterMutationCandidate,
        );
        const remainingUnindexed = finalInventory.entries.filter(
          (entry) => entry.classification === "figment" && !entry.indexed,
        );
        const remainingRemovals = finalInventory.entries.filter((entry) => entry.pendingRemoval);
        if (
          remainingCandidates.length > 0 ||
          remainingUnindexed.length > 0 ||
          remainingRemovals.length > 0
        ) {
          throw new Error(
            "reconcile verification failed: " +
              `${remainingCandidates.length} frontmatter candidate(s), ` +
              `${remainingUnindexed.length} unindexed figment(s), ` +
              `${remainingRemovals.length} pending removal(s) remain`,
          );
        }
        session.complete();
        emitApplied(opts, session.getReceipt(), outcome, finalInventory);
      } catch (error) {
        if (session !== undefined) {
          try {
            session.fail(error);
          } catch {
            /* report the original product failure; doctor owns receipt-store diagnostics */
          }
        }
        reportError(opts, name, error);
      }
    });
}

function entryProjection(entry: VaultFileInventoryEntry): Record<string, unknown> {
  return {
    path: entry.path,
    classification: entry.classification,
    kind: entry.kind,
    contentSha256: entry.contentSha256,
    indexed: entry.indexed,
    denseIndexed: entry.denseIndexed,
    pendingRemoval: entry.pendingRemoval,
    missingFields: entry.missingFields,
  };
}

async function assertPostBackfillProjection(
  before: VaultFilesInventory,
  vaultName: string,
  subtree: string | undefined,
): Promise<void> {
  const after = await inventoryVaultFiles(vaultName, subtree);
  if (
    after.ignorePolicy.exists !== before.ignorePolicy.exists ||
    after.ignorePolicy.sha256 !== before.ignorePolicy.sha256 ||
    after.entries.length !== before.entries.length
  ) {
    throw new Error("vault or .lytignore changed during sealed backfill");
  }
  const candidates = new Set(
    before.entries
      .filter((entry) => entry.frontmatterMutationCandidate)
      .map((entry) => entry.path),
  );
  for (let index = 0; index < before.entries.length; index += 1) {
    const previous = before.entries[index]!;
    const current = after.entries[index]!;
    if (previous.path !== current.path) {
      throw new Error("vault file set changed during sealed backfill");
    }
    if (candidates.has(previous.path)) {
      if (
        current.classification !== "figment" ||
        current.frontmatterMutationCandidate ||
        current.missingFields.length > 0 ||
        current.indexed !== previous.indexed ||
        current.denseIndexed !== previous.denseIndexed
      ) {
        throw new Error(`sealed backfill produced an unexpected projection for ${previous.path}`);
      }
      continue;
    }
    if (JSON.stringify(entryProjection(previous)) !== JSON.stringify(entryProjection(current))) {
      throw new Error(`unplanned vault change detected during sealed backfill: ${previous.path}`);
    }
  }
}

function emitPreview(opts: ReconcileCliOpts, receipt: MutationPreviewReceipt): void {
  const payload = { ok: true, operation: "reconcile", applied: false, ...receiptSummary(receipt) };
  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `reconcile preview ${receipt.plan.vault.name} [${receipt.plan.scope}]: ` +
      `${receipt.plan.candidateCount} frontmatter candidate(s), ` +
      `${receipt.plan.unindexedCount} unindexed, ` +
      `${receipt.plan.pendingRemovalCount} pending removal(s), ` +
      `${receipt.plan.exclusionCount} excluded.`,
  );
  // eslint-disable-next-line no-console
  console.log(`  receipt: ${receipt.plan.id} (expires ${receipt.plan.expiresAt})`);
  if (receipt.plan.reindexRequired) {
    // eslint-disable-next-line no-console
    console.log(`  reindex: ${receipt.plan.reindexScope}-wide derived-cache rebuild`);
  }
  for (const candidate of receipt.plan.candidates.slice(0, 20)) {
    // eslint-disable-next-line no-console
    console.log(`  ${candidate.path} — add: ${candidate.plannedMutations.join(", ")}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `  apply: lyt vault reconcile '${receipt.plan.vault.name}' --apply --receipt ${receipt.plan.id}` +
      `${opts.push === true ? " --push" : ""}`,
  );
}

function emitApplied(
  opts: ReconcileCliOpts,
  receipt: MutationPreviewReceipt,
  outcome: MetadataFillerOutcomeShape,
  inventory: VaultFilesInventory,
): void {
  const payload = {
    ok: true,
    operation: "reconcile",
    applied: true,
    ...receiptSummary(receipt),
    files_mutated: outcome.filesMutated,
    fields_filled_total: outcome.fieldsFilledTotal,
    files_written: outcome.filesWritten,
    resulting_inventory_digest: inventory.inventoryDigest,
  };
  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `reconcile applied ${receipt.plan.vault.name} [${receipt.plan.scope}]: ` +
      `${outcome.filesMutated}/${receipt.plan.candidateCount} frontmatter candidate(s), ` +
      `index reconciled; receipt ${receipt.plan.id} completed.`,
  );
}

function reportError(opts: ReconcileCliOpts, name: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({ ok: false, operation: "reconcile", vault: name, error: message }, null, 2),
    );
  } else {
    // eslint-disable-next-line no-console
    console.error(`reconcile refused ${name}: ${message}`);
  }
}
