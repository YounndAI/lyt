/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { relative } from "node:path";

import { getFederationRoot } from "../../util/federation-paths.js";
import { runGitReadOnly, runGitReadOnlyRaw } from "../../util/git-run.js";
import { observeLocalPodGitState, type LocalPodGitStateObservation } from "./pod-git-state.js";
import { observePodRemoteState, type PodRemoteStateObservation } from "./pod-remote-state.js";
import { readAuthenticatedPodTransformationEvidence } from "./pod-transformation-proof-ledger.js";
import {
  classifyReceiptBoundPodProvenance,
  type PodTransformationProofV1,
} from "./pod-transformation-proof.js";
import {
  derivePodReconciliationAction,
  POD_RECONCILIATION_REPAIR_COMMAND,
  type PodGraphState,
  type PodOperationState,
  type PodProvenanceState,
  type PodReconciliationReason,
  type PodRemoteState,
  type PodRepositoryState,
  type PodWorkspaceState,
} from "./pod-reconciliation.js";

export const POD_PRESERVE_BOTH_APPLY_COMMAND =
  "lyt repair --pod --strategy preserve-both --apply" as const;
export const POD_REPAIR_APPLY_PRECONDITION =
  "Before any mutation, re-observe and revalidate the complete local, remote, and provenance tuple." as const;

export interface PodRepairProvenanceObservation {
  readonly provenance: PodProvenanceState;
  readonly source: "receipt-evidence" | "deterministic-legacy-evidence" | "absent";
  readonly records_checked: number;
  readonly transformations?: readonly PodRepairProvenTransformation[];
}

export interface PodRepairProvenTransformation {
  readonly proof_digest: string;
  readonly proof: PodTransformationProofV1;
}

export interface PodRepairInspectionDependencies {
  readonly resolvePodRepositoryPath?: () => string;
  readonly observeLocal?: (repositoryPath: string) => Promise<LocalPodGitStateObservation>;
  readonly observeRemote?: (args: {
    repository_path: string;
    local: LocalPodGitStateObservation;
  }) => Promise<PodRemoteStateObservation>;
  readonly observeProvenance?: (args: {
    repository_path: string;
    local: LocalPodGitStateObservation;
    remote: PodRemoteStateObservation;
  }) => Promise<PodRepairProvenanceObservation>;
}

export interface PodRepairObservedState {
  readonly repository: PodRepositoryState;
  readonly workspace: PodWorkspaceState | null;
  readonly operation: PodOperationState | null;
  readonly graph: PodGraphState | null;
  readonly remote: PodRemoteState | null;
  readonly provenance: PodProvenanceState | null;
}

export interface PodRepairNextAction {
  readonly code:
    | "initialize-or-adopt-pod"
    | "restore-pod-connectivity"
    | "inspect-local-pod-state"
    | "stabilize-local-pod-state"
    | "preserve-dirty-pod-state"
    | "finish-existing-git-operation"
    | "restore-pod-upstream"
    | "restore-supported-pod-branch"
    | "preserve-ahead-pod-state"
    | "converge-behind-pod-state"
    | "preserve-diverged-pod-state"
    | "restore-deleted-pod-remote"
    | "preserve-ambiguous-provenance";
  readonly command: string | null;
  readonly available: boolean;
  readonly summary: string;
}

export type PodRepairDecision =
  | { readonly action: "no-op"; readonly reason: null }
  | { readonly action: "auto-converge"; readonly reason: null }
  | { readonly action: "repair-required"; readonly reason: PodReconciliationReason };

export interface PodRepairInspectionResult {
  readonly mode: "dry-run";
  readonly repository_path: string;
  readonly state: PodRepairObservedState;
  readonly decision: PodRepairDecision;
  readonly evidence: {
    readonly local: LocalPodGitStateObservation;
    readonly local_recheck: LocalPodGitStateObservation | null;
    readonly remote: PodRemoteStateObservation | null;
    readonly provenance: PodRepairProvenanceObservation | null;
  };
  readonly next_action: PodRepairNextAction | null;
  readonly apply_precondition: typeof POD_REPAIR_APPLY_PRECONDITION;
  readonly exit_code: 0 | 2;
}

const unavailableRemote: PodRemoteStateObservation = {
  remote: "unreachable-or-unknown",
  check: "incomplete",
  graph: null,
  evidence: {
    remote_name: null,
    advertised_ref: null,
    local_tracking_ref: null,
    local_tracking_sha: null,
    advertised_sha: null,
    graph_source: null,
    ahead: null,
    behind: null,
    diagnostic_kind: "invalid-input",
    diagnostic: "local pod state does not permit a remote observation",
  },
};

/** Physically read-only inspection of the one flat pod repository. */
export async function inspectPodRepair(
  dependencies: PodRepairInspectionDependencies = {},
): Promise<PodRepairInspectionResult> {
  const repositoryPath = (dependencies.resolvePodRepositoryPath ?? getFederationRoot)();
  const observeLocal = dependencies.observeLocal ?? observeLocalPodGitState;
  const local = await observeLocal(repositoryPath);
  if (!isCompleteLocalObservation(local, repositoryPath)) {
    const reason: PodReconciliationReason =
      local.repository === "present"
        ? "local-observation-incomplete"
        : `repository-${local.repository}`;
    return resultFor({ repositoryPath, local, reason });
  }

  if (
    local.workspace === "clean" &&
    local.operation === "normal" &&
    (local.graph === "no-upstream" || local.graph === "detached-HEAD")
  ) {
    const localRecheck = await observeLocal(repositoryPath);
    if (
      !isCompleteLocalObservation(localRecheck, repositoryPath) ||
      !sameLocalObservation(local, localRecheck)
    ) {
      return resultFor({
        repositoryPath,
        local,
        localRecheck,
        reason: "local-state-changed",
      });
    }
    return resultFor({
      repositoryPath,
      local,
      localRecheck,
      reason: `graph-${local.graph}`,
    });
  }

  const canObserveRemote =
    local.evidence.branch_ref !== null && local.evidence.upstream_ref !== null;
  const remote = canObserveRemote
    ? await (dependencies.observeRemote ?? observePodRemoteState)({
        repository_path: repositoryPath,
        local,
      })
    : unavailableRemote;
  const provenance = await (dependencies.observeProvenance ?? observeProductionProof)({
    repository_path: repositoryPath,
    local,
    remote,
  });
  const localRecheck = await observeLocal(repositoryPath);
  if (
    !isCompleteLocalObservation(localRecheck, repositoryPath) ||
    !sameLocalObservation(local, localRecheck)
  ) {
    return resultFor({
      repositoryPath,
      local,
      localRecheck,
      remote,
      provenance,
      reason: "local-state-changed",
    });
  }

  const state: PodRepairObservedState = {
    repository: local.repository,
    workspace: local.workspace,
    operation: local.operation,
    graph: remote.check === "complete" && remote.graph !== null ? remote.graph : local.graph,
    remote: remote.remote,
    provenance: provenance.provenance,
  };
  const policyDecision = derivePodReconciliationAction({
    repository: local.repository,
    workspace: local.workspace,
    operation: local.operation,
    graph: remote.check === "complete" && remote.graph !== null ? remote.graph : local.graph,
    remote: remote.remote,
    provenance: provenance.provenance,
  });
  const decision: PodRepairDecision =
    policyDecision.action === "repair-required"
      ? { action: "repair-required", reason: policyDecision.reason }
      : { action: policyDecision.action, reason: null };
  return finish(repositoryPath, state, decision, local, localRecheck, remote, provenance);
}

function resultFor(args: {
  repositoryPath: string;
  local: LocalPodGitStateObservation;
  localRecheck?: LocalPodGitStateObservation;
  remote?: PodRemoteStateObservation;
  provenance?: PodRepairProvenanceObservation;
  reason: PodReconciliationReason;
}): PodRepairInspectionResult {
  const state: PodRepairObservedState = {
    repository: args.local.repository,
    workspace: args.local.workspace,
    operation: args.local.operation,
    graph: args.local.graph,
    remote: args.remote?.remote ?? null,
    provenance: args.provenance?.provenance ?? null,
  };
  const decision: PodRepairDecision = {
    action: "repair-required",
    reason: args.reason,
  };
  return finish(
    args.repositoryPath,
    state,
    decision,
    args.local,
    args.localRecheck ?? null,
    args.remote ?? null,
    args.provenance ?? null,
  );
}

function finish(
  repositoryPath: string,
  state: PodRepairObservedState,
  decision: PodRepairDecision,
  local: LocalPodGitStateObservation,
  localRecheck: LocalPodGitStateObservation | null,
  remote: PodRemoteStateObservation | null,
  provenance: PodRepairProvenanceObservation | null,
): PodRepairInspectionResult {
  return {
    mode: "dry-run",
    repository_path: repositoryPath,
    state,
    decision,
    evidence: { local, local_recheck: localRecheck, remote, provenance },
    next_action: nextAction(decision, state),
    apply_precondition: POD_REPAIR_APPLY_PRECONDITION,
    exit_code: decision.action === "no-op" ? 0 : 2,
  };
}

function nextAction(
  decision: PodRepairDecision,
  state: PodRepairObservedState,
): PodRepairNextAction | null {
  if (decision.action === "no-op") return null;
  if (decision.reason === "repository-missing") {
    return {
      code: "initialize-or-adopt-pod",
      command: "lyt init --auto --json",
      available: true,
      summary: "Run `lyt init --auto --json` to initialize or adopt the pod.",
    };
  }
  if (decision.reason === "remote-unreachable-or-unknown") {
    return {
      code: "restore-pod-connectivity",
      command: POD_RECONCILIATION_REPAIR_COMMAND,
      available: true,
      summary:
        "Restore network and remote authentication, then run `lyt repair --pod --dry-run` once.",
    };
  }
  if (decision.reason === "remote-deleted") {
    return {
      code: "restore-deleted-pod-remote",
      command: POD_PRESERVE_BOTH_APPLY_COMMAND,
      available: false,
      summary:
        "The online pod repository is deleted. Planned recovery preserves local state before recreating or reconnecting it; the preserve-both apply command is not available in this slice.",
    };
  }
  if (decision.reason === "local-state-changed") {
    return {
      code: "stabilize-local-pod-state",
      command: POD_RECONCILIATION_REPAIR_COMMAND,
      available: true,
      summary:
        "Stop or finish the concurrent pod activity, then run `lyt repair --pod --dry-run` once against stable state.",
    };
  }
  if (decision.reason?.startsWith("workspace-")) {
    return {
      code: "preserve-dirty-pod-state",
      command: POD_PRESERVE_BOTH_APPLY_COMMAND,
      available: true,
      summary:
        "Local pod changes require preserve-both recovery. The apply command snapshots all local bytes before convergence.",
    };
  }
  if (decision.reason?.startsWith("operation-")) {
    return {
      code: "finish-existing-git-operation",
      command: POD_RECONCILIATION_REPAIR_COMMAND,
      available: true,
      summary:
        "Finish or abort the existing Git operation with the tool that started it, then run `lyt repair --pod --dry-run` once.",
    };
  }
  if (decision.reason === "graph-no-upstream") {
    return {
      code: "restore-pod-upstream",
      command: null,
      available: false,
      summary:
        "Restore the pod branch upstream through a supported Lyt recovery path; no public repair command for that action ships in this slice.",
    };
  }
  if (decision.reason === "graph-detached-HEAD") {
    return {
      code: "restore-supported-pod-branch",
      command: null,
      available: false,
      summary:
        "Restore a supported pod branch and upstream through Lyt; no public repair command for detached HEAD ships in this slice.",
    };
  }
  if (decision.reason === "provenance-ambiguous") {
    return {
      code: "preserve-ambiguous-provenance",
      command: POD_PRESERVE_BOTH_APPLY_COMMAND,
      available: true,
      summary:
        "Generated-change provenance is ambiguous. Preserve-both recovery retains it in a verified recovery snapshot before convergence.",
    };
  }
  if (decision.reason === "graph-ahead" || state.graph === "ahead") {
    return {
      code: "preserve-ahead-pod-state",
      command: POD_PRESERVE_BOTH_APPLY_COMMAND,
      available: true,
      summary:
        "The local pod is ahead. Preserve-both recovery snapshots those commits and all local bytes before convergence.",
    };
  }
  if (state.graph === "behind") {
    return {
      code: "converge-behind-pod-state",
      command: POD_PRESERVE_BOTH_APPLY_COMMAND,
      available: true,
      summary:
        "The local pod is behind. Preserve-both recovery snapshots local evidence before converging to the verified remote commit.",
    };
  }
  if (state.graph === "diverged") {
    return {
      code: "preserve-diverged-pod-state",
      command: POD_PRESERVE_BOTH_APPLY_COMMAND,
      available: true,
      summary:
        "The pod histories diverged. Preserve-both recovery snapshots the local side before converging to the verified remote commit.",
    };
  }
  if (decision.reason === "repository-not-git-repo") {
    return {
      code: "inspect-local-pod-state",
      command: POD_RECONCILIATION_REPAIR_COMMAND,
      available: true,
      summary:
        "Restore the pod path as a supported Git repository, then run `lyt repair --pod --dry-run` once.",
    };
  }
  if (
    decision.reason === "repository-unreadable" ||
    decision.reason === "local-observation-incomplete"
  ) {
    return {
      code: "inspect-local-pod-state",
      command: POD_RECONCILIATION_REPAIR_COMMAND,
      available: true,
      summary:
        "Restore readable, complete local Git evidence, then run `lyt repair --pod --dry-run` once.",
    };
  }
  return {
    code: "inspect-local-pod-state",
    command: null,
    available: false,
    summary: "No supported public recovery action is available for this observed state.",
  };
}

function isCompleteLocalObservation(
  observation: LocalPodGitStateObservation,
  repositoryPath: string,
): observation is LocalPodGitStateObservation & {
  repository: "present";
  workspace: PodWorkspaceState;
  operation: PodOperationState;
  graph: PodGraphState;
  evidence: LocalPodGitStateObservation["evidence"] & { head_sha: string };
} {
  return (
    observation.repository === "present" &&
    observation.refusal_reason === null &&
    observation.workspace !== null &&
    observation.operation !== null &&
    observation.graph !== null &&
    observation.evidence.repository_path === repositoryPath &&
    observation.evidence.head_sha !== null
  );
}

function sameLocalObservation(
  before: LocalPodGitStateObservation,
  after: LocalPodGitStateObservation,
): boolean {
  return (
    before.repository === after.repository &&
    before.workspace === after.workspace &&
    before.operation === after.operation &&
    before.graph === after.graph &&
    before.evidence.repository_path === after.evidence.repository_path &&
    before.evidence.branch_ref === after.evidence.branch_ref &&
    before.evidence.head_sha === after.evidence.head_sha &&
    before.evidence.upstream_ref === after.evidence.upstream_ref
  );
}

async function observeProductionProof(args: {
  repository_path: string;
  local: LocalPodGitStateObservation;
}): Promise<PodRepairProvenanceObservation> {
  const authenticated = await readAuthenticatedPodTransformationEvidence(args.repository_path);
  const proven: PodRepairProvenTransformation[] = [];
  for (const evidence of authenticated) {
    if (
      classifyReceiptBoundPodProvenance({
        proof: evidence.proof,
        expected_proof_digest: evidence.proof_digest,
        ledger_evidence: evidence.ledger_evidence,
        subject_evidence: evidence.subject_evidence,
      }) !== "receipt-proven" ||
      !(await isExactCommittedProofTail(args.repository_path, args.local, evidence))
    ) {
      continue;
    }
    proven.push({ proof_digest: evidence.proof_digest, proof: evidence.proof });
  }
  if (proven.length === 1) {
    return {
      provenance: "receipt-proven",
      source: "receipt-evidence",
      records_checked: 2,
      transformations: proven,
    };
  }
  return {
    provenance: "ambiguous",
    source: authenticated.length === 0 ? "absent" : "receipt-evidence",
    records_checked: authenticated.length * 2,
  };
}

async function isExactCommittedProofTail(
  repositoryPath: string,
  local: LocalPodGitStateObservation,
  evidence: Awaited<ReturnType<typeof readAuthenticatedPodTransformationEvidence>>[number],
): Promise<boolean> {
  const head = local.evidence.head_sha;
  if (head === null) return false;
  const parents = await runGitReadOnly(["rev-list", "--parents", "-n", "1", head], {
    cwd: repositoryPath,
    allowFailure: true,
  });
  if (parents.code !== 0) return false;
  const fields = parents.stdout.trim().split(/\s+/u);
  if (fields.length !== 2 || fields[0] !== head || fields[1] !== evidence.proof.after_commit) {
    return false;
  }
  const subject = await runGitReadOnly(["log", "-1", "--format=%s", head], {
    cwd: repositoryPath,
    allowFailure: true,
  });
  if (
    subject.code !== 0 ||
    subject.stdout.trim() !== "chore(lyt): record pod transformation proof"
  ) {
    return false;
  }
  const changed = await runGitReadOnlyRaw(
    ["diff", "--name-only", "--no-renames", "-z", evidence.proof.after_commit, head],
    { cwd: repositoryPath, allowFailure: true },
  );
  if (changed.code !== 0) return false;
  const actual = Buffer.from(changed.stdoutRaw)
    .toString("utf8")
    .split("\0")
    .filter((value) => value.length > 0)
    .sort();
  const expected = [evidence.ledger_source, evidence.subject_source]
    .map((path) => relative(repositoryPath, path).replaceAll("\\", "/"))
    .sort();
  return (
    expected.every((path) => path.length > 0 && path !== ".." && !path.startsWith("../")) &&
    actual.length === expected.length &&
    actual.every((path, index) => path === expected[index])
  );
}
