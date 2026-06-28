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

// v1.D.2a — `lyt vault rebuild-arcs` flow.
//
// Walks `<vault>/notes/**/*.md`, harvests arc membership from TWO
// detection mechanisms (per master-plan §v1.D.2a + brief ):
//
// 1. Frontmatter `arcs: [name1, name2, ...]` — each figment declares
// which named arcs it belongs to. Frontmatter-derived members are
// auto-assigned positions in deterministic file-path lexical
// order (skipping reserved-manual slots).
// 2. Embedded YON blocks in markdown bodies — runs of `@ARC` /
// `@ARC_MEMBER` records harvested via
// `extractArcRecordsFromMarkdownBody` (yon/arcs-read.ts). Manual
// `@ARC` records may set the arc's `category`; manual
// `@ARC_MEMBER` records carry explicit `position:int=N` values
// that WIN over frontmatter-derived auto-assignment.
//
// Writes the deterministic YON SoT at `<vault>/.lyt/indexes/arcs.yon`
// via `writeArcsDoc`.
//
// Open-once seam from the start (v1.A.5 CR-B1 + v1.D.1 vindication):
// accept optional `registryDb?: Client`; only `openRegistry()` when
// omitted; caller owns lifecycle when supplied. Mirrors
// rebuild-lanes.ts. Applies to BOTH the manual `lyt vault
// rebuild-arcs` CLI verb AND the v1.D.2c arc-builder automator body.
//
// Position resolution (default — manual wins; frontmatter
// auto-assigned skipping reserved slots):
// - Manual @ARC_MEMBER records reserve their explicit position
// - Frontmatter-derived members get positions 1, 2, ... in
// deterministic file-path order, skipping reserved slots
// - A figment that has BOTH a frontmatter declaration AND a manual
// @ARC_MEMBER for the same arc → manual wins (frontmatter
// suppressed for that arc)
//
// Position collision (default — fatal error): two MANUAL records
// claiming the same `(arc, position)` pair throw
// `ArcPositionCollisionError`; the CLI surfaces this as a structured
// `--json` error and exits non-zero.
//
// Category conflict (default — warn-not-error): when multiple
// `@ARC` records declare different categories for the same arc, last-
// by-deterministic-file-path-order wins; a warning is collected and
// surfaced via `--json` output.
//
// last_touched (default): max(mtime) across all members + any
// figment that declared the @ARC. When the arc has no members and no
// declarations, falls back to flow-entry timestamp.

import { readFileSync, statSync } from "node:fs";
import { posix, relative, sep } from "node:path";

import type { Client } from "@libsql/client";

import { isIndexable, walkVaultMarkdownFiles } from "../util/indexable.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { extractArcRecordsFromMarkdownBody } from "../yon/arcs-read.js";
import {
  writeArcsDoc,
  type ArcMemberRecord,
  type ArcRecord,
  type ArcsDoc,
} from "../yon/arcs-write.js";
import { upsertArcsCache } from "./upsert-arcs-cache.js";

export class ArcPositionCollisionError extends Error {
  readonly arc: string;
  readonly position: number;
  readonly conflictingFigments: readonly string[];
  constructor(arc: string, position: number, conflictingFigments: readonly string[]) {
    super(
      `arc position collision at ${arc} position ${position}: ${conflictingFigments.join(" vs ")}`,
    );
    this.name = "ArcPositionCollisionError";
    this.arc = arc;
    this.position = position;
    this.conflictingFigments = conflictingFigments;
  }
}

export interface RebuildArcsArgs {
  // Registered vault name. Mutually exclusive with `vaultPathOverride`
  // (test seam). One or the other is required.
  vault?: string;
  // Test / automator seam — bypass the registry lookup and operate on
  // the given vault path directly. Used by `runArcBuilderBody` (v1.D.2c)
  // to avoid resolving the same vault through the registry twice.
  vaultPathOverride?: string;
  // Open-once seam (v1.A.5 CR-B1 pattern). When supplied, the flow uses
  // the caller's registry client and does NOT close it. When omitted,
  // the flow opens + closes its own registry client.
  registryDb?: Client;
  // Deterministic timestamp override for the `last_touched` fallback
  // (when an arc has no members and no declarations). When omitted,
  // defaults to `new Date().toISOString()` at flow entry. Tests pin
  // this for byte-stable round-trips.
  nowIso?: string;
}

export interface RebuildArcsResult {
  vaultName: string;
  vaultPath: string;
  arcsWritten: number;
  membersWritten: number;
  arcsYonPath: string;
  // Non-fatal warnings surfaced during the build (e.g. category
  // conflicts per the ratified default). The CLI's `--json` mode includes these so
  // handlers can audit the vault state without re-running.
  warnings: readonly string[];
  durationMs: number;
  // v1.D.2b: rebuild emits SoT + cache atomically. Mirrors the
  // rebuild-lanes Commit 2 extension — callers (manual verb +
  // arc-builder automator) can surface cache-side counts to handlers
  // without a second round-trip. Null when the cache upsert was
  // skipped (no SoT file written this run — e.g. no notes in the
  // vault).
  cacheArcsUpserted: number | null;
  cacheMembersUpserted: number | null;
}

export async function rebuildArcsFlow(args: RebuildArcsArgs): Promise<RebuildArcsResult> {
  const startedAt = Date.now();
  const fallbackNow = args.nowIso ?? new Date().toISOString();

  const { vaultName, vaultPath } = await resolveVault(args);
  // B-4: root the arcs walk at the VAULT ROOT (not notes/) via the shared
  // isIndexable predicate. NEWLY excludes scaffold index.md uniformly with FTS.
  const noteFiles = walkVaultMarkdownFiles(vaultPath, isIndexable);

  interface CategoryEntry {
    value: string;
    declaringPath: string;
    mtimeMs: number;
  }
  interface FrontmatterCandidate {
    figmentPath: string;
    mtimeMs: number;
  }
  interface ManualCandidate {
    figmentPath: string;
    position: number;
    mtimeMs: number;
  }
  interface ArcAccumulator {
    name: string;
    nameSetByManual: boolean;
    frontmatter: FrontmatterCandidate[];
    manual: ManualCandidate[];
    categories: CategoryEntry[];
    // Mtime of any file that declared the @ARC (even with no member);
    // contributes to last_touched fallback when there are no members.
    declarerMtimes: number[];
  }
  const arcAcc = new Map<string, ArcAccumulator>();

  function ensureAcc(slug: string, name: string, fromManual: boolean): ArcAccumulator {
    let acc = arcAcc.get(slug);
    if (acc === undefined) {
      acc = {
        name,
        nameSetByManual: fromManual,
        frontmatter: [],
        manual: [],
        categories: [],
        declarerMtimes: [],
      };
      arcAcc.set(slug, acc);
    } else if (fromManual && !acc.nameSetByManual) {
      // Manual @ARC declaration wins for the display name (frontmatter
      // arc names are used to seed the slug + fallback display name).
      acc.name = name;
      acc.nameSetByManual = true;
    }
    return acc;
  }

  for (const abs of noteFiles) {
    let content: string;
    let mtimeMs: number;
    try {
      content = readFileSync(abs, "utf8");
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    const relPath = toVaultRelPosix(abs, vaultPath);

    // 1. Frontmatter `arcs:` field
    const arcNames = parseFrontmatterArcs(content);
    for (const arcName of arcNames) {
      const slug = slugifyArcName(arcName);
      if (slug.length === 0) continue;
      const acc = ensureAcc(slug, arcName, false);
      acc.frontmatter.push({ figmentPath: relPath, mtimeMs });
    }

    // 2. Embedded @ARC + @ARC_MEMBER from body
    const { arcs: bodyArcs, members: bodyMembers } = extractArcRecordsFromMarkdownBody(content);
    for (const arc of bodyArcs) {
      const slug = arc.ridSlug;
      const acc = ensureAcc(slug, arc.name, true);
      acc.categories.push({
        value: arc.category,
        declaringPath: relPath,
        mtimeMs,
      });
      acc.declarerMtimes.push(mtimeMs);
    }
    for (const m of bodyMembers) {
      const slug = m.arcRidSlug;
      const acc = ensureAcc(slug, slug, false);
      acc.manual.push({
        figmentPath: m.figmentPath,
        position: m.position,
        mtimeMs,
      });
      acc.declarerMtimes.push(mtimeMs);
    }
  }

  const arcs: ArcRecord[] = [];
  const members: ArcMemberRecord[] = [];
  const warnings: string[] = [];

  const sortedSlugs = [...arcAcc.keys()].sort();
  for (const slug of sortedSlugs) {
    const acc = arcAcc.get(slug)!;

    // Category resolution per the ratified default: last-by-deterministic-file-path
    // wins + warn on conflict.
    let category = "uncategorized";
    if (acc.categories.length > 0) {
      const sorted = [...acc.categories].sort((a, b) =>
        a.declaringPath < b.declaringPath ? -1 : a.declaringPath > b.declaringPath ? 1 : 0,
      );
      const distinctValues = new Set(sorted.map((c) => c.value));
      if (distinctValues.size > 1) {
        warnings.push(
          `arc:${slug}: multiple categories declared (${[...distinctValues].join(", ")}); ` +
            `using last-by-path '${sorted[sorted.length - 1]!.value}'`,
        );
      }
      category = sorted[sorted.length - 1]!.value;
    }

    // Position resolution per the ratified default:
    // - Manual records reserve their explicit positions
    // - Manual collision (two distinct figments same position) → fatal
    // - Same figment reusing same position is idempotent (deduped)
    // - Frontmatter-derived figments auto-assign skipping reserved
    const reservedPositions = new Set<number>();
    const memberByPosition = new Map<number, { figmentPath: string }>();
    const figmentsWithManualPosition = new Set<string>();

    // Deterministic order for manual records (so collision diagnostics
    // are reproducible).
    const sortedManual = [...acc.manual].sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return a.figmentPath < b.figmentPath ? -1 : a.figmentPath > b.figmentPath ? 1 : 0;
    });
    for (const m of sortedManual) {
      const existing = memberByPosition.get(m.position);
      if (existing !== undefined) {
        if (existing.figmentPath === m.figmentPath) {
          continue; // idempotent — same record declared twice
        }
        throw new ArcPositionCollisionError(`arc:${slug}`, m.position, [
          existing.figmentPath,
          m.figmentPath,
        ]);
      }
      reservedPositions.add(m.position);
      memberByPosition.set(m.position, { figmentPath: m.figmentPath });
      figmentsWithManualPosition.add(m.figmentPath);
    }

    // Frontmatter-derived members: dedupe by figment_path; suppress
    // figments already pinned by a manual @ARC_MEMBER record; sort
    // by file path for deterministic auto-assignment.
    const frontmatterPaths = [...new Set(acc.frontmatter.map((f) => f.figmentPath))]
      .filter((p) => !figmentsWithManualPosition.has(p))
      .sort();
    let nextPos = 1;
    for (const figmentPath of frontmatterPaths) {
      while (reservedPositions.has(nextPos)) nextPos++;
      memberByPosition.set(nextPos, { figmentPath });
      reservedPositions.add(nextPos);
      nextPos++;
    }

    // last_touched per the ratified default: max(mtime) across members + declarers.
    const allMtimes: number[] = [
      ...acc.frontmatter.map((f) => f.mtimeMs),
      ...acc.manual.map((m) => m.mtimeMs),
      ...acc.declarerMtimes,
    ];
    let lastTouched: string;
    if (allMtimes.length > 0) {
      const maxMs = Math.max(...allMtimes);
      lastTouched = new Date(maxMs).toISOString();
    } else {
      lastTouched = fallbackNow;
    }

    arcs.push({
      ridSlug: slug,
      name: acc.name,
      category,
      lastTouched,
    });
    const sortedPositions = [...memberByPosition.entries()].sort((a, b) => a[0] - b[0]);
    for (const [pos, m] of sortedPositions) {
      members.push({
        arcRidSlug: slug,
        figmentPath: m.figmentPath,
        position: pos,
      });
    }
  }

  const doc: ArcsDoc = { vaultName, arcs, members };
  const arcsYonPath = writeArcsDoc(vaultPath, doc);

  // v1.D.2b: emit SoT + libSQL cache atomically. The cache upsert is
  // fatal-on-failure inside the manual rebuild verb path because the
  // handler explicitly asked for a rebuild; partial state (SoT updated,
  // cache stale) would surface as silent search drift on the next
  // `lyt search` query. The lyt-mesh sync post-pull caller wraps THIS
  // flow in its own best-effort try/catch when it calls upsertArcsCache
  // directly without writing SoT. Mirrors v1.D.1 Commit 2 atomic
  // emission pattern.
  const cacheRes = await upsertArcsCache(vaultPath);

  return {
    vaultName,
    vaultPath,
    arcsWritten: arcs.length,
    membersWritten: members.length,
    arcsYonPath,
    warnings,
    durationMs: Date.now() - startedAt,
    cacheArcsUpserted: cacheRes.arcsUpserted,
    cacheMembersUpserted: cacheRes.membersUpserted,
  };
}

// ---------------------------------------------------------------------------
// Vault resolution — open-once seam
// ---------------------------------------------------------------------------

interface ResolvedVault {
  vaultName: string;
  vaultPath: string;
}

async function resolveVault(args: RebuildArcsArgs): Promise<ResolvedVault> {
  if (args.vaultPathOverride !== undefined) {
    return {
      vaultName: args.vault ?? deriveVaultNameFromPath(args.vaultPathOverride),
      vaultPath: args.vaultPathOverride,
    };
  }
  if (args.vault === undefined) {
    throw new Error("rebuild-arcs: either --vault <name> or vaultPathOverride is required.");
  }
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  let vault: VaultRow | null;
  try {
    vault = await getVaultByName(db, args.vault);
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
  if (!vault) {
    throw new Error(`rebuild-arcs: no vault registered with name '${args.vault}'.`);
  }
  if (vault.status === "tombstoned") {
    throw new Error(`rebuild-arcs: vault '${args.vault}' is tombstoned; cannot rebuild arcs.`);
  }
  return { vaultName: vault.name, vaultPath: vault.path };
}

function deriveVaultNameFromPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts[parts.length - 1] ?? "vault";
}

// ---------------------------------------------------------------------------
// B-4: the arcs walk now uses the shared `walkVaultMarkdownFiles` (vault-root +
// isIndexable). The pre-B-4 notes/-rooted private copy is DELETED.
// ---------------------------------------------------------------------------

function toVaultRelPosix(absPath: string, vaultPath: string): string {
  return relative(vaultPath, absPath).split(sep).join(posix.sep);
}

// ---------------------------------------------------------------------------
// Minimal frontmatter `arcs:` extractor
// ---------------------------------------------------------------------------
//
// Mirrors `parseFrontmatterTags` from rebuild-lanes.ts (locally
// duplicated rather than refactored — keeps the patch contained;
// generalisation can land in a v1.5+ sweep if a third
// `parseFrontmatter<List>` consumer emerges). Handles both inline
// (`arcs: [a, b]`) and block (`arcs:\n - a\n - b`) YAML shapes.

const FRONTMATTER_DELIM = "---";

export function parseFrontmatterArcs(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      firstNonEmpty = i;
      break;
    }
  }
  if (firstNonEmpty === -1 || lines[firstNonEmpty] !== FRONTMATTER_DELIM) {
    return [];
  }
  let closeIdx = -1;
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIM) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return [];

  for (let i = firstNonEmpty + 1; i < closeIdx; i++) {
    const trimmed = lines[i]!.replace(/^\s+/, "");
    const arcsMatch = trimmed.match(/^arcs\s*:\s*(.*)$/);
    if (!arcsMatch) continue;
    const rest = arcsMatch[1]!.trim();
    if (rest.startsWith("[")) {
      return parseInlineArcList(rest);
    }
    if (rest.length === 0) {
      return parseBlockArcList(lines, i + 1, closeIdx);
    }
    return [stripQuotes(rest)].filter((s) => s.length > 0);
  }
  return [];
}

function parseInlineArcList(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed.startsWith("[")) return [];
  const closeIdx = trimmed.lastIndexOf("]");
  if (closeIdx < 0) return [];
  const inner = trimmed.slice(1, closeIdx).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

function parseBlockArcList(lines: readonly string[], startIdx: number, closeIdx: number): string[] {
  const out: string[] = [];
  for (let i = startIdx; i < closeIdx; i++) {
    const line = lines[i]!;
    const m = line.match(/^\s*-\s*(.*)$/);
    if (!m) break;
    const raw = stripQuotes(m[1]!.trim());
    if (raw.length === 0) continue;
    out.push(raw);
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------
//
// Lowercase + replace any sequence of non-alphanumeric chars with `-` +
// trim leading/trailing `-`. Same algorithm as `slugifyTag` in
// rebuild-lanes.ts (locally duplicated — see parseFrontmatterArcs
// comment). Slug + `arc:` prefix = arc rid.

export function slugifyArcName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
