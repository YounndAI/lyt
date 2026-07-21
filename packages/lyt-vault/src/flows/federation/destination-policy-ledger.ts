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

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  DESTINATION_POLICY_SCHEMA_MAJOR,
  LEGACY_DESTINATION_POLICY_SCHEMA_MAJOR,
  DestinationPolicyValidationError,
  UnsupportedDestinationPolicySchemaError,
  assertSupportedDestinationPolicyWriter,
  destinationPolicyKey,
  type DestinationKind,
  type DestinationPolicyRecordV1,
  type DestinationPolicyState,
  type DestinationSource,
  type DestinationSubjectKind,
  type DestinationTargetKind,
  validateDestinationPolicyValue,
} from "../../registry/destination-policy.js";
import { getFederationRoot } from "../../util/federation-paths.js";
import {
  compareHlc,
  compareHlcStamped,
  parseHlc,
  serializeHlc,
  stampNext,
  type Hlc,
} from "../../util/hlc.js";
import { getLytHome } from "../../util/paths.js";
import { getWriterId } from "../../util/writer-id.js";
import {
  appendLedgerRecord,
  clearLedgerCache,
  type AppendLedgerRecordResult,
} from "../../yon/ledger-write.js";
import { walkLedger, type LedgerRecord } from "../../yon/ledger-read.js";
import {
  withDestinationPolicyLock,
  type DestinationPolicyLockOptions,
} from "./destination-policy-lock.js";

export class ForeignDestinationPolicyError extends Error {
  readonly errorCode = "foreign-destination-policy";
}

export class DestinationPolicyChainError extends Error {
  readonly errorCode = "invalid-destination-policy-chain";
}

export class DestinationPolicyLossError extends Error {
  readonly errorCode = "destination-policy-loss-detected";
}

export interface DestinationPolicyObservationEntry {
  key: string;
  policyEpoch: number;
  hlc: string;
  writerId: string;
  seq: number;
  digest: string;
}

export interface DestinationPolicyObservation {
  schemaMajor: 1 | 2;
  podRid: string;
  winners: readonly DestinationPolicyObservationEntry[];
}

export interface AppendDestinationPolicyArgs {
  podRid: string;
  subjectKind: DestinationSubjectKind;
  subjectRid: string;
  destinationKind: DestinationKind;
  targetOwner: string | null;
  targetKind: DestinationTargetKind | null;
  repositoryName?: string | null;
  source: DestinationSource;
  state?: DestinationPolicyState;
  policyEpoch?: number;
  writerVersion: string;
  recordedAt?: string;
  podRoot?: string;
  writerId?: string;
  hlc?: Hlc;
  seq?: number;
  hlcPath?: string;
  observationPath?: string;
  priorObservation?: DestinationPolicyObservation;
  lockOptions?: DestinationPolicyLockOptions;
}

export function getDestinationPolicyLedgerDir(podRoot?: string): string {
  return join(podRoot ?? getFederationRoot(), "ledger", "destination-policy");
}

export function getDestinationPolicyLockPath(podRoot?: string): string {
  return join(getDestinationPolicyLedgerDir(podRoot), ".policy-ledger.lock");
}

/** A scoped attempt lock blocks mutation of one policy subject during I/O. */
export function getDestinationPolicyAttemptLockPath(
  subjectKind: DestinationSubjectKind,
  subjectRid: string,
  podRoot?: string,
): string {
  return getPublicationAttemptLockPath(destinationPolicyKey(subjectKind, subjectRid), podRoot);
}

/** Scoped publication lock for non-policy subjects such as the pod repository. */
export function getPublicationAttemptLockPath(subjectIdentity: string, podRoot?: string): string {
  const digest = createHash("sha256").update(subjectIdentity).digest("hex");
  return join(getDestinationPolicyLedgerDir(podRoot), ".publication-attempts", `${digest}.lock`);
}

export function getDestinationPolicyObservationPath(podRid: string): string {
  return join(getLytHome(), "observations", `destination-policy-${podRid}.json`);
}

export function readAllDestinationPolicyRecords(
  expectedPodRid: string,
  podRoot?: string,
): DestinationPolicyRecordV1[] {
  const dir = getDestinationPolicyLedgerDir(podRoot);
  const out: DestinationPolicyRecordV1[] = [];
  for (const writerId of listPolicyShards(dir)) {
    const shard = walkLedger(dir, writerId);
    assertValidPolicyChain(shard);
    for (const raw of shard) {
      if (raw.recordType !== "DESTINATION_POLICY") continue;
      out.push(parsePolicyRecord(raw, writerId, expectedPodRid));
    }
  }
  return out;
}

export function foldDestinationPolicyWinners(
  records: readonly DestinationPolicyRecordV1[],
): Map<string, DestinationPolicyRecordV1> {
  const winners = new Map<string, DestinationPolicyRecordV1>();
  for (const record of records) {
    const key = destinationPolicyKey(record.subjectKind, record.subjectRid);
    const current = winners.get(key);
    if (current === undefined || comparePolicyRecord(record, current) > 0) {
      winners.set(key, record);
    }
  }
  return winners;
}

export function observeDestinationPolicyLedger(
  expectedPodRid: string,
  podRoot?: string,
  observationPath?: string,
): DestinationPolicyObservation {
  return withDestinationPolicyLock(getDestinationPolicyLockPath(podRoot), () =>
    observeDestinationPolicyLedgerUnlocked(expectedPodRid, podRoot, observationPath),
  );
}

/** Read winners only after enforcing the previously observed ledger tip. */
export function readVerifiedDestinationPolicyWinners(
  expectedPodRid: string,
  podRoot?: string,
  observationPath?: string,
): Map<string, DestinationPolicyRecordV1> {
  return withDestinationPolicyLock(getDestinationPolicyLockPath(podRoot), () =>
    readVerifiedDestinationPolicyWinnersUnderLock(expectedPodRid, podRoot, observationPath),
  );
}

/**
 * Physically read-only authority check for planning. It accepts only a ledger
 * state already covered by the durable loss-detection observation and never
 * advances that observation itself.
 */
export function readObservedDestinationPolicyWinnersReadOnly(
  expectedPodRid: string,
  podRoot?: string,
  observationPath?: string,
): Map<string, DestinationPolicyRecordV1> {
  const winners = foldDestinationPolicyWinners(
    readAllDestinationPolicyRecords(expectedPodRid, podRoot),
  );
  const prior = loadObservation(
    observationPath ?? getDestinationPolicyObservationPath(expectedPodRid),
  );
  if (prior === null) {
    throw new DestinationPolicyLossError(
      "No durable destination-policy observation covers the current ledger state.",
    );
  }
  assertNoObservedPolicyLoss(prior, expectedPodRid, winners);
  return winners;
}

/** Caller must already hold the canonical policy-wide lock. */
export function readVerifiedDestinationPolicyWinnersUnderLock(
  expectedPodRid: string,
  podRoot?: string,
  observationPath?: string,
): Map<string, DestinationPolicyRecordV1> {
  observeDestinationPolicyLedgerUnlocked(expectedPodRid, podRoot, observationPath);
  return foldDestinationPolicyWinners(readAllDestinationPolicyRecords(expectedPodRid, podRoot));
}

function observeDestinationPolicyLedgerUnlocked(
  expectedPodRid: string,
  podRoot?: string,
  observationPath?: string,
): DestinationPolicyObservation {
  const winners = foldDestinationPolicyWinners(
    readAllDestinationPolicyRecords(expectedPodRid, podRoot),
  );
  const resolvedObservationPath =
    observationPath ?? getDestinationPolicyObservationPath(expectedPodRid);
  const prior = loadObservation(resolvedObservationPath);
  if (prior !== null) assertNoObservedPolicyLoss(prior, expectedPodRid, winners);
  const observation = createObservation(expectedPodRid, winners);
  persistObservation(observation, resolvedObservationPath);
  return observation;
}

export function appendDestinationPolicyRecord(
  args: AppendDestinationPolicyArgs,
): AppendLedgerRecordResult {
  assertSupportedDestinationPolicyWriter(args.writerVersion);
  validateDestinationPolicyValue(args.subjectKind, args);

  return withDestinationPolicyLock(
    getDestinationPolicyLockPath(args.podRoot),
    () => appendDestinationPolicyRecordUnlocked(args),
    args.lockOptions,
  );
}

/** Caller must hold the policy-wide lock for the entire enclosing mutation. */
export function appendDestinationPolicyRecordUnderLock(
  args: AppendDestinationPolicyArgs,
): AppendLedgerRecordResult {
  assertSupportedDestinationPolicyWriter(args.writerVersion);
  validateDestinationPolicyValue(args.subjectKind, args);
  return appendDestinationPolicyRecordUnlocked(args);
}

function appendDestinationPolicyRecordUnlocked(
  args: AppendDestinationPolicyArgs,
): AppendLedgerRecordResult {
  const current = readAllDestinationPolicyRecords(args.podRid, args.podRoot);
  for (const record of current) assertSupportedDestinationPolicyWriter(record.writerVersion);
  const winners = foldDestinationPolicyWinners(current);
  const observationPath = args.observationPath ?? getDestinationPolicyObservationPath(args.podRid);
  const prior = args.priorObservation ?? loadObservation(observationPath);
  if (prior !== null) assertNoObservedPolicyLoss(prior, args.podRid, winners);

  let hlc: Hlc;
  let seq: number;
  const writerId = args.writerId ?? getWriterId();
  if (args.hlc !== undefined) {
    hlc = args.hlc;
    seq = args.seq ?? 0;
  } else {
    const stamped = stampNext(writerId, {
      observedMaxHlc: observedMaxPolicyHlc(current),
      path: args.hlcPath,
    });
    hlc = stamped.hlc;
    seq = stamped.seq;
  }
  const recordedAt = args.recordedAt ?? new Date().toISOString();
  const ledgerPath = join(getDestinationPolicyLedgerDir(args.podRoot), `${writerId}.yon`);
  // The generic ledger cache invalidates by size. Equal-size external changes
  // are possible, so policy writes always reload the current tip while holding
  // the policy-wide lease before replacing the shard.
  clearLedgerCache(ledgerPath);
  const result = appendLedgerRecord({
    ledgerPath,
    ledgerName: writerId,
    recordType: "DESTINATION_POLICY",
    fields: [
      ["schema_major", DESTINATION_POLICY_SCHEMA_MAJOR],
      ["pod_rid", args.podRid],
      ["subject_kind", args.subjectKind],
      ["subject_rid", args.subjectRid],
      ["destination_kind", args.destinationKind],
      ["target_owner", args.targetOwner ?? "-"],
      ["target_kind", args.targetKind ?? "-"],
      ["repository_name", args.repositoryName ?? "-"],
      ["source", args.source],
      ["state", args.state ?? "active"],
      ["policy_epoch", args.policyEpoch ?? 0],
      ["writer_version", args.writerVersion],
      ["hlc", serializeHlc(hlc)],
      ["seq", seq],
      ["recorded_at", recordedAt],
    ],
    stampSrc: "flows/federation/destination-policy",
    ts: recordedAt,
  });

  const after = readAllDestinationPolicyRecords(args.podRid, args.podRoot);
  assertAppendedPolicyReadBack(after, {
    args,
    writerId,
    hlc,
    seq,
    recordedAt,
  });
  observeDestinationPolicyLedgerUnlocked(args.podRid, args.podRoot, observationPath);
  return result;
}

export function assertNoObservedPolicyLoss(
  prior: DestinationPolicyObservation,
  expectedPodRid: string,
  current: ReadonlyMap<string, DestinationPolicyRecordV1>,
): void {
  if ((prior.schemaMajor !== 1 && prior.schemaMajor !== 2) || prior.podRid !== expectedPodRid) {
    throw new DestinationPolicyLossError(
      "The destination-policy observation belongs to a different or unsupported pod schema.",
    );
  }
  for (const seen of prior.winners) {
    const now = current.get(seen.key);
    if (now === undefined) {
      throw new DestinationPolicyLossError(
        `Previously observed destination policy ${JSON.stringify(seen.key)} is missing; ` +
          "restore the policy ledger or upgrade the older writer before changing policy.",
      );
    }
    if (!Number.isSafeInteger(seen.policyEpoch) || seen.policyEpoch < 0) {
      throw new DestinationPolicyLossError("Stored policy observation is invalid.");
    }
    const nowEpoch = now.policyEpoch ?? 0;
    if (nowEpoch < seen.policyEpoch) {
      throw new DestinationPolicyLossError(
        `Previously observed destination policy ${JSON.stringify(seen.key)} regressed or was rewritten.`,
      );
    }
    if (nowEpoch > seen.policyEpoch) continue;
    const seenHlc = parseHlc(seen.hlc);
    if (seenHlc === null)
      throw new DestinationPolicyLossError("Stored policy observation is invalid.");
    const ordering = compareHlcStamped(
      { hlc: now.hlc, writerId: now.writerId, seq: now.seq },
      { hlc: seenHlc, writerId: seen.writerId, seq: seen.seq },
    );
    if (ordering < 0 || (ordering === 0 && digestPolicyRecord(now) !== seen.digest)) {
      throw new DestinationPolicyLossError(
        `Previously observed destination policy ${JSON.stringify(seen.key)} regressed or was rewritten.`,
      );
    }
  }
}

function parsePolicyRecord(
  raw: LedgerRecord,
  writerId: string,
  expectedPodRid: string,
): DestinationPolicyRecordV1 {
  const major = Number(raw.fields.get("schema_major"));
  if (
    major !== LEGACY_DESTINATION_POLICY_SCHEMA_MAJOR &&
    major !== DESTINATION_POLICY_SCHEMA_MAJOR
  ) {
    throw new UnsupportedDestinationPolicySchemaError(
      `Unsupported destination-policy schema major ${String(raw.fields.get("schema_major"))}.`,
    );
  }
  const podRid = required(raw, "pod_rid");
  if (podRid !== expectedPodRid) {
    throw new ForeignDestinationPolicyError(
      `Destination policy belongs to pod ${podRid}, not local pod ${expectedPodRid}.`,
    );
  }
  const subjectKindRaw = required(raw, "subject_kind");
  if (subjectKindRaw !== "mesh" && subjectKindRaw !== "vault") invalid("subject_kind");
  const destinationKindRaw = required(raw, "destination_kind");
  if (destinationKindRaw !== "local" && destinationKindRaw !== "github")
    invalid("destination_kind");
  const targetKindRaw = required(raw, "target_kind");
  if (targetKindRaw !== "-" && targetKindRaw !== "user" && targetKindRaw !== "org")
    invalid("target_kind");
  const stateRaw = required(raw, "state");
  if (stateRaw !== "active" && stateRaw !== "tombstoned") invalid("state");
  const hlc = parseHlc(required(raw, "hlc"));
  if (hlc === null) invalid("hlc");
  const seq = Number(required(raw, "seq"));
  if (!Number.isSafeInteger(seq) || seq < 0) invalid("seq");
  const policyEpoch = Number(raw.fields.get("policy_epoch") ?? "0");
  if (!Number.isSafeInteger(policyEpoch) || policyEpoch < 0) invalid("policy_epoch");
  const record: DestinationPolicyRecordV1 = {
    schemaMajor: major as
      | typeof LEGACY_DESTINATION_POLICY_SCHEMA_MAJOR
      | typeof DESTINATION_POLICY_SCHEMA_MAJOR,
    podRid,
    subjectKind: subjectKindRaw as DestinationSubjectKind,
    subjectRid: required(raw, "subject_rid"),
    destinationKind: destinationKindRaw as DestinationKind,
    targetOwner: required(raw, "target_owner") === "-" ? null : required(raw, "target_owner"),
    targetKind: targetKindRaw === "-" ? null : (targetKindRaw as DestinationTargetKind),
    repositoryName:
      major === LEGACY_DESTINATION_POLICY_SCHEMA_MAJOR || raw.fields.get("repository_name") === "-"
        ? null
        : required(raw, "repository_name"),
    source: required(raw, "source") as DestinationSource,
    state: stateRaw as DestinationPolicyState,
    policyEpoch,
    writerVersion: required(raw, "writer_version"),
    writerId,
    hlc,
    seq,
    recordedAt: required(raw, "recorded_at"),
  };
  if (major === LEGACY_DESTINATION_POLICY_SCHEMA_MAJOR) {
    validateLegacyPolicyValue(record);
  } else {
    validateDestinationPolicyValue(record.subjectKind, record);
  }
  return record;
}

function validateLegacyPolicyValue(record: DestinationPolicyRecordV1): void {
  validateDestinationPolicyValue(record.subjectKind, {
    ...record,
    repositoryName:
      record.subjectKind === "vault" && record.destinationKind === "github"
        ? "legacy-schema-unbound"
        : null,
  });
}

function assertValidPolicyChain(records: readonly LedgerRecord[]): void {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const invalidStamp =
      record.stampSrc === null ||
      record.stampTs === null ||
      record.stampHash === null ||
      record.tamper === true;
    const invalidSentinel = index === 0 ? record.stampHash !== "-" : record.stampHash === "-";
    if (invalidStamp || invalidSentinel) {
      throw new DestinationPolicyChainError(
        `Destination-policy ledger chain is missing or invalid in ${record.sourceFile}.`,
      );
    }
  }
}

function assertAppendedPolicyReadBack(
  records: readonly DestinationPolicyRecordV1[],
  expected: {
    args: AppendDestinationPolicyArgs;
    writerId: string;
    hlc: Hlc;
    seq: number;
    recordedAt: string;
  },
): void {
  const actual = [...records]
    .reverse()
    .find(
      (record) =>
        record.writerId === expected.writerId &&
        compareHlc(record.hlc, expected.hlc) === 0 &&
        record.seq === expected.seq &&
        record.recordedAt === expected.recordedAt,
    );
  if (
    actual === undefined ||
    actual.podRid !== expected.args.podRid ||
    actual.subjectKind !== expected.args.subjectKind ||
    actual.subjectRid !== expected.args.subjectRid ||
    actual.destinationKind !== expected.args.destinationKind ||
    actual.targetOwner !== expected.args.targetOwner ||
    actual.targetKind !== expected.args.targetKind ||
    actual.repositoryName !== (expected.args.repositoryName ?? null) ||
    actual.source !== expected.args.source ||
    actual.state !== (expected.args.state ?? "active") ||
    actual.policyEpoch !== (expected.args.policyEpoch ?? 0) ||
    actual.writerVersion !== expected.args.writerVersion
  ) {
    throw new DestinationPolicyChainError(
      "The appended destination-policy record failed read-back verification.",
    );
  }
}

function listPolicyShards(dir: string): string[] {
  if (!existsSync(dir) || !safeIsDir(dir)) return [];
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (safeIsDir(full)) names.add(entry);
    else if (entry.endsWith(".yon")) names.add(entry.slice(0, -4));
  }
  return [...names].sort();
}

function observedMaxPolicyHlc(records: readonly DestinationPolicyRecordV1[]): Hlc | null {
  let max: Hlc | null = null;
  for (const record of records) {
    if (max === null || compareHlc(record.hlc, max) > 0) max = record.hlc;
  }
  return max;
}

function comparePolicyRecord(a: DestinationPolicyRecordV1, b: DestinationPolicyRecordV1): number {
  const aEpoch = a.policyEpoch ?? 0;
  const bEpoch = b.policyEpoch ?? 0;
  if (aEpoch !== bEpoch) return aEpoch < bEpoch ? -1 : 1;
  return compareHlcStamped(a, b);
}

function createObservation(
  podRid: string,
  winners: ReadonlyMap<string, DestinationPolicyRecordV1>,
): DestinationPolicyObservation {
  return {
    schemaMajor: 2,
    podRid,
    winners: [...winners.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, record]) => ({
        key,
        policyEpoch: record.policyEpoch ?? 0,
        hlc: serializeHlc(record.hlc),
        writerId: record.writerId,
        seq: record.seq,
        digest: digestPolicyRecord(record),
      })),
  };
}

function digestPolicyRecord(record: DestinationPolicyRecordV1): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaMajor: record.schemaMajor,
        podRid: record.podRid,
        subjectKind: record.subjectKind,
        subjectRid: record.subjectRid,
        destinationKind: record.destinationKind,
        targetOwner: record.targetOwner,
        targetKind: record.targetKind,
        ...(record.schemaMajor === LEGACY_DESTINATION_POLICY_SCHEMA_MAJOR
          ? {}
          : { repositoryName: record.repositoryName ?? null }),
        source: record.source,
        state: record.state,
        policyEpoch: record.policyEpoch,
        writerVersion: record.writerVersion,
        writerId: record.writerId,
        hlc: serializeHlc(record.hlc),
        seq: record.seq,
      }),
    )
    .digest("hex");
}

function loadObservation(path: string): DestinationPolicyObservation | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DestinationPolicyObservation;
  } catch {
    throw new DestinationPolicyLossError(
      "The local destination-policy observation is unreadable; inspect it before changing policy.",
    );
  }
}

function persistObservation(observation: DestinationPolicyObservation, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(observation)}\n`, "utf8");
  renameSync(tmp, path);
}

function required(record: LedgerRecord, field: string): string {
  const value = record.fields.get(field);
  if (value === undefined || value.length === 0) invalid(field);
  return value;
}

function invalid(field: string): never {
  throw new DestinationPolicyValidationError(`Invalid destination-policy field ${field}.`);
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
