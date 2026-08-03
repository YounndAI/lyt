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

// `lyt housekeep` — month-boundary rotation for YON ledger files.
//
// v1.A.2 contract per master-plan §v1.A.2 acceptance item 3:
// `lyt housekeep --ledger audit` rotates audit.yon →
// audit/YYYY-MM.yon on month boundary.
//
// Default scope: every active vault in the registry × every known ledger
// (audit, provenance — friction is deferred to v1.5 per DQ-new-3).
// --vault narrows to one vault; --ledger narrows to one ledger.
//
// Rotation decision: read the file's `@META key=month | value=YYYY-MM`
// header (fallback: first @STAMP `ts`'s month); compare to current UTC
// month. If different (or --rotate-now is set), rename
// `<vault>/.lyt/ledgers/<name>.yon` → `<vault>/.lyt/ledgers/<name>/YYYY-MM.yon`
// and create a fresh empty current-month file carrying
// `@META key=rotation_from | value=<old-month>`.
//
// `--dry-run` reports proposed renames without mutating.
// `--json` mode emits Lock 0.3 deterministic JSON.

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { LEDGER_NAMES, type LedgerKindName } from "../registry/ledger-registry.js";
import { getVaultByName, listVaults, type VaultRow } from "../registry/repo.js";
import { resolveConfig } from "../util/config.js";
import { getMachineId } from "../util/writer-id.js";
import { assertNoReparsePointInPath } from "../util/write-path-guard.js";
import { parseLedgerFile } from "../yon/ledger-read.js";
import { foldMachines, foldSyncObserved, type PublishedMachineSnapshot } from "../yon/machine-ledger.js";
import { compareHlc, parseHlc, type Hlc } from "../util/hlc.js";
import { monthKeyFromIsoTs, rotateLedgerFile } from "../yon/ledger-write.js";
import { normalizeGitHubRepoCoordinate } from "./federation/vault-publish.js";

// v1.A.3 (CR-3 / ALT4): the rotation scope is derived from the LEDGER
// registry — adding a new ledger kind there (e.g. friction post-v1.5)
// brings housekeep along automatically. Local type alias preserved so
// caller code that referenced `LedgerName` keeps compiling.
export type LedgerName = LedgerKindName | "sync";

export const KNOWN_LEDGERS: ReadonlyArray<LedgerName> = [...LEDGER_NAMES, "sync"];

export interface HousekeepArgs {
  // Restrict to one vault by name. Default: every active vault.
  vault?: string;
  /** Stable RID scope used by sync; takes precedence over display name. */
  vaultRid?: string;
  // Restrict to one ledger. Default: every entry in KNOWN_LEDGERS.
  ledger?: LedgerName;
  // Force rotation regardless of the month-boundary check.
  rotateNow?: boolean;
  // Report what would change without mutating any files.
  dryRun?: boolean;
  // Override the "current month" for determinism in tests. Defaults to
  // `new Date().toISOString()`.
  nowIso?: string;
  retentionDays?: number | "never";
  machineId?: string;
  /** Verified committed/upstream pod-ledger snapshot; absence fails closed. */
  publishedMachineSnapshot?: GcPublishedMachineSnapshot;
  verifyPublishedSnapshot?: () => Promise<boolean>;
}

export interface GcPublishedMachineSnapshot extends PublishedMachineSnapshot {
  canonicalUrl: string;
  canonicalRepository: string;
  canonicalRef: string;
  priorCommitOid: string;
  priorMachineIds: string[];
}

export interface HousekeepRotationReport {
  vaultName: string;
  vaultPath: string;
  ledger: LedgerName;
  ledgerPath: string;
  // The month-key of the file currently on disk before rotation. Null when
  // the file is missing OR the header is unreadable.
  fromMonth: string | null;
  // The current UTC month-key the housekeep run is targeting.
  toMonth: string;
  // The archive destination if rotation occurred.
  archivedPath: string | null;
  // What actually happened: rotated · skipped-same-month · skipped-empty ·
  // skipped-no-header · skipped-missing · would-rotate (dry-run) ·
  // would-rotate-now (dry-run + --rotate-now)
  outcome:
    | "rotated"
    | "skipped-same-month"
    | "skipped-empty"
    | "skipped-no-header"
    | "skipped-missing"
    | "would-rotate"
    | "would-rotate-now";
}

export interface HousekeepResult {
  rotations: HousekeepRotationReport[];
  dryRun: boolean;
  scannedVaults: string[];
  scannedLedgers: LedgerName[];
  gc: HousekeepGcReport[];
}

export interface HousekeepGcReport {
  vaultName: string;
  path: string;
  outcome: "deleted" | "would-delete" | "retained-recent" | "retained-unsafe";
  reason?: string;
}

export async function housekeepFlow(args: HousekeepArgs = {}): Promise<HousekeepResult> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const currentMonth = monthKeyFromIsoTs(nowIso);
  const dryRun = args.dryRun === true;
  const rotateNow = args.rotateNow === true;
  const retentionDays = args.retentionDays ?? resolveConfig().syncLedgerRetentionDays;
  if (retentionDays !== "never" && (!Number.isInteger(retentionDays) || retentionDays < 0)) {
    throw new Error("Sync ledger retention must be a non-negative day count or 'never'.");
  }
  if (args.ledger !== undefined && !KNOWN_LEDGERS.includes(args.ledger)) {
    throw new Error(`Unknown ledger '${args.ledger}'. Known: ${KNOWN_LEDGERS.join(", ")}`);
  }
  const ledgers: readonly LedgerName[] = args.ledger ? [args.ledger] : KNOWN_LEDGERS;
  const currentMachineId = args.machineId ?? (ledgers.includes("sync") ? getMachineId() : undefined);

  const db = await openRegistry();
  let vaults: VaultRow[];
  try {
    if (args.vaultRid !== undefined) {
      const all = await listVaults(db);
      vaults = all.filter((v) => v.ridHex === args.vaultRid);
    } else if (args.vault !== undefined) {
      // Names are an addressing layer over the stable RID. Route through the
      // shared resolver so a canonical `{mesh}/{vault}` address keeps working
      // immediately after `vault move`, even while the stored legacy prefix
      // remains unchanged.
      const resolved = await getVaultByName(db, args.vault);
      vaults = resolved === null ? [] : [resolved];
    } else {
      const all = await listVaults(db);
      vaults = all.filter((v) => v.status === "active");
    }
    if ((args.vault || args.vaultRid) && vaults.length === 0) {
      throw new Error(args.vaultRid !== undefined
        ? `No vault registered with RID '${args.vaultRid}'.`
        : `No vault registered with name '${args.vault}'.`);
    }
  } finally {
    await closeRegistry(db);
  }

  const rotations: HousekeepRotationReport[] = [];
  const gc: HousekeepGcReport[] = [];
  for (const v of vaults) {
    for (const ledger of ledgers) {
      // Slice 2b: rotate per-writerId shard files under the shard dir.
      // The old flat `<ledger>.yon` path no longer receives new writes; new
      // shards live under `<vault>/.lyt/ledgers/<ledger>/<writerId>.yon`.
      // Enumerate writerId shard CURRENT files in the shard directory and
      // rotate each one. The legacy flat `<ledger>.yon` is left in place
      // (read-tolerance; no new writes, so no rotation needed).
      const shardDir = join(v.path, ".lyt", "ledgers", ledger);
      assertNoReparsePointInPath(shardDir);
      const shards = listCurrentShardFiles(shardDir);
      if (shards.length === 0) {
        // No shards present — emit one skipped-missing report for the ledger.
        rotations.push({
          vaultName: v.name,
          vaultPath: v.path,
          ledger,
          ledgerPath: join(shardDir, "<no-shards>"),
          fromMonth: null,
          toMonth: currentMonth,
          archivedPath: null,
          outcome: "skipped-missing",
        });
      } else {
        for (const { writerId, shardPath } of shards) {
          if (ledger === "sync" && writerId !== currentMachineId) continue;
          rotations.push(
            rotateOneShard(v, ledger, writerId, shardPath, currentMonth, dryRun, rotateNow),
          );
        }
      }
    }
    if (ledgers.includes("sync") && retentionDays !== "never") {
      gc.push(...await gcSyncArchives(
        v, currentMachineId!, nowIso, retentionDays, dryRun,
        args.publishedMachineSnapshot, args.verifyPublishedSnapshot,
      ));
    }
  }
  return {
    rotations,
    dryRun,
    scannedVaults: vaults.map((v) => v.name),
    scannedLedgers: [...ledgers],
    gc,
  };
}

async function gcSyncArchives(
  vault: VaultRow,
  machineId: string,
  nowIso: string,
  retentionDays: number,
  dryRun: boolean,
  publishedMachineSnapshot?: GcPublishedMachineSnapshot,
  verifyPublishedSnapshot?: () => Promise<boolean>,
): Promise<HousekeepGcReport[]> {
  const dir = join(vault.path, ".lyt", "ledgers", "sync", machineId);
  if (!existsSync(dir)) return [];
  assertNoReparsePointInPath(dir);
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return [{ vaultName: vault.name, path: dir, outcome: "retained-unsafe" }];
    }
  } catch {
    return [{ vaultName: vault.name, path: dir, outcome: "retained-unsafe" }];
  }
  const cutoff = Date.parse(nowIso) - retentionDays * 86_400_000;
  const reports: HousekeepGcReport[] = [];
  for (const name of readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.yon$/u.test(n)).sort()) {
    const path = join(dir, name);
    assertNoReparsePointInPath(path);
    let safe = false;
    let expired = false;
    let reason = "malformed-or-reparse";
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        const parsedRecords = parseLedgerFile(path);
        const records = parsedRecords.filter((r) => r.recordType === "SYNC");
        safe = records.length > 0 && parsedRecords.length === records.length &&
          parsedRecords.every((r) => r.tamper !== true) && records.every((r) => {
          const ts = r.fields.get("timestamp") ?? r.stampTs;
          return ts !== null && ts !== undefined && Number.isFinite(Date.parse(ts)) &&
            r.fields.get("machine_id") === machineId && parseHlc(r.fields.get("hlc") ?? "") !== null &&
            Number.isSafeInteger(Number(r.fields.get("seq"))) && Number(r.fields.get("seq")) >= 1;
        });
        expired = safe && records.every((r) => Date.parse(r.fields.get("timestamp") ?? r.stampTs!) < cutoff);
        if (safe && expired) {
          if (publishedMachineSnapshot === undefined || verifyPublishedSnapshot === undefined) {
            safe = false;
            reason = "published-snapshot-unverified";
          } else {
            const archiveMax = records.reduce<{ hlc: Hlc; seq: number } | null>((max, r) => {
              const candidate = { hlc: parseHlc(r.fields.get("hlc")!)!, seq: Number(r.fields.get("seq")) };
              return max === null || compareHlc(candidate.hlc, max.hlc) > 0 ||
                (compareHlc(candidate.hlc, max.hlc) === 0 && candidate.seq > max.seq) ? candidate : max;
            }, null)!;
            const cohort = foldMachines(publishedMachineSnapshot.machines);
            const priorCohort = new Set(publishedMachineSnapshot.priorMachineIds);
            const cohortValid = cohort.size > 0 && cohort.has(machineId) &&
              publishedMachineSnapshot.canonicalRef.startsWith("refs/heads/") &&
              normalizeGitHubRepoCoordinate(publishedMachineSnapshot.canonicalUrl)?.toLowerCase() ===
                publishedMachineSnapshot.canonicalRepository.toLowerCase() &&
              /^[^/]+\/lyt-pod$/iu.test(publishedMachineSnapshot.canonicalRepository) &&
              /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(publishedMachineSnapshot.priorCommitOid) &&
              [...priorCohort].every((id) => cohort.has(id));
            if (!cohortValid) {
              safe = false;
              reason = "published-cohort-invalid-or-contracted";
            }
            const peers = [...cohort.keys()].filter((id) => id !== machineId);
            const watermarks = foldSyncObserved(publishedMachineSnapshot.observations);
            const covered = peers.every((peer) => {
              const mark = watermarks.get(`${peer}\0${vault.ridHex}\0${machineId}`);
              return mark !== undefined && (compareHlc(mark.throughHlc, archiveMax.hlc) > 0 ||
                (compareHlc(mark.throughHlc, archiveMax.hlc) === 0 && mark.throughSeq >= archiveMax.seq));
            });
            if (safe && !covered) { safe = false; reason = "peer-watermark-short-or-missing"; }
          }
        }
      }
    } catch {
      safe = false;
    }
    const outcome = !safe
      ? "retained-unsafe"
      : expired
        ? (dryRun ? "would-delete" : "deleted")
        : "retained-recent";
    let finalOutcome: HousekeepGcReport["outcome"] = outcome;
    if (outcome === "deleted") {
      // The canonical ref may move after snapshot construction. Revalidate at
      // the destructive boundary, not merely once per housekeep run.
      if (!(await verifyPublishedSnapshot!())) {
        finalOutcome = "retained-unsafe";
        reason = "canonical-publication-drifted";
      } else {
        rmSync(path);
      }
    }
    reports.push({ vaultName: vault.name, path, outcome: finalOutcome, ...(finalOutcome === "retained-unsafe" ? { reason } : {}) });
  }
  return reports;
}

// List the current-file shards (writerId name + path) under a shard directory.
// A current-file shard is `<dir>/<writerId>.yon` where the `<writerId>` entry
// is a FILE (not a directory — archive subdirs are `<dir>/<writerId>/`).
function listCurrentShardFiles(shardDir: string): Array<{ writerId: string; shardPath: string }> {
  if (!existsSync(shardDir)) return [];
  assertNoReparsePointInPath(shardDir);
  let isDir = false;
  try {
    isDir = lstatSync(shardDir).isDirectory();
  } catch {
    return [];
  }
  if (!isDir) return [];
  const out: Array<{ writerId: string; shardPath: string }> = [];
  for (const entry of readdirSync(shardDir)) {
    if (!entry.endsWith(".yon")) continue;
    const full = join(shardDir, entry);
    assertNoReparsePointInPath(full);
    try {
      if (!lstatSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ writerId: entry.replace(/\.yon$/, ""), shardPath: full });
  }
  return out.sort((a, b) => (a.writerId < b.writerId ? -1 : a.writerId > b.writerId ? 1 : 0));
}

// Slice 2b: rotate ONE per-writerId shard file. The archive destination
// for a shard `<shardDir>/<writerId>.yon` is
// `<shardDir>/<writerId>/<effectiveFromMonth>.yon` — the archive subdir is
// keyed by writerId, exactly mirroring the subscription/alias shard layout
// (subscription-ledger-write.ts: "current `<name>.yon` + monthly
// `<name>/YYYY-MM.yon` archives").
function rotateOneShard(
  vault: VaultRow,
  ledger: LedgerName,
  writerId: string,
  shardPath: string,
  currentMonth: string,
  dryRun: boolean,
  rotateNow: boolean,
): HousekeepRotationReport {
  const base: HousekeepRotationReport = {
    vaultName: vault.name,
    vaultPath: vault.path,
    ledger,
    ledgerPath: shardPath,
    fromMonth: null,
    toMonth: currentMonth,
    archivedPath: null,
    outcome: "skipped-missing",
  };
  if (!existsSync(shardPath)) {
    return base;
  }
  assertNoReparsePointInPath(shardPath);
  const content = readFileSync(shardPath, "utf8");
  if (content.length === 0) {
    return { ...base, outcome: "skipped-empty" };
  }
  const fromMonth = parseHeaderMonth(content);
  if (fromMonth === null && !rotateNow) {
    return { ...base, outcome: "skipped-no-header" };
  }
  const effectiveFromMonth = fromMonth ?? currentMonth;
  if (effectiveFromMonth === currentMonth && !rotateNow) {
    return { ...base, fromMonth: effectiveFromMonth, outcome: "skipped-same-month" };
  }
  // Archive: <shardDir>/<writerId>/<effectiveFromMonth>.yon
  // (shardPath is <shardDir>/<writerId>.yon, so dirname = shardDir)
  const archiveSubdir = join(dirname(shardPath), writerId);
  const archivedPath = join(archiveSubdir, `${effectiveFromMonth}.yon`);
  assertNoReparsePointInPath(archiveSubdir);
  assertNoReparsePointInPath(archivedPath);
  assertNoReparsePointInPath(shardPath);
  if (dryRun) {
    return {
      ...base,
      fromMonth: effectiveFromMonth,
      archivedPath,
      outcome: rotateNow ? "would-rotate-now" : "would-rotate",
    };
  }
  // Atomic rotation: mkdir archive parent, rename current → archive,
  // create fresh current with new month header + rotation_from @STAMP.
  const rotated = rotateLedgerFile({
    ledgerPath: shardPath,
    archivedPath,
    ledgerName: writerId,
    fromMonth: effectiveFromMonth,
    toMonth: currentMonth,
    stampSrc: "flows/housekeep",
  });
  if (!rotated) {
    return { ...base, fromMonth: effectiveFromMonth, outcome: "skipped-same-month" };
  }
  return {
    ...base,
    fromMonth: effectiveFromMonth,
    archivedPath,
    outcome: "rotated",
  };
}

function parseHeaderMonth(content: string): string | null {
  // Look for `@META key=month | value=YYYY-MM` first (canonical header).
  const m = content.match(/@META\s+key=month\s*\|\s*value=([0-9]{4}-[0-9]{2})/);
  if (m) return m[1]!;
  // Fallback: first @STAMP ts:ts= value → month key.
  const s = content.match(/@STAMP\s+ts:ts=([0-9TZ:\-.]+)/);
  if (s) {
    const candidate = s[1]!;
    if (/^[0-9]{4}-[0-9]{2}/.test(candidate)) return candidate.slice(0, 7);
  }
  return null;
}
