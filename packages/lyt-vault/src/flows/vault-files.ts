/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
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
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { platform } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { createClient } from "@libsql/client";

import { closeVaultDb, getLytDbPath, isCorruptDatabaseError } from "../registry/vault-db.js";
import { validateFrontmatterBlock } from "../templates/contract.js";
import { isIndexable, type IndexExclusion } from "../util/indexable.js";
import {
  loadLytIgnorePolicy,
  type LytIgnorePolicy,
} from "../util/lytignore.js";
import { resolveSingleVault } from "../util/vault-resolve.js";

export type VaultFileClassification =
  | "figment"
  | "ignored"
  | "system-floor"
  | "scaffold"
  | "oversize"
  | "binary"
  | "unreadable";

export interface VaultFileInventoryEntry {
  path: string;
  classification: VaultFileClassification;
  reason: string;
  kind: "markdown" | "directory" | "reparse-point" | "cache-only";
  sizeBytes: number | null;
  mtimeMs: number | null;
  contentSha256: string | null;
  indexed: boolean;
  denseIndexed: boolean;
  pendingRemoval: boolean;
  frontmatterMutationCandidate: boolean;
  missingFields: string[];
}

export interface VaultFilesInventory {
  schema: "lyt.vault-files";
  version: 1;
  vault: { rid: string; name: string; path: string };
  scope: string;
  ignorePolicy: {
    exists: boolean;
    sha256: string;
    byteLength: number;
    patternCount: number;
  };
  totals: {
    markdownFiles: number;
    indexableFigments: number;
    indexedFigments: number;
    frontmatterMutationCandidates: number;
    excluded: number;
    pendingRemovals: number;
  };
  inventoryDigest: string;
  entries: VaultFileInventoryEntry[];
}

interface CacheState {
  fts: Set<string>;
  dense: Set<string>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value).replace(/[\\/]+$/, "");
    return platform() === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function hasMarkdownExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

export function normalizeVaultSubtree(input: string | undefined): string {
  if (input === undefined || input.trim() === "" || input.trim() === ".") return ".";
  const raw = input.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    raw.length === 0 ||
    isAbsolute(input) ||
    /^[A-Za-z]:/.test(raw) ||
    raw.startsWith("/") ||
    raw.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    throw new Error(`--path must be one vault-relative subtree without '..': ${input}`);
  }
  return raw;
}

function assertContainedNoReparse(vaultRoot: string, target: string): void {
  const rootAbs = resolve(vaultRoot);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("inventory scope escapes the registered vault root");
  }
  const rootStat = lstatSync(rootAbs);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("registered vault root is not a real directory");
  }
  const rootReal = realpathSync(rootAbs);
  if (!sameFilesystemPath(rootReal, rootAbs)) {
    throw new Error("registered vault root resolves through a reparse point");
  }
  let current = rootAbs;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`inventory scope contains a reparse point: ${toPosix(relative(rootAbs, current))}`);
    }
  }
}

async function readCacheState(vaultPath: string): Promise<CacheState> {
  const dbPath = getLytDbPath(vaultPath);
  if (!existsSync(dbPath)) return { fts: new Set(), dense: new Set() };
  const db = createClient({ url: `file:${dbPath}` });
  try {
    const load = async (table: "figment_fts" | "embeddings"): Promise<Set<string>> => {
      try {
        const result = await db.execute(`SELECT figment_rid FROM ${table}`);
        return new Set(result.rows.map((row) => String(row["figment_rid"])));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no such table/i.test(message) || isCorruptDatabaseError(error)) {
          throw new Error(`vault inventory cannot read ${table}; run 'lyt doctor' then 'lyt repair --dry-run'`, {
            cause: error,
          });
        }
        throw error;
      }
    };
    return { fts: await load("figment_fts"), dense: await load("embeddings") };
  } finally {
    await closeVaultDb(db);
  }
}

function exclusionToClassification(category: IndexExclusion): VaultFileClassification {
  if (category === "not-markdown") return "unreadable";
  return category;
}

function classifyMarkdown(
  vaultRoot: string,
  relPath: string,
  policy: LytIgnorePolicy,
  indexed: boolean,
  denseIndexed: boolean,
): VaultFileInventoryEntry {
  const abs = join(vaultRoot, ...relPath.split("/"));
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch {
    return {
      path: relPath,
      classification: "unreadable",
      reason: "unreadable",
      kind: "markdown",
      sizeBytes: null,
      mtimeMs: null,
      contentSha256: null,
      indexed,
      denseIndexed,
      pendingRemoval: indexed || denseIndexed,
      frontmatterMutationCandidate: false,
      missingFields: [],
    };
  }
  const verdict = isIndexable(relPath, policy.matcher, vaultRoot);
  if (!verdict.include) {
    return {
      path: relPath,
      classification: exclusionToClassification(verdict.category),
      reason: verdict.reason,
      kind: "markdown",
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      contentSha256: null,
      indexed,
      denseIndexed,
      pendingRemoval: indexed || denseIndexed,
      frontmatterMutationCandidate: false,
      missingFields: [],
    };
  }
  try {
    const bytes = readFileSync(abs);
    const raw = bytes.toString("utf8");
    const missingFields = validateFrontmatterBlock(raw).map((issue) => issue.field);
    return {
      path: relPath,
      classification: "figment",
      reason: "indexable markdown figment",
      kind: "markdown",
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      contentSha256: sha256(bytes),
      indexed,
      denseIndexed,
      pendingRemoval: false,
      frontmatterMutationCandidate: missingFields.length > 0,
      missingFields,
    };
  } catch {
    return {
      path: relPath,
      classification: "unreadable",
      reason: `unreadable: ${relPath}`,
      kind: "markdown",
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      contentSha256: null,
      indexed,
      denseIndexed,
      pendingRemoval: indexed || denseIndexed,
      frontmatterMutationCandidate: false,
      missingFields: [],
    };
  }
}

function inventoryDigest(entries: readonly VaultFileInventoryEntry[]): string {
  return sha256(
    JSON.stringify(
      entries.map((entry) => ({
        path: entry.path,
        classification: entry.classification,
        sizeBytes: entry.sizeBytes,
        mtimeMs: entry.mtimeMs,
        contentSha256: entry.contentSha256,
        indexed: entry.indexed,
        denseIndexed: entry.denseIndexed,
        missingFields: entry.missingFields,
      })),
    ),
  );
}

export async function inventoryVaultFiles(
  vaultName: string,
  subtree?: string,
): Promise<VaultFilesInventory> {
  const vault = await resolveSingleVault(vaultName);
  const scope = normalizeVaultSubtree(subtree);
  const start = scope === "." ? vault.path : join(vault.path, ...scope.split("/"));
  if (!existsSync(start)) throw new Error(`inventory scope does not exist: ${scope}`);
  assertContainedNoReparse(vault.path, start);
  const policy = loadLytIgnorePolicy(vault.path);
  const cache = await readCacheState(vault.path);
  const entries: VaultFileInventoryEntry[] = [];

  const visit = (abs: string): void => {
    const relPath = toPosix(relative(vault.path, abs));
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch {
      if (relPath !== ".") {
        entries.push({
          path: relPath,
          classification: "unreadable",
          reason: "unreadable",
          kind: "reparse-point",
          sizeBytes: null,
          mtimeMs: null,
          contentSha256: null,
          indexed: cache.fts.has(relPath),
          denseIndexed: cache.dense.has(relPath),
          pendingRemoval: cache.fts.has(relPath) || cache.dense.has(relPath),
          frontmatterMutationCandidate: false,
          missingFields: [],
        });
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({
        path: relPath,
        classification: "unreadable",
        reason: "reparse-point",
        kind: "reparse-point",
        sizeBytes: null,
        mtimeMs: null,
        contentSha256: null,
        indexed: cache.fts.has(relPath),
        denseIndexed: cache.dense.has(relPath),
        pendingRemoval: cache.fts.has(relPath) || cache.dense.has(relPath),
        frontmatterMutationCandidate: false,
        missingFields: [],
      });
      return;
    }
    if (stat.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(abs).sort((left, right) => left.localeCompare(right, "en"));
      } catch {
        if (relPath !== "") {
          entries.push({
            path: relPath,
            classification: "unreadable",
            reason: "unreadable-directory",
            kind: "directory",
            sizeBytes: null,
            mtimeMs: stat.mtimeMs,
            contentSha256: null,
            indexed: false,
            denseIndexed: false,
            pendingRemoval: false,
            frontmatterMutationCandidate: false,
            missingFields: [],
          });
        }
        return;
      }
      for (const name of names) visit(join(abs, name));
      return;
    }
    if (!stat.isFile() || !hasMarkdownExtension(relPath)) return;
    entries.push(
      classifyMarkdown(
        vault.path,
        relPath,
        policy,
        cache.fts.has(relPath),
        cache.dense.has(relPath),
      ),
    );
  };

  visit(start);
  // Derived rows whose markdown source vanished are still reconciliation work.
  // A disk-only walk cannot see them, so project the cache-only residue into the
  // same inventory rather than silently declaring disk/index agreement.
  const knownPaths = new Set(entries.map((entry) => entry.path));
  const inScope = (path: string): boolean =>
    scope === "." || path === scope || path.startsWith(`${scope}/`);
  const cachedPaths = new Set([...cache.fts, ...cache.dense]);
  for (const path of cachedPaths) {
    if (!inScope(path) || knownPaths.has(path)) continue;
    entries.push({
      path,
      classification: "unreadable",
      reason: "indexed cache row has no markdown source",
      kind: "cache-only",
      sizeBytes: null,
      mtimeMs: null,
      contentSha256: null,
      indexed: cache.fts.has(path),
      denseIndexed: cache.dense.has(path),
      pendingRemoval: true,
      frontmatterMutationCandidate: false,
      missingFields: [],
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const markdownEntries = entries.filter((entry) => entry.kind === "markdown");
  const indexable = markdownEntries.filter((entry) => entry.classification === "figment");
  const candidates = indexable.filter((entry) => entry.frontmatterMutationCandidate);
  return {
    schema: "lyt.vault-files",
    version: 1,
    vault: { rid: vault.ridHex, name: vault.name, path: vault.path },
    scope,
    ignorePolicy: {
      exists: policy.exists,
      sha256: policy.sha256,
      byteLength: policy.bytes.length,
      patternCount: policy.patterns.length,
    },
    totals: {
      markdownFiles: markdownEntries.length,
      indexableFigments: indexable.length,
      indexedFigments: indexable.filter((entry) => entry.indexed).length,
      frontmatterMutationCandidates: candidates.length,
      excluded: markdownEntries.length - indexable.length,
      pendingRemovals: entries.filter((entry) => entry.pendingRemoval).length,
    },
    inventoryDigest: inventoryDigest(entries),
    entries,
  };
}
