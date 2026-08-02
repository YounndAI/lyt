/* Copyright 2026 MARLINK TRADING SRL (YounndAI). Licensed under Apache-2.0. */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getFederationRoot } from "../util/federation-paths.js";
import {
  compareHlc,
  compareHlcStamped,
  parseHlc,
  serializeHlc,
  stampNext,
  type Hlc,
} from "../util/hlc.js";
import {
  fallbackPodAlias,
  readPodIdentity,
  sanitizePodAlias,
  writePodIdentity,
} from "../util/identity-cache.js";
import { getMachineId } from "../util/writer-id.js";
import { appendLedgerRecord } from "./ledger-write.js";
import { walkLedger, type LedgerRecord } from "./ledger-read.js";

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RID7_OR_8 = /^[0-9a-f]{12}[78][0-9a-f]{3}[89ab][0-9a-f]{15}$/u;

export interface PodAliasRecord {
  podRid: string;
  alias: string;
  changedAt: string;
  hlc: Hlc;
  seq: number;
  writerId: string;
}

export function readAllPodAliasRecords(podRoot: string = getFederationRoot()): PodAliasRecord[] {
  const dir = join(podRoot, "ledger", "machines");
  if (!existsSync(dir)) return [];
  const rootStat = lstatSync(dir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing pod alias ledger read through symlink or reparse point: ${dir}`);
  }
  const writers = new Set<string>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing pod alias ledger read through symlink or reparse point: ${path}`);
    }
    if (name.endsWith(".yon") && stat.isFile()) writers.add(name.slice(0, -4));
    else if (stat.isDirectory()) writers.add(name);
  }
  const out: PodAliasRecord[] = [];
  for (const writer of [...writers].filter((id) => UUID7.test(id)).sort()) {
    for (const raw of walkLedger(dir, writer)) {
      const record = parsePodAlias(raw, writer);
      if (record !== null) out.push(record);
    }
  }
  return out;
}

export function foldPodAlias(
  records: readonly PodAliasRecord[],
  podRid: string,
): PodAliasRecord | null {
  assertPodRid(podRid);
  let winner: PodAliasRecord | null = null;
  for (const record of records) {
    if (record.podRid !== podRid)
      throw new Error(`Pod alias ledger RID mismatch: ${record.podRid} != ${podRid}.`);
    if (winner === null || compareHlcStamped(record, winner) > 0) winner = record;
  }
  return winner;
}

export function readPodAlias(podRoot: string, podRid: string): PodAliasRecord | null {
  return foldPodAlias(readAllPodAliasRecords(podRoot), podRid);
}

export function appendPodAlias(args: {
  podRoot?: string;
  podRid: string;
  alias: string;
  machineId?: string;
  changedAt?: string;
  hlcPath?: string;
}): PodAliasRecord {
  const podRoot = args.podRoot ?? getFederationRoot();
  const machineId = args.machineId ?? getMachineId();
  if (!UUID7.test(machineId)) throw new Error("Machine id must be a canonical lowercase UUIDv7.");
  assertPodRid(args.podRid);
  const alias = sanitizePodAlias(args.alias);
  if (alias === null || alias !== args.alias)
    throw new Error("Pod alias must be canonical lowercase letters, numbers, and hyphens.");
  const all = readAllPodAliasRecords(podRoot);
  const observed = all.reduce<Hlc | null>(
    (max, r) => (max === null || compareHlc(r.hlc, max) > 0 ? r.hlc : max),
    null,
  );
  const stamped = stampNext(machineId, {
    observedMaxHlc: observed,
    ...(args.hlcPath ? { path: args.hlcPath } : {}),
  });
  const changedAt = args.changedAt ?? new Date().toISOString();
  appendLedgerRecord({
    ledgerPath: join(podRoot, "ledger", "machines", `${machineId}.yon`),
    ledgerName: machineId,
    recordType: "POD_ALIAS",
    fields: [
      ["pod_rid", args.podRid],
      ["alias", alias],
      ["changed_at", changedAt],
      ["hlc", serializeHlc(stamped.hlc)],
      ["seq", stamped.seq],
    ],
    stampSrc: "flows/pod-alias",
    ts: changedAt,
  });
  return {
    podRid: args.podRid,
    alias,
    changedAt,
    hlc: stamped.hlc,
    seq: stamped.seq,
    writerId: machineId,
  };
}

export function ensurePodAliasAuthority(args: {
  podRoot: string;
  podRid: string;
  fallbackAlias?: string;
}): PodAliasRecord {
  const existing = readPodAlias(args.podRoot, args.podRid);
  if (existing !== null) return existing;
  const legacy = readPodIdentity(args.podRoot);
  if (legacy?.podRid !== undefined && legacy.podRid !== args.podRid)
    throw new Error("Pod identity RID does not match pod alias ledger.");
  const alias =
    sanitizePodAlias(args.fallbackAlias ?? legacy?.podAlias ?? "") ?? fallbackPodAlias(args.podRid);
  return appendPodAlias({ podRoot: args.podRoot, podRid: args.podRid, alias });
}

export function projectPodAlias(podRoot: string, podRid: string): string {
  const identity = readPodIdentity(podRoot);
  if (identity === null || identity.podRid === undefined) {
    return readPodAlias(podRoot, podRid)?.alias ?? fallbackPodAlias(podRid);
  }
  if (identity.podRid !== podRid)
    throw new Error("Pod identity RID does not match pod alias ledger.");
  const alias =
    readPodAlias(podRoot, podRid)?.alias ?? identity.podAlias ?? fallbackPodAlias(podRid);
  if (identity.podAlias !== alias) writePodIdentity({ ...identity, podAlias: alias }, podRoot);
  return alias;
}

function parsePodAlias(raw: LedgerRecord, writerId: string): PodAliasRecord | null {
  if (raw.recordType !== "POD_ALIAS") return null;
  const podRid = raw.fields.get("pod_rid") ?? "";
  const alias = raw.fields.get("alias") ?? "";
  const changedAt = raw.fields.get("changed_at") ?? "";
  const hlc = parseHlc(raw.fields.get("hlc") ?? "");
  const seq = Number(raw.fields.get("seq"));
  if (
    !RID7_OR_8.test(podRid) ||
    sanitizePodAlias(alias) !== alias ||
    !Number.isFinite(Date.parse(changedAt)) ||
    hlc === null ||
    !Number.isSafeInteger(seq) ||
    seq < 1
  )
    return null;
  return { podRid, alias, changedAt, hlc, seq, writerId };
}

function assertPodRid(value: string): void {
  if (!RID7_OR_8.test(value)) throw new Error("Pod RID must be canonical UUIDv7 or UUIDv8 hex.");
}
