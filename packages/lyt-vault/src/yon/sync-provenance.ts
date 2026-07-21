/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { compareHlcStamped, parseHlc, serializeHlc, stampNext, type Hlc } from "../util/hlc.js";
import { ensureSyncProvenancePendingIgnored } from "../flows/migrate-gitignore.js";
import { appendLedgerRecord } from "./ledger-write.js";
import { walkLedger, type LedgerRecord } from "./ledger-read.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RID = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/u;
const MAX_DETAILS_LENGTH = 2048;

export interface SyncProvenanceEvent {
  podRid: string;
  vaultRid: string;
  machineId: string;
  podAlias: string | null;
  alias: string | null;
  account: string | null;
  timestamp: string;
  outcome: string;
  details: string;
  hlc: Hlc;
  seq: number;
  eventId: string;
}

export interface QueueSyncProvenanceArgs {
  vaultPath: string;
  podRid: string;
  vaultRid: string;
  machineId: string;
  podAlias?: string | null;
  alias: string | null;
  account: string | null;
  timestamp?: string;
  outcome: string;
  details: string;
  hlcPath?: string;
}

export interface SyncProvenanceStatus {
  pendingPublication: number;
  degradedPending: number;
  latestLocalSync: SyncProvenanceEvent | null;
  latestPublishedSync: SyncProvenanceEvent | null;
}

export function getSyncLedgerDir(vaultPath: string): string {
  return join(vaultPath, ".lyt", "ledgers", "sync");
}

export function getSyncPendingDir(vaultPath: string): string {
  return join(vaultPath, ".lyt", "sync-provenance-pending");
}

export function queueSyncProvenance(args: QueueSyncProvenanceArgs): SyncProvenanceEvent {
  assertIdentity(args.podRid, "podRid");
  assertIdentity(args.vaultRid, "vaultRid");
  assertMachineId(args.machineId);
  ensureSyncProvenancePendingIgnored(args.vaultPath);
  const observed = maxObservedHlc(readSyncProvenance(args.vaultPath, { includePending: true }));
  const stamped = stampNext(args.machineId, {
    observedMaxHlc: observed,
    ...(args.hlcPath === undefined ? {} : { path: args.hlcPath }),
  });
  const event = normalizeEvent({
    ...args,
    podAlias: args.podAlias ?? null,
    timestamp: args.timestamp ?? new Date().toISOString(),
    details: sanitizeSyncProvenanceText(args.details),
    hlc: stamped.hlc,
    seq: stamped.seq,
    eventId: eventIdentity(args.machineId, stamped.hlc, stamped.seq),
  });
  const dir = getSyncPendingDir(args.vaultPath);
  const path = join(dir, `${safeEventFilename(event)}.json`);
  assertSafeWritePath(args.vaultPath, path);
  mkdirSync(dir, { recursive: true });
  atomicWrite(path, `${JSON.stringify(event)}\n`);
  return event;
}

/** Promote pending events into tracked YON. Safe to repeat after any crash. */
export function promotePendingSyncProvenance(
  vaultPath: string,
  machineId: string,
): string[] {
  assertMachineId(machineId);
  const pending = readPending(vaultPath).filter((e) => e.machineId === machineId);
  if (pending.length === 0) return [];
  const trackedIds = new Set(readTracked(vaultPath).map((e) => e.eventId));
  const ledgerPath = join(getSyncLedgerDir(vaultPath), `${machineId}.yon`);
  assertSafeWritePath(vaultPath, ledgerPath);
  for (const event of pending) {
    if (trackedIds.has(event.eventId)) continue;
    appendSyncEvent(ledgerPath, event);
    trackedIds.add(event.eventId);
  }
  return pending.map((e) => e.eventId);
}

/** Acknowledge only the exact batch promoted before the completed sync. */
export function acknowledgePromotedSyncProvenance(
  vaultPath: string,
  eventIds: readonly string[],
): void {
  const wanted = new Set(eventIds);
  for (const { event, path } of readPendingFiles(vaultPath)) {
    if (!wanted.has(event.eventId)) continue;
    assertSafeWritePath(vaultPath, path);
    rmSync(path);
  }
}

export function readSyncProvenance(
  vaultPath: string,
  options: { includePending?: boolean } = {},
): SyncProvenanceEvent[] {
  const tracked = readTracked(vaultPath);
  if (options.includePending !== true) return sortAndDedupe(tracked);
  return sortAndDedupe([...tracked, ...readPending(vaultPath)]);
}

export function getSyncProvenanceStatus(vaultPath: string): SyncProvenanceStatus {
  const pendingState = readPendingState(vaultPath);
  const pending = pendingState.files.map(({ event }) => event);
  const published = sortAndDedupe(readTracked(vaultPath));
  const local = sortAndDedupe([...published, ...pending]);
  return {
    pendingPublication: pending.length + pendingState.degraded,
    degradedPending: pendingState.degraded,
    latestLocalSync: local.at(-1) ?? null,
    latestPublishedSync: published.at(-1) ?? null,
  };
}

function readTracked(vaultPath: string): SyncProvenanceEvent[] {
  const dir = getSyncLedgerDir(vaultPath);
  if (!existsSync(dir) || !safeDirectory(dir)) return [];
  const writers = new Set<string>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.endsWith(".yon")) writers.add(name.slice(0, -4));
    else if (safeDirectory(path)) writers.add(name);
  }
  const result: SyncProvenanceEvent[] = [];
  for (const writer of [...writers].filter((id) => UUID_V7.test(id)).sort()) {
    for (const raw of walkLedger(dir, writer)) {
      const event = parseEvent(raw, writer);
      if (event !== null) result.push(event);
    }
  }
  return result;
}

function readPending(vaultPath: string): SyncProvenanceEvent[] {
  return readPendingFiles(vaultPath).map(({ event }) => event);
}

function readPendingFiles(vaultPath: string): Array<{ event: SyncProvenanceEvent; path: string }> {
  return readPendingState(vaultPath).files;
}

function readPendingState(vaultPath: string): {
  files: Array<{ event: SyncProvenanceEvent; path: string }>;
  degraded: number;
} {
  const dir = getSyncPendingDir(vaultPath);
  if (!existsSync(dir)) return { files: [], degraded: 0 };
  if (!safeDirectory(dir)) return { files: [], degraded: 1 };
  const result: Array<{ event: SyncProvenanceEvent; path: string }> = [];
  let degraded = 0;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return { files: [], degraded: 1 };
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) {
        degraded += 1;
        continue;
      }
      const event = normalizeEvent(JSON.parse(readFileSync(path, "utf8")) as SyncProvenanceEvent);
      result.push({ event, path });
    } catch {
      // Malformed/unreadable pending entries are retained and never promoted or deleted.
      degraded += 1;
    }
  }
  return { files: result, degraded };
}

function appendSyncEvent(ledgerPath: string, event: SyncProvenanceEvent): void {
  appendLedgerRecord({
    ledgerPath,
    ledgerName: event.machineId,
    recordType: "SYNC",
    fields: [
      ["event_id", event.eventId],
      ["pod_rid", event.podRid],
      ["vault_rid", event.vaultRid],
      ["machine_id", event.machineId],
      ["pod_alias", event.podAlias ?? ""],
      ["alias", event.alias ?? ""],
      ["account", event.account ?? ""],
      ["timestamp", event.timestamp],
      ["outcome", event.outcome],
      ["details", event.details],
      ["hlc", serializeHlc(event.hlc)],
      ["seq", event.seq],
    ],
    stampSrc: "flows/sync",
    ts: event.timestamp,
  });
}

function parseEvent(raw: LedgerRecord, writerId: string): SyncProvenanceEvent | null {
  if (raw.recordType !== "SYNC") return null;
  try {
    return normalizeEvent({
      eventId: required(raw, "event_id"),
      podRid: required(raw, "pod_rid"),
      vaultRid: required(raw, "vault_rid"),
      machineId: required(raw, "machine_id"),
      podAlias: nullable(raw.fields.get("pod_alias")),
      alias: nullable(raw.fields.get("alias")),
      account: nullable(raw.fields.get("account")),
      timestamp: required(raw, "timestamp"),
      outcome: required(raw, "outcome"),
      details: required(raw, "details"),
      hlc: parseHlc(required(raw, "hlc"))!,
      seq: Number(required(raw, "seq")),
    }, writerId);
  } catch {
    return null;
  }
}

function normalizeEvent(raw: SyncProvenanceEvent, writerId?: string): SyncProvenanceEvent {
  assertIdentity(raw.podRid, "podRid");
  assertIdentity(raw.vaultRid, "vaultRid");
  assertMachineId(raw.machineId);
  if (writerId !== undefined && raw.machineId !== writerId) throw new Error("Sync shard owner mismatch.");
  if (parseHlc(serializeHlc(raw.hlc)) === null || !Number.isSafeInteger(raw.seq) || raw.seq < 1)
    throw new Error("Invalid sync event clock.");
  if (raw.eventId !== eventIdentity(raw.machineId, raw.hlc, raw.seq))
    throw new Error("Invalid sync event identity.");
  if (!Number.isFinite(Date.parse(raw.timestamp))) throw new Error("Invalid sync timestamp.");
  if (raw.outcome.length === 0 || raw.outcome.length > 64) throw new Error("Invalid sync outcome.");
  return { ...raw, details: boundDetails(raw.details), podAlias: raw.podAlias ?? null, alias: raw.alias ?? null, account: raw.account ?? null };
}

function sortAndDedupe(events: SyncProvenanceEvent[]): SyncProvenanceEvent[] {
  const unique = new Map(events.map((event) => [event.eventId, event]));
  return [...unique.values()].sort((a, b) =>
    compareHlcStamped(
      { hlc: a.hlc, writerId: a.machineId, seq: a.seq },
      { hlc: b.hlc, writerId: b.machineId, seq: b.seq },
    ),
  );
}

function maxObservedHlc(events: readonly SyncProvenanceEvent[]): Hlc | null {
  return events.reduce<Hlc | null>((max, event) =>
    max === null || event.hlc.wallMs > max.wallMs ||
    (event.hlc.wallMs === max.wallMs && event.hlc.counter > max.counter) ? event.hlc : max, null);
}

function safeEventFilename(event: SyncProvenanceEvent): string {
  return `${event.hlc.wallMs}-${event.hlc.counter}-${event.seq}`;
}

function eventIdentity(machineId: string, hlc: Hlc, seq: number): string {
  return `${machineId}:${serializeHlc(hlc)}:${seq}`;
}

export function sanitizeSyncProvenanceText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[redacted]@")
    .replace(/\bBearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/\b(?:github_pat_|gh[opusr]_|npm_|sk_(?:live|test)_)[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[redacted]")
    .replace(/\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|cookie|session|jwt)\s*[:=]\s*[^\s,;}]+/giu, "$1=[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s"']+/gu, "[path]")
    .replace(/\\\\[^\s"']+/gu, "[path]")
    .replace(/\/(?:Users|home|root|var\/tmp|tmp)\/[^\s"']+/gu, "[path]")
    .slice(0, MAX_DETAILS_LENGTH);
}

function boundDetails(value: string): string {
  return sanitizeSyncProvenanceText(value);
}

function required(raw: LedgerRecord, key: string): string {
  const value = raw.fields.get(key);
  if (value === undefined) throw new Error(`Missing ${key}.`);
  return value;
}

function nullable(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function assertMachineId(value: string): void {
  if (!UUID_V7.test(value)) throw new Error("Machine id must be a canonical lowercase UUIDv7.");
}

function assertIdentity(value: string, label: string): void {
  if (!RID.test(value)) throw new Error(`${label} must be a canonical UUIDv7 hex identity.`);
}

function safeDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertSafeWritePath(root: string, target: string): void {
  const base = resolve(root);
  const absolute = resolve(target);
  if (existsSync(base) && lstatSync(base).isSymbolicLink()) {
    throw new Error(`Refusing sync provenance write through reparse point: ${base}`);
  }
  const rel = relative(base, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Sync provenance path escapes vault.");
  let cursor = base;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Refusing sync provenance write through reparse point: ${cursor}`);
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
