/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { isAbsolute, resolve } from "node:path";

import {
  GitRunTerminatedError,
  runGitReadOnly,
  runGitRemoteObservation,
  type GitRunOptions,
  type GitRunResult,
} from "../../util/git-run.js";
import type { PodGraphState, PodRemoteState } from "./pod-reconciliation.js";
import type { LocalPodGitStateObservation } from "./pod-git-state.js";

const OBSERVATION_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_DIAGNOSTIC = 512;
const MAX_REMOTE_URL = 2_048;
const MAX_REF = 1_024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;

export type PodRemoteCommandRunner = (
  args: readonly string[],
  options: Omit<GitRunOptions, "policy">,
) => Promise<GitRunResult>;

export interface PodRemoteObservationEvidence {
  readonly remote_name: string | null;
  readonly advertised_ref: string | null;
  readonly local_tracking_ref: string | null;
  readonly local_tracking_sha: string | null;
  readonly advertised_sha: string | null;
  readonly graph_source: "advertised-known-object" | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly diagnostic_kind:
    | "auth"
    | "offline"
    | "timeout"
    | "remote-error"
    | "invalid-input"
    | "advertised-object-unseen"
    | null;
  readonly diagnostic: string | null;
}

export interface PodRemoteStateObservation {
  readonly remote: PodRemoteState;
  readonly check: "complete" | "incomplete";
  readonly graph: PodGraphState | null;
  readonly evidence: PodRemoteObservationEvidence;
}

interface DerivedUpstream {
  remoteName: string;
  remoteUrl: string;
  advertisedRef: string;
  localTrackingRef: string;
  localTrackingSha: string;
}

interface CapturedHead {
  branchRef: string;
  headSha: string;
}

/** Derive and observe the configured upstream without accepting caller-selected remote facts. */
export async function observePodRemoteState(
  args: { repository_path: string; local: LocalPodGitStateObservation },
  runRemote: PodRemoteCommandRunner = runGitRemoteObservation,
  runLocal: PodRemoteCommandRunner = runGitReadOnly,
): Promise<PodRemoteStateObservation> {
  const inputError = validateLocalInput(args.repository_path, args.local);
  if (inputError !== null) return incomplete(null, "invalid-input", inputError);

  const captured = await captureHead(
    args.repository_path,
    args.local.evidence.branch_ref!,
    runLocal,
  );
  if (!captured.ok) return incomplete(null, "invalid-input", captured.error);

  const derived = await deriveUpstream(
    args.repository_path,
    args.local,
    captured.value.branchRef,
    runLocal,
  );
  if (!derived.ok) return incomplete(derived.partial, "invalid-input", derived.error);
  const upstream = derived.value;

  let advertised: GitRunResult;
  try {
    advertised = await runRemote(
      ["ls-remote", "--exit-code", upstream.remoteUrl, upstream.advertisedRef],
      {
        cwd: args.repository_path,
        allowFailure: true,
        timeoutMs: OBSERVATION_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      },
    );
  } catch (error) {
    if (isTimeout(error)) {
      return incomplete(upstream, "timeout", "remote observation timed out");
    }
    return incomplete(upstream, "remote-error", "remote observation failed");
  }
  if (advertised.stdoutTruncated || advertised.stderrTruncated) {
    return incomplete(upstream, "remote-error", "remote observation output was truncated");
  }
  if (advertised.code === 2 && advertised.stdout.length === 0) {
    if (!(await headStillMatches(args.repository_path, captured.value, runLocal))) {
      return incomplete(
        upstream,
        "invalid-input",
        "repository branch or HEAD changed during check",
      );
    }
    return {
      remote: "deleted",
      check: "complete",
      graph: null,
      evidence: baseEvidence(upstream),
    };
  }
  if (advertised.code !== 0) {
    const classified = classifyRemoteError(advertised.stderr);
    return incomplete(upstream, classified.kind, classified.message);
  }

  const advertisedSha = parseExactAdvertisement(advertised.stdout, upstream.advertisedRef);
  if (advertisedSha === null) {
    return incomplete(upstream, "remote-error", "remote returned malformed exact-ref evidence");
  }
  const object = await localGit(
    ["cat-file", "-e", `${advertisedSha}^{commit}`],
    args.repository_path,
    runLocal,
  );
  if (!object.ok) {
    return incomplete(
      upstream,
      "advertised-object-unseen",
      "advertised commit is not present locally; fetch is required before graph classification",
      advertisedSha,
    );
  }
  const counts = await localGit(
    ["rev-list", "--left-right", "--count", `${captured.value.headSha}...${advertisedSha}`],
    args.repository_path,
    runLocal,
  );
  if (!counts.ok) return incomplete(upstream, "remote-error", counts.error, advertisedSha);
  const graph = parseGraphCounts(counts.result.stdout);
  if (graph === null) {
    return incomplete(upstream, "remote-error", "local graph counts were malformed", advertisedSha);
  }
  if (!(await headStillMatches(args.repository_path, captured.value, runLocal))) {
    return incomplete(
      upstream,
      "invalid-input",
      "repository branch or HEAD changed during check",
      advertisedSha,
    );
  }
  return {
    remote: "reachable",
    check: "complete",
    graph: graph.graph,
    evidence: {
      ...baseEvidence(upstream, advertisedSha),
      graph_source: "advertised-known-object",
      ahead: graph.ahead,
      behind: graph.behind,
    },
  };
}

function validateLocalInput(path: string, local: LocalPodGitStateObservation): string | null {
  if (!isAbsolute(path)) return "repository path must be absolute";
  if (resolve(path) !== resolve(local.evidence.repository_path)) {
    return "repository path does not match local observation evidence";
  }
  if (
    local.repository !== "present" ||
    local.refusal_reason !== null ||
    local.evidence.branch_ref === null ||
    local.evidence.upstream_ref === null
  ) {
    return "local observation has no usable configured upstream";
  }
  return null;
}

async function deriveUpstream(
  repositoryPath: string,
  local: LocalPodGitStateObservation,
  currentBranchRef: string,
  runLocal: PodRemoteCommandRunner,
): Promise<
  | { ok: true; value: DerivedUpstream }
  | { ok: false; error: string; partial: Partial<DerivedUpstream> | null }
> {
  const fields = await localGit(
    [
      "for-each-ref",
      "--count=1",
      "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
      currentBranchRef,
    ],
    repositoryPath,
    runLocal,
  );
  if (!fields.ok) return { ok: false, error: fields.error, partial: null };
  const parsed = parseUpstreamFields(fields.result.stdout);
  if (parsed === null) {
    return { ok: false, error: "configured upstream evidence is malformed", partial: null };
  }
  if (parsed.localTrackingRef !== local.evidence.upstream_ref) {
    return {
      ok: false,
      error: "configured upstream changed after local observation",
      partial: parsed,
    };
  }
  const urlResult = await localGit(
    ["config", "--get-all", `remote.${parsed.remoteName}.url`],
    repositoryPath,
    runLocal,
  );
  if (!urlResult.ok)
    return { ok: false, error: "configured remote URL is unreadable", partial: parsed };
  const urls = urlResult.result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (urls.length !== 1 || !safeRemoteUrl(urls[0]!)) {
    return {
      ok: false,
      error: "configured remote URL is missing, ambiguous, or unsafe",
      partial: parsed,
    };
  }
  const tracking = await localGit(
    ["rev-parse", "--verify", `${parsed.localTrackingRef}^{commit}`],
    repositoryPath,
    runLocal,
  );
  if (!tracking.ok || !SHA.test(tracking.result.stdout.trim())) {
    return { ok: false, error: "configured local tracking ref is unreadable", partial: parsed };
  }
  return {
    ok: true,
    value: {
      ...parsed,
      remoteUrl: urls[0]!,
      localTrackingSha: tracking.result.stdout.trim(),
    },
  };
}

async function captureHead(
  repositoryPath: string,
  expectedBranchRef: string,
  runLocal: PodRemoteCommandRunner,
): Promise<{ ok: true; value: CapturedHead } | { ok: false; error: string }> {
  const branch = await localGit(["symbolic-ref", "--quiet", "HEAD"], repositoryPath, runLocal);
  if (!branch.ok) return { ok: false, error: "repository HEAD is detached or unreadable" };
  const branchRef = branch.result.stdout.trim();
  if (branchRef !== expectedBranchRef) {
    return { ok: false, error: "repository branch changed after local observation" };
  }
  const head = await localGit(["rev-parse", "--verify", "HEAD^{commit}"], repositoryPath, runLocal);
  const headSha = head.ok ? head.result.stdout.trim() : "";
  if (!head.ok || !SHA.test(headSha)) {
    return { ok: false, error: "repository HEAD commit is unreadable" };
  }
  return { ok: true, value: { branchRef, headSha } };
}

async function headStillMatches(
  repositoryPath: string,
  captured: CapturedHead,
  runLocal: PodRemoteCommandRunner,
): Promise<boolean> {
  const current = await captureHead(repositoryPath, captured.branchRef, runLocal);
  return current.ok && current.value.headSha === captured.headSha;
}

function parseUpstreamFields(
  output: string,
): Omit<DerivedUpstream, "remoteUrl" | "localTrackingSha"> | null {
  const fields = output.replace(/\r?\n$/, "").split("\0");
  if (fields.length !== 3) return null;
  const [localTrackingRef, remoteName, advertisedRef] = fields as [string, string, string];
  if (
    !REMOTE_NAME.test(remoteName) ||
    remoteName === "." ||
    !safeRef(localTrackingRef) ||
    !safeRef(advertisedRef) ||
    !localTrackingRef.startsWith(`refs/remotes/${remoteName}/`) ||
    !advertisedRef.startsWith("refs/heads/")
  ) {
    return null;
  }
  return { localTrackingRef, remoteName, advertisedRef };
}

function parseExactAdvertisement(output: string, expectedRef: string): string | null {
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(lines[0]!);
  return match !== null && match[2] === expectedRef ? match[1]! : null;
}

function parseGraphCounts(
  output: string,
): { graph: PodGraphState; ahead: number; behind: number } | null {
  const match = /^(\d+)\s+(\d+)$/.exec(output.trim());
  if (match === null) return null;
  const ahead = Number(match[1]);
  const behind = Number(match[2]);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return null;
  const graph: PodGraphState =
    ahead === 0 ? (behind === 0 ? "equal" : "behind") : behind === 0 ? "ahead" : "diverged";
  return { graph, ahead, behind };
}

async function localGit(
  gitArgs: readonly string[],
  cwd: string,
  runner: PodRemoteCommandRunner,
): Promise<{ ok: true; result: GitRunResult } | { ok: false; error: string }> {
  try {
    const result = await runner(gitArgs, {
      cwd,
      allowFailure: true,
      timeoutMs: OBSERVATION_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      return { ok: false, error: bounded(result.stderr || `git ${gitArgs[0]} failed`) };
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: bounded(errorText(error)) };
  }
}

function incomplete(
  upstream: Partial<DerivedUpstream> | null,
  kind: NonNullable<PodRemoteObservationEvidence["diagnostic_kind"]>,
  message: string,
  advertisedSha: string | null = null,
): PodRemoteStateObservation {
  return {
    remote: "unreachable-or-unknown",
    check: "incomplete",
    graph: null,
    evidence: {
      ...baseEvidence(upstream, advertisedSha),
      diagnostic_kind: kind,
      diagnostic: bounded(message),
    },
  };
}

function baseEvidence(
  upstream: Partial<DerivedUpstream> | null,
  advertisedSha: string | null = null,
): PodRemoteObservationEvidence {
  return {
    remote_name: upstream?.remoteName === undefined ? null : bounded(upstream.remoteName),
    advertised_ref: upstream?.advertisedRef === undefined ? null : bounded(upstream.advertisedRef),
    local_tracking_ref:
      upstream?.localTrackingRef === undefined ? null : bounded(upstream.localTrackingRef),
    local_tracking_sha: upstream?.localTrackingSha ?? null,
    advertised_sha: advertisedSha,
    graph_source: null,
    ahead: null,
    behind: null,
    diagnostic_kind: null,
    diagnostic: null,
  };
}

function classifyRemoteError(stderr: string): {
  kind: "auth" | "offline" | "remote-error";
  message: string;
} {
  if (
    /auth|credential|permission denied|repository not found|could not read username/i.test(stderr)
  ) {
    return { kind: "auth", message: "remote authentication or authorization failed" };
  }
  if (
    /could not resolve|unable to access|connection|network|does not appear to be a git repository/i.test(
      stderr,
    )
  ) {
    return { kind: "offline", message: "remote could not be reached" };
  }
  return { kind: "remote-error", message: "remote observation failed" };
}

function isTimeout(error: unknown): boolean {
  return (
    (error instanceof GitRunTerminatedError && error.errorCode === "git-timeout") ||
    (typeof error === "object" &&
      error !== null &&
      "errorCode" in error &&
      error.errorCode === "git-timeout")
  );
}

function safeRemoteUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REMOTE_URL || /[\u0000-\u001f\u007f]/.test(value))
    return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value)) return false;
  return true;
}

function safeRef(value: string): boolean {
  return (
    value.length > 5 &&
    value.length <= MAX_REF &&
    value.startsWith("refs/") &&
    !/[\u0000-\u0020~^:?*\\\u007f]/.test(value) &&
    !value.includes("[") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function bounded(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, MAX_DIAGNOSTIC);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "remote observation failed";
}
