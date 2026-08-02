/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import { getWriterId } from "../../util/writer-id.js";
import { assertSafeWritePath } from "../../util/write-path-guard.js";
import { appendLedgerRecord, clearLedgerCache } from "../../yon/ledger-write.js";
import { parseLedgerText, type LedgerRecord } from "../../yon/ledger-read.js";
import {
  type DestinationPolicyLockOptions,
  withDestinationPolicyLock,
} from "./destination-policy-lock.js";
import {
  derivePodTransformationProofV1,
  derivePodTransformationRecordIds,
  digestPodTransformationEvidenceRecordV1,
  digestPodTransformationProofV1,
  parsePodTransformationProofV1,
  serializePodTransformationProofV1,
  type PodTransformationLedgerCorroborationV1,
  type PodTransformationProofV1,
  type PodTransformationSubjectCorroborationV1,
} from "./pod-transformation-proof.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// SEE ALSO: pod-transformation-proof.ts, op/receipt-v1.ts — persisted proof
// identities accept historical UUIDv7 and deterministic UUIDv8. Ledger writer
// ids below remain clock-derived UUIDv7.
const UUID_V7_OR_V8 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const LEDGER_TAG = "POD_TRANSFORMATION";
const SUBJECT_TAG = "POD_TRANSFORMATION_SUBJECT";
const LEDGER_STAMP = "flows/federation/pod-transformation-proof";
const SUBJECT_STAMP = "flows/federation/pod-transformation-subject";
const MAX_SHARDS = 64;
const MAX_FILES_PER_SHARD = 32;
const MAX_RECORDS = 4_096;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const inProcessTails = new Map<string, Promise<void>>();

export interface AppendPodTransformationProofArgs {
  pod_root: string;
  proof: unknown;
}

export interface PodTransformationProofDependencies {
  /** Tests only; production always resolves the machine writer internally. */
  get_writer_id?: () => string;
  /** Tests only; production uses the current wall clock. */
  now?: () => Date;
  lock_options?: DestinationPolicyLockOptions;
}

export interface AppendPodTransformationProofResult {
  readonly ledger: "appended" | "unchanged";
  readonly subject: "appended" | "unchanged";
  readonly ledger_path: string;
  readonly subject_path: string;
  readonly ledger_evidence: PodTransformationLedgerCorroborationV1;
  readonly subject_evidence: PodTransformationSubjectCorroborationV1;
}

export interface AuthenticatedPodTransformationEvidence {
  readonly proof: PodTransformationProofV1;
  readonly proof_digest: string;
  readonly ledger_evidence: PodTransformationLedgerCorroborationV1;
  readonly subject_evidence: PodTransformationSubjectCorroborationV1;
  readonly ledger_source: string;
  readonly subject_source: string;
}

interface LocatedRecord {
  record: LedgerRecord;
  writerId: string;
}

type ExistingState = "absent" | "same" | "conflict";

export function getPodTransformationLedgerPath(podRoot: string, writerId: string): string {
  assertWriterId(writerId);
  return join(podRoot, "ledger", "pod-transformations", `${writerId}.yon`);
}

export function getPodTransformationSubjectLedgerPath(podRoot: string, writerId: string): string {
  assertWriterId(writerId);
  return join(podRoot, "ledger", "pod-transformation-subjects", `${writerId}.yon`);
}

/** One crash-recoverable writer lock covers preflight, both appends, and authenticated read-back. */
export async function appendPodTransformationProof(
  args: AppendPodTransformationProofArgs,
  dependencies: PodTransformationProofDependencies = {},
): Promise<AppendPodTransformationProofResult> {
  const proof = parsePodTransformationProofV1(args.proof);
  const writerId = (dependencies.get_writer_id ?? getWriterId)();
  assertWriterId(writerId);
  const lockPath = proofLockPath(args.pod_root, writerId);
  return withInProcessQueue(lockPath, () =>
    withDestinationPolicyLock(
      lockPath,
      async () => appendUnderLock(args.pod_root, proof, writerId, dependencies),
      { ...dependencies.lock_options, subject: `pod-transformation:${writerId}` },
    ),
  );
}

/** Archive-aware read; stored proof and record digests are rederived, never trusted. */
export async function readAuthenticatedPodTransformationEvidence(
  podRoot: string,
): Promise<AuthenticatedPodTransformationEvidence[]> {
  const ledgerRecords = collectRecords(join(podRoot, "ledger", "pod-transformations"));
  const subjectRecords = collectRecords(join(podRoot, "ledger", "pod-transformation-subjects"));
  return authenticateCollected(podRoot, ledgerRecords, subjectRecords);
}

async function appendUnderLock(
  podRoot: string,
  proof: PodTransformationProofV1,
  writerId: string,
  dependencies: PodTransformationProofDependencies,
): Promise<AppendPodTransformationProofResult> {
  const canonicalProof = await rederiveExactProof(podRoot, proof);
  const proofDigest = digestPodTransformationProofV1(canonicalProof);
  const ids = derivePodTransformationRecordIds(canonicalProof.operation_id);
  const ledgerEvidence = makeLedgerEvidence(canonicalProof, proofDigest, ids.ledger_record_id);
  const subjectEvidence = makeSubjectEvidence(canonicalProof, proofDigest, ids.subject_record_id);
  const ledgerPath = getPodTransformationLedgerPath(podRoot, writerId);
  const subjectPath = getPodTransformationSubjectLedgerPath(podRoot, writerId);
  assertSafeWritePath(ledgerPath);
  assertSafeWritePath(subjectPath);
  clearLedgerCache(ledgerPath);
  clearLedgerCache(subjectPath);

  const allLedgers = collectRecords(join(podRoot, "ledger", "pod-transformations"));
  const allSubjects = collectRecords(join(podRoot, "ledger", "pod-transformation-subjects"));
  const ledgerState = inspectExisting(
    allLedgers,
    writerId,
    LEDGER_TAG,
    ledgerEvidence.record_id,
    ledgerEvidence.record_digest,
    proofDigest,
  );
  const subjectState = inspectExisting(
    allSubjects,
    writerId,
    SUBJECT_TAG,
    subjectEvidence.record_id,
    subjectEvidence.record_digest,
    proofDigest,
  );
  if (ledgerState === "conflict" || subjectState === "conflict") {
    throw new Error(
      "Pod transformation record id already exists with different or non-unique evidence.",
    );
  }
  const recordedAt = canonicalTimestamp((dependencies.now ?? (() => new Date()))());
  if (ledgerState === "absent") {
    appendLedgerRecord({
      ledgerPath,
      ledgerName: writerId,
      recordType: LEDGER_TAG,
      fields: fullProofFields(canonicalProof, ledgerEvidence),
      stampSrc: LEDGER_STAMP,
      ts: recordedAt,
    });
  }
  if (subjectState === "absent") {
    appendLedgerRecord({
      ledgerPath: subjectPath,
      ledgerName: writerId,
      recordType: SUBJECT_TAG,
      fields: evidenceFields(subjectEvidence),
      stampSrc: SUBJECT_STAMP,
      ts: recordedAt,
    });
  }

  const authenticated = await authenticateCollected(
    podRoot,
    collectRecords(join(podRoot, "ledger", "pod-transformations")),
    collectRecords(join(podRoot, "ledger", "pod-transformation-subjects")),
  );
  if (
    !authenticated.some(
      (entry) =>
        entry.ledger_evidence.record_id === ledgerEvidence.record_id &&
        entry.subject_evidence.record_id === subjectEvidence.record_id,
    )
  ) {
    throw new Error("Appended pod transformation proof failed read-back authentication.");
  }
  return {
    ledger: ledgerState === "same" ? "unchanged" : "appended",
    subject: subjectState === "same" ? "unchanged" : "appended",
    ledger_path: ledgerPath,
    subject_path: subjectPath,
    ledger_evidence: ledgerEvidence,
    subject_evidence: subjectEvidence,
  };
}

async function authenticateCollected(
  podRoot: string,
  ledgerRecords: readonly LocatedRecord[],
  subjectRecords: readonly LocatedRecord[],
): Promise<AuthenticatedPodTransformationEvidence[]> {
  const ledgerIds = countRecordIds(ledgerRecords, LEDGER_TAG);
  const subjectIds = countRecordIds(subjectRecords, SUBJECT_TAG);
  const subjects = subjectRecords.flatMap((located) => {
    if (
      located.record.recordType !== SUBJECT_TAG ||
      located.record.stampSrc !== SUBJECT_STAMP ||
      !isCanonicalTimestamp(located.record.stampTs) ||
      located.record.tamper === true
    ) {
      return [];
    }
    const core = evidenceCore(located.record);
    if (core === null || core.record_kind !== "pod-transformation-subject-v1") return [];
    const expectedIds = derivePodTransformationRecordIds(core.operation_id);
    const digest = digestPodTransformationEvidenceRecordV1(core);
    if (
      core.record_id !== expectedIds.subject_record_id ||
      subjectIds.get(core.record_id) !== 1 ||
      located.record.fields.get("record_digest") !== digest
    ) {
      return [];
    }
    return [{ evidence: { ...core, record_digest: digest }, ...located }];
  });
  const out: AuthenticatedPodTransformationEvidence[] = [];
  for (const located of ledgerRecords) {
    if (
      located.record.recordType !== LEDGER_TAG ||
      located.record.stampSrc !== LEDGER_STAMP ||
      !isCanonicalTimestamp(located.record.stampTs) ||
      located.record.tamper === true
    ) {
      continue;
    }
    const parsed = parseLedgerRecord(located.record);
    if (parsed === null) continue;
    const ids = derivePodTransformationRecordIds(parsed.proof.operation_id);
    if (
      parsed.evidence.record_id !== ids.ledger_record_id ||
      ledgerIds.get(parsed.evidence.record_id) !== 1
    ) {
      continue;
    }
    let rederived: PodTransformationProofV1;
    try {
      rederived = await rederiveExactProof(podRoot, parsed.proof);
    } catch {
      continue;
    }
    if (
      serializePodTransformationProofV1(rederived) !==
      serializePodTransformationProofV1(parsed.proof)
    ) {
      continue;
    }
    const matches = subjects.filter(
      (candidate) =>
        candidate.writerId === located.writerId &&
        candidate.evidence.record_id === ids.subject_record_id &&
        candidate.evidence.pod_rid === parsed.proof.pod_rid &&
        candidate.evidence.operation_id === parsed.proof.operation_id &&
        candidate.evidence.replay_key_digest === parsed.proof.replay_key_digest &&
        candidate.evidence.proof_digest === parsed.proofDigest,
    );
    if (matches.length !== 1) continue;
    const subject = matches[0]!;
    out.push({
      proof: parsed.proof,
      proof_digest: parsed.proofDigest,
      ledger_evidence: parsed.evidence,
      subject_evidence: subject.evidence,
      ledger_source: located.record.sourceFile,
      subject_source: subject.record.sourceFile,
    });
  }
  return out.sort((a, b) => a.ledger_evidence.record_id.localeCompare(b.ledger_evidence.record_id));
}

async function rederiveExactProof(
  podRoot: string,
  proof: PodTransformationProofV1,
): Promise<PodTransformationProofV1> {
  return derivePodTransformationProofV1({
    repository_root: podRoot,
    pod_rid: proof.pod_rid,
    operation_id: proof.operation_id,
    replay_key_digest: proof.replay_key_digest,
    generator_id: proof.generator_id,
    generator_version: proof.generator_version,
    before_commit: proof.before_commit,
    after_commit: proof.after_commit,
    affected_paths: proof.affected_paths,
  });
}

function collectRecords(directory: string): LocatedRecord[] {
  if (!existsSync(directory)) return [];
  assertPlainDirectory(directory, "evidence root");
  const entries = readdirSync(directory, { withFileTypes: true });
  const inventories = new Map<string, string[]>();
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Error("Evidence inventory refuses symlink or reparse entries.");
    if (stat.isFile() && entry.name.endsWith(".yon")) {
      const writerId = entry.name.slice(0, -4);
      assertWriterId(writerId);
      inventories.set(writerId, [...(inventories.get(writerId) ?? []), path]);
      continue;
    }
    if (stat.isDirectory()) {
      const writerId = entry.name;
      assertWriterId(writerId);
      assertPlainDirectory(path, "writer archive");
      const archiveEntries = readdirSync(path, { withFileTypes: true });
      if (archiveEntries.length > MAX_FILES_PER_SHARD) {
        throw new Error("Pod transformation evidence exceeds the per-shard file bound.");
      }
      const archiveFiles: string[] = [];
      for (const archiveEntry of archiveEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        const archivePath = join(path, archiveEntry.name);
        const archiveStat = lstatSync(archivePath);
        if (
          archiveStat.isSymbolicLink() ||
          !archiveStat.isFile() ||
          !archiveEntry.name.endsWith(".yon")
        ) {
          throw new Error("Evidence archive entries must be regular YON files.");
        }
        archiveFiles.push(archivePath);
      }
      inventories.set(writerId, [...archiveFiles, ...(inventories.get(writerId) ?? [])]);
      continue;
    }
    throw new Error("Evidence root entries must be writer shards or archives.");
  }
  if (inventories.size > MAX_SHARDS)
    throw new Error("Pod transformation evidence exceeds the shard bound.");
  let aggregateBytes = 0;
  let aggregateRecords = 0;
  const out: LocatedRecord[] = [];
  for (const [writerId, files] of [...inventories].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.length > MAX_FILES_PER_SHARD) {
      throw new Error("Pod transformation evidence exceeds the per-shard file bound.");
    }
    for (const file of files) {
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error("Evidence shard must be a regular file.");
      }
      aggregateBytes += before.size;
      if (aggregateBytes > MAX_LEDGER_BYTES)
        throw new Error("Pod transformation evidence exceeds the byte bound.");
      const fd = openSync(file, "r");
      try {
        const opened = fstatSync(fd);
        assertSameFile(before, opened);
        const bytes = readFileSync(fd);
        const after = fstatSync(fd);
        assertSameFile(opened, after);
        if (bytes.length !== opened.size)
          throw new Error("Evidence shard changed while being read.");
        const records = parseLedgerText(bytes.toString("utf8"), file);
        aggregateRecords += records.length;
        if (aggregateRecords > MAX_RECORDS) {
          throw new Error("Pod transformation evidence exceeds the record bound.");
        }
        for (const record of records) out.push({ record, writerId });
      } finally {
        closeSync(fd);
      }
    }
  }
  return out;
}

function assertPlainDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Pod transformation ${label} must be a plain directory.`);
  }
}

function assertSameFile(before: Stats, after: Stats): void {
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error("Evidence shard identity or size changed while being read.");
  }
}

function inspectExisting(
  records: readonly LocatedRecord[],
  writerId: string,
  tag: string,
  recordId: string,
  recordDigest: string,
  proofDigest: string,
): ExistingState {
  const matching = records.filter(
    (entry) => entry.record.recordType === tag && entry.record.fields.get("record_id") === recordId,
  );
  if (matching.length === 0) return "absent";
  if (matching.length !== 1 || matching[0]!.writerId !== writerId) return "conflict";
  const record = matching[0]!.record;
  if (record.tamper === true || record.fields.get("proof_digest") !== proofDigest)
    return "conflict";
  if (tag === LEDGER_TAG) {
    const parsed = parseLedgerRecord(record);
    return parsed !== null && parsed.evidence.record_digest === recordDigest ? "same" : "conflict";
  }
  const core = evidenceCore(record);
  return core !== null &&
    core.record_kind === "pod-transformation-subject-v1" &&
    record.fields.get("record_digest") === recordDigest &&
    digestPodTransformationEvidenceRecordV1(core) === recordDigest
    ? "same"
    : "conflict";
}

function fullProofFields(
  proof: PodTransformationProofV1,
  evidence: PodTransformationLedgerCorroborationV1,
): ReadonlyArray<readonly [string, string | number]> {
  return [
    ...evidenceFields(evidence),
    ["schema_id", proof.schema_id],
    ["schema_version", proof.schema_version],
    ["generator_id", proof.generator_id],
    ["generator_version", proof.generator_version],
    ["before_commit", proof.before_commit],
    ["after_commit", proof.after_commit],
    ["affected_paths", JSON.stringify(proof.affected_paths)],
    ["tree_digest", proof.tree_digest],
    ["content_digest", proof.content_digest],
  ];
}

function evidenceFields(
  evidence: PodTransformationLedgerCorroborationV1 | PodTransformationSubjectCorroborationV1,
): ReadonlyArray<readonly [string, string | number]> {
  return [
    ["record_kind", evidence.record_kind],
    ["record_id", evidence.record_id],
    ["record_digest", evidence.record_digest],
    ["pod_rid", evidence.pod_rid],
    ["operation_id", evidence.operation_id],
    ["replay_key_digest", evidence.replay_key_digest],
    ["proof_digest", evidence.proof_digest],
  ];
}

function makeLedgerEvidence(
  proof: PodTransformationProofV1,
  proofDigest: string,
  recordId: string,
): PodTransformationLedgerCorroborationV1 {
  const core = {
    record_kind: "pod-ledger-receipt-v1" as const,
    record_id: recordId,
    pod_rid: proof.pod_rid,
    operation_id: proof.operation_id,
    replay_key_digest: proof.replay_key_digest,
    proof_digest: proofDigest,
  };
  return { ...core, record_digest: digestPodTransformationEvidenceRecordV1({ ...core, proof }) };
}

function makeSubjectEvidence(
  proof: PodTransformationProofV1,
  proofDigest: string,
  recordId: string,
): PodTransformationSubjectCorroborationV1 {
  const core = {
    record_kind: "pod-transformation-subject-v1" as const,
    record_id: recordId,
    pod_rid: proof.pod_rid,
    operation_id: proof.operation_id,
    replay_key_digest: proof.replay_key_digest,
    proof_digest: proofDigest,
  };
  return { ...core, record_digest: digestPodTransformationEvidenceRecordV1(core) };
}

function parseLedgerRecord(record: LedgerRecord): {
  proof: PodTransformationProofV1;
  proofDigest: string;
  evidence: PodTransformationLedgerCorroborationV1;
} | null {
  try {
    const proof = parsePodTransformationProofV1({
      schema_id: record.fields.get("schema_id"),
      schema_version: Number(record.fields.get("schema_version")),
      generator_id: record.fields.get("generator_id"),
      generator_version: record.fields.get("generator_version"),
      pod_rid: record.fields.get("pod_rid"),
      operation_id: record.fields.get("operation_id"),
      replay_key_digest: record.fields.get("replay_key_digest"),
      before_commit: record.fields.get("before_commit"),
      after_commit: record.fields.get("after_commit"),
      affected_paths: JSON.parse(record.fields.get("affected_paths") ?? "null") as unknown,
      tree_digest: record.fields.get("tree_digest"),
      content_digest: record.fields.get("content_digest"),
    });
    const proofDigest = digestPodTransformationProofV1(proof);
    if (record.fields.get("proof_digest") !== proofDigest) return null;
    const core = evidenceCore(record);
    if (core === null || core.record_kind !== "pod-ledger-receipt-v1") return null;
    const digest = digestPodTransformationEvidenceRecordV1({ ...core, proof });
    if (record.fields.get("record_digest") !== digest) return null;
    return { proof, proofDigest, evidence: { ...core, record_digest: digest } };
  } catch {
    return null;
  }
}

function evidenceCore(
  record: LedgerRecord,
):
  | Omit<PodTransformationLedgerCorroborationV1, "record_digest">
  | Omit<PodTransformationSubjectCorroborationV1, "record_digest">
  | null {
  const kind = record.fields.get("record_kind");
  const value = {
    record_kind: kind,
    record_id: record.fields.get("record_id"),
    pod_rid: record.fields.get("pod_rid"),
    operation_id: record.fields.get("operation_id"),
    replay_key_digest: record.fields.get("replay_key_digest"),
    proof_digest: record.fields.get("proof_digest"),
  };
  if (
    (kind !== "pod-ledger-receipt-v1" && kind !== "pod-transformation-subject-v1") ||
    !UUID_V7_OR_V8.test(value.record_id ?? "") ||
    !UUID_V7_OR_V8.test(value.pod_rid ?? "") ||
    !UUID_V7_OR_V8.test(value.operation_id ?? "") ||
    !SHA256.test(value.replay_key_digest ?? "") ||
    !SHA256.test(value.proof_digest ?? "")
  ) {
    return null;
  }
  return value as
    | Omit<PodTransformationLedgerCorroborationV1, "record_digest">
    | Omit<PodTransformationSubjectCorroborationV1, "record_digest">;
}

function countRecordIds(records: readonly LocatedRecord[], tag: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { record } of records) {
    if (record.recordType !== tag) continue;
    const id = record.fields.get("record_id");
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function proofLockPath(podRoot: string, writerId: string): string {
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: podRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  }).trim();
  const path = join(gitDir, "lyt-locks", "pod-transformations", `${writerId}.lock`);
  assertSafeWritePath(path);
  return path;
}

async function withInProcessQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prior = inProcessTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = prior.then(() => gate);
  inProcessTails.set(key, tail);
  await prior;
  try {
    return await action();
  } finally {
    release();
    if (inProcessTails.get(key) === tail) inProcessTails.delete(key);
  }
}

function canonicalTimestamp(date: Date): string {
  const value = date.toISOString();
  if (!isCanonicalTimestamp(value))
    throw new Error("Pod transformation timestamp is not canonical ISO-8601.");
  return value;
}

function isCanonicalTimestamp(value: string | null): value is string {
  if (value === null) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function assertWriterId(writerId: string): void {
  if (!UUID_V7.test(writerId)) throw new Error("Pod transformation writer id must be UUIDv7.");
}
