/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

export const POD_RECONCILIATION_REPAIR_COMMAND = "lyt repair --pod --dry-run" as const;

export const POD_REPOSITORY_STATES = ["present", "missing", "not-git-repo", "unreadable"] as const;
export const POD_WORKSPACE_STATES = [
  "clean",
  "untracked-only",
  "unstaged-tracked",
  "staged",
  "mixed",
] as const;
export const POD_OPERATION_STATES = [
  "normal",
  "merge-in-progress",
  "rebase-in-progress",
  "cherry-pick-in-progress",
] as const;
export const POD_GRAPH_STATES = [
  "equal",
  "ahead",
  "behind",
  "diverged",
  "no-upstream",
  "detached-HEAD",
] as const;
export const POD_REMOTE_STATES = ["reachable", "unreachable-or-unknown", "deleted"] as const;
export const POD_PROVENANCE_STATES = [
  "receipt-proven",
  "deterministic-legacy-proven",
  "ambiguous",
] as const;

export type PodRepositoryState = (typeof POD_REPOSITORY_STATES)[number];
export type PodWorkspaceState = (typeof POD_WORKSPACE_STATES)[number];
export type PodOperationState = (typeof POD_OPERATION_STATES)[number];
export type PodGraphState = (typeof POD_GRAPH_STATES)[number];
export type PodRemoteState = (typeof POD_REMOTE_STATES)[number];
export type PodProvenanceState = (typeof POD_PROVENANCE_STATES)[number];

export interface PodReconciliationState {
  repository: PodRepositoryState;
  workspace: PodWorkspaceState;
  operation: PodOperationState;
  graph: PodGraphState;
  remote: PodRemoteState;
  provenance: PodProvenanceState;
}

export type PodReconciliationReason =
  | `repository-${Exclude<PodRepositoryState, "present">}`
  | `workspace-${Exclude<PodWorkspaceState, "clean">}`
  | `operation-${Exclude<PodOperationState, "normal">}`
  | `graph-${Exclude<PodGraphState, "equal" | "behind" | "diverged">}`
  | `remote-${Exclude<PodRemoteState, "reachable">}`
  | "provenance-ambiguous"
  | "local-observation-incomplete"
  | "local-state-changed";

export type PodReconciliationDecision =
  | { action: "no-op"; reason: null; next_action: null }
  | { action: "auto-converge"; reason: null; next_action: null }
  | {
      action: "repair-required";
      reason: PodReconciliationReason;
      next_action: typeof POD_RECONCILIATION_REPAIR_COMMAND;
    };

/** Pure, exhaustive policy kernel. It observes and mutates nothing. */
export function derivePodReconciliationAction(
  state: PodReconciliationState,
): PodReconciliationDecision {
  if (state.repository !== "present") return repair(`repository-${state.repository}`);
  if (state.workspace !== "clean") return repair(`workspace-${state.workspace}`);
  if (state.operation !== "normal") return repair(`operation-${state.operation}`);
  if (state.remote !== "reachable") return repair(`remote-${state.remote}`);
  if (state.provenance === "ambiguous") return repair("provenance-ambiguous");
  if (state.graph === "equal") return { action: "no-op", reason: null, next_action: null };
  if (state.graph !== "behind" && state.graph !== "diverged") {
    return repair(`graph-${state.graph}`);
  }
  return { action: "auto-converge", reason: null, next_action: null };
}

function repair(reason: PodReconciliationReason): PodReconciliationDecision {
  return { action: "repair-required", reason, next_action: POD_RECONCILIATION_REPAIR_COMMAND };
}
