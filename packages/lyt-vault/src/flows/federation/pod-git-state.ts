/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { runGitReadOnly, type GitRunResult } from "../../util/git-run.js";
import type {
  PodGraphState,
  PodOperationState,
  PodRepositoryState,
  PodWorkspaceState,
} from "./pod-reconciliation.js";

const OBSERVATION_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 262_144;
const MAX_EVIDENCE_TEXT = 4_096;
const MAX_ERROR_TEXT = 512;

export interface LocalPodGitEvidence {
  readonly repository_path: string;
  readonly git_dir: string | null;
  readonly branch_ref: string | null;
  readonly head_sha: string | null;
  readonly upstream_ref: string | null;
  readonly status_entries: number;
  readonly untracked_entries: number;
  readonly unstaged_tracked_entries: number;
  readonly staged_entries: number;
  readonly operation_markers: readonly PodOperationState[];
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly error: string | null;
}

export interface LocalPodGitStateObservation {
  readonly repository: PodRepositoryState;
  readonly workspace: PodWorkspaceState | null;
  readonly operation: PodOperationState | null;
  readonly graph: PodGraphState | null;
  readonly refusal_reason: "contradictory-operation-state" | "git-observation-failed" | null;
  readonly evidence: LocalPodGitEvidence;
}

export interface PodWorkspaceObservationEvidence {
  workspace: PodWorkspaceState;
  statusEntries: number;
  untrackedEntries: number;
  unstagedTrackedEntries: number;
  stagedEntries: number;
}

/** Observe one local pod repository without contacting a remote or mutating Git state. */
export async function observeLocalPodGitState(
  repositoryPath: string,
): Promise<LocalPodGitStateObservation> {
  const evidence = emptyEvidence(repositoryPath);
  const pathState = await inspectRepositoryPath(repositoryPath);
  if (pathState !== "present") return incomplete(pathState, evidence, null);

  const inside = await git(["rev-parse", "--is-inside-work-tree"], repositoryPath);
  if (!inside.ok) {
    const notGit = /not a git repository/i.test(inside.error);
    return incomplete(notGit ? "not-git-repo" : "unreadable", evidence, inside.error);
  }
  if (inside.result.stdout.trim() !== "true") {
    return incomplete("not-git-repo", evidence, "path is not a Git working tree");
  }

  const gitDirResult = await git(["rev-parse", "--absolute-git-dir"], repositoryPath);
  if (!gitDirResult.ok) return incomplete("unreadable", evidence, gitDirResult.error);
  const gitDir = gitDirResult.result.stdout.trim();
  if (!isAbsolute(gitDir) || gitDir.length === 0 || gitDir.length > MAX_EVIDENCE_TEXT) {
    return incomplete("unreadable", evidence, "Git returned an invalid absolute git directory");
  }
  const withGitDir = { ...evidence, git_dir: bounded(gitDir, MAX_EVIDENCE_TEXT) };

  const status = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"],
    repositoryPath,
  );
  if (!status.ok) return refused(withGitDir, status.error);
  if (status.result.stdoutTruncated)
    return refused(withGitDir, "Git status evidence was truncated");
  const workspace = parsePodPorcelainV1Z(status.result.stdout);
  if (workspace === null)
    return refused(withGitDir, "Git status returned malformed porcelain data");

  let operations: readonly PodOperationState[];
  try {
    operations = await operationMarkers(gitDir);
  } catch (error) {
    return refused(withWorkspace(withGitDir, workspace), errorText(error));
  }
  const withOperations = {
    ...withWorkspace(withGitDir, workspace),
    operation_markers: operations,
  };
  if (operations.length > 1) {
    return {
      repository: "present",
      workspace: workspace.workspace,
      operation: null,
      graph: null,
      refusal_reason: "contradictory-operation-state",
      evidence: withOperations,
    };
  }
  const operation = operations[0] ?? "normal";

  const graph = await observeGraph(repositoryPath);
  if (!graph.ok) {
    return {
      repository: "present",
      workspace: workspace.workspace,
      operation,
      graph: null,
      refusal_reason: "git-observation-failed",
      evidence: { ...withOperations, error: bounded(graph.error, MAX_ERROR_TEXT) },
    };
  }
  return {
    repository: "present",
    workspace: workspace.workspace,
    operation,
    graph: graph.graph,
    refusal_reason: null,
    evidence: {
      ...withOperations,
      branch_ref: graph.branchRef,
      head_sha: graph.headSha,
      upstream_ref: graph.upstreamRef,
      ahead: graph.ahead,
      behind: graph.behind,
    },
  };
}

async function inspectRepositoryPath(path: string): Promise<PodRepositoryState> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) return "not-git-repo";
    await access(path, constants.R_OK | constants.X_OK);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

async function operationMarkers(gitDir: string): Promise<readonly PodOperationState[]> {
  const candidates = [
    { state: "merge-in-progress" as const, path: `${gitDir}/MERGE_HEAD` },
    { state: "rebase-in-progress" as const, path: `${gitDir}/rebase-merge` },
    { state: "rebase-in-progress" as const, path: `${gitDir}/rebase-apply` },
    { state: "cherry-pick-in-progress" as const, path: `${gitDir}/CHERRY_PICK_HEAD` },
  ];
  const active: PodOperationState[] = [];
  for (const candidate of candidates) {
    try {
      await lstat(candidate.path);
      active.push(candidate.state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return active;
}

async function observeGraph(repositoryPath: string): Promise<
  | {
      ok: true;
      graph: PodGraphState;
      branchRef: string | null;
      headSha: string;
      upstreamRef: string | null;
      ahead: number | null;
      behind: number | null;
    }
  | { ok: false; error: string }
> {
  const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], repositoryPath);
  const headSha = head.ok ? head.result.stdout.trim() : "";
  if (!head.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) {
    return { ok: false, error: "repository HEAD commit is unreadable" };
  }
  const branch = await git(["symbolic-ref", "--quiet", "HEAD"], repositoryPath);
  if (!branch.ok) {
    if (branch.code === 1) {
      return {
        ok: true,
        graph: "detached-HEAD",
        branchRef: null,
        headSha,
        upstreamRef: null,
        ahead: null,
        behind: null,
      };
    }
    return { ok: false, error: branch.error };
  }
  const branchRef = branch.result.stdout.trim();
  if (!branchRef.startsWith("refs/heads/") || branchRef.length > MAX_EVIDENCE_TEXT) {
    return { ok: false, error: "Git returned an invalid branch ref" };
  }

  const upstream = await git(
    ["for-each-ref", "--count=1", "--format=%(upstream)", branchRef],
    repositoryPath,
  );
  if (!upstream.ok) return { ok: false, error: upstream.error };
  const upstreamRef = upstream.result.stdout.trim();
  if (upstreamRef.length === 0) {
    return {
      ok: true,
      graph: "no-upstream",
      branchRef,
      headSha,
      upstreamRef: null,
      ahead: null,
      behind: null,
    };
  }
  if (!upstreamRef.startsWith("refs/") || upstreamRef.length > MAX_EVIDENCE_TEXT) {
    return { ok: false, error: "Git returned an invalid upstream ref" };
  }
  const upstreamExists = await git(
    ["show-ref", "--verify", "--quiet", upstreamRef],
    repositoryPath,
  );
  if (!upstreamExists.ok) {
    if (upstreamExists.code === 1) {
      return {
        ok: true,
        graph: "no-upstream",
        branchRef,
        headSha,
        upstreamRef,
        ahead: null,
        behind: null,
      };
    }
    return { ok: false, error: upstreamExists.error };
  }

  const counts = await git(
    ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
    repositoryPath,
  );
  if (!counts.ok) return { ok: false, error: counts.error };
  const match = /^(\d+)\s+(\d+)$/.exec(counts.result.stdout.trim());
  if (match === null) return { ok: false, error: "Git returned invalid ahead/behind counts" };
  const ahead = Number(match[1]);
  const behind = Number(match[2]);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    return { ok: false, error: "Git returned unbounded ahead/behind counts" };
  }
  const graph: PodGraphState =
    ahead === 0 ? (behind === 0 ? "equal" : "behind") : behind === 0 ? "ahead" : "diverged";
  return { ok: true, graph, branchRef, headSha, upstreamRef, ahead, behind };
}

export function parsePodPorcelainV1Z(output: string): PodWorkspaceObservationEvidence | null {
  const records = output.split("\0");
  if (records.at(-1) !== "") return null;
  let statusEntries = 0;
  let untrackedEntries = 0;
  let unstagedTrackedEntries = 0;
  let stagedEntries = 0;
  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== " ") return null;
    const x = record[0]!;
    const y = record[1]!;
    if (!validStatusPair(x, y)) return null;
    statusEntries += 1;
    if (x === "?" && y === "?") untrackedEntries += 1;
    else {
      if (x !== " ") stagedEntries += 1;
      if (y !== " ") unstagedTrackedEntries += 1;
    }
    if ([x, y].some((code) => code === "R" || code === "C")) {
      index += 1;
      if (index >= records.length - 1 || records[index]!.length === 0) return null;
    }
  }
  const categories = [untrackedEntries, unstagedTrackedEntries, stagedEntries].filter(
    (count) => count > 0,
  ).length;
  const workspace: PodWorkspaceState =
    categories === 0
      ? "clean"
      : categories > 1
        ? "mixed"
        : untrackedEntries > 0
          ? "untracked-only"
          : unstagedTrackedEntries > 0
            ? "unstaged-tracked"
            : "staged";
  return { workspace, statusEntries, untrackedEntries, unstagedTrackedEntries, stagedEntries };
}

function validStatusPair(x: string, y: string): boolean {
  return LEGAL_PORCELAIN_V1_STATUS_PAIRS.has(`${x}${y}`);
}

const LEGAL_PORCELAIN_V1_STATUS_PAIRS = new Set([
  " M",
  " T",
  " A",
  " D",
  " R",
  " C",
  "M ",
  "MM",
  "MT",
  "MD",
  "T ",
  "TM",
  "TT",
  "TD",
  "A ",
  "AM",
  "AT",
  "AD",
  "D ",
  "R ",
  "RM",
  "RT",
  "RD",
  "C ",
  "CM",
  "CT",
  "CD",
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
  "??",
]);

async function git(
  args: readonly string[],
  cwd: string,
): Promise<
  | { ok: true; result: GitRunResult; code: number }
  | { ok: false; error: string; code: number | null }
> {
  try {
    const result = await runGitReadOnly(args, {
      cwd,
      allowFailure: true,
      timeoutMs: OBSERVATION_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    });
    if (result.code !== 0 || result.stderrTruncated) {
      return {
        ok: false,
        code: result.code,
        error: bounded(result.stderr || `git ${args[0]} exited ${result.code}`, MAX_ERROR_TEXT),
      };
    }
    return { ok: true, result, code: result.code };
  } catch (error) {
    return { ok: false, code: null, error: bounded(errorText(error), MAX_ERROR_TEXT) };
  }
}

function emptyEvidence(repositoryPath: string): LocalPodGitEvidence {
  return {
    repository_path: bounded(repositoryPath, MAX_EVIDENCE_TEXT),
    git_dir: null,
    branch_ref: null,
    head_sha: null,
    upstream_ref: null,
    status_entries: 0,
    untracked_entries: 0,
    unstaged_tracked_entries: 0,
    staged_entries: 0,
    operation_markers: [],
    ahead: null,
    behind: null,
    error: null,
  };
}

function withWorkspace(
  evidence: LocalPodGitEvidence,
  workspace: PodWorkspaceObservationEvidence,
): LocalPodGitEvidence {
  return {
    ...evidence,
    status_entries: workspace.statusEntries,
    untracked_entries: workspace.untrackedEntries,
    unstaged_tracked_entries: workspace.unstagedTrackedEntries,
    staged_entries: workspace.stagedEntries,
  };
}

function incomplete(
  repository: PodRepositoryState,
  evidence: LocalPodGitEvidence,
  error: string | null,
): LocalPodGitStateObservation {
  return {
    repository,
    workspace: null,
    operation: null,
    graph: null,
    refusal_reason: repository === "present" ? "git-observation-failed" : null,
    evidence: { ...evidence, error: error === null ? null : bounded(error, MAX_ERROR_TEXT) },
  };
}

function refused(evidence: LocalPodGitEvidence, error: string): LocalPodGitStateObservation {
  return {
    repository: "present",
    workspace: null,
    operation: null,
    graph: null,
    refusal_reason: "git-observation-failed",
    evidence: { ...evidence, error: bounded(error, MAX_ERROR_TEXT) },
  };
}

function bounded(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, max);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "local Git observation failed";
}
