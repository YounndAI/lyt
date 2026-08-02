/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  closeOpLog,
  listOps,
  markOpApplied,
  openOpLog,
  appendPendingOp,
  POD_REPAIR_OPERATION_ID_SQL,
} from "../../op/operation-log.js";
import {
  runGitLocalMutation,
  runGitReadOnlyRaw,
  runGitRemoteObservation,
} from "../../util/git-run.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../../util/uuid7.js";
import {
  findRecoverablePodRepairReceiptAttempts as findRecoverableReceiptAttempts,
  type RecoverableTerminalReceiptAttempt,
} from "../../op/receipt-repository.js";
import { getFederationRoot } from "../../util/federation-paths.js";
import { observeLocalPodGitState } from "./pod-git-state.js";
import {
  createPodRecoverySnapshot,
  planPodRecoverySnapshot,
  verifyPodRecoverySnapshot,
  verifyPodRecoverySnapshotAgainstPlan,
  type PodRecoverySnapshotPlan,
  type PodRecoverySnapshotReceipt,
} from "./pod-recovery-snapshot.js";
import { inspectPodRepair, type PodRepairInspectionResult } from "./pod-repair.js";
import { readAuthenticatedPodTransformationEvidence } from "./pod-transformation-proof-ledger.js";

export const POD_REPAIR_PHASES = [
  "planned",
  "staged",
  "remote-updated",
  "original-aside",
  "replacement-active",
  "verified",
] as const;
export type PodRepairPhase = (typeof POD_REPAIR_PHASES)[number];

export interface PodRepairJournalRecord {
  readonly version: 2;
  readonly prior_record_digest: string | null;
  readonly record_digest: string;
  readonly attempt_id: string;
  readonly operation_id: string;
  readonly receipt_replay_digest: string;
  readonly plan_digest: string;
  readonly snapshot_plan_digest: string;
  readonly snapshot_intent: { readonly snapshot_id: string; readonly ref: string };
  readonly snapshot: PodRecoverySnapshotReceipt | null;
  readonly original_identity: DirectoryIdentity | null;
  readonly candidate_identity: DirectoryIdentity | null;
  readonly phase: PodRepairPhase;
  readonly candidate_step:
    | "intended"
    | "directory-created"
    | "repository-initialized"
    | "remote-added"
    | "fetched"
    | "fetched-checked-out"
    | "replay-proof-complete";
  readonly repository_path: string;
  readonly candidate_path: string;
  readonly aside_path: string;
  readonly remote_name: string;
  readonly remote_url: string;
  readonly remote_ref: string;
  readonly branch_ref: string;
  readonly upstream_ref: string;
  readonly expected_old: string;
  readonly replacement_head: string;
  readonly replay: {
    readonly proof_digest: string;
    readonly pod_rid: string;
    readonly operation_id: string;
    readonly replay_key_digest: string;
    readonly before_commit: string;
    readonly after_commit: string;
    readonly affected_paths: readonly string[];
  } | null;
  readonly aside_reservation: DirectoryReservation | null;
  readonly active_reservation: DirectoryReservation | null;
}

export interface DirectoryReservation {
  readonly path: string;
  readonly dev: string | null;
  readonly ino: string | null;
}

export interface DirectoryIdentity {
  readonly realpath: string;
  readonly dev: string;
  readonly ino: string;
  readonly head: string;
  readonly tree: string;
  readonly content_sha256: string;
}

export interface PodRepairApplyDependencies {
  readonly inspect?: () => Promise<PodRepairInspectionResult>;
  readonly attempt_id?: string;
  readonly operation_id?: string;
  readonly replay_digest?: string;
  readonly plan_snapshot?: typeof planPodRecoverySnapshot;
  readonly create_snapshot?: typeof createPodRecoverySnapshot;
  readonly verify_snapshot?: typeof verifyPodRecoverySnapshot;
  readonly now?: () => Date;
  readonly open_journal?: typeof openOpLog;
  readonly close_journal?: typeof closeOpLog;
  readonly list_journal?: typeof listOps;
  readonly append_phase?: typeof appendPendingOp;
  readonly complete_phase?: typeof markOpApplied;
  readonly move_directory?: typeof moveDirectoryNoClobber;
  readonly after_phase?: (phase: PodRepairPhase) => void;
  readonly after_mutation?: (
    mutation:
      | "snapshot-ref"
      | "candidate-mkdir"
      | "candidate-init"
      | "candidate-remote"
      | "candidate-fetch"
      | "candidate-checkout"
      | "candidate-fetch-checkout"
      | "candidate-replay"
      | "aside-reservation-mkdir"
      | "active-reservation-mkdir"
      | "stage"
      | "remote-cas"
      | "original-aside"
      | "replacement-active"
      | "verified",
  ) => void;
  readonly observe_local?: typeof observeLocalPodGitState;
  readonly resolve_consumed_path?: () => string;
}

export interface PodRepairApplyResult {
  readonly mode: "apply";
  readonly status: "success" | "no-op" | "refused" | "partial" | "failed";
  readonly exit_code: 0 | 1 | 2;
  readonly repository_path: string;
  readonly target_commit: string | null;
  /** Legacy receipt slot; namespace-swap retains the complete original repository instead. */
  readonly snapshot: PodRecoverySnapshotReceipt | null;
  readonly local_mutations: number;
  readonly remote_mutations: number;
  readonly replayed_transformations: number;
  readonly error_code: string | null;
  readonly summary: string;
  readonly attempt_id: string | null;
  readonly phase: PodRepairPhase | null;
  readonly retained_original_path: string | null;
  readonly retained_original_identity: DirectoryIdentity | null;
  readonly replay_disposition: "new" | "resumed";
  readonly resumed_from_phase?: PodRepairPhase | null;
}

export interface PendingPodRepairReceiptAttempt {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly started_at: string;
}

export type RecoverablePodRepairReceiptAttempt = RecoverableTerminalReceiptAttempt;

export interface PendingPodRepairJournalIdentity {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly replay_digest: string;
  readonly plan_digest: string;
  readonly phase: PodRepairPhase;
  readonly local_mutations: number;
  readonly remote_mutations: number;
}

export interface PodRepairLogicalPlan {
  readonly replay_digest: string;
}

/** Build the stable, read-only replay identity before any operation UUID is allocated. */
export async function planPodRepairPreserveBoth(
  dependencies: Pick<PodRepairApplyDependencies, "inspect" | "plan_snapshot"> = {},
): Promise<PodRepairLogicalPlan> {
  const before = await (dependencies.inspect ?? inspectPodRepair)();
  const remote = verifiedRemote(before);
  const transformations = before.evidence.provenance?.transformations ?? [];
  const snapshotPlan = (dependencies.plan_snapshot ?? planPodRecoverySnapshot)(
    before.repository_path,
  );
  return Object.freeze({
    replay_digest: logicalReplayDigest(before, remote, transformations, snapshotPlan),
  });
}

export async function findPendingPodRepairJournalIdentities(
  operationIds: readonly string[] = [],
  dependencies: Pick<PodRepairApplyDependencies, "open_journal" | "close_journal"> = {},
): Promise<readonly PendingPodRepairJournalIdentity[]> {
  if (operationIds.length === 0) return [];
  const db = await (dependencies.open_journal ?? openOpLog)();
  try {
    const entries = (
      await Promise.all(
        [...new Set(operationIds)].map((operationId) =>
          pendingAttempts(db, listOps, operationId, true),
        ),
      )
    ).flat();
    return await Promise.all(
      entries.map(async (entry) => {
        const mutations = await observeMutationCounts(entry);
        return {
          operation_id: entry.operation_id,
          attempt_id: entry.attempt_id,
          replay_digest: entry.receipt_replay_digest,
          plan_digest: entry.plan_digest,
          phase: entry.phase,
          local_mutations: mutations.local,
          remote_mutations: mutations.remote,
        };
      }),
    );
  } finally {
    await (dependencies.close_journal ?? closeOpLog)(db);
  }
}

/** Locate, but never mutate, the bounded Receipt V1 crash boundary for this verb. */
export async function findPendingPodRepairReceiptAttempts(): Promise<
  readonly PendingPodRepairReceiptAttempt[]
> {
  const db = await openOpLog();
  try {
    const found = await db.execute({
      sql: `SELECT a.operation_id, a.attempt_id, a.started_at
              FROM operation_attempts a
              JOIN operations o ON o.operation_id = a.operation_id
             WHERE o.operation = 'pod-repair'
               AND a.finished_at IS NULL
               AND a.receipt_json IS NULL
             ORDER BY a.started_at ASC, a.attempt_id ASC
             LIMIT 2`,
      args: [],
    });
    return found.rows.map((row) => ({
      operation_id: uuid7BytesToDashedString(blobBytes(row["operation_id"])),
      attempt_id: uuid7BytesToDashedString(blobBytes(row["attempt_id"])),
      started_at: String(row["started_at"]),
    }));
  } finally {
    await closeOpLog(db);
  }
}

export async function findRecoverablePodRepairReceiptAttempts(): Promise<
  readonly RecoverablePodRepairReceiptAttempt[]
> {
  const db = await openOpLog();
  try {
    return await findRecoverableReceiptAttempts(db);
  } finally {
    await closeOpLog(db);
  }
}

/**
 * Lossless preserve-both recovery. A verified sibling candidate is published
 * with expected-old CAS, then the complete original repository and candidate
 * exchange names through two same-parent atomic renames. The original is never
 * reset, cleaned, copied, merged, or deleted.
 */
export async function applyPodRepairPreserveBoth(
  dependencies: PodRepairApplyDependencies = {},
): Promise<PodRepairApplyResult> {
  const inspect = dependencies.inspect ?? inspectPodRepair;
  const moveDirectory = dependencies.move_directory ?? moveDirectoryNoClobber;
  const now = dependencies.now ?? (() => new Date());
  const journal = await (dependencies.open_journal ?? openOpLog)();
  try {
    let pending: PodRepairJournalRecord[];
    try {
      pending = await pendingAttempts(
        journal,
        dependencies.list_journal ?? listOps,
        dependencies.operation_id,
      );
    } catch (error) {
      return refused(
        "",
        errorCode(error),
        "The durable pod repair journal is malformed or fails its immutable plan seal.",
      );
    }
    if (pending.length > 1) {
      return refused(
        "",
        "pod-repair-multiple-pending-attempts",
        "Multiple incomplete pod repair attempts require inspection before any mutation.",
      );
    }

    let record = pending[0] ?? null;
    const resumed = record !== null;
    const resumedFromPhase = record?.phase ?? null;
    let phase = record?.phase ?? null;
    if (record === null) {
      const before = await inspect();
      if (before.decision.action === "no-op") {
        return result(
          before.repository_path,
          "no-op",
          0,
          null,
          0,
          0,
          null,
          "The pod is already converged.",
          null,
          null,
          null,
        );
      }
      const remote = verifiedRemote(before);
      if (remote === null || before.state.operation !== "normal") {
        return refused(
          before.repository_path,
          "pod-repair-apply-precondition-failed",
          "Preserve-both requires complete, stable local and remote evidence.",
        );
      }
      try {
        assertSupportedTopology(before.repository_path);
      } catch (error) {
        return refused(
          before.repository_path,
          errorCode(error),
          "The pod uses a repository or filesystem topology that preserve-both does not support.",
        );
      }
      const attemptId = dependencies.attempt_id ?? uuid7BytesToDashedString(newUuidv7Bytes());
      const operationId = dependencies.operation_id ?? attemptId;
      const transformations = before.evidence.provenance?.transformations ?? [];
      if (transformations.length > 1) {
        return refused(
          before.repository_path,
          "pod-repair-ambiguous-proven-transformations",
          "Preserve-both will not guess between multiple independently proven transformations.",
        );
      }
      const transformation = transformations[0];
      const parent = dirname(before.repository_path);
      const leaf = basename(before.repository_path);
      const snapshotPlan = (dependencies.plan_snapshot ?? planPodRecoverySnapshot)(
        before.repository_path,
      );
      const snapshotDigest = digestSnapshotPlan(snapshotPlan);
      const replayDigest = logicalReplayDigest(before, remote, transformations, snapshotPlan);
      if (dependencies.replay_digest !== undefined && dependencies.replay_digest !== replayDigest)
        return refused(
          before.repository_path,
          "pod-repair-replay-plan-changed",
          "The read-only pod repair plan changed before the durable attempt could begin.",
        );
      const snapshotId = deterministicUuidV7(
        sha256Canonical({
          strategy: "preserve-both",
          repository_path: resolve(before.repository_path),
          remote_url: remote.url,
          remote_ref: remote.ref,
          expected_old: remote.sha,
          snapshot_plan_digest: snapshotDigest,
        }),
      );
      const immutablePlan = {
        operation_id: operationId,
        repository_path: before.repository_path,
        candidate_path: join(parent, `.${leaf}.lyt-repair-${operationId}.candidate`),
        aside_path: join(parent, `.${leaf}.lyt-repair-${operationId}.original`),
        remote_name: remote.name,
        remote_url: remote.url,
        remote_ref: remote.ref,
        branch_ref: before.evidence.local.evidence.branch_ref!,
        upstream_ref: `refs/remotes/${remote.name}/${branchName(remote.ref)}`,
        expected_old: remote.sha,
        replay_proof_digest: transformation?.proof_digest ?? null,
        snapshot_plan_digest: snapshotDigest,
      };
      const planDigest = sha256Json(immutablePlan);
      record = {
        version: 2,
        prior_record_digest: null,
        record_digest: "",
        attempt_id: attemptId,
        operation_id: operationId,
        receipt_replay_digest: replayDigest,
        plan_digest: planDigest,
        snapshot_plan_digest: snapshotDigest,
        snapshot_intent: {
          snapshot_id: snapshotId,
          ref: `refs/lyt/recovery/pod/${snapshotId}`,
        },
        snapshot: null,
        original_identity: null,
        candidate_identity: null,
        phase: "planned",
        candidate_step: "intended",
        repository_path: before.repository_path,
        candidate_path: immutablePlan.candidate_path,
        aside_path: immutablePlan.aside_path,
        remote_name: remote.name,
        remote_url: remote.url,
        remote_ref: remote.ref,
        branch_ref: immutablePlan.branch_ref,
        upstream_ref: immutablePlan.upstream_ref,
        expected_old: remote.sha,
        replacement_head: remote.sha,
        replay:
          transformation === undefined
            ? null
            : {
                proof_digest: transformation.proof_digest,
                pod_rid: transformation.proof.pod_rid,
                operation_id: transformation.proof.operation_id,
                replay_key_digest: transformation.proof.replay_key_digest,
                before_commit: transformation.proof.before_commit,
                after_commit: transformation.proof.after_commit,
                affected_paths: transformation.proof.affected_paths,
              },
        aside_reservation: null,
        active_reservation: null,
      };
      assertSiblingPaths(record);
      assertAbsent(record.candidate_path);
      assertAbsent(record.aside_path);
      record = await writePhase(journal, record, "planned", dependencies, now());
      phase = "planned";
    } else {
      assertSiblingPaths(record);
      assertSupportedResumeTopology(record);
    }

    try {
      if (phase === null) throw coded("pod-repair-journal-phase-missing");
      await assertRemoteReconcileValue(record);
      phase = await reconcileNamespacePhase(record, phase);
      record = { ...record, phase };
      if (phase === "planned") {
        assertConsumedRootPath(record, dependencies);
        if (record.snapshot === null || record.original_identity === null) {
          const snapshotPlan = (dependencies.plan_snapshot ?? planPodRecoverySnapshot)(
            record.repository_path,
          );
          if (digestSnapshotPlan(snapshotPlan) !== record.snapshot_plan_digest)
            throw coded("pod-repair-snapshot-source-changed");
          const snapshot = (dependencies.create_snapshot ?? createPodRecoverySnapshot)(
            snapshotPlan,
            {
              snapshot_id: record.snapshot_intent.snapshot_id,
              hooks: {
                afterRefUpdate: () => dependencies.after_mutation?.("snapshot-ref"),
              },
            },
          );
          if (snapshot.ref !== record.snapshot_intent.ref)
            throw coded("pod-repair-snapshot-intent-mismatch");
          verifyPodRecoverySnapshotAgainstPlan(snapshotPlan, snapshot.ref);
          record = {
            ...record,
            snapshot,
            original_identity: await directoryIdentity(record.repository_path),
          };
          record = await writePhase(journal, record, "planned", dependencies, now());
        } else {
          await assertDirectoryIdentity(record.repository_path, record.original_identity);
          const snapshotPlan = (dependencies.plan_snapshot ?? planPodRecoverySnapshot)(
            record.repository_path,
          );
          if (digestSnapshotPlan(snapshotPlan) !== record.snapshot_plan_digest)
            throw coded("pod-repair-snapshot-source-changed");
          verifyPodRecoverySnapshotAgainstPlan(snapshotPlan, record.snapshot.ref);
        }
        record = await advanceCandidateStaging(record, journal, dependencies, now);
        const replacementHead = await validateUnjournaledCandidate(record);
        record = {
          ...record,
          replacement_head: replacementHead,
          candidate_identity: await directoryIdentity(record.candidate_path),
        };
        await verifyCandidate(record);
        record = await writePhase(journal, record, "staged", dependencies, now());
        record = { ...record, phase: "staged" };
        phase = "staged";
      }
      if (phase === "staged") {
        assertConsumedRootPath(record, dependencies);
        await assertDirectoryIdentity(record.repository_path, record.original_identity!);
        const remoteBeforeCas = await observeRemoteSha(record);
        if (remoteBeforeCas === record.expected_old) {
          await assertDirectoryIdentity(record.candidate_path, record.candidate_identity!);
        } else if (remoteBeforeCas === record.replacement_head) {
          await validateUnjournaledCandidate(record);
        } else {
          throw coded("pod-repair-remote-third-value-drift");
        }
        const remoteMutated = await updateRemoteCas(record);
        if (remoteMutated) dependencies.after_mutation?.("remote-cas");
        record = { ...record, candidate_identity: await directoryIdentity(record.candidate_path) };
        record = await writePhase(journal, record, "remote-updated", dependencies, now());
        record = { ...record, phase: "remote-updated" };
        phase = "remote-updated";
      }
      if (phase === "remote-updated") {
        assertConsumedRootPath(record, dependencies);
        await assertRemoteAtReplacement(record);
        await verifyCandidate(record);
        await assertDirectoryIdentity(record.repository_path, record.original_identity!);
        await assertDirectoryIdentity(record.candidate_path, record.candidate_identity!);
        const prepared = await prepareMoveReservation(
          record,
          "aside",
          journal,
          dependencies,
          now(),
        );
        record = prepared.record;
        await moveDirectory(record.repository_path, record.aside_path, prepared.reservation);
        dependencies.after_mutation?.("original-aside");
        record = await writePhase(journal, record, "original-aside", dependencies, now());
        record = { ...record, phase: "original-aside" };
        phase = "original-aside";
      }
      if (phase === "original-aside") {
        assertConsumedRootPath(record, dependencies);
        await assertRemoteAtReplacement(record);
        await assertDirectoryIdentity(record.aside_path, record.original_identity!, true);
        await assertDirectoryIdentity(record.candidate_path, record.candidate_identity!);
        const prepared = await prepareMoveReservation(
          record,
          "active",
          journal,
          dependencies,
          now(),
        );
        record = prepared.record;
        await moveDirectory(record.candidate_path, record.repository_path, prepared.reservation);
        dependencies.after_mutation?.("replacement-active");
        record = await writePhase(journal, record, "replacement-active", dependencies, now());
        record = { ...record, phase: "replacement-active" };
        phase = "replacement-active";
      }
      if (phase === "replacement-active") {
        const repositoryPath = record.repository_path;
        await verifyActive(
          record,
          dependencies.observe_local ?? observeLocalPodGitState,
          dependencies.resolve_consumed_path ??
            (dependencies.inspect === undefined ? getFederationRoot : () => repositoryPath),
        );
        dependencies.after_mutation?.("verified");
        record = await writePhase(journal, record, "verified", dependencies, now());
        record = { ...record, phase: "verified" };
        phase = "verified";
      }
      if (phase === "verified") {
        const repositoryPath = record.repository_path;
        await verifyActive(
          record,
          dependencies.observe_local ?? observeLocalPodGitState,
          dependencies.resolve_consumed_path ??
            (dependencies.inspect === undefined ? getFederationRoot : () => repositoryPath),
        );
      }
      const mutations = await observeMutationCounts(record);
      return result(
        record.repository_path,
        "success",
        0,
        record.replacement_head,
        mutations.local,
        mutations.remote,
        null,
        "The verified replacement is active at the unchanged pod path; the complete original repository is retained beside it.",
        record.attempt_id,
        phase,
        record.aside_path,
        record.replay === null ? 0 : 1,
        record.snapshot,
        record.original_identity,
        resumed ? "resumed" : "new",
        resumedFromPhase,
      );
    } catch (error) {
      const mutations = await observeMutationCounts(record);
      const mutated = mutations.local + mutations.remote > 0;
      return result(
        record.repository_path,
        mutated ? "partial" : "failed",
        mutated ? 2 : 1,
        record.replacement_head,
        mutations.local,
        mutations.remote,
        errorCode(error),
        "Preserve-both stopped without overwriting or deleting either repository. Retry the same supported Lyt repair command to reconcile the durable attempt.",
        record.attempt_id,
        phase,
        existsSync(record.aside_path) ? record.aside_path : null,
        0,
        record.snapshot,
        existsSync(record.aside_path) ? record.original_identity : null,
        resumed ? "resumed" : "new",
      );
    }
  } finally {
    await (dependencies.close_journal ?? closeOpLog)(journal).catch(() => undefined);
  }
}

function assertConsumedRootPath(
  record: PodRepairJournalRecord,
  dependencies: PodRepairApplyDependencies,
): void {
  const resolved =
    dependencies.resolve_consumed_path?.() ??
    (dependencies.inspect === undefined ? getFederationRoot() : record.repository_path);
  if (normalizeIdentityPath(resolved) !== normalizeIdentityPath(record.repository_path))
    throw coded("pod-repair-consumed-root-identity-mismatch");
}

async function reconcileNamespacePhase(
  record: PodRepairJournalRecord,
  journalPhase: PodRepairPhase,
): Promise<PodRepairPhase> {
  if (record.original_identity === null) return journalPhase;
  const originalAtCanonical = await identityMatches(
    record.repository_path,
    record.original_identity,
    false,
  );
  const originalAside = await identityMatches(record.aside_path, record.original_identity, true);
  const candidateAtStaging =
    record.candidate_identity !== null &&
    (await identityMatches(record.candidate_path, record.candidate_identity, false));
  const candidateActive =
    record.candidate_identity !== null &&
    (await identityMatches(record.repository_path, record.candidate_identity, true));
  if (originalAside && candidateActive)
    return journalPhase === "verified" ? "verified" : "replacement-active";
  if (originalAside && candidateAtStaging) return "original-aside";
  if (originalAtCanonical) return journalPhase;
  throw coded("pod-repair-namespace-identity-ambiguous");
}

async function identityMatches(
  path: string,
  expected: DirectoryIdentity,
  allowMoved: boolean,
): Promise<boolean> {
  if (lstatMaybe(path) === null) return false;
  try {
    await assertDirectoryIdentity(path, expected, allowMoved);
    return true;
  } catch {
    return false;
  }
}

async function pendingAttempts(
  db: Awaited<ReturnType<typeof openOpLog>>,
  list: typeof listOps,
  includeVerifiedOperationId?: string,
  includeAllVerified = false,
): Promise<PodRepairJournalRecord[]> {
  const rows =
    includeVerifiedOperationId !== undefined && list === listOps
      ? await operationJournalRows(db, includeVerifiedOperationId)
      : await list(db, 500);
  const chains = new Map<string, PodRepairJournalRecord[]>();
  for (const row of rows) {
    if (row.kind !== "pod-repair-namespace-swap" || row.fileSet.length !== 1) continue;
    const parsed = parseJournal(row.fileSet[0]!);
    if (parsed === null) throw coded("pod-repair-journal-seal-invalid");
    const chain = chains.get(parsed.operation_id) ?? [];
    chain.push(parsed);
    chains.set(parsed.operation_id, chain);
  }
  const latest: PodRepairJournalRecord[] = [];
  for (const chain of chains.values()) {
    for (let index = 0; index < chain.length; index += 1) {
      const newer = chain[index]!;
      const older = chain[index + 1];
      if (
        (older === undefined
          ? newer.prior_record_digest !== null
          : newer.prior_record_digest !== older.record_digest) ||
        (older !== undefined &&
          (newer.operation_id !== older.operation_id ||
            newer.attempt_id !== older.attempt_id ||
            newer.receipt_replay_digest !== older.receipt_replay_digest ||
            newer.plan_digest !== older.plan_digest))
      )
        throw coded("pod-repair-journal-chain-invalid");
    }
    latest.push(chain[0]!);
  }
  return latest.filter(
    (entry) =>
      entry.phase !== "verified" ||
      includeAllVerified ||
      entry.operation_id === includeVerifiedOperationId,
  );
}

async function operationJournalRows(
  db: Awaited<ReturnType<typeof openOpLog>>,
  operationId: string,
): Promise<readonly { kind: string; fileSet: string[] }[]> {
  if (!isUuidV7OrV8(operationId)) throw coded("pod-repair-operation-id-invalid");
  const maximumRows = 32;
  const found = await db.execute({
    sql: `SELECT kind, file_set
           FROM op_log
           WHERE kind = 'pod-repair-namespace-swap'
             AND (${POD_REPAIR_OPERATION_ID_SQL}) = ?
           ORDER BY id DESC
           LIMIT ?`,
    args: [operationId, maximumRows + 1],
  });
  if (found.rows.length > maximumRows) throw coded("pod-repair-journal-row-limit-exceeded");
  return found.rows.map((row) => {
    let fileSet: unknown;
    try {
      fileSet = JSON.parse(String(row["file_set"]));
    } catch {
      throw coded("pod-repair-journal-seal-invalid");
    }
    if (!Array.isArray(fileSet) || fileSet.length !== 1 || typeof fileSet[0] !== "string")
      throw coded("pod-repair-journal-seal-invalid");
    return { kind: String(row["kind"]), fileSet };
  });
}

function parseJournal(value: string): PodRepairJournalRecord | null {
  try {
    const v = JSON.parse(value) as Partial<PodRepairJournalRecord>;
    if (
      v.version !== 2 ||
      !(v.prior_record_digest === null || isSha256(v.prior_record_digest)) ||
      !isSha256(v.record_digest) ||
      !isUuidV7(v.attempt_id) ||
      !isUuidV7OrV8(v.operation_id) ||
      !isSha256(v.receipt_replay_digest) ||
      !isSha256(v.plan_digest) ||
      !POD_REPAIR_PHASES.includes(v.phase as PodRepairPhase)
    )
      return null;
    for (const key of [
      "repository_path",
      "candidate_path",
      "aside_path",
      "remote_name",
      "remote_url",
      "remote_ref",
      "branch_ref",
      "upstream_ref",
      "expected_old",
      "replacement_head",
      "snapshot_plan_digest",
    ] as const)
      if (typeof v[key] !== "string") return null;
    if (
      !isCanonicalAbsolutePath(v.repository_path) ||
      !isCanonicalAbsolutePath(v.candidate_path) ||
      !isCanonicalAbsolutePath(v.aside_path) ||
      !isNonEmptyString(v.remote_name) ||
      !isNonEmptyString(v.remote_url) ||
      typeof v.remote_ref !== "string" ||
      !v.remote_ref.startsWith("refs/heads/") ||
      typeof v.branch_ref !== "string" ||
      !v.branch_ref.startsWith("refs/heads/") ||
      typeof v.upstream_ref !== "string" ||
      !v.upstream_ref.startsWith(`refs/remotes/${v.remote_name}/`) ||
      !isGitObjectId(v.expected_old) ||
      !isGitObjectId(v.replacement_head) ||
      !isSha256(v.snapshot_plan_digest)
    )
      return null;
    if (v.replay !== null) {
      if (typeof v.replay !== "object" || v.replay === undefined) return null;
      const replay = v.replay as Partial<NonNullable<PodRepairJournalRecord["replay"]>>;
      if (
        !isSha256(replay.proof_digest) ||
        !isUuidV7OrV8(replay.pod_rid) ||
        !isUuidV7OrV8(replay.operation_id) ||
        !isSha256(replay.replay_key_digest) ||
        !isGitObjectId(replay.before_commit) ||
        !isGitObjectId(replay.after_commit) ||
        !Array.isArray(replay.affected_paths) ||
        !replay.affected_paths.every((path) => typeof path === "string")
      )
        return null;
    }
    if (!validReservation(v.aside_reservation) || !validReservation(v.active_reservation))
      return null;
    if (
      typeof v.snapshot_intent !== "object" ||
      v.snapshot_intent === null ||
      !isUuidV7(v.snapshot_intent.snapshot_id) ||
      v.snapshot_intent.ref !== `refs/lyt/recovery/pod/${v.snapshot_intent.snapshot_id}` ||
      ![
        "intended",
        "directory-created",
        "repository-initialized",
        "remote-added",
        "fetched",
        "fetched-checked-out",
        "replay-proof-complete",
      ].includes(String(v.candidate_step))
    )
      return null;
    if (
      !validSnapshot(v.snapshot) ||
      !validDirectoryIdentity(v.original_identity) ||
      !validDirectoryIdentity(v.candidate_identity)
    )
      return null;
    const sealed = v as PodRepairJournalRecord;
    if (sealed.record_digest !== digestFullJournalRecord(sealed)) return null;
    if (sealed.plan_digest !== digestJournalPlan(sealed)) return null;
    if (
      sealed.phase !== "planned" &&
      (sealed.snapshot === null ||
        sealed.original_identity === null ||
        sealed.candidate_identity === null)
    )
      return null;
    return sealed;
  } catch {
    return null;
  }
}

function validSnapshot(value: unknown): value is PodRecoverySnapshotReceipt | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === undefined) return false;
  const snapshot = value as Partial<PodRecoverySnapshotReceipt>;
  return (
    isUuidV7(snapshot.snapshot_id) &&
    snapshot.ref === `refs/lyt/recovery/pod/${snapshot.snapshot_id}` &&
    isGitObjectId(snapshot.commit_sha) &&
    isSha256(snapshot.manifest_sha256)
  );
}

function validDirectoryIdentity(value: unknown): value is DirectoryIdentity | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === undefined) return false;
  const identity = value as Partial<DirectoryIdentity>;
  return (
    isCanonicalAbsolutePath(identity.realpath) &&
    isUnsignedInteger(identity.dev) &&
    isUnsignedInteger(identity.ino) &&
    isGitObjectId(identity.head) &&
    isGitObjectId(identity.tree) &&
    isSha256(identity.content_sha256)
  );
}

function validReservation(value: unknown): value is DirectoryReservation | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === undefined) return false;
  const reservation = value as Partial<DirectoryReservation>;
  return (
    isCanonicalAbsolutePath(reservation.path) &&
    (reservation.dev === null || isUnsignedInteger(reservation.dev)) &&
    (reservation.ino === null || isUnsignedInteger(reservation.ino)) &&
    (reservation.dev === null) === (reservation.ino === null)
  );
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && resolve(value) === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUnsignedInteger(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value);
}

function isUuidV7(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function isUuidV7OrV8(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

function deterministicUuidV7(sha256: string): string {
  const hex = sha256.slice(0, 32).split("");
  hex[12] = "7";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex
    .slice(12, 16)
    .join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
  if (!isUuidV7(value)) throw coded("pod-repair-deterministic-id-failed");
  return value;
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

async function prepareMoveReservation(
  record: PodRepairJournalRecord,
  destination: "aside" | "active",
  journal: Awaited<ReturnType<typeof openOpLog>>,
  dependencies: PodRepairApplyDependencies,
  at: Date,
): Promise<{ record: PodRepairJournalRecord; reservation: DirectoryReservation | null }> {
  if (process.platform === "win32") {
    const path = destination === "aside" ? record.aside_path : record.repository_path;
    assertAbsent(path);
    return { record, reservation: null };
  }
  const key = destination === "aside" ? "aside_reservation" : "active_reservation";
  const path = destination === "aside" ? record.aside_path : record.repository_path;
  let reservation = record[key];
  if (reservation === null) {
    reservation = { path, dev: null, ino: null };
    record = { ...record, [key]: reservation };
    record = await writePhase(journal, record, record.phase, dependencies, at);
  }
  if (reservation.dev === null || reservation.ino === null) {
    const existing = lstatMaybe(path);
    if (existing === null) {
      mkdirSync(path, { mode: 0o700 });
      dependencies.after_mutation?.(
        destination === "aside" ? "aside-reservation-mkdir" : "active-reservation-mkdir",
      );
    } else if (
      !existing.isDirectory() ||
      existing.isSymbolicLink() ||
      readdirSync(path).length !== 0
    ) {
      throw coded("pod-repair-reservation-identity-mismatch");
    }
    const stat = lstatSync(path);
    reservation = { path, dev: String(stat.dev), ino: String(stat.ino) };
    record = { ...record, [key]: reservation };
    record = await writePhase(journal, record, record.phase, dependencies, at);
  } else {
    assertExactEmptyReservation(reservation);
  }
  return { record, reservation };
}

/**
 * Move a complete directory without clobbering any pre-existing namespace.
 * On POSIX the only consumed destination entry is the exact empty sacrificial
 * directory whose device/inode identity was durably journaled. Its metadata is
 * intentionally not preserved; every source entry and file-content byte is.
 */
export async function moveDirectoryNoClobber(
  source: string,
  destination: string,
  reservation: DirectoryReservation | null,
): Promise<void> {
  assertSameVolume(source, destination);
  if (process.platform === "win32") {
    if (reservation !== null) throw coded("pod-repair-invalid-windows-reservation");
    assertAbsent(destination);
    const script =
      "$ErrorActionPreference='Stop';$s=$env:LYT_MOVE_SOURCE;$d=$env:LYT_MOVE_DESTINATION;" +
      "if([IO.File]::Exists($d)-or[IO.Directory]::Exists($d)){exit 17};" +
      "[IO.Directory]::Move($s,$d)";
    try {
      execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 120_000,
          maxBuffer: 65_536,
          env: {
            ...process.env,
            LYT_MOVE_SOURCE: source,
            LYT_MOVE_DESTINATION: destination,
          },
        },
      );
    } catch {
      throw coded("pod-repair-namespace-move-refused");
    }
    return;
  }
  if (reservation === null || resolve(reservation.path) !== resolve(destination))
    throw coded("pod-repair-posix-reservation-required");
  assertExactEmptyReservation(reservation);
  try {
    renameSync(source, destination);
  } catch {
    throw coded("pod-repair-namespace-move-refused");
  }
}

function assertExactEmptyReservation(reservation: DirectoryReservation): void {
  if (reservation.dev === null || reservation.ino === null)
    throw coded("pod-repair-reservation-identity-mismatch");
  const stat = lstatMaybe(reservation.path);
  if (
    stat === null ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    String(stat.dev) !== reservation.dev ||
    String(stat.ino) !== reservation.ino ||
    readdirSync(reservation.path).length !== 0
  )
    throw coded("pod-repair-reservation-identity-mismatch");
}

async function writePhase(
  db: Awaited<ReturnType<typeof openOpLog>>,
  base: PodRepairJournalRecord,
  phase: PodRepairPhase,
  dependencies: PodRepairApplyDependencies,
  at: Date,
): Promise<PodRepairJournalRecord> {
  const unsealed = {
    ...base,
    phase,
    prior_record_digest: base.record_digest === "" ? null : base.record_digest,
    record_digest: "",
  } satisfies PodRepairJournalRecord;
  const record = { ...unsealed, record_digest: digestFullJournalRecord(unsealed) };
  const append = dependencies.append_phase ?? appendPendingOp;
  const complete = dependencies.complete_phase ?? markOpApplied;
  const id = await append(
    db,
    {
      kind: "pod-repair-namespace-swap",
      horizon: phase === "remote-updated" ? "pushed" : "local",
      fileSet: [JSON.stringify(record)],
      inverse: {
        class: "compensating",
        note: "Retry the supported Lyt preserve-both repair action.",
      },
    },
    at.toISOString(),
  );
  await complete(
    db,
    id,
    {
      horizon: phase === "remote-updated" ? "pushed" : "local",
      inverse: {
        class: "compensating",
        note: "Retry the supported Lyt preserve-both repair action.",
      },
    },
    at.toISOString(),
  );
  dependencies.after_phase?.(phase);
  return record;
}

function digestFullJournalRecord(record: PodRepairJournalRecord): string {
  const { record_digest: _ignored, ...bound } = record;
  return sha256Canonical(bound);
}

function verifiedRemote(
  inspection: PodRepairInspectionResult,
): { name: string; url: string; ref: string; sha: string } | null {
  const remote = inspection.evidence.remote;
  const branch = inspection.evidence.local.evidence.branch_ref;
  if (
    inspection.state.repository !== "present" ||
    branch === null ||
    remote?.remote !== "reachable" ||
    remote.check !== "complete" ||
    remote.evidence.remote_name === null ||
    remote.evidence.advertised_ref === null ||
    remote.evidence.advertised_sha === null ||
    remote.evidence.graph_source !== "advertised-known-object"
  )
    return null;
  const url = readGitTextSync(inspection.repository_path, [
    "config",
    "--get-all",
    `remote.${remote.evidence.remote_name}.url`,
  ]);
  if (url.length === 0 || url.includes("\n")) return null;
  return {
    name: remote.evidence.remote_name,
    url,
    ref: remote.evidence.advertised_ref,
    sha: remote.evidence.advertised_sha,
  };
}

function logicalReplayDigest(
  before: PodRepairInspectionResult,
  remote: ReturnType<typeof verifiedRemote>,
  transformations: NonNullable<
    NonNullable<PodRepairInspectionResult["evidence"]["provenance"]>["transformations"]
  >,
  snapshotPlan: PodRecoverySnapshotPlan,
): string {
  const snapshotPlanDigest = digestSnapshotPlan(snapshotPlan);
  const transformation = transformations.length === 1 ? transformations[0]! : null;
  return sha256Canonical({
    strategy: "preserve-both",
    pod_identity: {
      pod_rid: transformation?.proof.pod_rid ?? null,
      federation_root: normalizeIdentityPath(before.repository_path),
    },
    source_fingerprint: {
      repository: before.state.repository,
      workspace: before.state.workspace,
      operation: before.state.operation,
      graph: before.state.graph,
      branch_ref: before.evidence.local.evidence.branch_ref,
      head_sha: before.evidence.local.evidence.head_sha,
      snapshot_plan_digest: snapshotPlanDigest,
    },
    remote: remote === null ? null : remote,
    proof:
      transformation === null
        ? null
        : { digest: transformation.proof_digest, identity: transformation.proof },
    snapshot_plan: {
      digest: snapshotPlanDigest,
      head: snapshotPlan.head,
      branch: snapshotPlan.branch,
      index_sha256: snapshotPlan.index_sha256,
      shared_index_sha256: snapshotPlan.shared_index_sha256,
      worktree_fingerprint: snapshotPlan.worktree_fingerprint,
      material_bytes: snapshotPlan.material_bytes,
      paths: snapshotPlan.paths,
    },
  });
}

async function advanceCandidateStaging(
  initial: PodRepairJournalRecord,
  journal: Awaited<ReturnType<typeof openOpLog>>,
  dependencies: PodRepairApplyDependencies,
  now: () => Date,
): Promise<PodRepairJournalRecord> {
  let record = initial;
  if (record.candidate_step === "intended") {
    const existing = lstatMaybe(record.candidate_path);
    if (existing === null) {
      mkdirSync(record.candidate_path, { recursive: false });
      dependencies.after_mutation?.("candidate-mkdir");
    } else if (
      !existing.isDirectory() ||
      existing.isSymbolicLink() ||
      readdirSync(record.candidate_path).length !== 0
    ) {
      throw coded("pod-repair-candidate-substep-mismatch");
    }
    record = { ...record, candidate_step: "directory-created" };
    record = await writePhase(journal, record, "planned", dependencies, now());
  }
  if (record.candidate_step === "directory-created") {
    const entries = readdirSync(record.candidate_path);
    if (entries.length === 0) {
      const init = await runGitLocalMutation(["init", "-b", branchName(record.remote_ref)], {
        cwd: record.candidate_path,
        allowFailure: true,
      });
      if (init.code !== 0) throw coded("pod-repair-candidate-stage-failed");
      dependencies.after_mutation?.("candidate-init");
    } else if (entries.length !== 1 || entries[0] !== ".git") {
      throw coded("pod-repair-candidate-substep-mismatch");
    }
    const head = await runGitReadOnlyRaw(["rev-parse", "--verify", "HEAD"], {
      cwd: record.candidate_path,
      allowFailure: true,
    });
    if (head.code === 0) throw coded("pod-repair-candidate-substep-mismatch");
    record = { ...record, candidate_step: "repository-initialized" };
    record = await writePhase(journal, record, "planned", dependencies, now());
  }
  if (record.candidate_step === "repository-initialized") {
    const configured = readGitTextSync(
      record.candidate_path,
      ["config", "--get-all", `remote.${record.remote_name}.url`],
      true,
    );
    if (configured === "") {
      const added = await runGitLocalMutation(
        ["remote", "add", record.remote_name, record.remote_url],
        { cwd: record.candidate_path, allowFailure: true },
      );
      if (added.code !== 0) throw coded("pod-repair-candidate-stage-failed");
      dependencies.after_mutation?.("candidate-remote");
    } else if (configured !== record.remote_url) {
      throw coded("pod-repair-candidate-substep-mismatch");
    }
    record = { ...record, candidate_step: "remote-added" };
    record = await writePhase(journal, record, "planned", dependencies, now());
  }
  if (record.candidate_step === "remote-added") {
    let fetchedMutation = false;
    const object = await runGitReadOnlyRaw(["cat-file", "-e", `${record.expected_old}^{commit}`], {
      cwd: record.candidate_path,
      allowFailure: true,
    });
    if (object.code !== 0) {
      const fetched = await runGitLocalMutation(
        ["fetch", "--no-tags", record.remote_name, record.expected_old],
        { cwd: record.candidate_path, allowFailure: true },
      );
      if (fetched.code !== 0) throw coded("pod-repair-candidate-stage-failed");
      fetchedMutation = true;
    }
    const tracking = readGitTextSync(
      record.candidate_path,
      ["rev-parse", "--verify", record.upstream_ref],
      true,
    );
    if (tracking !== record.expected_old) {
      const updated = await runGitLocalMutation(
        ["update-ref", record.upstream_ref, record.expected_old],
        { cwd: record.candidate_path, allowFailure: true },
      );
      if (updated.code !== 0) throw coded("pod-repair-candidate-stage-failed");
      fetchedMutation = true;
    }
    if (fetchedMutation) dependencies.after_mutation?.("candidate-fetch");
    record = { ...record, candidate_step: "fetched" };
    record = await writePhase(journal, record, "planned", dependencies, now());
  }
  if (record.candidate_step === "fetched") {
    const observed = await runGitReadOnlyRaw(["rev-parse", "--verify", "HEAD"], {
      cwd: record.candidate_path,
      allowFailure: true,
    });
    const branch = readGitTextSync(record.candidate_path, ["symbolic-ref", "-q", "HEAD"], true);
    if (observed.code !== 0 || branch !== record.branch_ref) {
      const checkout = await runGitLocalMutation(
        ["checkout", "-B", branchName(record.branch_ref), record.expected_old],
        {
          cwd: record.candidate_path,
          allowFailure: true,
        },
      );
      if (checkout.code !== 0) throw coded("pod-repair-candidate-stage-failed");
      dependencies.after_mutation?.("candidate-checkout");
    } else if (observed.stdout.trim() !== record.expected_old) {
      throw coded("pod-repair-candidate-substep-mismatch");
    }
    const upstream = await runGitLocalMutation(
      [
        "branch",
        "--set-upstream-to",
        `${record.remote_name}/${branchName(record.remote_ref)}`,
        branchName(record.branch_ref),
      ],
      { cwd: record.candidate_path, allowFailure: true },
    );
    if (upstream.code !== 0) throw coded("pod-repair-candidate-stage-failed");
    record = { ...record, candidate_step: "fetched-checked-out" };
    record = await writePhase(journal, record, "planned", dependencies, now());
  }
  if (record.candidate_step === "fetched-checked-out") {
    if (record.replay !== null) {
      await replayProvenTransformation(record);
      dependencies.after_mutation?.("candidate-replay");
    }
    record = { ...record, candidate_step: "replay-proof-complete" };
    record = await writePhase(journal, record, "planned", dependencies, now());
  }
  return record;
}

async function validateUnjournaledCandidate(record: PodRepairJournalRecord): Promise<string> {
  assertSupportedTopology(record.candidate_path);
  const head = await gitText(record.candidate_path, ["rev-parse", "HEAD"]);
  const status = await gitText(record.candidate_path, ["status", "--porcelain=v1"]);
  if (status !== "") throw coded("pod-repair-candidate-identity-mismatch");
  await assertBranchUpstream(record.candidate_path, record);
  if (record.replay === null) {
    if (head !== record.expected_old) throw coded("pod-repair-candidate-identity-mismatch");
    return head;
  }
  if (head !== record.replay.after_commit) throw coded("pod-repair-candidate-identity-mismatch");
  const ancestor = await runGitReadOnlyRaw(
    ["merge-base", "--is-ancestor", record.expected_old, head],
    { cwd: record.candidate_path, allowFailure: true },
  );
  if (ancestor.code !== 0) throw coded("pod-repair-candidate-identity-mismatch");
  const authenticated = await readAuthenticatedPodTransformationEvidence(record.candidate_path);
  if (
    !authenticated.some(
      (entry) =>
        entry.proof_digest === record.replay!.proof_digest &&
        entry.proof.pod_rid === record.replay!.pod_rid &&
        entry.proof.operation_id === record.replay!.operation_id &&
        entry.proof.replay_key_digest === record.replay!.replay_key_digest &&
        entry.proof.before_commit === record.replay!.before_commit &&
        entry.proof.after_commit === record.replay!.after_commit &&
        JSON.stringify(entry.proof.affected_paths) ===
          JSON.stringify(record.replay!.affected_paths),
    )
  )
    throw coded("pod-repair-candidate-identity-mismatch");
  return head;
}

async function replayProvenTransformation(record: PodRepairJournalRecord): Promise<void> {
  const replay = record.replay!;
  const sourceAuthenticated = await readAuthenticatedPodTransformationEvidence(
    record.repository_path,
  );
  const sourceExact = sourceAuthenticated.find(
    (entry) =>
      entry.proof_digest === replay.proof_digest &&
      entry.proof.pod_rid === replay.pod_rid &&
      entry.proof.operation_id === replay.operation_id &&
      entry.proof.replay_key_digest === replay.replay_key_digest &&
      entry.proof.before_commit === replay.before_commit &&
      entry.proof.after_commit === replay.after_commit &&
      JSON.stringify(entry.proof.affected_paths) === JSON.stringify(replay.affected_paths),
  );
  if (sourceExact === undefined) throw coded("pod-repair-proven-replay-verification-failed");
  const current = await gitText(record.candidate_path, ["rev-parse", "HEAD"]);
  const currentBranch = readGitTextSync(
    record.candidate_path,
    ["symbolic-ref", "-q", "HEAD"],
    true,
  );
  if (current !== replay.after_commit || currentBranch !== record.branch_ref) {
    const commands = [
      ...(current === replay.after_commit
        ? []
        : [["fetch", "--no-tags", record.repository_path, replay.after_commit]]),
      ["checkout", "-B", branchName(record.branch_ref), replay.after_commit],
    ];
    for (const args of commands) {
      const outcome = await runGitLocalMutation(args, {
        cwd: record.candidate_path,
        allowFailure: true,
      });
      if (outcome.code !== 0) throw coded("pod-repair-proven-replay-failed");
    }
  }
  const ancestor = await runGitReadOnlyRaw(
    ["merge-base", "--is-ancestor", record.expected_old, replay.after_commit],
    { cwd: record.candidate_path, allowFailure: true },
  );
  if (ancestor.code !== 0) throw coded("pod-repair-replay-ancestry-ambiguous");
  for (const source of [sourceExact.ledger_source, sourceExact.subject_source])
    copyExactProofEvidence(record.repository_path, record.candidate_path, source);
  const authenticated = await readAuthenticatedPodTransformationEvidence(record.candidate_path);
  const exact = authenticated.find((entry) => entry.proof_digest === replay.proof_digest);
  if (
    exact === undefined ||
    exact.proof.pod_rid !== replay.pod_rid ||
    exact.proof.operation_id !== replay.operation_id ||
    exact.proof.replay_key_digest !== replay.replay_key_digest ||
    exact.proof.before_commit !== replay.before_commit ||
    exact.proof.after_commit !== replay.after_commit ||
    JSON.stringify(exact.proof.affected_paths) !== JSON.stringify(replay.affected_paths)
  ) {
    throw coded("pod-repair-proven-replay-verification-failed");
  }
  if ((await gitText(record.candidate_path, ["status", "--porcelain=v1"])) !== "")
    throw coded("pod-repair-proven-replay-verification-failed");
  /* Exact proof commit is the final candidate; no repair-generated commit may follow it. */
  if ((await gitText(record.candidate_path, ["rev-parse", "HEAD"])) !== replay.after_commit)
    throw coded("pod-repair-proven-replay-verification-failed");
}

function copyExactProofEvidence(sourceRoot: string, candidateRoot: string, source: string): void {
  const relativeSource = relativePath(sourceRoot, source);
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
    throw coded("pod-repair-proven-replay-verification-failed");
  const destination = join(candidateRoot, relativeSource);
  let cursor = candidateRoot;
  for (const component of relativeSource.split(/[\\/]/u).slice(0, -1)) {
    cursor = join(cursor, component);
    const existing = lstatMaybe(cursor);
    if (existing === null) mkdirSync(cursor);
    else if (!existing.isDirectory() || existing.isSymbolicLink())
      throw coded("pod-repair-reparse-topology-refused");
  }
  const bytes = readFileSync(source);
  const existing = lstatMaybe(destination);
  if (existing !== null) {
    if (!existing.isFile() || existing.isSymbolicLink() || !readFileSync(destination).equals(bytes))
      throw coded("pod-repair-proven-replay-verification-failed");
    return;
  }
  assertNoReparseDirectoryChain(dirname(destination));
  writeFileSync(destination, bytes, { flag: "wx" });
}

async function verifyCandidate(record: PodRepairJournalRecord): Promise<void> {
  assertSupportedTopology(record.candidate_path);
  const head = await gitText(record.candidate_path, ["rev-parse", "HEAD"]);
  const status = await gitText(record.candidate_path, ["status", "--porcelain=v1"]);
  if (head !== record.replacement_head || status !== "")
    throw coded("pod-repair-candidate-verification-failed");
  await assertBranchUpstream(record.candidate_path, record);
}

async function assertBranchUpstream(path: string, record: PodRepairJournalRecord): Promise<void> {
  const branch = await gitText(path, ["symbolic-ref", "-q", "HEAD"]);
  const upstream = await gitText(path, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  if (branch !== record.branch_ref || upstream !== record.upstream_ref)
    throw coded("pod-repair-branch-upstream-mismatch");
}

async function updateRemoteCas(record: PodRepairJournalRecord): Promise<boolean> {
  const configuredUrl = readGitTextSync(record.candidate_path, [
    "config",
    "--get-all",
    `remote.${record.remote_name}.url`,
  ]);
  if (configuredUrl !== record.remote_url) throw coded("pod-repair-remote-url-drift");
  const observed = await observeRemoteSha(record);
  const remoteMutated = observed !== record.replacement_head;
  if (remoteMutated) {
    if (observed !== record.expected_old) throw coded("pod-repair-remote-third-value-drift");
    const result = await runGitLocalMutation(
      [
        "push",
        `--force-with-lease=${record.remote_ref}:${record.expected_old}`,
        record.remote_name,
        `${record.replacement_head}:${record.remote_ref}`,
      ],
      { cwd: record.candidate_path, allowFailure: true },
    );
    if (result.code !== 0) throw coded("pod-repair-remote-cas-mismatch");
  }
  if ((await observeRemoteSha(record)) !== record.replacement_head)
    throw coded("pod-repair-remote-cas-verification-failed");
  const tracking = readGitTextSync(
    record.candidate_path,
    ["rev-parse", "--verify", record.upstream_ref],
    true,
  );
  if (tracking !== record.replacement_head) {
    const updated = await runGitLocalMutation(
      ["update-ref", record.upstream_ref, record.replacement_head],
      { cwd: record.candidate_path, allowFailure: true },
    );
    if (updated.code !== 0) throw coded("pod-repair-candidate-stage-failed");
  }
  return remoteMutated;
}

async function observeRemoteSha(record: PodRepairJournalRecord): Promise<string> {
  const observed = await runGitRemoteObservation(
    ["ls-remote", record.remote_url, record.remote_ref],
    {
      cwd: dirname(record.repository_path),
      allowFailure: true,
    },
  );
  if (observed.code !== 0) throw coded("pod-repair-remote-observation-failed");
  const lines = observed.stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw coded("pod-repair-remote-identity-ambiguous");
  const [sha, ref] = lines[0]!.split(/\s+/u);
  if (ref !== record.remote_ref || !/^[0-9a-f]{40,64}$/u.test(sha ?? ""))
    throw coded("pod-repair-remote-identity-ambiguous");
  return sha!;
}

async function assertRemoteReconcileValue(record: PodRepairJournalRecord): Promise<void> {
  const sha = await observeRemoteSha(record);
  if (sha !== record.expected_old && sha !== record.replacement_head)
    throw coded("pod-repair-remote-third-value-drift");
}

async function assertRemoteAtReplacement(record: PodRepairJournalRecord): Promise<void> {
  if ((await observeRemoteSha(record)) !== record.replacement_head)
    throw coded("pod-repair-remote-third-value-drift");
}

async function verifyActive(
  record: PodRepairJournalRecord,
  observe: typeof observeLocalPodGitState,
  resolveConsumedPath: () => string,
): Promise<void> {
  if (!existsSync(record.aside_path) || existsSync(record.candidate_path))
    throw coded("pod-repair-namespace-verification-failed");
  const local = await observe(record.repository_path);
  if (
    normalizeIdentityPath(resolveConsumedPath()) !== normalizeIdentityPath(record.repository_path)
  )
    throw coded("pod-repair-registry-path-changed");
  if (
    local.repository !== "present" ||
    local.workspace !== "clean" ||
    local.operation !== "normal" ||
    local.evidence.branch_ref !== record.branch_ref ||
    local.evidence.upstream_ref !== record.upstream_ref ||
    local.evidence.head_sha !== record.replacement_head
  )
    throw coded("pod-repair-namespace-verification-failed");
  await assertDirectoryIdentity(record.repository_path, record.candidate_identity!, true);
  await assertDirectoryIdentity(record.aside_path, record.original_identity!, true);
  await assertBranchUpstream(record.repository_path, record);
  const configuredUrl = readGitTextSync(record.repository_path, [
    "config",
    "--get-all",
    `remote.${record.remote_name}.url`,
  ]);
  if (configuredUrl !== record.remote_url) throw coded("pod-repair-remote-url-drift");
  await assertRemoteAtReplacement(record);
}

function assertSupportedTopology(repositoryPath: string): void {
  assertNoReparseDirectoryChain(repositoryPath);
  const root = realpathSync.native(repositoryPath);
  const gitDir = resolve(
    repositoryPath,
    readGitTextSync(repositoryPath, ["rev-parse", "--git-dir"]),
  );
  const common = resolve(
    repositoryPath,
    readGitTextSync(repositoryPath, ["rev-parse", "--git-common-dir"]),
  );
  const expected = join(root, ".git");
  if (!lstatSync(expected).isDirectory() || lstatSync(expected).isSymbolicLink())
    throw coded("pod-repair-reparse-topology-refused");
  if (
    realpathSync.native(gitDir) !== realpathSync.native(expected) ||
    realpathSync.native(common) !== realpathSync.native(expected)
  )
    throw coded("pod-repair-unsupported-git-topology");
  if (
    process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] ||
    existsSync(join(expected, "objects", "info", "alternates"))
  )
    throw coded("pod-repair-unsupported-object-alternates");
  const coreWorktree = readGitTextSync(repositoryPath, ["config", "--get", "core.worktree"], true);
  if (coreWorktree !== "") throw coded("pod-repair-unsupported-core-worktree");
  const gitlinks = readGitTextSync(repositoryPath, ["ls-files", "-s"], true)
    .split(/\r?\n/u)
    .some((line) => line.startsWith("160000 "));
  if (gitlinks || existsSync(join(repositoryPath, ".gitmodules")))
    throw coded("pod-repair-unsupported-submodules");
  assertNoDescendantReparseDirectories(repositoryPath);
}

function assertSupportedResumeTopology(record: PodRepairJournalRecord): void {
  for (const path of [record.repository_path, record.candidate_path, record.aside_path])
    if (existsSync(path)) assertNoReparseDirectoryChain(path);
  const volumes = [record.repository_path, record.candidate_path, record.aside_path].map(
    volumeIdentity,
  );
  if (!volumes.every((value) => value === volumes[0]))
    throw coded("pod-repair-cross-volume-refused");
}

function assertSiblingPaths(record: PodRepairJournalRecord): void {
  const parent = dirname(resolve(record.repository_path));
  for (const path of [record.candidate_path, record.aside_path])
    if (dirname(resolve(path)) !== parent || resolve(path) === resolve(record.repository_path))
      throw coded("pod-repair-ambiguous-namespace");
  assertSupportedResumeTopology(record);
}

function assertNoReparseDirectoryChain(path: string): void {
  let cursor = resolve(path);
  for (;;) {
    const stat = lstatMaybe(cursor);
    if (stat !== null) {
      if (
        stat.isSymbolicLink() ||
        (process.platform === "win32" && stat.isDirectory() && stat.isSymbolicLink())
      )
        throw coded("pod-repair-reparse-topology-refused");
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function assertNoDescendantReparseDirectories(root: string): void {
  const trackedSymlinks = new Set(
    readGitTextSync(root, ["ls-files", "-s", "-z"], true)
      .split("\0")
      .filter((entry) => entry.startsWith("120000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1).replaceAll("/", sep)),
  );
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        let targetIsDirectory = true;
        try {
          targetIsDirectory = statSync(path).isDirectory();
        } catch {
          /* broken links refuse */
        }
        const rel = relativePath(root, path);
        if (targetIsDirectory || !trackedSymlinks.has(rel))
          throw coded("pod-repair-reparse-topology-refused");
        continue;
      }
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
}

function assertAbsent(path: string): void {
  if (lstatMaybe(path) !== null) throw coded("pod-repair-namespace-occupied");
}
function lstatMaybe(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function assertSameVolume(source: string, destination: string): void {
  const sourceStat = lstatSync(source);
  const destinationParent = lstatSync(dirname(destination));
  if (String(sourceStat.dev) !== String(destinationParent.dev))
    throw coded("pod-repair-cross-volume-refused");
}
function volumeIdentity(path: string): string {
  const parsed = resolve(path).slice(0, resolve(path).indexOf(sep) + 1);
  return process.platform === "win32"
    ? parsed.toLowerCase()
    : statSync(dirname(path)).dev.toString();
}
function branchName(ref: string): string {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix) || ref.length === prefix.length)
    throw coded("pod-repair-ambiguous-remote-ref");
  return ref.slice(prefix.length);
}
function relativePath(root: string, path: string): string {
  const value = relative(root, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value))
    throw coded("pod-repair-ambiguous-namespace");
  return value;
}
async function gitText(cwd: string, args: string[]): Promise<string> {
  const r = await runGitReadOnlyRaw(args, { cwd, allowFailure: true });
  if (r.code !== 0) throw coded("pod-repair-git-observation-failed");
  return Buffer.from(r.stdoutRaw).toString("utf8").trim();
}
function readGitTextSync(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    if (allowFailure) return "";
    throw coded("pod-repair-git-observation-failed");
  }
}
function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}
function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sha256Canonical(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    return input;
  };
  return sha256Json(canonicalize(value));
}
function digestSnapshotPlan(plan: PodRecoverySnapshotPlan): string {
  return sha256Json({
    repository_root: resolve(plan.repository_root),
    git_dir: resolve(plan.git_dir),
    head: plan.head,
    branch: plan.branch,
    index_sha256: plan.index_sha256,
    shared_index_sha256: plan.shared_index_sha256,
    worktree_fingerprint: plan.worktree_fingerprint,
    material_bytes: plan.material_bytes,
    paths: plan.paths,
  });
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw coded("pod-repair-directory-identity-unavailable");
  const head = await gitText(path, ["rev-parse", "HEAD"]);
  const tree = await gitText(path, ["rev-parse", "HEAD^{tree}"]);
  return {
    realpath: realpathSync.native(path),
    dev: String(stat.dev),
    ino: String(stat.ino),
    head,
    tree,
    content_sha256: digestDirectoryContent(path),
  };
}

function digestDirectoryContent(root: string): string {
  const digest = createHash("sha256");
  let totalBytes = 0;
  let entries = 0;
  const walk = (directory: string): void => {
    const children = readdirSync(directory).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    for (const name of children) {
      entries += 1;
      if (entries > 200_000) throw coded("pod-repair-content-digest-limit");
      const path = join(directory, name);
      const rel = relative(root, path).replaceAll("\\", "/");
      const stat = lstatSync(path);
      digest.update(`${rel}\0${stat.mode}\0`);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path, { encoding: "buffer" });
        totalBytes += target.length;
        digest.update("l\0").update(target).update("\0");
      } else if (stat.isDirectory()) {
        digest.update("d\0");
        walk(path);
      } else if (stat.isFile()) {
        if (stat.size > 512 * 1024 * 1024 || totalBytes + stat.size > 512 * 1024 * 1024)
          throw coded("pod-repair-content-digest-limit");
        const bytes = readFileSync(path);
        totalBytes += bytes.length;
        digest.update("f\0").update(bytes).update("\0");
      } else {
        throw coded("pod-repair-special-file-refused");
      }
    }
  };
  walk(root);
  return digest.digest("hex");
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  allowMoved = false,
): Promise<void> {
  const actual = await directoryIdentity(path);
  if (
    (!allowMoved &&
      normalizeIdentityPath(actual.realpath) !== normalizeIdentityPath(expected.realpath)) ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.head !== expected.head ||
    actual.tree !== expected.tree ||
    actual.content_sha256 !== expected.content_sha256
  )
    throw coded("pod-repair-directory-identity-mismatch");
}

function normalizeIdentityPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function digestJournalPlan(record: PodRepairJournalRecord): string {
  return sha256Json({
    operation_id: record.operation_id,
    repository_path: record.repository_path,
    candidate_path: record.candidate_path,
    aside_path: record.aside_path,
    remote_name: record.remote_name,
    remote_url: record.remote_url,
    remote_ref: record.remote_ref,
    branch_ref: record.branch_ref,
    upstream_ref: record.upstream_ref,
    expected_old: record.expected_old,
    replay_proof_digest: record.replay?.proof_digest ?? null,
    snapshot_plan_digest: record.snapshot_plan_digest,
  });
}
function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw coded("receipt-store-corrupt");
}
function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "pod-repair-namespace-swap-failed";
}
async function observeMutationCounts(
  record: PodRepairJournalRecord,
): Promise<{ local: number; remote: number }> {
  let local = record.snapshot === null ? 0 : 1;
  if (record.snapshot === null && lstatMaybe(record.repository_path) !== null) {
    const intendedSnapshot = await runGitReadOnlyRaw(
      ["show-ref", "--verify", "--quiet", record.snapshot_intent.ref],
      { cwd: record.repository_path, allowFailure: true },
    );
    if (intendedSnapshot.code === 0) local += 1;
  }
  if (record.candidate_identity !== null || lstatMaybe(record.candidate_path) !== null) local += 1;
  if (
    record.original_identity !== null &&
    (await identityMatches(record.aside_path, record.original_identity, true))
  )
    local += 1;
  if (
    record.candidate_identity !== null &&
    (await identityMatches(record.repository_path, record.candidate_identity, true))
  )
    local += 1;
  let remote = 0;
  try {
    if (
      record.replacement_head !== record.expected_old &&
      (await observeRemoteSha(record)) === record.replacement_head
    )
      remote = 1;
  } catch {
    // The terminal result reports only observed mutations. An unavailable or
    // third-value remote is not guessed into the count.
  }
  return { local, remote };
}
function refused(path: string, code: string, summary: string): PodRepairApplyResult {
  return result(path, "refused", 2, null, 0, 0, code, summary, null, null, null);
}
function result(
  repositoryPath: string,
  status: PodRepairApplyResult["status"],
  exitCode: PodRepairApplyResult["exit_code"],
  target: string | null,
  local: number,
  remote: number,
  error: string | null,
  summary: string,
  attempt: string | null,
  phase: PodRepairPhase | null,
  aside: string | null,
  replayed = 0,
  snapshot: PodRecoverySnapshotReceipt | null = null,
  retainedIdentity: DirectoryIdentity | null = null,
  replayDisposition: "new" | "resumed" = "new",
  resumedFromPhase: PodRepairPhase | null = null,
): PodRepairApplyResult {
  return {
    mode: "apply",
    status,
    exit_code: exitCode,
    repository_path: repositoryPath,
    target_commit: target,
    snapshot,
    local_mutations: local,
    remote_mutations: remote,
    replayed_transformations: replayed,
    error_code: error,
    summary,
    attempt_id: attempt,
    phase,
    retained_original_path: aside,
    retained_original_identity: retainedIdentity,
    replay_disposition: replayDisposition,
    resumed_from_phase: resumedFromPhase,
  };
}
