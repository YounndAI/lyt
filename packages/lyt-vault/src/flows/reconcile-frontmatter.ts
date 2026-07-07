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

// Phase D (0.10.0 frontmatter-contract lane) — disk↔index + frontmatter-contract
// DETECT primitives. Pure, read-only, no lyt-runner dep (so the doctor check in
// this package can reuse them without pulling the runner in). The HEAL side lives
// in the meta @younndai/lyt CLI (`lyt vault backfill` / `lyt vault reconcile
// --apply`), because filling frontmatter runs the metadata-filler automator body
// (lyt-runner) and re-indexing runs reindexFlow.
//
// TWO detect axes:
//   1. frontmatter-contract — a figment ON DISK whose leading frontmatter block
//      is missing one of the 8 mandatory contract fields (or has no block at
//      all). This is the `younndai/general/testus/cats.md` case (a raw agent /
//      hand-dropped note with zero frontmatter). SoT: validateFrontmatterBlock.
//   2. disk↔index — a figment ON DISK that the FTS content index does not carry
//      (present-but-unindexed): a raw `.md` copied into the vault that never went
//      through a capture/reindex, so search/recall miss it entirely.
//
// SCOPE FUNNEL — both axes walk the WHOLE vault through the SINGLE shared
// `walkVaultMarkdownFiles` + `isIndexable` funnel, IDENTICAL to what upsertFtsCache
// indexes and the metadata-filler automator fills. That funnel already excludes the
// immutable floor (.lyt / .obsidian / .git), the `lyt-scaffold: true` seed sentinel
// (g6), AND — load-bearing here — `index.md` / `README.md` by basename
// (isScaffoldNote). So README is NEVER counted as a contract violation or an
// unindexed figment: it is frontmatter-EXEMPT by design (regenReadme ships it with
// no frontmatter — handler decision 2026-07-02) and the exemption is enforced for
// free by walking the same funnel, not by a bespoke basename skip here.

import { existsSync, readFileSync } from "node:fs";
import { posix as posixPath, relative, sep } from "node:path";

import { createClient } from "@libsql/client";

import {
  FRONTMATTER_CONTRACT_VERSION,
  readFrontmatterVersion,
  validateFrontmatterBlock,
} from "../templates/contract.js";
import { isIndexable, walkVaultMarkdownFiles } from "../util/indexable.js";
import { closeVaultDb, getLytDbPath, isCorruptDatabaseError } from "../registry/vault-db.js";
import { resolveSingleVault } from "../util/vault-resolve.js";

// ---------------------------------------------------------------------------
// Increment 1 · Phase 0 (gate 1) — the frontmatter migration ENGINE.
//
// This module IS the migration engine the plan calls for ("promote the existing
// reconcile into a migration engine"): the read-only DETECT axes (below) + the
// versioned, forward-only TRANSFORM (here), keyed on readFrontmatterVersion
// (contract.ts). The registry is EMPTY at v1 (current) — every Figment is
// already current, so migration is a no-op. Freezing the pathway now is the
// one-way door: the first contract bump registers one migrator and every
// pre-existing / foreign-imported Figment migrates forward through this ONE
// chokepoint.
//
// STAMP-ON-WRITE is intentionally deferred to the v2 bump: at v1 every Figment
// reads as the baseline, so stamping `frontmatter_version: 1` on every write
// would be redundant noise on the 8-field contract. The key is written only once
// a non-baseline version exists to record (the scaffold-writer wire-in lands with
// v2). The READER (frozen now) makes that safe — an unstamped Figment reads as v1.
//
// The batch WRITE-apply (rewriting migrated Figments as an undoable Operation)
// rides the Phase-A Operation primitive; this file is the pure transform + the
// read-only candidate scan, folded into scanFrontmatterContract's single walk.
// ---------------------------------------------------------------------------

/** One Figment on disk whose stamped contract version is behind the target. */
export interface FrontmatterMigrationCandidate {
  /** Vault-relative POSIX path. */
  relPath: string;
  /** The contract version the Figment reads as (baseline 1 when unstamped). */
  fromVersion: number;
}

/** Migrates one Figment's raw text exactly ONE contract version forward. */
export type FrontmatterMigrator = (raw: string) => string;

/**
 * The migrator registry, keyed by FROM version: `get(n)` takes a vN Figment to
 * v(N+1). EMPTY at v1 — the frozen pathway, populated only when
 * FRONTMATTER_CONTRACT_VERSION bumps. Every registered migrator MUST preserve the
 * body + all author fields byte-stable, NEVER fabricate purpose/topic (an absent
 * author field is queued for the handler, not invented), and be idempotent.
 */
export const FRONTMATTER_MIGRATORS: ReadonlyMap<number, FrontmatterMigrator> = new Map();

/** Outcome of migrating one Figment toward a target contract version. */
export interface FrontmatterMigrationResult {
  /** The (possibly) rewritten Figment text; the last good text on a fault. */
  raw: string;
  /** The version the Figment was read as (baseline 1 when unstamped). */
  fromVersion: number;
  /** The version actually reached (== target on success; the stall point otherwise). */
  toVersion: number;
  /** True when the text changed (a migrator produced different bytes). */
  changed: boolean;
  /** True when a needed migrator is missing — the Figment could not fully migrate. */
  gap: boolean;
  /** Set when a migrator THREW — the message; the chain stops, never propagates. */
  error?: string;
}

/**
 * Migrate a Figment forward to `target` by applying registered migrators in
 * version order. Pure + never-throws (consistent with the detect axes): a
 * migrator that throws STOPS the chain and is reported via `error`, not
 * propagated — so a batch migration can skip one bad Figment and continue. A
 * Figment already at/above `target` is returned unchanged; a missing migrator
 * reports `gap: true` (fail-visible). Takes the registry explicitly so the
 * algorithm is testable without waiting for a real v2 migrator.
 */
export function migrateFrontmatterTo(
  raw: string,
  target: number,
  migrators: ReadonlyMap<number, FrontmatterMigrator>,
): FrontmatterMigrationResult {
  const from = readFrontmatterVersion(raw);
  if (from >= target) {
    return { raw, fromVersion: from, toVersion: from, changed: false, gap: false };
  }
  let cur = raw;
  let v = from;
  while (v < target) {
    const migrator = migrators.get(v);
    if (migrator === undefined) {
      return { raw: cur, fromVersion: from, toVersion: v, changed: cur !== raw, gap: true };
    }
    try {
      cur = migrator(cur);
    } catch (err) {
      return {
        raw: cur,
        fromVersion: from,
        toVersion: v,
        changed: cur !== raw,
        gap: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    v += 1;
  }
  return { raw: cur, fromVersion: from, toVersion: target, changed: cur !== raw, gap: false };
}

/**
 * Migrate a Figment forward to the CURRENT contract version using the live
 * registry. The INTENDED production entry point — the Phase-A batch write-apply
 * and the Phase-D adopt/import backfill WILL call this. It has NO production
 * caller today (the registry is empty → a verified no-op at v1); the transform
 * is a frozen pathway until the first contract bump wires those callers.
 */
export function migrateFrontmatterToCurrent(raw: string): FrontmatterMigrationResult {
  return migrateFrontmatterTo(raw, FRONTMATTER_CONTRACT_VERSION, FRONTMATTER_MIGRATORS);
}

/** One figment on disk whose frontmatter violates the 8-field contract. */
export interface FrontmatterContractIssue {
  /** Vault-relative POSIX path (e.g. `testus/cats.md`). */
  relPath: string;
  /** Mandatory field names that are missing (or `["title"]` when NO block at all). */
  missing: string[];
}

/** Result of the pure disk-only frontmatter-contract scan (contract + migration axes). */
export interface FrontmatterContractScan {
  /** Total indexable figments walked (README/scaffold/floor already excluded). */
  scanned: number;
  /** The figments that fail validateFrontmatterBlock. */
  invalid: FrontmatterContractIssue[];
  /** The contract version the migration axis measures `behind` against. */
  targetVersion: number;
  /** Figments whose stamped version is behind `targetVersion` (migration candidates). */
  behind: FrontmatterMigrationCandidate[];
}

// Vault-relative POSIX path from an absolute path (matches the key shape
// upsertFtsCache writes + listDiskFigments in doctor.ts).
function toVaultRel(absPath: string, vaultRoot: string): string {
  return relative(vaultRoot, absPath).split(sep).join(posixPath.sep);
}

/**
 * Walk every indexable figment in `vaultPath` and report the ones whose leading
 * frontmatter block is missing a mandatory contract field (or is absent). Pure +
 * synchronous + read-only — never writes, never throws on a single bad file (an
 * unreadable file is skipped, not counted). README / scaffold seeds are excluded
 * by the shared isIndexable funnel (they are contract-exempt by design).
 */
export function scanFrontmatterContract(
  vaultPath: string,
  targetVersion: number = FRONTMATTER_CONTRACT_VERSION,
): FrontmatterContractScan {
  const absPaths = walkVaultMarkdownFiles(vaultPath, isIndexable);
  const invalid: FrontmatterContractIssue[] = [];
  const behind: FrontmatterMigrationCandidate[] = [];
  for (const abs of absPaths) {
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      // Unreadable → skip (the walker's own guards already dropped most bad
      // files; a detect check must never crash on one odd figment).
      continue;
    }
    const relPath = toVaultRel(abs, vaultPath);
    const errors = validateFrontmatterBlock(raw);
    if (errors.length > 0) {
      invalid.push({ relPath, missing: errors.map((e) => e.field) });
    }
    // Same walk, migration axis: Figments behind the target contract version.
    // Reuses this read — no separate vault walk (the plan's anti-duplication door).
    const from = readFrontmatterVersion(raw);
    if (from < targetVersion) {
      behind.push({ relPath, fromVersion: from });
    }
  }
  return { scanned: absPaths.length, invalid, targetVersion, behind };
}

/** Result of the disk↔index (present-but-unindexed) scan. */
export interface UnindexedScan {
  /** Vault-relative POSIX paths present on disk but absent from figment_fts. */
  unindexed: string[];
  /** Figments walked on disk (README/scaffold/floor excluded). */
  onDisk: number;
  /** False when the vault has no `.lyt/indexes/lyt.db` yet (never indexed). */
  indexPresent: boolean;
}

// Read ALL indexed figment keys from figment_fts via a RAW read-only client (no
// migrations — a detect scan must never write). Mirrors doctor.ts
// readIndexedFigmentPaths but UNCAPPED (reconcile needs the full set, not a
// bounded sample). A missing table / corrupt db reads as an empty index (nothing
// indexed) so `--apply`'s reindex heals it rather than the scan throwing.
async function readAllIndexedRelPaths(vaultPath: string): Promise<Set<string>> {
  const raw = createClient({ url: `file:${getLytDbPath(vaultPath)}` });
  try {
    const r = await raw.execute("SELECT figment_rid FROM figment_fts");
    return new Set(r.rows.map((row) => String(row["figment_rid"])));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) return new Set();
    if (isCorruptDatabaseError(err)) return new Set();
    throw err;
  } finally {
    await closeVaultDb(raw);
  }
}

/**
 * Diff the on-disk indexable figments against the FTS content index, returning
 * the present-but-unindexed set. Read-only. When the index db does not exist yet
 * every on-disk figment is "unindexed" (nothing has been indexed) — `indexPresent`
 * distinguishes that from a populated-but-stale index.
 */
export async function scanUnindexedFigments(vaultPath: string): Promise<UnindexedScan> {
  const diskRel = walkVaultMarkdownFiles(vaultPath, isIndexable).map((p) => toVaultRel(p, vaultPath));
  if (!existsSync(getLytDbPath(vaultPath))) {
    return { unindexed: diskRel, onDisk: diskRel.length, indexPresent: false };
  }
  const indexed = await readAllIndexedRelPaths(vaultPath);
  return {
    unindexed: diskRel.filter((r) => !indexed.has(r)),
    onDisk: diskRel.length,
    indexPresent: true,
  };
}

/** Combined detect result for one vault (both axes). */
export interface ReconcileScan {
  vaultName: string;
  vaultPath: string;
  /** Indexable figments walked on disk. */
  scanned: number;
  /** Figments failing the 8-field frontmatter contract. */
  missingFrontmatter: FrontmatterContractIssue[];
  /** Figments present on disk but absent from the FTS index. */
  unindexed: string[];
  /** False when the vault has never been indexed (no lyt.db). */
  indexPresent: boolean;
  /** Contract version the migration axis measures `behind` against. */
  targetVersion: number;
  /** Figments behind targetVersion (forward-migration candidates). */
  behind: FrontmatterMigrationCandidate[];
}

/**
 * Resolve a single vault by name (the standard resolveSingleVault chokepoint —
 * required when more than one vault is registered) and run BOTH detect axes.
 * Read-only; the caller (`lyt vault reconcile`) decides whether to heal.
 */
export async function reconcileVaultScan(vaultName: string | undefined): Promise<ReconcileScan> {
  const vault = await resolveSingleVault(vaultName);
  // Two independent walks (one per axis) — acceptable for an on-demand reconcile
  // verb; not a hot path. Both use the identical funnel so the two views agree on
  // which files are in scope.
  const fm = scanFrontmatterContract(vault.path);
  const idx = await scanUnindexedFigments(vault.path);
  return {
    vaultName: vault.name,
    vaultPath: vault.path,
    scanned: fm.scanned,
    missingFrontmatter: fm.invalid,
    unindexed: idx.unindexed,
    indexPresent: idx.indexPresent,
    targetVersion: fm.targetVersion,
    behind: fm.behind,
  };
}
