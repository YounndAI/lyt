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

// v1.D.1a — `lyt vault rebuild-lanes` flow.
//
// Walks `<vault>/notes/**/*.md`, parses frontmatter `tags:`, clusters notes
// by tag frequency (each tag with ≥threshold member notes becomes a lane),
// and writes the deterministic YON SoT at `<vault>/.lyt/indexes/lanes.yon`
// via `writeLanesDoc`.
//
// Open-once seam from the start (v1.A.5 CR-B1 lesson): accept optional
// `registryDb?: Client`; only `openRegistry()` when omitted; caller owns
// lifecycle when supplied. Applies to BOTH the manual `lyt vault
// rebuild-lanes` CLI verb (no caller-supplied db → flow opens + closes)
// AND the v1.D.1c lane-builder automator body (caller-supplied db →
// flow reuses + does not close).
//
// Algorithm note (v1.D.1a): single-keyword-per-lane clustering. Each tag
// with ≥threshold member notes becomes one lane with
// source_keywords=[tag]. The plural `source_keywords` shape is
// forward-compatible with multi-keyword co-occurrence clustering, which
// is deferred to v1.D.2+ (see master-plan §15 hook #5 sub-thread D for
// the shared file-scan optimisation).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import {
  writeLanesDoc,
  type LaneMemberRecord,
  type LaneRecord,
  type LanesDoc,
} from "../yon/lanes-write.js";
import { upsertLanesCache } from "./upsert-lanes-cache.js";

export const DEFAULT_LANE_THRESHOLD = 2;

export interface RebuildLanesArgs {
  // Registered vault name. Mutually exclusive with `vaultPathOverride`
  // (test seam). One or the other is required.
  vault?: string;
  // Test / automator seam — bypass the registry lookup and operate on
  // the given vault path directly. Used by `runLaneBuilderBody` (v1.D.1c)
  // to avoid resolving the same vault through the registry twice
  // (lyt-runner already resolved it for the run-plan).
  vaultPathOverride?: string;
  // Minimum number of notes a tag must appear in to form a lane. Default
  // = 2 per brief OD-5.
  threshold?: number;
  // Open-once seam (v1.A.5 CR-B1 pattern). When supplied, the flow uses
  // the caller's registry client and does NOT close it. When omitted,
  // the flow opens + closes its own registry client.
  registryDb?: Client;
  // Deterministic timestamp override for the `last_built` field. When
  // omitted, defaults to `new Date().toISOString()` at flow entry.
  nowIso?: string;
}

export interface RebuildLanesResult {
  vaultName: string;
  vaultPath: string;
  lanesWritten: number;
  membersWritten: number;
  lanesYonPath: string;
  threshold: number;
  durationMs: number;
  // v1.D.1b: rebuild emits SoT + cache atomically. These mirror the
  // upsertLanesCache result so callers (manual verb + lane-builder
  // automator) can surface cache-side counts to handlers without a
  // second round-trip. Null when the cache upsert was skipped (e.g.
  // a future `--no-cache` flag).
  cacheLanesUpserted: number | null;
  cacheMembersUpserted: number | null;
}

export async function rebuildLanesFlow(args: RebuildLanesArgs): Promise<RebuildLanesResult> {
  const startedAt = Date.now();
  const threshold = args.threshold ?? DEFAULT_LANE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 1) {
    throw new Error(`rebuild-lanes: threshold must be a positive integer; got ${args.threshold}.`);
  }
  const lastBuilt = args.nowIso ?? new Date().toISOString();

  const { vaultName, vaultPath } = await resolveVault(args);
  const notesRoot = join(vaultPath, "notes");
  const noteFiles = walkMarkdownFiles(notesRoot);

  // tag → ordered list of vault-relative posix paths (sorted at emit time
  // for determinism)
  const tagIndex = new Map<string, string[]>();
  for (const abs of noteFiles) {
    const tags = parseFrontmatterTags(readFileSync(abs, "utf8"));
    if (tags.length === 0) continue;
    const relPath = toVaultRelPosix(abs, vaultPath);
    for (const tag of tags) {
      const list = tagIndex.get(tag);
      if (list === undefined) {
        tagIndex.set(tag, [relPath]);
      } else {
        list.push(relPath);
      }
    }
  }

  const lanes: LaneRecord[] = [];
  const members: LaneMemberRecord[] = [];
  for (const [tag, paths] of tagIndex) {
    if (paths.length < threshold) continue;
    const slug = slugifyTag(tag);
    if (slug.length === 0) continue;
    const uniqueSortedPaths = [...new Set(paths)].sort();
    lanes.push({
      ridSlug: slug,
      name: tag,
      sourceKeywords: [tag],
      memCount: uniqueSortedPaths.length,
      lastBuilt,
    });
    for (const p of uniqueSortedPaths) {
      members.push({
        laneRidSlug: slug,
        figmentPath: p,
      });
    }
  }

  const doc: LanesDoc = {
    vaultName,
    lanes,
    members,
  };
  const lanesYonPath = writeLanesDoc(vaultPath, doc);

  // v1.D.1b: emit SoT + libSQL cache atomically. The cache upsert is
  // fatal-on-failure inside the manual rebuild verb path because the
  // handler explicitly asked for a rebuild; partial state (SoT updated,
  // cache stale) would surface as silent search drift on the next
  // `lyt search` query. The lyt-mesh sync post-pull caller wraps THIS
  // flow in its own best-effort try/catch when it calls upsertLanesCache
  // directly without writing SoT.
  const cacheRes = await upsertLanesCache(vaultPath);

  return {
    vaultName,
    vaultPath,
    lanesWritten: lanes.length,
    membersWritten: members.length,
    lanesYonPath,
    threshold,
    durationMs: Date.now() - startedAt,
    cacheLanesUpserted: cacheRes.lanesUpserted,
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

async function resolveVault(args: RebuildLanesArgs): Promise<ResolvedVault> {
  if (args.vaultPathOverride !== undefined) {
    return {
      vaultName: args.vault ?? deriveVaultNameFromPath(args.vaultPathOverride),
      vaultPath: args.vaultPathOverride,
    };
  }
  if (args.vault === undefined) {
    throw new Error("rebuild-lanes: either --vault <name> or vaultPathOverride is required.");
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
    throw new Error(`rebuild-lanes: no vault registered with name '${args.vault}'.`);
  }
  if (vault.status === "tombstoned") {
    throw new Error(`rebuild-lanes: vault '${args.vault}' is tombstoned; cannot rebuild lanes.`);
  }
  return { vaultName: vault.name, vaultPath: vault.path };
}

function deriveVaultNameFromPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts[parts.length - 1] ?? "vault";
}

// ---------------------------------------------------------------------------
// Filesystem walking — mirror metadata-filler.walkMarkdownFiles
// ---------------------------------------------------------------------------

function walkMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(root, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(p);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkMarkdownFiles(p));
    } else if (stat.isFile() && p.toLowerCase().endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

function toVaultRelPosix(absPath: string, vaultPath: string): string {
  return relative(vaultPath, absPath).split(sep).join(posix.sep);
}

// ---------------------------------------------------------------------------
// Minimal frontmatter `tags:` extractor
// ---------------------------------------------------------------------------
//
// Handles both YAML shapes the v1 vault scaffolds emit:
// inline: tags: ["a", "b"]
// tags: [a, b]
// block: tags:
// - a
// - b
//
// Returns lowercased tag strings with surrounding quotes stripped.
// Returns [] when no tags field exists OR the frontmatter is malformed.
// Same line-based posture as metadata-filler.fillMissingMandatoryFields —
// no full YAML parse (deferred to a real YAML lib only if frontmatter
// complexity grows past v1.A.5's manual line-walk).

const FRONTMATTER_DELIM = "---";

export function parseFrontmatterTags(raw: string): string[] {
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
    const tagsMatch = trimmed.match(/^tags\s*:\s*(.*)$/);
    if (!tagsMatch) continue;
    const rest = tagsMatch[1]!.trim();
    if (rest.startsWith("[")) {
      // Inline array
      return parseInlineTagList(rest);
    }
    if (rest.length === 0) {
      // Block list — gather subsequent ` - foo` lines
      return parseBlockTagList(lines, i + 1, closeIdx);
    }
    // tags: "foo" (single value) — treat as single-element list
    return [stripQuotes(rest)].filter((s) => s.length > 0);
  }
  return [];
}

function parseInlineTagList(body: string): string[] {
  // Strip the surrounding `[ ... ]`
  const trimmed = body.trim();
  if (!trimmed.startsWith("[")) return [];
  // Find the matching `]` — for v1 we assume a single-line inline array.
  const closeIdx = trimmed.lastIndexOf("]");
  if (closeIdx < 0) return [];
  const inner = trimmed.slice(1, closeIdx).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

function parseBlockTagList(lines: readonly string[], startIdx: number, closeIdx: number): string[] {
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
// trim leading/trailing `-`. Deterministic + safe for use as a rid suffix
// in `lane:<slug>`. Tags like "Software Design" → "software-design",
// "obsidian/plugins" → "obsidian-plugins". Pure tags that slug to empty
// (e.g. "---") are filtered upstream by the caller.

export function slugifyTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
