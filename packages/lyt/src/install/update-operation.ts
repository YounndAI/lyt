/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  newUuidv7Bytes,
  openReceiptAttempt,
  inspectReceiptAttempt,
  parseReceiptV1ForEmission,
  reopenReceiptAttempt,
  uuid7BytesToDashedString,
  type ReceiptAttemptSession,
  type ReceiptV1,
} from "@younndai/lyt-vault";

import { assertPathChainHasNoLinks } from "./reconcile-engine.js";
import {
  canonicalJson,
  digestCanonical,
  parseUpdatePlanV1,
  type UpdatePlanV1,
} from "./update-plan.js";

export interface UpdateOperationJournalV1 {
  readonly schema_id: "lyt.update-operation";
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly plan: UpdatePlanV1;
  readonly status: "pending" | "completed";
  readonly completed_boundaries: readonly Readonly<{
    boundary_id: string;
    receipt_digest: string;
  }>[];
  readonly active_attempt_id: string | null;
  readonly started_at: string;
}

export type UpdateOperationJournalInspectionV1 =
  | Readonly<{ valid: true; status: "pending" | "completed"; journal: UpdateOperationJournalV1 }>
  | Readonly<{ valid: false; status: "invalid" | "missing"; journal: null; error_code: string }>;

const UUID_V7_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JOURNAL_KEYS = [
  "active_attempt_id",
  "completed_boundaries",
  "plan",
  "schema_id",
  "schema_version",
  "started_at",
  "status",
] as const;

export interface UpdateOperationHandleV1 {
  readonly plan: UpdatePlanV1;
  readonly alreadyCompleted: boolean;
  isBoundaryCompleted(boundaryId: string): boolean;
  finalizeCompleted(): Promise<boolean>;
  recordReconciled(receiptDigest: string): Promise<boolean>;
}

export interface UpdateOperationOptions {
  readonly root?: string;
  readonly now?: () => Date;
  readonly newAttemptId?: () => string;
  readonly receiptOpen?: typeof openReceiptAttempt;
  readonly receiptReopen?: typeof reopenReceiptAttempt;
  readonly receiptInspect?: typeof inspectReceiptAttempt;
}

export function defaultUpdateOperationRoot(home: string = homedir()): string {
  return join(home, "lyt", ".update-operations");
}

export function readUpdateOperationPlanV1(
  operationId: string,
  root: string = defaultUpdateOperationRoot(),
): UpdatePlanV1 {
  return readJournal(root, operationId).plan;
}

export function inspectUpdateOperationJournalV1(
  operationId: string,
  root: string = defaultUpdateOperationRoot(),
): UpdateOperationJournalInspectionV1 {
  try {
    const journal = readJournal(root, operationId);
    return Object.freeze({ valid: true, status: journal.status, journal });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return Object.freeze({
      valid: false,
      status: missing ? "missing" : "invalid",
      journal: null,
      error_code: missing ? "update-operation-journal-missing" : "update-operation-journal-invalid",
    });
  }
}

export async function beginUpdateOperationV1(
  value: unknown,
  options: UpdateOperationOptions = {},
): Promise<UpdateOperationHandleV1 | null> {
  const plan = parseUpdatePlanV1(value);
  const root = resolve(options.root ?? defaultUpdateOperationRoot());
  assertPathChainHasNoLinks(root, true);
  const path = journalPath(root, plan.operation_id);
  let existing: UpdateOperationJournalV1 | null = null;
  if (existsSync(path)) {
    existing = readJournal(root, plan.operation_id);
    if (canonicalJson(existing.plan) !== canonicalJson(plan)) {
      throw new Error("update-operation-plan-mismatch");
    }
  }
  if (existing?.status === "completed") {
    return journalHandle(existing, root);
  }
  if (existing !== null && existing.active_attempt_id === null) {
    return journalHandle(existing, root);
  }
  if (existing !== null && existing.active_attempt_id !== null) {
    const inspect =
      options.receiptInspect ??
      (options.receiptReopen === undefined ? inspectReceiptAttempt : undefined);
    if (inspect !== undefined) {
      const state = await inspect(existing.active_attempt_id);
      if (state.kind === "terminal") {
        const evidence = completedBoundaryEvidence(state.receipt, existing);
        for (const boundary of evidence) {
          existing = recordBoundary(existing, boundary.boundary_id, boundary.receipt_digest);
        }
        existing = Object.freeze({ ...existing, active_attempt_id: null, status: "completed" });
        writeJournal(root, existing);
        return journalHandle(existing, root);
      }
      if (state.kind === "absent") throw new Error("update-operation-receipt-absent");
    }
  }
  const now = options.now ?? (() => new Date());
  const attemptId =
    existing?.active_attempt_id ??
    options.newAttemptId?.() ??
    uuid7BytesToDashedString(newUuidv7Bytes());
  const startedAt = existing?.started_at ?? now().toISOString();
  const disposition = existing === null ? "new" : "resumed";
  const pendingReceipt = updateReceipt(
    plan,
    attemptId,
    startedAt,
    startedAt,
    "failed",
    "update-interrupted",
    disposition,
    [],
  );
  const opened =
    existing === null
      ? await (options.receiptOpen ?? openReceiptAttempt)(pendingReceipt)
      : await (options.receiptReopen ?? reopenReceiptAttempt)(pendingReceipt);
  if (opened.kind !== "ready") return null;
  const journal: UpdateOperationJournalV1 = Object.freeze({
    schema_id: "lyt.update-operation",
    schema_version: Object.freeze({ major: 1, minor: 0 }),
    plan,
    status: "pending",
    completed_boundaries: Object.freeze([]),
    active_attempt_id: attemptId,
    started_at: startedAt,
  });
  writeJournal(root, journal);
  return handleFor(journal, root, opened.session, now, disposition);
}

function completedBoundaryEvidence(
  receipt: ReceiptV1,
  journal: UpdateOperationJournalV1,
): readonly { boundary_id: string; receipt_digest: string }[] {
  if (
    receipt.operation_id !== journal.plan.operation_id ||
    receipt.attempt_id !== journal.active_attempt_id ||
    receipt.operation !== "update" ||
    receipt.status !== "success" ||
    receipt.replay.key_digest !== journal.plan.plan_digest
  ) {
    throw new Error("update-operation-terminal-receipt-mismatch");
  }
  const evidence = receipt.evidence.after.map((entry) => ({
    boundary_id: entry.subject.replace(/^boundary:/, ""),
    receipt_digest: entry.digest ?? "",
    kind: entry.kind,
  }));
  if (
    evidence.length !== journal.plan.boundaries.length ||
    evidence.some(
      (entry, index) =>
        entry.kind !== "update-boundary" ||
        entry.boundary_id !== journal.plan.boundaries[index]?.boundary_id ||
        !/^[a-f0-9]{64}$/.test(entry.receipt_digest),
    )
  ) {
    throw new Error("update-operation-terminal-boundary-evidence-mismatch");
  }
  for (const [index, completed] of journal.completed_boundaries.entries()) {
    if (
      evidence[index]?.boundary_id !== completed.boundary_id ||
      evidence[index]?.receipt_digest !== completed.receipt_digest
    ) {
      throw new Error("update-operation-terminal-boundary-evidence-mismatch");
    }
  }
  return Object.freeze(
    evidence.map(({ boundary_id, receipt_digest }) =>
      Object.freeze({ boundary_id, receipt_digest }),
    ),
  );
}

function handleFor(
  journal: UpdateOperationJournalV1,
  root: string,
  session: ReceiptAttemptSession,
  now: () => Date,
  disposition: "new" | "resumed",
): UpdateOperationHandleV1 {
  let current = journal;
  return Object.freeze({
    plan: journal.plan,
    alreadyCompleted: false,
    isBoundaryCompleted(boundaryId: string) {
      return current.completed_boundaries.some((entry) => entry.boundary_id === boundaryId);
    },
    async finalizeCompleted() {
      current = recordBoundary(
        current,
        "npm-self-replacement",
        digestCanonical({
          plan_digest: current.plan.plan_digest,
          boundary_id: "npm-self-replacement",
          artifacts: current.plan.target_artifacts.map((artifact) => ({
            package: artifact.package,
            payload_digest: artifact.payload_digest,
          })),
        }),
      );
      writeJournal(root, current);
      return true;
    },
    async recordReconciled(receiptDigest: string) {
      if (!/^[a-f0-9]{64}$/.test(receiptDigest)) return false;
      let completed = current;
      for (const boundary of current.plan.boundaries) {
        if (boundary.kind !== "npm-self-replacement") {
          completed = recordBoundary(completed, boundary.boundary_id, receiptDigest);
        }
      }
      const terminalReceipt = updateReceipt(
        journal.plan,
        session.attemptId,
        journal.started_at,
        now().toISOString(),
        "success",
        null,
        disposition,
        completed.completed_boundaries,
      );
      const warnings = await session.finalize(terminalReceipt);
      if (warnings.length > 0) return false;
      current = Object.freeze({ ...completed, active_attempt_id: null, status: "completed" });
      writeJournal(root, current);
      return true;
    },
  });
}

function journalHandle(journal: UpdateOperationJournalV1, root: string): UpdateOperationHandleV1 {
  let current = journal;
  return Object.freeze({
    plan: journal.plan,
    alreadyCompleted: journal.status === "completed",
    isBoundaryCompleted(boundaryId: string) {
      return current.completed_boundaries.some((entry) => entry.boundary_id === boundaryId);
    },
    async finalizeCompleted() {
      return current.completed_boundaries.some(
        (entry) => entry.boundary_id === "npm-self-replacement",
      );
    },
    async recordReconciled(receiptDigest: string) {
      if (!/^[a-f0-9]{64}$/.test(receiptDigest)) return false;
      if (current.status === "completed") return true;
      for (const boundary of current.plan.boundaries) {
        if (boundary.kind !== "npm-self-replacement") {
          current = recordBoundary(current, boundary.boundary_id, receiptDigest);
        }
      }
      writeJournal(root, current);
      return true;
    },
  });
}

function recordBoundary(
  journal: UpdateOperationJournalV1,
  boundaryId: string,
  receiptDigest: string,
): UpdateOperationJournalV1 {
  const recorded = journal.completed_boundaries.find((entry) => entry.boundary_id === boundaryId);
  if (recorded !== undefined) {
    if (recorded.receipt_digest !== receiptDigest) {
      throw new Error("update-operation-boundary-evidence-mismatch");
    }
    return journal;
  }
  const boundary = journal.plan.boundaries.find((entry) => entry.boundary_id === boundaryId);
  const nextBoundary = journal.plan.boundaries[journal.completed_boundaries.length];
  if (
    boundary === undefined ||
    nextBoundary?.boundary_id !== boundaryId ||
    !/^[a-f0-9]{64}$/.test(receiptDigest)
  ) {
    throw new Error("update-operation-invalid-boundary-evidence");
  }
  const completed = Object.freeze([
    ...journal.completed_boundaries,
    Object.freeze({ boundary_id: boundaryId, receipt_digest: receiptDigest }),
  ]);
  return Object.freeze({
    ...journal,
    completed_boundaries: completed,
    // A completed boundary is not a completed operation. The operation becomes
    // terminal only after reconciliation evidence is recorded and the shared
    // Phase-A receipt has been finalized successfully.
    status: "pending",
  });
}

function updateReceipt(
  plan: UpdatePlanV1,
  attemptId: string,
  startedAt: string,
  finishedAt: string,
  status: "success" | "failed",
  errorCode: string | null,
  disposition: "new" | "resumed",
  completedBoundaries: readonly Readonly<{
    boundary_id: string;
    receipt_digest: string;
  }>[],
) {
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: plan.operation_id,
    attempt_id: attemptId,
    operation: "update",
    scope: { kind: "system" },
    timestamps: { started_at: startedAt, finished_at: finishedAt },
    replay: { disposition, key_digest: plan.plan_digest },
    status,
    exit_code: status === "success" ? 0 : 1,
    mutations: { local: status === "success" ? 1 : 0, remote: 0 },
    evidence: {
      before: [{ kind: "update-plan", subject: "sealed update plan", digest: plan.plan_digest }],
      after: completedBoundaries.map((boundary) => ({
        kind: "update-boundary",
        subject: `boundary:${boundary.boundary_id}`,
        digest: boundary.receipt_digest,
      })),
    },
    next_action:
      status === "success"
        ? null
        : { code: "resume-update", summary: `Resume update operation ${plan.operation_id}.` },
    error:
      errorCode === null
        ? null
        : { code: errorCode, summary: "The exact update is incomplete.", retryable: true },
  });
}

function journalPath(root: string, operationId: string): string {
  return join(root, "operations", operationId, "journal.json");
}

function readJournal(root: string, operationId: string): UpdateOperationJournalV1 {
  if (!UUID_V7_DASHED.test(operationId)) {
    throw new Error("update-operation-invalid-id");
  }
  const path = journalPath(resolve(root), operationId);
  assertPathChainHasNoLinks(dirname(path), true);
  assertPathChainHasNoLinks(path, true);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as UpdateOperationJournalV1;
  if (
    parsed.schema_id !== "lyt.update-operation" ||
    parsed.schema_version?.major !== 1 ||
    parsed.schema_version?.minor !== 0 ||
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([...JOURNAL_KEYS].sort()) ||
    parsed.plan?.operation_id !== operationId ||
    (parsed.status !== "pending" && parsed.status !== "completed") ||
    (parsed.active_attempt_id !== null && !UUID_V7_DASHED.test(parsed.active_attempt_id)) ||
    typeof parsed.started_at !== "string" ||
    !isCanonicalIso(parsed.started_at)
  )
    throw new Error("update-operation-journal-tampered");
  const plan = parseUpdatePlanV1(parsed.plan);
  const completed = parsed.completed_boundaries;
  if (!Array.isArray(completed)) throw new Error("update-operation-journal-tampered");
  const expectedPrefix = plan.boundaries
    .slice(0, completed.length)
    .map((entry) => entry.boundary_id);
  if (
    completed.some(
      (entry, index) =>
        entry?.boundary_id !== expectedPrefix[index] ||
        typeof entry.receipt_digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.receipt_digest),
    ) ||
    (parsed.status === "completed" && completed.length !== plan.boundaries.length) ||
    (parsed.active_attempt_id === null) !== (parsed.status === "completed")
  ) {
    throw new Error("update-operation-journal-tampered");
  }
  return parsed;
}

function isCanonicalIso(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function writeJournal(root: string, journal: UpdateOperationJournalV1): void {
  const path = journalPath(root, journal.plan.operation_id);
  assertPathChainHasNoLinks(root, true);
  assertPathChainHasNoLinks(dirname(path), true);
  assertPathChainHasNoLinks(path, true);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  assertPathChainHasNoLinks(temporary, true);
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  renameSync(temporary, path);
}
