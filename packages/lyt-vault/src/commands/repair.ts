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
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { closeRegistry, openRegistry } from "../registry/client.js";
import {
  GitHistoryEmptyError,
  OrphanReattachMeshNotFoundError,
  OrphanReattachMissingArgError,
  repairFlow,
  RepairTargetNotFoundError,
  RestoreParseFailedError,
  type RepairAction,
  type RepairFinding,
  type RepairMode,
  type RepairResult,
} from "../flows/repair.js";
import { enumerateMeshYonRevisions, readMeshYonAtRevision } from "../util/git-history.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import { withSpinner } from "../util/spinner.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import {
  inspectPodRepair,
  type PodRepairInspectionResult,
} from "../flows/federation/pod-repair.js";
import {
  applyPodRepairPreserveBoth,
  planPodRepairPreserveBoth,
  findPendingPodRepairReceiptAttempts,
  findRecoverablePodRepairReceiptAttempts,
  findPendingPodRepairJournalIdentities,
  type PodRepairApplyResult,
  type PendingPodRepairReceiptAttempt,
  type RecoverablePodRepairReceiptAttempt,
  type PendingPodRepairJournalIdentity,
  type PodRepairLogicalPlan,
} from "../flows/federation/pod-repair-apply.js";
import type { LocalPodGitStateObservation } from "../flows/federation/pod-git-state.js";
import { parseReceiptV1ForEmission, type ReceiptV1 } from "../op/receipt-v1.js";
import {
  openReceiptAttemptForReplayPlan,
  supersedeReceiptAttempt,
  type OpenReceiptAttemptResult,
} from "../op/receipt-attempt.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import { validateVaultName } from "../util/identity.js";
import {
  applyEditorLocalizationPlanV1,
  prepareEditorLocalizationPlanV1,
  readEditorLocalizationPlanFileV1,
  readEditorLocalizationMachineEvidenceFilesV1,
  type ApplyEditorLocalizationArgs,
  type PrepareEditorLocalizationArgs,
} from "../flows/editor-localization.js";

// v1.C.4 — `lyt repair` top-level meta-CLI verb. Mirrors `lyt discover`
// attach pattern from v1.C.3.
//
// Default mode is `--dry-run` per the ratified default (safer for a write verb). The user
// explicitly opts into `--apply`.
//
// Under TTY with a mesh-yon-parse-error target + no `--from-revision`,
// the command surfaces the candidate revisions via readline/promises and
// asks the user to pick one (federation-design §11:521 "offer to
// restore"). Under `--json` or non-TTY the flow auto-picks the most
// recent revision that parses cleanly.
//
// Exit-code mapping (per the ratified default):
// 0 repair ran cleanly (no findings OR all repaired)
// 1 vault-not-found / mesh-not-found / git-history-empty /
// parse-still-fails-after-restore / orphan-reattach-mesh-not-found
// 2 partial-repair-warnings (--apply with mixed success) OR dry-run
// surfaced findings
// 3 non-TTY under interactive default OR --apply without --target when
// registry has > 5 findings (safety)

interface RepairCliOpts {
  pod?: boolean;
  target?: string;
  mesh?: string;
  dryRun?: boolean;
  apply?: boolean;
  fromRevision?: string;
  strategy?: string;
  planOut?: string;
  plan?: string;
  planDigest?: string;
  declaredMachine?: string[];
  machineReceipt?: string[];
  json?: boolean;
}

export interface RepairCommandDependencies {
  inspectPod?: () => Promise<PodRepairInspectionResult>;
  applyPod?: typeof applyPodRepairPreserveBoth;
  planPod?: () => Promise<PodRepairLogicalPlan>;
  openReceiptAttempt?: (receipt: ReceiptV1) => Promise<OpenReceiptAttemptResult>;
  supersedeReceiptAttempt?: (
    interrupted: ReceiptV1,
    fresh: ReceiptV1,
  ) => Promise<OpenReceiptAttemptResult>;
  findPendingPodReceiptAttempts?: () => Promise<readonly PendingPodRepairReceiptAttempt[]>;
  findRecoverablePodReceiptAttempts?: () => Promise<readonly RecoverablePodRepairReceiptAttempt[]>;
  findPendingPodJournalIdentities?: (
    operationIds: readonly string[],
  ) => Promise<readonly PendingPodRepairJournalIdentity[]>;
  repairLegacy?: typeof repairFlow;
  now?: () => Date;
  newId?: () => string;
  prepareEditorLocalization?: typeof prepareEditorLocalizationPlanV1;
  applyEditorLocalization?: typeof applyEditorLocalizationPlanV1;
  editorLocalizationMachineEvidence?: () => Pick<
    PrepareEditorLocalizationArgs,
    "declared_machines" | "machine_receipts"
  >;
}

const BATCH_FINDING_THRESHOLD = 5;

export function buildRepairCommand(dependencies: RepairCommandDependencies = {}): Command {
  return new Command("repair")
    .description(
      "Repair broken mesh.yon references / orphan vaults / unparseable mesh.yon. Default mode is --dry-run; pass --apply to perform writes. This is the write-side companion to `lyt mesh validate`.",
    )
    .option(
      "--pod",
      "Inspect the flat pod repository (default dry-run), or select it for explicit preserve-both --apply",
    )
    .option(
      "--target <rid|name>",
      "Restrict the repair to a single finding (vault rid hex OR vault name OR mesh name)",
    )
    .option(
      "--mesh <name>",
      "Target mesh for orphan-vault re-attachment (required with --apply for class 'orphan-vault')",
    )
    .option("--dry-run", "Report findings + actions without mutating disk or registry (default)")
    .option("--apply", "Perform the writes (mutually exclusive with --dry-run)")
    .option(
      "--from-revision <sha>",
      "Force a specific git revision for restore-from-Git (mesh-yon-parse-error class only)",
    )
    .option("--strategy <name>", "Pod repair apply strategy (supported: preserve-both)")
    .option("--plan-out <path>", "Write an editor-localization dry-run plan to this path")
    .option("--plan <path>", "Read the exact editor-localization apply plan from this path")
    .option("--plan-digest <sha256>", "Require this exact editor-localization plan digest")
    .option(
      "--declared-machine <id>",
      "Declare one machine in the Handler-defined editor-localization roster (repeatable)",
      collectRepeatableString,
      [],
    )
    .option(
      "--machine-receipt <file>",
      "Read one strict receipt for a declared machine; omitted receipts stay unavailable (repeatable)",
      collectRepeatableString,
      [],
    )
    .option("--json", "Emit deterministic JSON instead of human-readable output")
    .action(async (opts: RepairCliOpts) => {
      const json = opts.json === true;
      const apply = opts.apply === true;
      const dryRun = opts.dryRun === true;

      const editorTarget = exactEditorLocalizationTarget(opts.target);
      if (editorLocalizationIntent(opts) && editorTarget === null) {
        emitEditorLocalizationCliError(
          "editor-localization-target-required",
          "Editor-localization options require one exact qualified vault target.",
          editorLocalizationPrepareSyntax(),
        );
        return;
      }
      if (editorTarget !== null) {
        await runEditorLocalizationRepair(opts, dependencies);
        return;
      }

      if (opts.pod === true) {
        const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
        const finishedAt = () => (dependencies.now ?? (() => new Date()))().toISOString();
        const newId = dependencies.newId ?? (() => uuid7BytesToDashedString(newUuidv7Bytes()));
        let ids: { operationId: string; attemptId: string } | undefined;
        const conflict = podFlagConflict(opts);
        if (conflict !== null) {
          ids = { operationId: newId(), attemptId: newId() };
          const receipt = makePodRepairReceipt({
            ...ids,
            startedAt,
            finishedAt: finishedAt(),
            refusal: conflict,
          });
          emitPodRepairReceipt(receipt, json);
          process.exitCode = receipt.exit_code;
          return;
        }
        try {
          if (apply) {
            const pending = await (
              dependencies.findPendingPodReceiptAttempts ?? findPendingPodRepairReceiptAttempts
            )();
            const recoverable = await (
              dependencies.findRecoverablePodReceiptAttempts ??
              findRecoverablePodRepairReceiptAttempts
            )();
            const candidateOperationIds = [
              ...new Set([
                ...pending.map((attempt) => attempt.operation_id),
                ...recoverable.map((attempt) => attempt.operationId),
              ]),
            ];
            const observedJournals = await (
              dependencies.findPendingPodJournalIdentities ?? findPendingPodRepairJournalIdentities
            )(candidateOperationIds);
            const pendingJournals = observedJournals.filter(
              (journal) =>
                journal.phase !== "verified" ||
                pending.some((attempt) => attempt.operation_id === journal.operation_id),
            );
            const recoverableIncomplete = pendingJournals.filter(
              (journal) =>
                journal.phase !== "verified" &&
                recoverable.some((attempt) => attempt.operationId === journal.operation_id),
            );
            if (
              pending.length > 1 ||
              pendingJournals.length > 1 ||
              recoverableIncomplete.length > 1
            ) {
              ids = { operationId: newId(), attemptId: newId() };
              const receipt = makePodRepairMultiplePendingReceipt({
                ...ids,
                startedAt,
                finishedAt: finishedAt(),
              });
              emitPodRepairReceipt(receipt, json);
              process.exitCode = receipt.exit_code;
              return;
            }
            const resumed = pending[0];
            const journalIdentity = pendingJournals[0];
            const terminalResume =
              journalIdentity !== undefined &&
              recoverableIncomplete.some(
                (entry) => entry.operation_id === journalIdentity.operation_id,
              );
            if (
              resumed !== undefined &&
              journalIdentity !== undefined &&
              resumed.operation_id !== journalIdentity.operation_id
            ) {
              ids = { operationId: newId(), attemptId: newId() };
              const receipt = makePodRepairMultiplePendingReceipt({
                ...ids,
                startedAt,
                finishedAt: finishedAt(),
              });
              emitPodRepairReceipt(receipt, json);
              process.exitCode = receipt.exit_code;
              return;
            }
            const replayDigest =
              journalIdentity?.replay_digest ??
              (await (dependencies.planPod ?? planPodRepairPreserveBoth)()).replay_digest;
            ids = {
              operationId: resumed?.operation_id ?? journalIdentity?.operation_id ?? newId(),
              attemptId: newId(),
            };
            const freshAttempt = makePodRepairAttemptPlaceholder({
              ...ids,
              startedAt,
              replayDisposition: resumed === undefined && !terminalResume ? "new" : "resumed",
              replayDigest,
            });
            const opened =
              resumed === undefined
                ? await (dependencies.openReceiptAttempt ?? openReceiptAttemptForReplayPlan)(
                    freshAttempt,
                  )
                : await (dependencies.supersedeReceiptAttempt ?? supersedeReceiptAttempt)(
                    makePodRepairSupersededReceipt({
                      operationId: resumed.operation_id,
                      attemptId: resumed.attempt_id,
                      startedAt: resumed.started_at,
                      finishedAt: finishedAt(),
                      replayDisposition:
                        journalIdentity?.attempt_id === resumed.attempt_id ? "new" : "resumed",
                      localMutations: journalIdentity?.local_mutations ?? 0,
                      remoteMutations: journalIdentity?.remote_mutations ?? 0,
                      replayDigest,
                    }),
                    freshAttempt,
                  );
            if (opened.kind === "unavailable") {
              const receipt = makePodRepairReceiptStoreUnavailable({
                ...ids,
                startedAt,
                finishedAt: finishedAt(),
                replayDigest,
              });
              emitPodRepairReceipt(receipt, json);
              process.exitCode = receipt.exit_code;
              return;
            }
            try {
              const adopted = opened.session.operationId !== ids.operationId;
              const priorCompleted =
                opened.session.priorTerminalStatus === "success" ||
                opened.session.priorTerminalStatus === "no-op" ||
                opened.session.priorTerminalStatus === "replayed";
              ids = { ...ids, operationId: opened.session.operationId };
              let result: PodRepairApplyResult;
              try {
                result = await (dependencies.applyPod ?? applyPodRepairPreserveBoth)({
                  attempt_id: ids.attemptId,
                  operation_id: ids.operationId,
                  replay_digest: replayDigest,
                });
              } catch (error) {
                result = failedPodRepairApplyResult(error);
              }
              const verifiedWithoutMutation =
                (result.status === "no-op" &&
                  result.local_mutations === 0 &&
                  result.remote_mutations === 0) ||
                (result.status === "success" && result.resumed_from_phase === "verified");
              const replayDisposition =
                adopted && priorCompleted && verifiedWithoutMutation
                  ? "replayed"
                  : resumed !== undefined || terminalResume || adopted
                    ? "resumed"
                    : "new";
              const receipt = makePodRepairApplyReceipt({
                ...ids,
                startedAt,
                finishedAt: finishedAt(),
                result,
                replayDigest,
                replayDisposition,
              });
              const warnings = await opened.session.finalize(receipt);
              for (const warning of warnings) {
                // eslint-disable-next-line no-console
                console.error(`lyt repair warning: ${warning}`);
              }
              emitPodRepairApplyReceipt(receipt, json, result);
              process.exitCode = receipt.exit_code;
              return;
            } finally {
              const closeWarnings = (await opened.session.close?.()) ?? [];
              for (const warning of closeWarnings) {
                // eslint-disable-next-line no-console
                console.error(`lyt repair warning: ${warning}`);
              }
            }
          }
          ids = { operationId: newId(), attemptId: newId() };
          const result = await (dependencies.inspectPod ?? inspectPodRepair)();
          const receipt = makePodRepairReceipt({
            ...ids,
            startedAt,
            finishedAt: finishedAt(),
            result,
          });
          emitPodRepairReceipt(receipt, json, result);
          process.exitCode = receipt.exit_code;
        } catch {
          ids ??= { operationId: newId(), attemptId: newId() };
          const receipt = makePodRepairReceipt({
            ...ids,
            startedAt,
            finishedAt: finishedAt(),
            failure: true,
          });
          emitPodRepairReceipt(receipt, json);
          process.exitCode = receipt.exit_code;
        }
        return;
      }

      if (opts.strategy !== undefined) {
        emitError(json, {
          error: "flag-combo-invalid",
          message: "lyt repair: --strategy is reserved for pod repair and is not available yet.",
        });
        process.exitCode = 1;
        return;
      }

      if (apply && dryRun) {
        emitError(json, {
          error: "flag-combo-invalid",
          message: "lyt repair: --apply and --dry-run are mutually exclusive. Pass at most one.",
        });
        process.exitCode = 1;
        return;
      }
      const mode: RepairMode = apply ? "apply" : "dry-run";

      try {
        // For the interactive restore-from-Git picker we need a pre-flight
        // probe: did the user target a mesh-yon-parse-error finding, are
        // we under TTY, and did they omit --from-revision?
        let chosenRevision = opts.fromRevision;
        if (
          apply &&
          opts.target !== undefined &&
          opts.fromRevision === undefined &&
          !json &&
          process.stdin.isTTY === true
        ) {
          const picked = await maybePickRevisionInteractive(opts.target);
          if (picked !== null) {
            chosenRevision = picked;
          }
        }

        // safety: --apply without --target at > 5 findings is
        // refused unless the user picked a single target. We probe with
        // a dry-run first to count findings.
        if (apply && opts.target === undefined) {
          const probeDb = await openRegistry();
          let probe: RepairResult;
          try {
            probe = await (dependencies.repairLegacy ?? repairFlow)({
              ...(opts.target !== undefined ? { target: opts.target } : {}),
              ...(opts.mesh !== undefined ? { mesh: opts.mesh } : {}),
              mode: "dry-run",
              registryDb: probeDb,
            });
          } finally {
            await closeRegistry(probeDb);
          }
          if (probe.findings.length > BATCH_FINDING_THRESHOLD) {
            emitError(json, {
              error: "batch-confirm-required",
              message: `lyt repair --apply without --target refuses to repair ${probe.findings.length} findings in bulk (> ${BATCH_FINDING_THRESHOLD}). Run lyt repair --json to list them, then pass --target <id> per finding.`,
              findings_count: probe.findings.length,
            });
            process.exitCode = 3;
            return;
          }
        }

        const repairArgs = {
          ...(opts.target !== undefined ? { target: opts.target } : {}),
          ...(opts.mesh !== undefined ? { mesh: opts.mesh } : {}),
          mode,
          ...(chosenRevision !== undefined ? { fromRevision: chosenRevision } : {}),
        };
        // V-DX-1 — liveness spinner over the registry-open + reconcile window.
        // --json stays spinner-free; non-TTY prints "Repairing…" once. The
        // interactive revision picker + apply-batch probe above are left
        // un-wrapped (the picker is interactive; the probe is a fast count).
        const result = !json
          ? await withSpinner("", () => (dependencies.repairLegacy ?? repairFlow)(repairArgs), {
              op: "repair",
            })
          : await (dependencies.repairLegacy ?? repairFlow)(repairArgs);

        if (json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(toJsonShape(result), null, 2));
        } else {
          emitHumanSummary(result);
        }
        process.exitCode = result.exitCode;
      } catch (err) {
        const status = mapErrorToExitCode(err);
        if (status !== null) {
          emitError(json, errorToJsonBody(err));
          process.exitCode = status;
          return;
        }
        throw err;
      }
    });
}

const EDITOR_LOCALIZATION_TARGET_PREFIX = "editor-localization:";

async function runEditorLocalizationRepair(
  opts: RepairCliOpts,
  dependencies: RepairCommandDependencies,
): Promise<void> {
  const target = opts.target!.slice(EDITOR_LOCALIZATION_TARGET_PREFIX.length);
  if (
    target.length === 0 ||
    opts.json !== true ||
    opts.pod === true ||
    opts.mesh !== undefined ||
    opts.fromRevision !== undefined ||
    opts.strategy !== undefined
  ) {
    emitEditorLocalizationCliError(
      "editor-localization-flag-combo-invalid",
      "Editor localization requires a non-empty target, --json, and no pod/mesh/revision/strategy flags.",
    );
    return;
  }
  if (opts.apply === true && opts.dryRun === true) {
    emitEditorLocalizationCliError(
      "editor-localization-flag-combo-invalid",
      "Editor localization accepts exactly one of --dry-run or --apply.",
    );
    return;
  }
  let mode:
    | Readonly<{ kind: "prepare"; planOut: string }>
    | Readonly<{ kind: "apply"; plan: string; planDigest: string }>;
  if (opts.apply !== true) {
    if (
      opts.dryRun !== true ||
      opts.planOut === undefined ||
      opts.plan !== undefined ||
      opts.planDigest !== undefined
    ) {
      emitEditorLocalizationCliError(
        "editor-localization-flag-combo-invalid",
        "Dry-run requires --dry-run --plan-out <path> and refuses --plan/--plan-digest.",
      );
      return;
    }
    mode = { kind: "prepare", planOut: opts.planOut };
  } else {
    if (opts.plan === undefined || opts.planDigest === undefined || opts.planOut !== undefined) {
      emitEditorLocalizationCliError(
        "editor-localization-flag-combo-invalid",
        "Apply requires --apply --plan <path> --plan-digest <sha256> and refuses --plan-out.",
      );
      return;
    }
    mode = { kind: "apply", plan: opts.plan, planDigest: opts.planDigest };
  }
  let evidence: Pick<PrepareEditorLocalizationArgs, "declared_machines" | "machine_receipts">;
  try {
    evidence =
      dependencies.editorLocalizationMachineEvidence?.() ??
      readEditorLocalizationMachineEvidenceFilesV1(
        opts.declaredMachine ?? [],
        opts.machineReceipt ?? [],
      );
    if (evidence.declared_machines.length === 0) {
      throw new Error("at least one declared machine is required");
    }
  } catch {
    emitEditorLocalizationCliError(
      "editor-localization-machine-evidence-invalid",
      "Editor localization requires at least one unique --declared-machine <id>. Each repeatable --machine-receipt <file> must be a safe, bounded, strict V1 receipt for one declared machine.",
    );
    return;
  }
  if (mode.kind === "prepare") {
    try {
      const result = await (
        dependencies.prepareEditorLocalization ?? prepareEditorLocalizationPlanV1
      )({
        target,
        ...evidence,
        plan_path: mode.planOut,
      });
      if (result.kind !== "prepared") {
        if (result.receipt !== undefined) {
          console.log(JSON.stringify(result.receipt, null, 2));
          process.exitCode = result.receipt.exit_code;
        } else {
          emitEditorLocalizationCliError(
            "editor-localization-prepare-failed",
            "Editor-localization planning failed without changing the target.",
            editorLocalizationPrepareSyntax(target),
          );
        }
        return;
      }
      console.log(JSON.stringify(result.receipt, null, 2));
      process.exitCode = result.receipt.exit_code;
    } catch {
      emitEditorLocalizationCliError(
        "editor-localization-prepare-failed",
        "Editor-localization planning failed without changing the target.",
      );
    }
    return;
  }
  try {
    const plan = readEditorLocalizationPlanFileV1(mode.plan);
    if (plan.target.canonical_name !== target) {
      emitEditorLocalizationCliError(
        "editor-localization-target-mismatch",
        "The command target does not match the sealed plan target.",
      );
      return;
    }
    const applyArgs: ApplyEditorLocalizationArgs = {
      plan,
      plan_digest: mode.planDigest,
      ...evidence,
      handler_approval: { approved: true, plan_digest: mode.planDigest },
    };
    const receipt = await (dependencies.applyEditorLocalization ?? applyEditorLocalizationPlanV1)(
      applyArgs,
    );
    console.log(JSON.stringify(receipt, null, 2));
    process.exitCode = receipt.exit_code;
  } catch {
    emitEditorLocalizationCliError(
      "editor-localization-plan-invalid",
      "The plan file is missing, unsafe, oversized, malformed, or does not satisfy the exact V1 contract.",
    );
  }
}

function collectRepeatableString(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function emitEditorLocalizationCliError(code: string, summary: string, nextAction?: string): void {
  console.log(
    JSON.stringify(
      {
        operation: "editor-localization",
        status: "refused",
        error: { code, summary },
        next_action: nextAction ?? editorLocalizationPrepareSyntax(),
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
}

function exactEditorLocalizationTarget(value: string | undefined): string | null {
  if (value?.startsWith(EDITOR_LOCALIZATION_TARGET_PREFIX) !== true) return null;
  const target = value.slice(EDITOR_LOCALIZATION_TARGET_PREFIX.length);
  try {
    validateVaultName(target);
    return target.includes("/") ? target : null;
  } catch {
    return null;
  }
}

function editorLocalizationIntent(opts: RepairCliOpts): boolean {
  return (
    opts.target?.startsWith("editor-localization") === true ||
    opts.planOut !== undefined ||
    opts.plan !== undefined ||
    opts.planDigest !== undefined ||
    (opts.declaredMachine?.length ?? 0) > 0 ||
    (opts.machineReceipt?.length ?? 0) > 0
  );
}

function editorLocalizationPrepareSyntax(target = "<qualified-vault>"): string {
  return `lyt repair --target editor-localization:${target} --dry-run --plan-out <plan.json> --declared-machine <id> [--machine-receipt <file>] --json`;
}

interface PodFlagRefusal {
  code: "pod-repair-flag-combo-invalid";
  summary: string;
  next: { code: "correct-pod-repair-flags"; summary: string };
}

function podFlagConflict(opts: RepairCliOpts): PodFlagRefusal | null {
  const incompatible = [
    opts.target === undefined ? null : "--target",
    opts.mesh === undefined ? null : "--mesh",
    opts.fromRevision === undefined ? null : "--from-revision",
    opts.apply === true && opts.dryRun === true ? "--apply-with---dry-run" : null,
    opts.apply === true && opts.strategy !== "preserve-both"
      ? "--strategy preserve-both required"
      : null,
    opts.apply !== true && opts.strategy !== undefined ? "--strategy-without---apply" : null,
  ].filter((value): value is string => value !== null);
  if (incompatible.length === 0) return null;
  return {
    code: "pod-repair-flag-combo-invalid",
    summary: `Pod repair flags are invalid: ${incompatible.join(", ")}.`,
    next: {
      code: "correct-pod-repair-flags",
      summary:
        "Run `lyt repair --pod --dry-run`, or `lyt repair --pod --strategy preserve-both --apply`.",
    },
  };
}

function makePodRepairApplyReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  result: PodRepairApplyResult;
  replayDigest: string;
  replayDisposition: "new" | "resumed" | "replayed";
}): ReceiptV1 {
  const snapshot = args.result.snapshot;
  const replayed = args.replayDisposition === "replayed";
  const success = replayed || args.result.status === "success" || args.result.status === "no-op";
  const after: ReceiptV1["evidence"]["after"] = [];
  if (snapshot !== null) {
    after.push({
      kind: "pod-recovery-snapshot",
      subject: `${snapshot.ref} commit=${snapshot.commit_sha}`,
      digest: snapshot.manifest_sha256,
    });
  }
  if (args.result.target_commit !== null) {
    after.push({
      kind: "pod-repair-target",
      subject: `commit=${args.result.target_commit}`,
    });
  }
  if (
    args.result.retained_original_path !== null &&
    args.result.retained_original_identity !== null
  ) {
    const identity = args.result.retained_original_identity;
    after.push({
      kind: "pod-retained-original",
      subject:
        `path=${args.result.retained_original_path} head=${identity.head} ` +
        `tree=${identity.tree} dev=${identity.dev} ino=${identity.ino}`,
      digest: identity.content_sha256,
    });
  }
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "pod-repair",
    scope: { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: args.finishedAt },
    replay: {
      disposition: args.result.status === "refused" ? "rejected" : args.replayDisposition,
      key_digest: args.replayDigest,
    },
    status: replayed ? "replayed" : args.result.status,
    exit_code: replayed ? 0 : args.result.exit_code,
    mutations: replayed
      ? { local: 0, remote: 0 }
      : { local: args.result.local_mutations, remote: args.result.remote_mutations },
    evidence: { before: [], after },
    next_action: success
      ? null
      : {
          code: "inspect-pod-repair-state",
          summary:
            snapshot === null
              ? "Inspect the emitted pod repair evidence, then retry the supported `lyt repair --pod --strategy preserve-both --apply` action."
              : `Inspect recovery snapshot ${snapshot.ref} and the retained-original evidence, then retry the supported Lyt preserve-both action.`,
        },
    error:
      args.result.error_code === null
        ? null
        : {
            code: args.result.error_code,
            summary: args.result.summary,
            retryable: true,
          },
  });
}

function failedPodRepairApplyResult(error: unknown): PodRepairApplyResult {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "pod-repair-apply-threw";
  return Object.freeze({
    mode: "apply",
    status: "failed",
    exit_code: 1,
    repository_path: "",
    target_commit: null,
    snapshot: null,
    local_mutations: 0,
    remote_mutations: 0,
    replayed_transformations: 0,
    error_code: code,
    summary: "Pod repair failed before it returned observable mutation evidence.",
    attempt_id: null,
    phase: null,
    retained_original_path: null,
    retained_original_identity: null,
    replay_disposition: "new",
  });
}

function makePodRepairAttemptPlaceholder(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  replayDisposition: "new" | "resumed";
  replayDigest: string;
}): ReceiptV1 {
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "pod-repair",
    scope: { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: args.startedAt },
    replay: {
      disposition: args.replayDisposition,
      key_digest: args.replayDigest,
    },
    status: "no-op",
    exit_code: 0,
    mutations: { local: 0, remote: 0 },
    evidence: { before: [], after: [] },
    next_action: null,
    error: null,
  });
}

function makePodRepairSupersededReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  replayDisposition: "new" | "resumed";
  localMutations: number;
  remoteMutations: number;
  replayDigest: string;
}): ReceiptV1 {
  const partial = args.localMutations + args.remoteMutations > 0;
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "pod-repair",
    scope: { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: args.finishedAt },
    replay: {
      disposition: args.replayDisposition,
      key_digest: args.replayDigest,
    },
    status: partial ? "partial" : "failed",
    exit_code: partial ? 2 : 1,
    mutations: { local: args.localMutations, remote: args.remoteMutations },
    evidence: { before: [], after: [] },
    next_action: {
      code: "continue-pod-repair",
      summary: "A fresh resumed attempt now owns the same durable pod repair operation.",
    },
    error: {
      code: "pod-repair-attempt-superseded",
      summary: "This interrupted attempt was atomically superseded by a fresh resumed attempt.",
      retryable: true,
    },
  });
}

function makePodRepairReceiptStoreUnavailable(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  replayDigest: string;
}): ReceiptV1 {
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "pod-repair",
    scope: { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: args.finishedAt },
    replay: {
      disposition: "rejected",
      key_digest: args.replayDigest,
    },
    status: "refused",
    exit_code: 2,
    mutations: { local: 0, remote: 0 },
    evidence: { before: [], after: [] },
    next_action: {
      code: "retry-pod-repair",
      summary:
        "Resolve the local receipt-store problem, then retry the same supported Lyt repair command.",
    },
    error: {
      code: "receipt-store-unavailable",
      summary: "Pod repair did not start because its durable receipt attempt could not be opened.",
      retryable: true,
    },
  });
}

function makePodRepairMultiplePendingReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
}): ReceiptV1 {
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "pod-repair",
    scope: { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: args.finishedAt },
    replay: {
      disposition: "rejected",
      key_digest: digestJson({ operation: "pod-repair", strategy: "preserve-both" }),
    },
    status: "refused",
    exit_code: 2,
    mutations: { local: 0, remote: 0 },
    evidence: { before: [], after: [] },
    next_action: {
      code: "inspect-operation-receipts",
      summary:
        "Run `lyt receipt show <operation-id> --json` for each reported operation; preserve-both will not guess between multiple pending attempts.",
    },
    error: {
      code: "pod-repair-multiple-pending-attempts",
      summary: "Multiple pending pod repair attempts make recovery ambiguous.",
      retryable: true,
    },
  });
}

function makePodRepairReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  result?: PodRepairInspectionResult;
  refusal?: PodFlagRefusal;
  failure?: true;
}): ReceiptV1 {
  const tuple = args.result?.state;
  const decision = args.result?.decision;
  const refusal = args.refusal;
  const failed = args.failure === true;
  const isNoOp = decision?.action === "no-op";
  const status = isNoOp ? "no-op" : failed ? "failed" : "refused";
  const next = podReceiptNextAction(refusal, args.result, failed);
  const errorCode =
    refusal?.code ?? (failed ? "pod-repair-inspection-failed" : "pod-repair-required");
  const errorSummary =
    refusal?.summary ??
    (failed
      ? "Pod repair inspection failed before a trustworthy state could be reported."
      : `Pod repair inspection requires recovery (${decision?.reason ?? "inspection-incomplete"}).`);
  const before: ReceiptV1["evidence"]["before"] = [];
  if (tuple !== undefined && args.result !== undefined) {
    before.push(
      {
        kind: "pod-state",
        subject: stateSubject(tuple),
        digest: digestJson(tuple),
      },
      {
        kind: "pod-evidence",
        subject:
          `local=${localEvidenceState(args.result.evidence.local, decision?.reason)} ` +
          `recheck=${localEvidenceState(args.result.evidence.local_recheck)} ` +
          `remote=${args.result.evidence.remote?.check ?? "not-observed"} ` +
          `provenance=${args.result.evidence.provenance?.source ?? "not-observed"}`,
        count: args.result.evidence.provenance?.records_checked ?? 0,
      },
    );
  }
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "pod-repair",
    scope: { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: args.finishedAt },
    replay: {
      disposition: failed || isNoOp ? "new" : "rejected",
      key_digest: digestJson({
        operation: "pod-repair",
        state: tuple ?? null,
        refusal: refusal?.code,
      }),
    },
    status,
    exit_code: isNoOp ? 0 : 2,
    mutations: { local: 0, remote: 0 },
    evidence: { before, after: [] },
    next_action: isNoOp ? null : next,
    error: isNoOp ? null : { code: errorCode, summary: errorSummary, retryable: true },
  });
}

function podReceiptNextAction(
  refusal: PodFlagRefusal | undefined,
  result: PodRepairInspectionResult | undefined,
  failed: boolean,
): { code: string; summary: string } {
  if (refusal !== undefined) return refusal.next;
  if (result?.next_action !== null && result?.next_action !== undefined) {
    const command = result.next_action.command;
    return {
      code: result.next_action.code,
      summary:
        command === null
          ? result.next_action.summary
          : `${result.next_action.summary} Command: ${command}`,
    };
  }
  if (failed) {
    return {
      code: "inspect-local-pod-state",
      summary:
        "Verify that the local Lyt home and Git executable are readable, then run `lyt repair --pod --dry-run` once.",
    };
  }
  return {
    code: "preserve-both-pod-recovery",
    summary: "Wait for the supported preserve-both pod recovery strategy.",
  };
}

function localEvidenceState(
  observation: LocalPodGitStateObservation | null,
  decisionReason?: PodRepairInspectionResult["decision"]["reason"],
): string {
  if (decisionReason === "local-state-changed") return "state-changed";
  if (observation === null) return "not-observed";
  if (observation.repository === "missing") return "missing";
  if (observation.repository === "not-git-repo") return "not-git-repo";
  if (observation.repository === "unreadable") return "unreadable";
  if (
    observation.refusal_reason !== null ||
    observation.workspace === null ||
    observation.operation === null ||
    observation.graph === null ||
    observation.evidence.head_sha === null
  ) {
    return "incomplete";
  }
  return "present-complete";
}

function stateSubject(state: PodRepairInspectionResult["state"]): string {
  return (
    `repository=${state.repository} workspace=${observed(state.workspace)} ` +
    `operation=${observed(state.operation)} graph=${observed(state.graph)} ` +
    `remote=${observed(state.remote)} provenance=${observed(state.provenance)}`
  );
}

function observed(value: string | null): string {
  return value ?? "not-observed";
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emitPodRepairReceipt(
  receipt: ReceiptV1,
  json: boolean,
  result?: PodRepairInspectionResult,
): void {
  if (!json) {
    const action = result?.decision.action ?? "refused";
    // eslint-disable-next-line no-console
    console.error(`Pod repair dry-run: ${action}.`);
    if (result !== undefined) {
      // eslint-disable-next-line no-console
      console.error(`  ${stateSubject(result.state)}`);
      if (result.next_action !== null) {
        const command = result.next_action.command;
        // eslint-disable-next-line no-console
        console.error(
          `  Next: ${result.next_action.summary}${command === null ? "" : ` Command: ${command}`}`,
        );
      }
    }
  }
  // Receipt V1 is the only stdout object and is never persisted by inspection.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(receipt));
}

function emitPodRepairApplyReceipt(
  receipt: ReceiptV1,
  json: boolean,
  result: PodRepairApplyResult,
): void {
  if (!json) {
    // eslint-disable-next-line no-console
    console.error(`Pod repair preserve-both: ${result.status}.`);
    // eslint-disable-next-line no-console
    console.error(`  ${result.summary}`);
    if (result.snapshot !== null) {
      // eslint-disable-next-line no-console
      console.error(`  Recovery ref: ${result.snapshot.ref}`);
    }
    if (result.retained_original_path !== null && result.retained_original_identity !== null) {
      // eslint-disable-next-line no-console
      console.error(
        `  Retained original: ${result.retained_original_path} digest=${result.retained_original_identity.content_sha256}`,
      );
    }
  }
  // Receipt V1 is the only stdout object.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(receipt));
}

async function maybePickRevisionInteractive(target: string): Promise<string | null> {
  // Resolve the target to a mesh name (if --target is a mesh name).
  const db = await openRegistry();
  let meshYonPath: string | null = null;
  try {
    const mesh = await getMeshByName(db, target);
    if (mesh === null || mesh.mainVaultRid === null) return null;
    const mv = await getVaultByRid(db, mesh.mainVaultRid);
    if (mv === null) return null;
    meshYonPath = mv.path;
  } finally {
    await closeRegistry(db);
  }
  if (meshYonPath === null) return null;

  let shas: string[];
  try {
    shas = await enumerateMeshYonRevisions({ mainVaultPath: meshYonPath });
  } catch {
    return null;
  }
  if (shas.length === 0) return null;

  // Probe each candidate; surface up to the first 5 parseable ones.
  const candidates: { sha: string; ok: boolean }[] = [];
  for (const sha of shas.slice(0, 10)) {
    try {
      const content = await readMeshYonAtRevision({ mainVaultPath: meshYonPath, sha });
      try {
        parseMeshYon(content);
        candidates.push({ sha, ok: true });
      } catch {
        candidates.push({ sha, ok: false });
      }
    } catch {
      candidates.push({ sha, ok: false });
    }
    if (candidates.filter((c) => c.ok).length >= 5) break;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-console
    console.log(`\nmesh '${target}' mesh.yon candidate revisions (most recent first):`);
    let idx = 1;
    const parseable: string[] = [];
    for (const c of candidates) {
      const tag = c.ok ? "[ok ]" : "[bad]";
      // eslint-disable-next-line no-console
      console.log(`  ${idx}. ${tag} ${c.sha.slice(0, 7)}`);
      if (c.ok) parseable.push(c.sha);
      idx += 1;
    }
    if (parseable.length === 0) {
      // eslint-disable-next-line no-console
      console.log("No parseable revisions surfaced.");
      return null;
    }
    const ans = (
      await rl.question(
        `Pick revision number (1-${candidates.length}) or [a]uto-pick first parseable: `,
      )
    )
      .trim()
      .toLowerCase();
    if (ans === "" || ans === "a") return parseable[0] ?? null;
    const n = Number.parseInt(ans, 10);
    if (!Number.isFinite(n) || n < 1 || n > candidates.length) return null;
    const picked = candidates[n - 1];
    if (picked === undefined || !picked.ok) return null;
    return picked.sha;
  } finally {
    rl.close();
  }
}

// Exported for the release review F1 unit test (tests/flows/phase-d-agent-file-relocation.test.ts)
// — asserts a present `snapshot_note` (a non-git vault migrated without a recovery
// snapshot) surfaces in the human output, not just `details`. Test-only seam.
export function emitHumanSummary(r: RepairResult): void {
  // eslint-disable-next-line no-console
  console.log(
    `Repair ${r.mode}: ${r.summary.findingsCount} finding${r.summary.findingsCount === 1 ? "" : "s"}; ${r.summary.actionsApplied} applied; ${r.summary.actionsSkipped} skipped; ${r.summary.actionsErrored} errored.`,
  );
  for (const f of r.findings) {
    // eslint-disable-next-line no-console
    console.log(`  • [${f.class}] ${f.meshName} target=${f.targetId} — ${f.reason}`);
    // eslint-disable-next-line no-console
    console.log(`      → ${f.remediation}`);
  }
  for (const a of r.actions) {
    const marker = a.status === "applied" ? "✓" : a.status === "skipped" ? "~" : "✗";
    // eslint-disable-next-line no-console
    console.log(`  ${marker} ${a.kind} ${a.meshName} (${a.targetId}): ${a.message}`);
    // Release review F1 — a present snapshot_note (e.g. a non-git vault migrated
    // without a recovery snapshot) rides only in `details` and was invisible in
    // human output. Surface it on its own line so the reduced safety net is seen.
    const snapshotNote = a.details["snapshot_note"];
    if (typeof snapshotNote === "string" && snapshotNote.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`      ⚠ ${snapshotNote}`);
    }
  }
}

interface RepairJsonShape {
  mode: RepairMode;
  findings: ReturnType<typeof findingToJson>[];
  actions: ReturnType<typeof actionToJson>[];
  summary: RepairResult["summary"];
  exit_code: number;
  duration_ms: number;
}

function toJsonShape(r: RepairResult): RepairJsonShape {
  return {
    mode: r.mode,
    findings: r.findings.map(findingToJson),
    actions: r.actions.map(actionToJson),
    summary: r.summary,
    exit_code: r.exitCode,
    duration_ms: r.durationMs,
  };
}

function findingToJson(f: RepairFinding): Record<string, unknown> {
  return {
    class: f.class,
    mesh_name: f.meshName,
    target_id: f.targetId,
    reason: f.reason,
    remediation: f.remediation,
    details: f.details,
  };
}

function actionToJson(a: RepairAction): Record<string, unknown> {
  return {
    kind: a.kind,
    mesh_name: a.meshName,
    target_id: a.targetId,
    status: a.status,
    message: a.message,
    details: a.details,
  };
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof RepairTargetNotFoundError) return 1;
  if (err instanceof GitHistoryEmptyError) return 1;
  if (err instanceof RestoreParseFailedError) return 1;
  if (err instanceof OrphanReattachMeshNotFoundError) return 1;
  if (err instanceof OrphanReattachMissingArgError) return 1;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof RepairTargetNotFoundError) {
    return { error: err.errorCode, target: err.target, message: err.message };
  }
  if (err instanceof GitHistoryEmptyError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  if (err instanceof RestoreParseFailedError) {
    return {
      error: err.errorCode,
      mesh_name: err.meshName,
      sha: err.sha,
      parse_cause: err.parseCause,
      message: err.message,
    };
  }
  if (err instanceof OrphanReattachMeshNotFoundError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  if (err instanceof OrphanReattachMissingArgError) {
    return { error: err.errorCode, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt repair: ${String(body["message"] ?? body["error"])}`);
  }
}
