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

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { listFederationStates, readFederationState } from "../../registry/federation-state.js";
import {
  inspectReceiptAttempt,
  openReceiptAttempt,
  reopenReceiptAttempt,
  type ReceiptAttemptSession,
} from "../../op/receipt-attempt.js";
import { parseReceiptV1ForEmission, type ReceiptV1 } from "../../op/receipt-v1.js";
import { getFederationRepoDir } from "../../util/federation-paths.js";
import { narrate } from "../../util/git-error-firewall.js";
import { runGit as defaultRunGit } from "../../util/git-run.js";
import { derivePlannedCreationRid } from "../creation-plan.js";
import { hexToUuid7Bytes, uuid7BytesToDashedString } from "../../util/uuid7.js";
import {
  appendPodTransformationProof,
  readAuthenticatedPodTransformationEvidence,
  type AppendPodTransformationProofResult,
} from "./pod-transformation-proof-ledger.js";
import { withDestinationPolicyLock } from "./destination-policy-lock.js";
import {
  derivePodTransformationProofV1,
  digestPodTransformationProofV1,
  isPodGeneratedArtifactPath,
} from "./pod-transformation-proof.js";
import { rebuildFederationCacheFlow } from "./rebuildFederationCacheFlow.js";
import { normalizeGitHubRepoCoordinate, type GitRunner } from "./vault-publish.js";
import {
  observePublicationPermission,
  type PublicationPermissionObserver,
} from "./publication-permission.js";
import { withFreshPublicationPermission } from "./publication-authority.js";
import { ensurePodAliasAuthority, projectPodAlias } from "../../yon/pod-alias-ledger.js";
import {
  foldMachines,
  parseMachineShardText,
  type PublishedMachineSnapshot,
} from "../../yon/machine-ledger.js";
import { parseLedgerText } from "../../yon/ledger-read.js";
import { getMachineId } from "../../util/writer-id.js";

const LYT_VAULT_PACKAGE_VERSION = (
  createRequire(import.meta.url)("../../../package.json") as { version: string }
).version;

// Fed-v2 Layer-1 (Phase D1d) — POD-REPO LEDGER GIT-SYNC. FULLY NET-NEW.
//
// Today `lyt sync` is PER-VAULT only: syncFlow (lyt-mesh) iterates the
// registered vaults and runs git per-vault, and reconcilePublishFlow
// commits/pushes ONLY the pod manifest (pod.yon + identity.yon) via
// commitPodRepo. NOTHING syncs the per-writer subscription/alias SHARD ledger
// under `<podRoot>/ledger/` — the git SoT for cross-machine convergence (design
// §1). This flow is that missing leg.
//
// The convergence model (design §3): each writer appends ONLY to its own shard
// (`ledger/subscriptions/<writerId>/…`), so two machines' shards are disjoint
// files. A plain `git pull --rebase` of the pod repo UNION-MERGES them with
// ZERO conflict — there is no merge driver to build for the common case. The
// derived view (registry.db cache) is reconstituted LOCALLY from the union via
// rebuildFederationCacheFlow and is NEVER committed (committing it would
// reintroduce the conflict we removed). So this flow's job is the thin git
// envelope around that:
//
//   locate pod working tree (handle discovery → getFederationRepoDir)
//     → pull --rebase  (union-merge other writers' shards; CONFLICT → abort,
//                        surface-and-halt, NEVER overwrite — locked posture)
//     → stage + commit local `ledger/` changes (explicit pathspec, never -A)
//     → push (non-fatal; pull-only pods / offline degrade gracefully)
//     → rebuildFederationCacheFlow (reconstitute the LOCAL cache from the union)
//
// Order matters: PULL BEFORE COMMIT so a remote shard that lands during this
// run is in the working tree before we reconstitute, and so the rebase replays
// our local shard commit on top of the union (append-only shards never textually
// collide, so the rebase is trivial). Reconstitution runs AFTER the union is on
// disk regardless of whether we had local changes to push — a peer's pull alone
// must update our cache.
//
// REUSE vs NET-NEW: the git PRIMITIVE (runGit) and the pull-rebase-if-behind
// SHAPE are reused from commitPodRepo (vault-publish.ts) — but commitPodRepo
// stages ONLY pod.yon/identity.yon/.gitignore and never reconstitutes, so the
// `ledger/`-staging + reconstitution ORCHESTRATION here is net-new. The OR-Set
// fold + cache rebuild is REUSED wholesale (rebuildFederationCacheFlow); no
// convergence logic is re-implemented here.

export type PodLedgerSyncStatus =
  // No pod / no single resolvable handle / pod dir absent or not a git repo —
  // nothing to sync. Non-error: a pod-less install runs `lyt sync` cleanly.
  | "skipped"
  // Pulled (union-merged peers' shards) and/or committed+pushed local shards,
  // then reconstituted. The healthy outcome.
  | "synced"
  // Pull-rebase hit a conflict beyond the append-only shard model (e.g. a
  // hand-edited pod.yon collision) — rebase ABORTED, no overwrite. The local
  // cache is reconstituted from the PRE-PULL working tree, so it reflects
  // LOCAL-ONLY state (the peer shards that the aborted pull would have brought
  // in are NOT yet folded) until the handler resolves the conflict and re-syncs.
  | "conflict"
  // A git step errored unexpectedly (not a conflict). Surfaced, non-fatal to
  // the wider sync.
  | "error";

export interface SyncPodLedgerResult {
  status: PodLedgerSyncStatus;
  // The resolved pod working tree (absent when skipped before discovery).
  podDir?: string;
  // True when `pull --rebase` brought in remote commits (peers' shards).
  pulled: boolean;
  // True when a local `ledger/` commit was created this run.
  committed: boolean;
  // True when the local commit was pushed to the pod remote.
  pushed: boolean;
  proofDigest?: string;
  proofRecordCount: 0 | 2;
  proofCommitted: boolean;
  receiptPersisted: boolean;
  // True when rebuildFederationCacheFlow ran (reconstituted the cache).
  reconstituted: boolean;
  // Count of live subscriptions reconstituted (0 when skipped/not-run).
  subscriptionsReconstituted: number;
  // Non-fatal degradations (offline push, no upstream, reconstitution warning).
  warnings: string[];
  /** Observations read from a local HEAD proven byte-identical to remote main. */
  publishedMachineSnapshot?: VerifiedPublishedMachineSnapshot;
  /** Rechecks the exact canonical ref/OID immediately before destructive GC. */
  revalidatePublishedMachineSnapshot?: () => Promise<boolean>;
  // Set on status === "skipped" / "conflict" / "error".
  reason?: string;
}

export interface VerifiedPublishedMachineSnapshot extends PublishedMachineSnapshot {
  canonicalUrl: string;
  canonicalRepository: string;
  canonicalRef: string;
  priorCommitOid: string;
  priorMachineIds: string[];
}

export interface PublishedMachineAuthority {
  snapshot: VerifiedPublishedMachineSnapshot;
  revalidate: () => Promise<boolean>;
}

/** Conservative standalone-housekeep authority from an already-published HEAD. */
export async function resolvePublishedMachineAuthorityForHousekeep(
  git: GitRunner = defaultRunGit,
): Promise<PublishedMachineAuthority | undefined> {
  const db = await openRegistry();
  try {
    const states = await listFederationStates(db);
    if (states.length !== 1) return undefined;
    const handle = states[0]!.handle;
    const podDir = getFederationRepoDir(handle);
    if (!existsSync(podDir)) return undefined;
    const branch = await git(["symbolic-ref", "--short", "HEAD"], { cwd: podDir, allowFailure: true });
    const branchName = branch.stdout.trim();
    const merge = branch.code === 0
      ? await git(["config", "--get", `branch.${branchName}.merge`], { cwd: podDir, allowFailure: true })
      : { code: 1, stdout: "", stderr: "" };
    const canonicalRef = merge.stdout.trim();
    if (merge.code !== 0 || !canonicalRef.startsWith("refs/heads/")) return undefined;
    const authority = await resolveConfiguredCanonicalAuthorityForTest(
      git, podDir, branchName, canonicalRef, `${handle}/lyt-pod`,
    );
    if (authority === undefined) return undefined;
    const remote = await git(["ls-remote", authority.canonicalUrl, canonicalRef], {
      cwd: podDir, allowFailure: true, maxOutputBytes: 1024,
    });
    const currentOid = remote.code === 0 ? exactRemoteOid(remote.stdout, canonicalRef) : "";
    if (currentOid.length === 0) return undefined;
    const fetched = await git(["fetch", "--quiet", authority.canonicalUrl, canonicalRef], {
      cwd: podDir, allowFailure: true, maxOutputBytes: 1024,
    });
    const fetchedOid = fetched.code === 0
      ? await git(["rev-parse", "FETCH_HEAD"], { cwd: podDir, allowFailure: true, maxOutputBytes: 256 })
      : { code: 1, stdout: "", stderr: "" };
    if (fetchedOid.code !== 0 || fetchedOid.stdout.trim() !== currentOid) return undefined;
    const prior = await git(["rev-parse", `${currentOid}^`], { cwd: podDir, allowFailure: true, maxOutputBytes: 256 });
    const priorCommitOid = prior.stdout.trim();
    if (prior.code !== 0) return undefined;
    const floor = await readMachineSnapshotAtCommit(git, podDir, priorCommitOid);
    if (floor === undefined) return undefined;
    const priorMachineIds = [...foldMachines(floor.machines).keys()].sort();
    const snapshot = await readVerifiedPublishedMachineSnapshotForTest(git, podDir, {
      ...authority,
      priorCommitOid,
      priorMachineIds,
      currentMachineId: getMachineId(),
    });
    if (snapshot === undefined) return undefined;
    return {
      snapshot,
      revalidate: async () => {
        const observed = await git(["ls-remote", authority.canonicalUrl, canonicalRef], {
          cwd: podDir, allowFailure: true, maxOutputBytes: 1024,
        });
        return observed.code === 0 && exactRemoteOid(observed.stdout, canonicalRef) === snapshot.commitOid;
      },
    };
  } finally {
    await closeRegistry(db);
  }
}

export interface SyncPodLedgerArgs {
  // Pod handle. When omitted, resolved from federation_state (the single-pod
  // default — mirrors reconcilePublishFlow's resolution).
  handle?: string | undefined;
  // Outward push of the local `ledger/` commit. Default true (sync is the
  // consented outward step). false = local pull+commit+reconstitute, push held.
  push?: boolean | undefined;
  // Pull-rebase before commit. Default true. On conflict → abort + surface.
  pull?: boolean | undefined;
  // Fetch/pull only. Used by re-init to refresh the authoritative pod manifest
  // before recovery without staging, committing, pushing, or regenerating it
  // from the machine's stale registry.
  refreshOnly?: boolean | undefined;
  runGit?: GitRunner | undefined;
  // Open-once registry seam (the reconstitution shares it).
  registryDb?: Client | undefined;
  // Deterministic stamp for the downstream pod.yon regen in reconstitution.
  nowIso?: string | undefined;
  permissionObserver?: PublicationPermissionObserver | undefined;
  permissionAttemptId?: string | undefined;
  dependencies?: SyncPodLedgerDependencies | undefined;
}

export interface SyncPodLedgerDependencies {
  /** Tests only; production derives stable operation identity from pod facts. */
  newOperationId?: () => string;
  /** Tests only; production derives stable attempt identity from the operation. */
  newAttemptId?: () => string;
  now?: () => Date;
  openReceiptAttempt?: typeof openReceiptAttempt;
  reopenReceiptAttempt?: typeof reopenReceiptAttempt;
  inspectReceiptAttempt?: typeof inspectReceiptAttempt;
  appendProof?: (
    args: Parameters<typeof appendPodTransformationProof>[0],
  ) => Promise<AppendPodTransformationProofResult>;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isLocalRepositoryRemote(remote: string): boolean {
  const value = remote.trim();
  if (value.length === 0) return false;
  if (/^file:\/\//i.test(value)) return true;
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

// The pod-repo `ledger/` dir is the only pathspec this flow ever stages — the
// per-writer shard tree (subscriptions/ + aliases/). Explicit pathspec, never
// `git add -A` (mirrors commitPodRepo + the per-vault sync's explicit-paths
// rule — a stray file is never swept into the pod commit).
const LEDGER_PATHSPEC = "ledger";
const PROOF_LEDGER_PATHSPEC = "ledger/pod-transformations";
const PROOF_SUBJECT_PATHSPEC = "ledger/pod-transformation-subjects";
const DATA_LEDGER_PATHSPECS = [
  LEDGER_PATHSPEC,
  `:(exclude)${PROOF_LEDGER_PATHSPEC}`,
  `:(exclude)${PROOF_SUBJECT_PATHSPEC}`,
] as const;
const MAX_SYNC_PROOF_PATHS = 256;
const MAX_SYNC_PROOF_PATH_LENGTH = 512;
const podSyncTails = new Map<string, Promise<void>>();

async function withPodSyncQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prior = podSyncTails.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(action);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  podSyncTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (podSyncTails.get(key) === tail) podSyncTails.delete(key);
  }
}

interface PodSyncReceiptArgs {
  operationId: string;
  attemptId: string;
  podRid: string;
  startedAt: string;
  finishedAt: string;
  replayDigest: string;
  stagedPathCount: number;
  status: "success" | "no-op" | "partial" | "failed";
  localMutations: number;
  proofDigest?: string;
  failureCode?: string;
  replayDisposition?: "new" | "resumed";
}

function digestCanonical(value: {
  podRid: string;
  beforeHead: string;
  stagedPaths: readonly string[];
}): string {
  const canonical = JSON.stringify({
    pod_rid: value.podRid,
    before_commit: value.beforeHead,
    affected_paths: [...value.stagedPaths].sort(),
  });
  if (Buffer.byteLength(canonical, "utf8") > 256 * 1024) {
    throw new Error("Pod sync replay identity exceeded its bound.");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function makePodSyncReceipt(args: PodSyncReceiptArgs): ReceiptV1 {
  const failed = args.status === "partial" || args.status === "failed";
  const after: ReceiptV1["evidence"]["after"] = [];
  if (args.proofDigest !== undefined) {
    after.push({
      kind: "pod-proof",
      subject: "paired pod transformation records",
      digest: args.proofDigest,
      count: 2,
    });
  }
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "pod-ledger-sync",
    scope: { kind: "pod", pod_id: args.podRid },
    timestamps: { started_at: args.startedAt, finished_at: args.finishedAt },
    replay: { disposition: args.replayDisposition ?? "new", key_digest: args.replayDigest },
    status: args.status,
    exit_code: failed ? 2 : 0,
    mutations: { local: args.localMutations, remote: 0 },
    evidence: {
      before: [
        {
          kind: "staged-path-set",
          subject: "exact staged pod data paths",
          digest: args.replayDigest,
          count: args.stagedPathCount,
        },
      ],
      after,
    },
    next_action: failed
      ? { code: "retry-pod-ledger-sync", summary: "Run Lyt sync again after inspection." }
      : null,
    error: failed
      ? {
          code: args.failureCode ?? "pod-sync-failed",
          summary: "Pod transformation evidence was not committed.",
          retryable: true,
        }
      : null,
  });
}

function deterministicUuid(seed: string, label: string): string {
  return uuid7BytesToDashedString(hexToUuid7Bytes(derivePlannedCreationRid(seed, label)));
}

function assertLedgerRootIsNotReparsePoint(podDir: string): void {
  const ledgerRoot = join(podDir, LEDGER_PATHSPEC);
  if (lstatSync(podDir).isSymbolicLink()) throw new Error("pod-ledger-reparse-point-refused");
  if (!existsSync(ledgerRoot)) return;
  const pending = [ledgerRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("pod-ledger-reparse-point-refused");
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(current)) pending.push(join(current, entry));
  }
}

function validDataPaths(paths: readonly string[]): boolean {
  return (
    paths.length <= MAX_SYNC_PROOF_PATHS &&
    paths.every(
      (path) => path.length <= MAX_SYNC_PROOF_PATH_LENGTH && isPodGeneratedArtifactPath(path),
    )
  );
}

/** Source-only verification seam; production consumes it through syncPodLedgerFlow. */
export async function readVerifiedPublishedMachineSnapshotForTest(
  git: GitRunner,
  podDir: string,
  authority?: {
    canonicalUrl: string;
    canonicalRef: string;
    canonicalRepository: string;
    priorCommitOid: string;
    priorMachineIds: readonly string[];
    currentMachineId: string;
  },
): Promise<VerifiedPublishedMachineSnapshot | undefined> {
  if (authority === undefined || !authority.canonicalRef.startsWith("refs/heads/")) return undefined;
  const { canonicalUrl, canonicalRef, canonicalRepository, priorCommitOid, currentMachineId } = authority;

  const statusBefore = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "ledger/machines"],
    { cwd: podDir, allowFailure: true, maxOutputBytes: 256 * 1024 },
  );
  const headBefore = await git(["rev-parse", "HEAD"], { cwd: podDir, allowFailure: true, maxOutputBytes: 256 });
  const remoteBefore = await git(["ls-remote", canonicalUrl, canonicalRef], {
    cwd: podDir, allowFailure: true, maxOutputBytes: 1024,
  });
  const commitOid = headBefore.stdout.trim();
  const remoteOid = exactRemoteOid(remoteBefore.stdout, canonicalRef);
  if (statusBefore.code !== 0 || statusBefore.stdout.length !== 0 || headBefore.code !== 0 ||
      remoteBefore.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commitOid) || commitOid !== remoteOid) return undefined;

  const current = await readMachineSnapshotAtCommit(git, podDir, commitOid);
  if (current === undefined) return undefined;
  const currentIds = new Set(foldMachines(current.machines).keys());
  const priorMachineIds = [...new Set(authority.priorMachineIds)].sort();
  if (priorMachineIds.length === 0 || currentIds.size === 0 || !currentIds.has(currentMachineId) ||
      priorMachineIds.some((id) => !currentIds.has(id))) return undefined;
  const ancestor = await git(["merge-base", "--is-ancestor", priorCommitOid, commitOid], {
    cwd: podDir, allowFailure: true, maxOutputBytes: 256,
  });
  if (ancestor.code !== 0) return undefined;

  const statusAfter = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "ledger/machines"],
    { cwd: podDir, allowFailure: true, maxOutputBytes: 256 * 1024 },
  );
  const headAfter = await git(["rev-parse", "HEAD"], { cwd: podDir, allowFailure: true, maxOutputBytes: 256 });
  const remoteAfter = await git(["ls-remote", canonicalUrl, canonicalRef], {
    cwd: podDir, allowFailure: true, maxOutputBytes: 1024,
  });
  const remoteAfterOid = exactRemoteOid(remoteAfter.stdout, canonicalRef);
  if (statusAfter.code !== 0 || statusAfter.stdout.length !== 0 || headAfter.stdout.trim() !== commitOid ||
      remoteAfter.code !== 0 || remoteAfterOid !== commitOid) return undefined;
  return { commitOid, ...current, canonicalUrl, canonicalRepository, canonicalRef, priorCommitOid, priorMachineIds };
}

export async function resolveConfiguredCanonicalAuthorityForTest(
  git: GitRunner,
  podDir: string,
  branchName: string,
  canonicalRef: string,
  expectedRepository: string,
): Promise<{ canonicalUrl: string; canonicalRepository: string; canonicalRef: string } | undefined> {
  if (branchName.length === 0) return undefined;
  const remote = await git(["config", "--get", `branch.${branchName}.remote`], { cwd: podDir, allowFailure: true });
  const remoteName = remote.stdout.trim();
  if (remote.code !== 0 || remoteName.length === 0 || remoteName === ".") return undefined;
  const pushUrl = await git(["remote", "get-url", "--push", remoteName], { cwd: podDir, allowFailure: true });
  const canonicalUrl = pushUrl.stdout.trim();
  const coordinate = pushUrl.code === 0 ? normalizeGitHubRepoCoordinate(canonicalUrl) : null;
  if (isLocalRepositoryRemote(canonicalUrl) || coordinate === null ||
      coordinate.toLowerCase() !== expectedRepository.toLowerCase()) return undefined;
  return { canonicalUrl, canonicalRepository: expectedRepository, canonicalRef };
}

function exactRemoteOid(output: string, ref: string): string {
  const match = output.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts[1] === ref);
  return match?.[0] && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(match[0]) ? match[0] : "";
}

async function readMachineSnapshotAtCommit(
  git: GitRunner,
  podDir: string,
  commitOid: string,
): Promise<Pick<PublishedMachineSnapshot, "machines" | "observations"> | undefined> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commitOid)) return undefined;
  const listed = await git(["ls-tree", "-r", "--name-only", "-z", commitOid, "--", "ledger/machines"], {
    cwd: podDir, allowFailure: true, maxOutputBytes: 256 * 1024,
  });
  if (listed.code !== 0 || listed.stdoutTruncated === true) return undefined;
  const paths = listed.stdout.split("\0").filter(Boolean).sort();
  if (paths.length > 256 || paths.some((path) => !/^ledger\/machines\/[0-9a-f-]+(?:\/\d{4}-\d{2})?\.yon$/u.test(path))) return undefined;
  const machines: PublishedMachineSnapshot["machines"] = [];
  const observations: PublishedMachineSnapshot["observations"] = [];
  for (const path of paths) {
    const parts = path.split("/");
    const writerId = parts.length === 3 ? parts[2]!.slice(0, -4) : parts[2]!;
    const blob = await git(["show", `${commitOid}:${path}`], { cwd: podDir, allowFailure: true, maxOutputBytes: 4 * 1024 * 1024 });
    if (blob.code !== 0 || blob.stdoutTruncated === true) return undefined;
    const raw = parseLedgerText(blob.stdout, `${commitOid}:${path}`);
    const relevant = raw.filter((record) => record.recordType === "MACHINE" || record.recordType === "SYNC_OBSERVED");
    if (relevant.length === 0 || relevant.some((record) => record.tamper === true)) return undefined;
    let parsed: ReturnType<typeof parseMachineShardText>;
    try {
      parsed = parseMachineShardText(blob.stdout, writerId, `${commitOid}:${path}`);
    } catch {
      return undefined;
    }
    if (parsed.machines.length + parsed.observations.length !== relevant.length) return undefined;
    machines.push(...parsed.machines);
    observations.push(...parsed.observations);
  }
  return { machines, observations };
}

async function enumerateDataChanges(git: GitRunner, podDir: string): Promise<string[] | null> {
  const commands = [
    ["diff", "--name-only", "-z", "--no-renames", "--", ...DATA_LEDGER_PATHSPECS],
    ["diff", "--cached", "--name-only", "-z", "--no-renames", "--", ...DATA_LEDGER_PATHSPECS],
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...DATA_LEDGER_PATHSPECS],
  ];
  const paths = new Set<string>();
  for (const command of commands) {
    const observed = await git(command, {
      cwd: podDir,
      allowFailure: true,
      maxOutputBytes: 256 * 1024,
    });
    if (observed.code !== 0 || observed.stdoutTruncated === true) return null;
    for (const path of observed.stdout.split("\0").filter(Boolean)) paths.add(path);
  }
  return [...paths].sort();
}

interface ReplayReceipt {
  session: ReceiptAttemptSession | null;
  operationId: string;
  attemptId: string;
  startedAt: string;
  replayDisposition: "new" | "resumed";
  alreadySucceeded: boolean;
}

async function openReplayReceipt(
  dependencies: SyncPodLedgerDependencies,
  base: Omit<
    PodSyncReceiptArgs,
    "attemptId" | "startedAt" | "finishedAt" | "status" | "localMutations"
  >,
  now: () => Date,
): Promise<ReplayReceipt | null> {
  const inspect = dependencies.inspectReceiptAttempt ?? inspectReceiptAttempt;
  const open = dependencies.openReceiptAttempt ?? openReceiptAttempt;
  const reopen = dependencies.reopenReceiptAttempt ?? reopenReceiptAttempt;
  for (let ordinal = 0; ordinal < 32; ordinal += 1) {
    const attemptId =
      ordinal === 0 && dependencies.newAttemptId !== undefined
        ? dependencies.newAttemptId()
        : deterministicUuid(base.operationId, `pod-ledger-sync-attempt:${ordinal}`);
    const state = await inspect(attemptId);
    if (state.kind === "terminal") {
      if (state.receipt.status === "success") {
        return {
          session: null,
          operationId: base.operationId,
          attemptId,
          startedAt: state.receipt.timestamps.started_at,
          replayDisposition: ordinal === 0 ? "new" : "resumed",
          alreadySucceeded: true,
        };
      }
      continue;
    }
    const startedAt = state.kind === "pending" ? state.startedAt : now().toISOString();
    const pending = makePodSyncReceipt({
      ...base,
      attemptId,
      startedAt,
      finishedAt: startedAt,
      status: "no-op",
      localMutations: 0,
      replayDisposition: ordinal === 0 ? "new" : "resumed",
    });
    const opened = state.kind === "pending" ? await reopen(pending) : await open(pending);
    if (opened.kind !== "ready") return null;
    return {
      session: opened.session,
      operationId: base.operationId,
      attemptId,
      startedAt: opened.session.startedAt ?? startedAt,
      replayDisposition: ordinal === 0 ? "new" : "resumed",
      alreadySucceeded: false,
    };
  }
  return null;
}

async function finalizePodSyncReceipt(
  session: ReceiptAttemptSession,
  args: PodSyncReceiptArgs,
): Promise<boolean> {
  const warnings = await session.finalize(makePodSyncReceipt(args));
  return !warnings.includes("receipt-store-finalize-failed");
}

function validatedProofPaths(
  podDir: string,
  evidence: AppendPodTransformationProofResult,
): [string, string] {
  const paths = [evidence.ledger_path, evidence.subject_path].map((absolute) => {
    const candidate = relative(podDir, absolute).replace(/\\/gu, "/");
    if (
      candidate.length === 0 ||
      isAbsolute(candidate) ||
      candidate === ".." ||
      candidate.startsWith("../") ||
      (!candidate.startsWith(`${PROOF_LEDGER_PATHSPEC}/`) &&
        !candidate.startsWith(`${PROOF_SUBJECT_PATHSPEC}/`))
    ) {
      throw new Error("Pod proof writer returned a path outside its evidence ledgers.");
    }
    return candidate;
  });
  if (paths[0] === paths[1]) throw new Error("Pod proof records must use distinct paths.");
  return [paths[0]!, paths[1]!];
}

export async function syncPodLedgerFlow(
  args: SyncPodLedgerArgs = {},
): Promise<SyncPodLedgerResult> {
  const git = args.runGit ?? defaultRunGit;
  const push = args.push ?? true;
  const pull = args.pull ?? true;
  const refreshOnly = args.refreshOnly ?? false;
  const warnings: string[] = [];
  const dependencies = args.dependencies ?? {};

  const result: SyncPodLedgerResult = {
    status: "skipped",
    pulled: false,
    committed: false,
    pushed: false,
    proofRecordCount: 0,
    proofCommitted: false,
    receiptPersisted: false,
    reconstituted: false,
    subscriptionsReconstituted: 0,
    warnings,
  };

  const ownDb = args.registryDb === undefined;
  const db = args.registryDb ?? (await openRegistry());
  try {
    // 1. Handle discovery (mirrors reconcilePublishFlow). No gh call — the
    //    handle comes from the local federation_state. A pod-less install
    //    (no single state) skips cleanly.
    let handle = args.handle;
    if (handle === undefined || handle.length === 0) {
      const states = await listFederationStates(db);
      if (states.length !== 1) {
        return { ...result, status: "skipped", reason: "no-single-pod" };
      }
      handle = states[0]!.handle;
    }
    const federationState = await readFederationState(db, handle);
    if (federationState === null) {
      return { ...result, status: "skipped", reason: "no-federation-state" };
    }

    const podDir = getFederationRepoDir(handle);
    result.podDir = podDir;
    if (!existsSync(podDir)) {
      return { ...result, status: "skipped", reason: "pod-dir-missing", podDir };
    }
    const gitDir = await git(["rev-parse", "--git-dir"], { cwd: podDir, allowFailure: true });
    if (gitDir.code !== 0) {
      return { ...result, status: "skipped", reason: "pod-not-git-repo", podDir };
    }
    const currentBranch = await git(["symbolic-ref", "--short", "HEAD"], { cwd: podDir, allowFailure: true });
    const configuredMerge = currentBranch.code === 0
      ? await git(["config", "--get", `branch.${currentBranch.stdout.trim()}.merge`], { cwd: podDir, allowFailure: true })
      : { code: 1, stdout: "", stderr: "" };
    const publicationRef = configuredMerge.code === 0 && configuredMerge.stdout.trim().startsWith("refs/heads/")
      ? configuredMerge.stdout.trim()
      : "refs/heads/main";
    const expectedRepository = `${handle}/lyt-pod`;
    const configuredAuthority = await resolveConfiguredCanonicalAuthorityForTest(
      git, podDir, currentBranch.stdout.trim(), publicationRef, expectedRepository,
    );
    // Capture the deletion cohort floor before any local registration or
    // publication. An absent/unreadable canonical branch simply withholds GC
    // evidence; it never blocks publication.
    const priorCanonical = push && configuredAuthority !== undefined
      ? await git(["ls-remote", configuredAuthority.canonicalUrl, publicationRef], { cwd: podDir, allowFailure: true, maxOutputBytes: 1024 })
      : { code: 1, stdout: "", stderr: "" };
    const priorCanonicalOid = priorCanonical.code === 0
      ? exactRemoteOid(priorCanonical.stdout, publicationRef)
      : "";
    let priorCanonicalMachineIds: string[] | undefined;
    if (priorCanonicalOid.length > 0) {
      const fetchedFloor = await git(["fetch", "--quiet", configuredAuthority!.canonicalUrl, publicationRef], {
        cwd: podDir, allowFailure: true, maxOutputBytes: 1024,
      });
      const fetchedOid = fetchedFloor.code === 0
        ? await git(["rev-parse", "FETCH_HEAD"], { cwd: podDir, allowFailure: true, maxOutputBytes: 256 })
        : { code: 1, stdout: "", stderr: "" };
      if (fetchedOid.code === 0 && fetchedOid.stdout.trim() === priorCanonicalOid) {
        const floor = await readMachineSnapshotAtCommit(git, podDir, priorCanonicalOid);
        if (floor !== undefined) priorCanonicalMachineIds = [...foldMachines(floor.machines).keys()].sort();
      }
    }

    const lockRoot = gitDir.stdout.trim();
    const lockPath = join(
      isAbsolute(lockRoot) ? lockRoot : join(podDir, lockRoot),
      "lyt-locks",
      "pod-ledger-sync.lock",
    );
    let conflicted = false;
    let hasPublishableLedgerCommit = false;
    const lifecycleOutcome = await withPodSyncQueue(lockPath, () =>
      withDestinationPolicyLock(
        lockPath,
        async (): Promise<SyncPodLedgerResult | null> => {
          // 2. PULL --rebase the pod (union-merge peers' shards). Only when there is
          //    an upstream AND we are behind. On a non-shard conflict (hand-edited
          //    pod.yon, etc.) ABORT — never overwrite. Append-only shards never
          //    textually collide, so a real conflict here is the manifest, not the
          //    ledger — surface it. We still reconstitute below, but ONLY from the
          //    pre-pull tree: the cache then reflects LOCAL-ONLY state (the peer
          //    shards the aborted pull would have unioned in are NOT folded yet), not
          //    the converged set. This keeps the cache self-consistent with what is
          //    actually on disk rather than leaving it untouched; it is NOT a
          //    substitute for resolving the conflict and re-syncing.
          if (pull) {
            const hasUpstream = await git(
              ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
              {
                cwd: podDir,
                allowFailure: true,
              },
            );
            if (hasUpstream.code === 0) {
              const repository = `${handle}/lyt-pod`;
              const origin = await git(["remote", "get-url", "origin"], {
                cwd: podDir,
                allowFailure: true,
              });
              const originUrl = origin.stdout.trim();
              const localRemote = origin.code === 0 && isLocalRepositoryRemote(originUrl);
              if (!localRemote && configuredAuthority === undefined) {
                return { ...result, status: "error", reason: "origin-mismatch" };
              }
              const fetchChild = () =>
                git(
                  ["fetch", "--quiet", localRemote ? originUrl : configuredAuthority!.canonicalUrl, publicationRef],
                  {
                    cwd: podDir,
                    allowFailure: true,
                  },
                );
              const fetched = localRemote
                ? await fetchChild()
                : await withFreshPublicationPermission({
                    capability: "repository-push",
                    target: `github:user/${handle}`,
                    repository,
                    actor: handle,
                    attemptId: args.permissionAttemptId ?? randomUUID(),
                    policyEpoch: 0,
                    permissionObserver: args.permissionObserver ?? observePublicationPermission,
                    publicationSubject: {
                      identity: `pod:${repository.toLowerCase()}`,
                      podRoot: podDir,
                    },
                    action: (attempt) => attempt.runOutwardChild(fetchChild),
                  });
              if (refreshOnly && fetched.code !== 0) {
                return { ...result, status: "error", reason: "fetch-failed" };
              }
              const ab = await git(["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"], {
                cwd: podDir,
                allowFailure: true,
              });
              // Fail SAFE: an unreadable rev-list (code != 0) is treated as
              // possibly-behind (→ attempt pull-rebase) rather than assume-not-behind
              // (mirrors commitPodRepo). Never default to the unsafe skip-the-pull.
              const behind = ab.code === 0 ? Number(ab.stdout.trim().split(/\s+/)[1] ?? 0) || 0 : 1;
              if (behind > 0) {
                // --autostash: the local `ledger/` shard may have UNCOMMITTED changes
                // (a fresh append not yet staged/committed — this flow commits AFTER
                // the pull, step 3). Without autostash, `pull --rebase` ABORTS on a
                // dirty tracked file ("cannot rebase: you have unstaged changes"),
                // the abort path below trips, and the whole sync no-ops to "conflict"
                // — local writes never push, the remote union never integrates (
                // bug 1). Autostash stashes the working-tree change, replays the
                // rebase on the pulled union, then pops it back; an append-only shard
                // pops cleanly (the stash applies on top of the union with no textual
                // collision). A genuine non-shard collision still surfaces below.
                const rebased = await git(["rebase", "--autostash", "--quiet", "FETCH_HEAD"], {
                  cwd: podDir,
                  allowFailure: true,
                });
                if (rebased.code === 0) {
                  result.pulled = true;
                } else {
                  // Abort: leave NO half-rebased tree. Surface; reconstitute the
                  // local cache below from the (pre-pull) working tree anyway.
                  await git(["rebase", "--abort"], { cwd: podDir, allowFailure: true });
                  conflicted = true;
                  // firewall-C1 fix-pass — plain conflict warning (no `git pull --rebase`
                  // recipe / git noun); renders on `lyt sync` via printPodLedgerHuman.
                  warnings.push(
                    "Lyt couldn't automatically combine your pod's shared records with your online " +
                      "copy this time (something other than the shared lists changed in both places). " +
                      "Your notes are safe and unchanged. Re-run `lyt sync`, or run `lyt doctor` if it keeps happening.",
                  );
                }
              }
            }
          }

          if (refreshOnly) {
            if (conflicted) {
              return { ...result, status: "conflict", reason: "pull-rebase-conflict" };
            }
            return { ...result, status: "synced" };
          }

          if (!conflicted) {
            try {
              assertLedgerRootIsNotReparsePoint(podDir);
              ensurePodAliasAuthority({ podRoot: podDir, podRid: federationState.fedRidHex });
              projectPodAlias(podDir, federationState.fedRidHex);
            } catch (error) {
              if (errMsg(error).includes("symlink or reparse point") ||
                  errMsg(error) === "pod-ledger-reparse-point-refused") {
                return { ...result, status: "error", reason: "pod-ledger-reparse-point-refused" };
              }
              throw error;
            }
          }

          if (!conflicted) {
            const lockedFailure = await (async () => {
              try {
                assertLedgerRootIsNotReparsePoint(podDir);
              } catch {
                return "pod-ledger-reparse-point-refused";
              }
              const now = dependencies.now ?? (() => new Date());
              const podRid = uuid7BytesToDashedString(federationState.fedRidBytes);
              const headResult = await git(["rev-parse", "--verify", "HEAD"], {
                cwd: podDir,
                allowFailure: true,
                maxOutputBytes: 256,
              });
              let beforeHead = headResult.stdout.trim();
              if (headResult.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(beforeHead)) {
                return "pod-head-unreadable";
              }
              let dataHead: string | undefined;
              let proofAlreadyCommitted = false;
              let proofOperationId: string | undefined;
              let proofReplayDigest: string | undefined;
              let proofDigest: string | undefined;
              const enumeratedPaths = await enumerateDataChanges(git, podDir);
              if (enumeratedPaths === null) return "pod-ledger-path-enumeration-failed";
              let stagedPaths = enumeratedPaths;
              if (!validDataPaths(stagedPaths)) return "pod-ledger-path-boundary-refused";

              if (stagedPaths.length === 0) {
                const subject = await git(["log", "-1", "--pretty=%s"], {
                  cwd: podDir,
                  allowFailure: true,
                });
                if (subject.stdout.trim() === "chore(lyt): sync federation ledger shards") {
                  const parent = await git(["rev-parse", "HEAD^"], {
                    cwd: podDir,
                    allowFailure: true,
                  });
                  const changed = await git(
                    [
                      "diff-tree",
                      "--no-commit-id",
                      "--name-only",
                      "-z",
                      "--no-renames",
                      "-r",
                      "HEAD",
                      "--",
                      ...DATA_LEDGER_PATHSPECS,
                    ],
                    { cwd: podDir, allowFailure: true, maxOutputBytes: 256 * 1024 },
                  );
                  stagedPaths = changed.stdout.split("\0").filter(Boolean).sort();
                  if (
                    parent.code !== 0 ||
                    changed.code !== 0 ||
                    !validDataPaths(stagedPaths) ||
                    stagedPaths.length === 0
                  ) {
                    return "pod-ledger-replay-mismatch";
                  }
                  beforeHead = parent.stdout.trim();
                  dataHead = headResult.stdout.trim();
                  hasPublishableLedgerCommit = true;
                } else if (
                  subject.stdout.trim() === "chore(lyt): record pod transformation proof"
                ) {
                  const data = await git(["rev-parse", "HEAD^"], {
                    cwd: podDir,
                    allowFailure: true,
                  });
                  const authenticated = await readAuthenticatedPodTransformationEvidence(podDir);
                  const match = authenticated.find(
                    (entry) => entry.proof.after_commit === data.stdout.trim(),
                  );
                  if (data.code !== 0 || match === undefined) return "pod-ledger-replay-mismatch";
                  beforeHead = match.proof.before_commit;
                  dataHead = match.proof.after_commit;
                  stagedPaths = [...match.proof.affected_paths];
                  proofOperationId = match.proof.operation_id;
                  proofReplayDigest = match.proof.replay_key_digest;
                  proofDigest = match.proof_digest;
                  proofAlreadyCommitted = true;
                  hasPublishableLedgerCommit = true;
                  result.proofCommitted = true;
                  result.proofRecordCount = 2;
                  result.proofDigest = proofDigest;
                }
              }

              if (stagedPaths.length > 0) {
                const replayDigest =
                  proofReplayDigest ?? digestCanonical({ podRid, beforeHead, stagedPaths });
                const operationId =
                  proofOperationId ??
                  dependencies.newOperationId?.() ??
                  deterministicUuid(podRid, `pod-ledger-sync:${replayDigest}`);
                const replay = await openReplayReceipt(
                  dependencies,
                  {
                    operationId,
                    podRid,
                    replayDigest,
                    stagedPathCount: stagedPaths.length,
                  },
                  now,
                );
                if (replay === null) return "receipt-open-failed";
                if (replay.alreadySucceeded && !proofAlreadyCommitted)
                  return "pod-ledger-replay-mismatch";

                if (dataHead === undefined) {
                  const added = await git(["add", "--", ...DATA_LEDGER_PATHSPECS], {
                    cwd: podDir,
                    allowFailure: true,
                  });
                  if (added.code !== 0) return "pod-ledger-stage-failed";
                  const cached = await git(
                    [
                      "diff",
                      "--cached",
                      "--name-only",
                      "-z",
                      "--no-renames",
                      "--",
                      ...DATA_LEDGER_PATHSPECS,
                    ],
                    { cwd: podDir, allowFailure: true, maxOutputBytes: 256 * 1024 },
                  );
                  const exact = cached.stdout.split("\0").filter(Boolean).sort();
                  if (
                    cached.code !== 0 ||
                    cached.stdoutTruncated === true ||
                    JSON.stringify(exact) !== JSON.stringify(stagedPaths)
                  ) {
                    return "pod-ledger-path-enumeration-failed";
                  }
                  const committed = await git(
                    [
                      "commit",
                      "-m",
                      "chore(lyt): sync federation ledger shards",
                      "--",
                      ...stagedPaths,
                    ],
                    { cwd: podDir, allowFailure: true },
                  );
                  if (committed.code !== 0) {
                    if (replay.session !== null) {
                      result.receiptPersisted = await finalizePodSyncReceipt(replay.session, {
                        operationId,
                        attemptId: replay.attemptId,
                        podRid,
                        startedAt: replay.startedAt,
                        finishedAt: now().toISOString(),
                        replayDigest,
                        stagedPathCount: stagedPaths.length,
                        status: "failed",
                        localMutations: 0,
                        failureCode: "pod-data-commit-failed",
                        replayDisposition: replay.replayDisposition,
                      });
                    }
                    return "pod-data-commit-failed";
                  }
                  result.committed = true;
                  hasPublishableLedgerCommit = true;
                  const after = await git(["rev-parse", "--verify", "HEAD"], {
                    cwd: podDir,
                    allowFailure: true,
                  });
                  dataHead = after.stdout.trim();
                  if (after.code !== 0) return "pod-head-unreadable";
                }

                if (!proofAlreadyCommitted) {
                  try {
                    const proof = await derivePodTransformationProofV1({
                      repository_root: podDir,
                      pod_rid: podRid,
                      operation_id: operationId,
                      replay_key_digest: replayDigest,
                      generator_id: "lyt.pod-ledger-sync",
                      generator_version: LYT_VAULT_PACKAGE_VERSION,
                      before_commit: beforeHead,
                      after_commit: dataHead,
                      affected_paths: stagedPaths,
                    });
                    const appendProof = dependencies.appendProof ?? appendPodTransformationProof;
                    const evidence = await appendProof({ pod_root: podDir, proof });
                    const proofPaths = validatedProofPaths(podDir, evidence);
                    const proofStaged = await git(["add", "--", ...proofPaths], {
                      cwd: podDir,
                      allowFailure: true,
                    });
                    if (proofStaged.code !== 0) throw new Error("proof-stage-failed");
                    const metadataCommit = await git(
                      [
                        "commit",
                        "-m",
                        "chore(lyt): record pod transformation proof",
                        "--",
                        ...proofPaths,
                      ],
                      { cwd: podDir, allowFailure: true },
                    );
                    if (metadataCommit.code !== 0) throw new Error("proof-commit-failed");
                    proofDigest = digestPodTransformationProofV1(proof);
                    result.proofDigest = proofDigest;
                    result.proofRecordCount = 2;
                    result.proofCommitted = true;
                  } catch {
                    if (replay.session !== null) {
                      result.receiptPersisted = await finalizePodSyncReceipt(replay.session, {
                        operationId,
                        attemptId: replay.attemptId,
                        podRid,
                        startedAt: replay.startedAt,
                        finishedAt: now().toISOString(),
                        replayDigest,
                        stagedPathCount: stagedPaths.length,
                        status: "partial",
                        localMutations: 1,
                        failureCode: "pod-proof-commit-failed",
                        replayDisposition: replay.replayDisposition,
                      });
                    }
                    return "pod-proof-commit-failed";
                  }
                }

                if (replay.alreadySucceeded) {
                  result.receiptPersisted = true;
                } else if (replay.session !== null) {
                  result.receiptPersisted = await finalizePodSyncReceipt(replay.session, {
                    operationId,
                    attemptId: replay.attemptId,
                    podRid,
                    startedAt: replay.startedAt,
                    finishedAt: now().toISOString(),
                    replayDigest,
                    stagedPathCount: stagedPaths.length,
                    status: "success",
                    localMutations: 2,
                    proofDigest,
                    replayDisposition: replay.replayDisposition,
                  });
                  if (!result.receiptPersisted) return "receipt-finalize-failed";
                }
              }
              return null;
            })();
            if (lockedFailure !== null) {
              return { ...result, status: "error", reason: lockedFailure };
            }

            // 4. PUSH (outward — only after proof and receipt are durable).
            //    Non-fatal: a pull-only pod (no upstream) or an offline push degrades
            //    to committed-locally; the next sync retries.
            if (push && hasPublishableLedgerCommit && result.proofCommitted && result.receiptPersisted) {
              const repository = `${handle}/lyt-pod`;
              const origin = await git(["remote", "get-url", "origin"], {
                cwd: podDir,
                allowFailure: true,
              });
              const originUrl = origin.stdout.trim();
              const localRemote = origin.code === 0 && isLocalRepositoryRemote(originUrl);
              if (!localRemote && configuredAuthority === undefined) {
                warnings.push(`pod ledger push held: canonical origin must be ${repository}`);
              } else {
                const targetUrl = localRemote ? originUrl : configuredAuthority!.canonicalUrl;
                const localHead = await git(["rev-parse", "HEAD"], { cwd: podDir, allowFailure: true, maxOutputBytes: 256 });
                const remoteHead = await git(["ls-remote", targetUrl, publicationRef], { cwd: podDir, allowFailure: true, maxOutputBytes: 1024 });
                const alreadyPublished = localHead.code === 0 && remoteHead.code === 0 &&
                  localHead.stdout.trim() === (remoteHead.stdout.trim().split(/\s+/u)[0] ?? "");
                if (alreadyPublished) {
                  // Receipt-backed retry already reached the exact configured branch.
                } else if (localRemote) {
                // A filesystem remote is local transport, not a GitHub publication.
                // Keep real-git convergence/dogfood usable without fabricating GitHub
                // permission evidence; unknown/non-GitHub network remotes still fail
                // closed in the canonical-origin branch above.
                const pushed = await git(["push", originUrl, `HEAD:${publicationRef}`], {
                  cwd: podDir,
                  allowFailure: true,
                });
                if (pushed.code === 0) {
                  result.pushed = true;
                } else {
                  warnings.push(
                    `Lyt couldn't send your pod's shared records to your online copy this time — it'll try again next sync. ${narrate(pushed.stderr).nextAction}`,
                  );
                }
                } else {
                const attemptId = args.permissionAttemptId ?? randomUUID();
                try {
                  const pushed = await withFreshPublicationPermission({
                    capability: "repository-push",
                    target: `github:user/${handle}`,
                    repository,
                    actor: handle,
                    attemptId,
                    policyEpoch: 0,
                    permissionObserver: args.permissionObserver ?? observePublicationPermission,
                    publicationSubject: {
                      identity: `pod:${repository.toLowerCase()}`,
                      podRoot: podDir,
                    },
                    action: (attempt) =>
                      attempt.runOutwardChild(() =>
                        git(["push", configuredAuthority!.canonicalUrl, `HEAD:${publicationRef}`], {
                          cwd: podDir,
                          allowFailure: true,
                        }),
                      ),
                  });
                  if (pushed.code === 0) {
                    result.pushed = true;
                  } else {
                    warnings.push(
                      `Lyt couldn't send your pod's shared records to your online copy this time — it'll try again next sync. ${narrate(pushed.stderr).nextAction}`,
                    );
                  }
                } catch (error) {
                  warnings.push(`pod ledger push held: ${errMsg(error)}`);
                }
                }
              }
            }
          }
          return null;
        },
        { subject: `pod-ledger-sync:${uuid7BytesToDashedString(federationState.fedRidBytes)}` },
      ),
    );
    if (lifecycleOutcome !== null) return lifecycleOutcome;

    // 5. RECONSTITUTE the local cache from the union (REUSED wholesale — no
    //    fold/cache logic here). Runs whether or not we pushed: a peer's shards
    //    pulled in step 2 must update our derived cache. Best-effort + non-fatal
    //    (the git sync already succeeded; a cache rebuild hiccup must not fail
    //    the wider `lyt sync`). Shares the open registry so the reconstitution
    //    writes the same db this flow opened.
    try {
      const rebuilt = await rebuildFederationCacheFlow({
        registryDb: db,
        handle,
        ...(args.nowIso !== undefined ? { nowIso: args.nowIso } : {}),
      });
      result.reconstituted = true;
      result.subscriptionsReconstituted = rebuilt.subscriptionsReconstituted;
    } catch (err) {
      // firewall-C1 fix-pass — plain warning; raw error text stays out of it.
      warnings.push(
        "Lyt couldn't rebuild your pod's shared records from the latest data this time. Run `lyt doctor` if it keeps happening.",
      );
    }

    // GC may consume observation watermarks only from a commit proven present
    // on the configured online branch. A working-tree read, successful commit,
    // or attempted push alone is not publication evidence.
    if (push && configuredAuthority !== undefined && priorCanonicalOid.length > 0 && priorCanonicalMachineIds !== undefined) {
      try {
        result.publishedMachineSnapshot = await readVerifiedPublishedMachineSnapshotForTest(git, podDir, {
          canonicalUrl: configuredAuthority.canonicalUrl,
          canonicalRepository: configuredAuthority.canonicalRepository,
          canonicalRef: publicationRef,
          priorCommitOid: priorCanonicalOid,
          priorMachineIds: priorCanonicalMachineIds,
          currentMachineId: getMachineId(),
        });
      } catch {
        result.publishedMachineSnapshot = undefined;
      }
      if (result.publishedMachineSnapshot !== undefined) {
        const expectedOid = result.publishedMachineSnapshot.commitOid;
        result.revalidatePublishedMachineSnapshot = async () => {
          const observed = await git(["ls-remote", configuredAuthority.canonicalUrl, publicationRef], {
            cwd: podDir, allowFailure: true, maxOutputBytes: 1024,
          });
          return observed.code === 0 && exactRemoteOid(observed.stdout, publicationRef) === expectedOid;
        };
      }
    }

    if (conflicted) {
      return { ...result, status: "conflict", reason: "pull-rebase-conflict" };
    }
    return { ...result, status: "synced" };
  } catch (err) {
    return { ...result, status: "error", reason: errMsg(err) };
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}
