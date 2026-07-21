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

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { getFederationRoot } from "../util/federation-paths.js";
import { withDestinationPolicyLock } from "../flows/federation/destination-policy-lock.js";
import {
  compareHlc,
  compareHlcStamped,
  parseHlc,
  serializeHlc,
  stampNext,
  type Hlc,
} from "../util/hlc.js";
import { assertNoReparsePointInPath } from "../util/write-path-guard.js";
import { getMachineId } from "../util/writer-id.js";
import { appendLedgerRecord } from "./ledger-write.js";
import { parseLedgerText, walkLedger, type LedgerRecord } from "./ledger-read.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MACHINE_OPERATION_LOCK_ACQUIRE_TIMEOUT_MS = 1_000;
const MACHINE_OPERATION_LOCK_LEASE_MS = 30_000;

export interface MachineLedgerRecord {
  machineId: string;
  alias: string;
  firstSeen: string;
  lastSeen: string;
  lastSync: string | null;
  accountIdentity: string | null;
  hlc: Hlc;
  seq: number;
  writerId: string;
}

export interface SyncObservedRecord {
  observerMachineId: string;
  vaultRid: string;
  sourceMachineId: string;
  throughHlc: Hlc;
  throughSeq: number;
  observedAt: string;
  publication: "online";
  hlc: Hlc;
  seq: number;
  writerId: string;
}

export interface PublishedMachineSnapshot {
  commitOid: string;
  machines: MachineLedgerRecord[];
  observations: SyncObservedRecord[];
}

export interface RegisterCurrentMachineArgs {
  podRoot?: string;
  nowIso?: string;
  accountIdentity?: string;
  hostname?: string;
  machineId?: string;
  hlcPath?: string;
}

export function getMachineLedgerDir(podRoot?: string): string {
  return join(podRoot ?? getFederationRoot(), "ledger", "machines");
}

export function sanitizeMachineAlias(value: string): string | null {
  const alias = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return alias.length > 0 ? alias : null;
}

export function fallbackMachineAlias(machineId: string): string {
  return `machine-${machineId.slice(0, 8)}`;
}

export function deriveInitialMachineAlias(machineId: string, hostnameOverride?: string): string {
  let raw = hostnameOverride;
  if (raw === undefined) {
    try {
      raw = hostname();
    } catch {
      raw = "";
    }
  }
  return sanitizeMachineAlias(raw ?? "") ?? fallbackMachineAlias(machineId);
}

export function listMachineShards(podRoot?: string): string[] {
  const dir = getMachineLedgerDir(podRoot);
  if (!existsSync(dir)) return [];
  assertReadableDirectory(dir);
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing machine ledger read through symlink or reparse point: ${full}`);
    }
    if (stat.isDirectory()) names.add(entry);
    else if (stat.isFile() && entry.endsWith(".yon")) names.add(entry.slice(0, -4));
  }
  return [...names].filter((name) => UUID_V7.test(name)).sort();
}

export function readAllMachineRecords(podRoot?: string): MachineLedgerRecord[] {
  const dir = getMachineLedgerDir(podRoot);
  const records: MachineLedgerRecord[] = [];
  for (const writerId of listMachineShards(podRoot)) {
    for (const raw of readMachineShard(dir, writerId)) {
      const parsed = parseMachineRecord(raw, writerId);
      if (parsed !== null) records.push(parsed);
    }
  }
  return records;
}

export function parseMachineShardText(
  content: string,
  writerId: string,
  sourceFile: string,
): {
  machines: MachineLedgerRecord[];
  observations: SyncObservedRecord[];
} {
  assertMachineId(writerId);
  const machines: MachineLedgerRecord[] = [];
  const observations: SyncObservedRecord[] = [];
  for (const raw of parseLedgerText(content, sourceFile)) {
    const machine = parseMachineRecord(raw, writerId);
    if (machine !== null) machines.push(machine);
    const observation = parseSyncObserved(raw, writerId);
    if (observation !== null) observations.push(observation);
  }
  return { machines, observations };
}

export function foldMachines(
  records: readonly MachineLedgerRecord[],
): Map<string, MachineLedgerRecord> {
  const winners = new Map<string, MachineLedgerRecord>();
  for (const record of records) {
    const current = winners.get(record.machineId);
    if (current === undefined || compareMachineRecords(record, current) > 0) {
      winners.set(record.machineId, record);
    }
  }
  return winners;
}

export function readCurrentMachine(
  podRoot?: string,
  machineId: string = getMachineId(),
): MachineLedgerRecord | null {
  return foldMachines(readAllMachineRecords(podRoot)).get(machineId) ?? null;
}

export function readAllSyncObservedRecords(podRoot?: string): SyncObservedRecord[] {
  const dir = getMachineLedgerDir(podRoot);
  const out: SyncObservedRecord[] = [];
  for (const writerId of listMachineShards(podRoot)) {
    for (const raw of readMachineShard(dir, writerId)) {
      const parsed = parseSyncObserved(raw, writerId);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

export function foldSyncObserved(
  records: readonly SyncObservedRecord[],
): Map<string, SyncObservedRecord> {
  const winners = new Map<string, SyncObservedRecord>();
  for (const record of records) {
    const key = `${record.observerMachineId}\0${record.vaultRid}\0${record.sourceMachineId}`;
    const current = winners.get(key);
    const advances =
      current === undefined ||
      compareHlc(record.throughHlc, current.throughHlc) > 0 ||
      (compareHlc(record.throughHlc, current.throughHlc) === 0 &&
        record.throughSeq > current.throughSeq);
    if (
      advances ||
      (current !== undefined &&
        compareHlc(record.throughHlc, current.throughHlc) === 0 &&
        record.throughSeq === current.throughSeq &&
        compareHlcStamped(record, current) > 0)
    )
      winners.set(key, record);
  }
  return winners;
}

export function appendSyncObserved(args: {
  podRoot?: string;
  vaultRid: string;
  sourceMachineId: string;
  throughHlc: Hlc;
  throughSeq: number;
  observedAt?: string;
  hlcPath?: string;
}): SyncObservedRecord | null {
  return appendSyncObservedCore(args, getMachineId());
}

/** Source-only private seam for deterministic multi-machine tests. Not exported by package index. */
export function appendSyncObservedForTest(
  args: Parameters<typeof appendSyncObserved>[0],
  observerMachineId: string,
): SyncObservedRecord | null {
  return appendSyncObservedCore(args, observerMachineId);
}

function appendSyncObservedCore(
  args: Parameters<typeof appendSyncObserved>[0],
  observer: string,
): SyncObservedRecord | null {
  assertMachineId(observer);
  assertMachineId(args.sourceMachineId);
  if (!/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/u.test(args.vaultRid))
    throw new Error("Vault RID must be canonical UUIDv7 hex.");
  const current = foldSyncObserved(readAllSyncObservedRecords(args.podRoot)).get(
    `${observer}\0${args.vaultRid}\0${args.sourceMachineId}`,
  );
  if (
    current !== undefined &&
    (compareHlc(current.throughHlc, args.throughHlc) > 0 ||
      (compareHlc(current.throughHlc, args.throughHlc) === 0 &&
        current.throughSeq >= args.throughSeq))
  )
    return null;
  const observedMax = readAllSyncObservedRecords(args.podRoot).reduce<Hlc | null>(
    (max, r) => (max === null || compareHlc(r.hlc, max) > 0 ? r.hlc : max),
    null,
  );
  const stamped = stampNext(observer, {
    observedMaxHlc: observedMax,
    ...(args.hlcPath ? { path: args.hlcPath } : {}),
  });
  const observedAt = args.observedAt ?? new Date().toISOString();
  appendLedgerRecord({
    ledgerPath: join(getMachineLedgerDir(args.podRoot), `${observer}.yon`),
    ledgerName: observer,
    recordType: "SYNC_OBSERVED",
    fields: [
      ["observer_machine_id", observer],
      ["vault_rid", args.vaultRid],
      ["source_machine_id", args.sourceMachineId],
      ["through_hlc", serializeHlc(args.throughHlc)],
      ["through_seq", args.throughSeq],
      ["observed_at", observedAt],
      ["publication", "online"],
      ["hlc", serializeHlc(stamped.hlc)],
      ["seq", stamped.seq],
    ],
    stampSrc: "flows/sync",
    ts: observedAt,
  });
  return {
    observerMachineId: observer,
    vaultRid: args.vaultRid,
    sourceMachineId: args.sourceMachineId,
    throughHlc: args.throughHlc,
    throughSeq: args.throughSeq,
    observedAt,
    publication: "online",
    hlc: stamped.hlc,
    seq: stamped.seq,
    writerId: observer,
  };
}

export function registerCurrentMachine(args: RegisterCurrentMachineArgs = {}): MachineLedgerRecord {
  const machineId = args.machineId ?? getMachineId();
  assertMachineId(machineId);
  const nowIso = args.nowIso ?? new Date().toISOString();
  return mutateCurrentMachine(args, machineId, (existing) => ({
    alias: existing?.alias ?? deriveInitialMachineAlias(machineId, args.hostname),
    firstSeen: existing?.firstSeen ?? nowIso,
    lastSeen: nowIso,
    lastSync: existing?.lastSync ?? null,
    accountIdentity: args.accountIdentity ?? existing?.accountIdentity ?? null,
  }));
}

export function updateCurrentMachineAlias(
  alias: string,
  args: Omit<RegisterCurrentMachineArgs, "hostname"> = {},
): MachineLedgerRecord {
  const machineId = args.machineId ?? getMachineId();
  assertMachineId(machineId);
  const normalized = sanitizeMachineAlias(alias);
  if (normalized === null)
    throw new Error("Machine alias must contain at least one letter or number.");
  const nowIso = args.nowIso ?? new Date().toISOString();
  return mutateCurrentMachine(args, machineId, (existing) => ({
    alias: normalized,
    firstSeen: existing?.firstSeen ?? nowIso,
    lastSeen: nowIso,
    lastSync: existing?.lastSync ?? null,
    accountIdentity: args.accountIdentity ?? existing?.accountIdentity ?? null,
  }));
}

export function recordCurrentMachineSyncSuccess(
  args: Omit<RegisterCurrentMachineArgs, "hostname"> = {},
): MachineLedgerRecord {
  const machineId = args.machineId ?? getMachineId();
  assertMachineId(machineId);
  const nowIso = args.nowIso ?? new Date().toISOString();
  return mutateCurrentMachine(args, machineId, (existing) => ({
    alias: existing?.alias ?? fallbackMachineAlias(machineId),
    firstSeen: existing?.firstSeen ?? nowIso,
    lastSeen: nowIso,
    lastSync: nowIso,
    accountIdentity: args.accountIdentity ?? existing?.accountIdentity ?? null,
  }));
}

interface AppendCurrentMachineArgs extends Omit<RegisterCurrentMachineArgs, "accountIdentity"> {
  machineId: string;
  alias: string;
  firstSeen: string;
  lastSeen: string;
  lastSync: string | null;
  accountIdentity: string | null;
}

type CurrentMachineFields = Pick<
  AppendCurrentMachineArgs,
  "alias" | "firstSeen" | "lastSeen" | "lastSync" | "accountIdentity"
>;

function mutateCurrentMachine(
  args: RegisterCurrentMachineArgs,
  machineId: string,
  derive: (existing: MachineLedgerRecord | null) => CurrentMachineFields,
): MachineLedgerRecord {
  const ledgerPath = join(getMachineLedgerDir(args.podRoot), `${machineId}.yon`);
  const operationLockPath = `${ledgerPath}.machine-operation.lock`;
  assertNoReparsePointInPath(ledgerPath);
  assertNoReparsePointInPath(operationLockPath);
  return withDestinationPolicyLock(
    operationLockPath,
    () => {
      const shard = readMachineShard(getMachineLedgerDir(args.podRoot), machineId);
      const existing =
        foldMachines(
          shard
            .map((raw) => parseMachineRecord(raw, machineId))
            .filter((record): record is MachineLedgerRecord => record !== null),
        ).get(machineId) ?? null;
      const observedMaxHlc = maxShardHlc(shard);
      return appendCurrentMachine(
        { ...args, machineId, ...derive(existing) },
        ledgerPath,
        observedMaxHlc,
      );
    },
    {
      acquireTimeoutMs: MACHINE_OPERATION_LOCK_ACQUIRE_TIMEOUT_MS,
      leaseMs: MACHINE_OPERATION_LOCK_LEASE_MS,
      subject: `machine:${machineId}`,
    },
  );
}

function appendCurrentMachine(
  args: AppendCurrentMachineArgs,
  ledgerPath: string,
  observedMaxHlc: Hlc | null,
): MachineLedgerRecord {
  const stamped = stampNext(args.machineId, {
    observedMaxHlc,
    ...(args.hlcPath === undefined ? {} : { path: args.hlcPath }),
  });
  appendLedgerRecord({
    ledgerPath,
    ledgerName: args.machineId,
    recordType: "MACHINE",
    fields: [
      ["machine_id", args.machineId],
      ["alias", args.alias],
      ["first_seen", args.firstSeen],
      ["last_seen", args.lastSeen],
      ...(args.lastSync === null ? [] : ([["last_sync", args.lastSync]] as const)),
      ...(args.accountIdentity === null
        ? []
        : ([["account_identity", args.accountIdentity]] as const)),
      ["hlc", serializeHlc(stamped.hlc)],
      ["seq", stamped.seq],
    ],
    stampSrc: "flows/machine-state",
    ts: args.lastSeen,
  });
  return {
    machineId: args.machineId,
    alias: args.alias,
    firstSeen: args.firstSeen,
    lastSeen: args.lastSeen,
    lastSync: args.lastSync,
    accountIdentity: args.accountIdentity,
    hlc: stamped.hlc,
    seq: stamped.seq,
    writerId: args.machineId,
  };
}

function parseMachineRecord(raw: LedgerRecord, writerId: string): MachineLedgerRecord | null {
  if (raw.recordType !== "MACHINE") return null;
  const machineId = raw.fields.get("machine_id");
  const alias = raw.fields.get("alias");
  const firstSeen = raw.fields.get("first_seen");
  const lastSeen = raw.fields.get("last_seen");
  const hlc = parseHlc(raw.fields.get("hlc") ?? "");
  const seq = Number(raw.fields.get("seq"));
  // The shard owner is the machine authority: records may describe only the
  // machine whose canonical UUID names this shard.
  if (
    machineId !== writerId ||
    !UUID_V7.test(machineId) ||
    alias === undefined ||
    sanitizeMachineAlias(alias) !== alias ||
    firstSeen === undefined ||
    lastSeen === undefined ||
    hlc === null ||
    !Number.isSafeInteger(seq) ||
    seq < 0
  ) {
    return null;
  }
  return {
    machineId,
    alias,
    firstSeen,
    lastSeen,
    lastSync: raw.fields.get("last_sync") ?? null,
    accountIdentity: raw.fields.get("account_identity") ?? null,
    hlc,
    seq,
    writerId,
  };
}

function parseSyncObserved(raw: LedgerRecord, writerId: string): SyncObservedRecord | null {
  if (raw.recordType !== "SYNC_OBSERVED") return null;
  const observerMachineId = raw.fields.get("observer_machine_id") ?? "";
  const vaultRid = raw.fields.get("vault_rid") ?? "";
  const sourceMachineId = raw.fields.get("source_machine_id") ?? "";
  const throughHlc = parseHlc(raw.fields.get("through_hlc") ?? "");
  const throughSeq = Number(raw.fields.get("through_seq"));
  const observedAt = raw.fields.get("observed_at") ?? "";
  const hlc = parseHlc(raw.fields.get("hlc") ?? "");
  const seq = Number(raw.fields.get("seq"));
  if (
    observerMachineId !== writerId ||
    !UUID_V7.test(observerMachineId) ||
    !UUID_V7.test(sourceMachineId) ||
    !/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/u.test(vaultRid) ||
    throughHlc === null ||
    !Number.isSafeInteger(throughSeq) ||
    throughSeq < 1 ||
    !Number.isFinite(Date.parse(observedAt)) ||
    raw.fields.get("publication") !== "online" ||
    hlc === null ||
    !Number.isSafeInteger(seq) ||
    seq < 1
  )
    return null;
  return {
    observerMachineId,
    vaultRid,
    sourceMachineId,
    throughHlc,
    throughSeq,
    observedAt,
    publication: "online",
    hlc,
    seq,
    writerId,
  };
}

function compareMachineRecords(a: MachineLedgerRecord, b: MachineLedgerRecord): number {
  return compareHlcStamped(
    { hlc: a.hlc, writerId: a.writerId, seq: a.seq },
    { hlc: b.hlc, writerId: b.writerId, seq: b.seq },
  );
}

function assertMachineId(value: string): void {
  if (!UUID_V7.test(value)) throw new Error("Machine id must be a canonical lowercase UUIDv7.");
}

function assertReadableDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing machine ledger read through symlink or reparse point: ${path}`);
  }
}

function readMachineShard(dir: string, writerId: string): LedgerRecord[] {
  const current = join(dir, `${writerId}.yon`);
  const archive = join(dir, writerId);
  if (existsSync(current)) assertReadableFile(current);
  if (existsSync(archive)) assertReadableDirectory(archive);
  return walkLedger(dir, writerId);
}

function assertReadableFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing machine ledger read through symlink or reparse point: ${path}`);
  }
}

function maxShardHlc(records: readonly LedgerRecord[]): Hlc | null {
  let max: Hlc | null = null;
  for (const record of records) {
    const candidate = parseHlc(record.fields.get("hlc") ?? "");
    if (candidate !== null && (max === null || compareHlc(candidate, max) > 0)) max = candidate;
  }
  return max;
}
