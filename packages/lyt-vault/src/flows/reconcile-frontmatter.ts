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

import { validateFrontmatterBlock } from "../templates/contract.js";
import { isIndexable, walkVaultMarkdownFiles } from "../util/indexable.js";
import { closeVaultDb, getLytDbPath, isCorruptDatabaseError } from "../registry/vault-db.js";
import { resolveSingleVault } from "../util/vault-resolve.js";

/** One figment on disk whose frontmatter violates the 8-field contract. */
export interface FrontmatterContractIssue {
  /** Vault-relative POSIX path (e.g. `testus/cats.md`). */
  relPath: string;
  /** Mandatory field names that are missing (or `["title"]` when NO block at all). */
  missing: string[];
}

/** Result of the pure disk-only frontmatter-contract scan. */
export interface FrontmatterContractScan {
  /** Total indexable figments walked (README/scaffold/floor already excluded). */
  scanned: number;
  /** The figments that fail validateFrontmatterBlock. */
  invalid: FrontmatterContractIssue[];
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
export function scanFrontmatterContract(vaultPath: string): FrontmatterContractScan {
  const absPaths = walkVaultMarkdownFiles(vaultPath, isIndexable);
  const invalid: FrontmatterContractIssue[] = [];
  for (const abs of absPaths) {
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      // Unreadable → skip (the walker's own guards already dropped most bad
      // files; a detect check must never crash on one odd figment).
      continue;
    }
    const errors = validateFrontmatterBlock(raw);
    if (errors.length > 0) {
      invalid.push({ relPath: toVaultRel(abs, vaultPath), missing: errors.map((e) => e.field) });
    }
  }
  return { scanned: absPaths.length, invalid };
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
  };
}
