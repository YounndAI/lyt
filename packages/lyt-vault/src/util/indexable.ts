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

// B-4 (figment-roots) — the SINGLE inclusion predicate + the SINGLE filesystem
// markdown walker for every READ/index tier in lyt-vault.
//
// WHY: pre-B-4, every index tier (FTS, arcs, lanes, doctor, self-heal watermark,
// the index-on-write reconcile gate) hard-rooted its scan at `<vault>/notes/**`,
// so a vault whose markdown lives in semantic folders (`identity/`, `funding/`,
// …) was completely unsearchable. `notes/` was a write-router conflated with a
// read-filter. B-4 decouples the two: `notes/` stays a capture write-default
// only; the indexer scans ALL markdown under the vault root EXCEPT a system
// floor, via this one predicate.
//
// `isIndexable` is the documented SUPERSET of the Phase-0 walker-semantics audit
// (2026-06-24-result-b4-phase0-seam-audit.md §2). The audit found the pre-B-4
// READ walkers diverged on three reconcilable axes:
//   1. sort        — FTS/doctor sorted; arcs/lanes/mtime-scans did not.
//   2. scaffold    — FTS/doctor/reconcile applied isScaffoldNote; arcs/lanes did not.
//   3. case        — pod-status used case-SENSITIVE `.endsWith(".md")`; all others
//                    case-insensitive.
// The superset resolves all three: `walkVaultMarkdownFiles` sorts uniformly;
// `isIndexable` applies isScaffoldNote uniformly (arcs/lanes NEWLY exclude the
// scaffold `index.md` — an intended behavior change matching FTS); the extension
// gate is case-insensitive uniformly.
//
// WRITER carve-out: this governs READ/index scope ONLY. The metadata-filler
// AUTOMATOR (packages/lyt) is a frontmatter WRITER and stays `notes/`-scoped —
// it is NOT routed through this predicate. Re-rooting a writer to whole-vault
// scope would widen its mutation blast radius.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { isScaffoldNote } from "../flows/upsert-fts-cache.js";

// ---------------------------------------------------------------------------
// The immutable system floor (g2). Directory names whose subtree is NEVER
// indexed — a CODE CONSTANT, non-overridable in this lane (no `.lytignore`
// surface present; that is a deferred fast-follow). Matched
// case-insensitively + separator-normalized, so `.LYT`, `.Lyt`, `.GIT` are all
// excluded on a case-insensitive filesystem (self-corruption guard — the FTS
// DB lives under `.lyt/`, and re-indexing it would loop).
// ---------------------------------------------------------------------------
export const INDEX_FLOOR: readonly string[] = [".lyt", ".obsidian", ".git"];

// g3 — size cap. Files larger than this are skipped (with a reason). Pinned at
// exactly 2,000,000 bytes per the plan (not "~1-2MB").
export const MAX_INDEXABLE_BYTES = 2_000_000;

// g4 — binary-sniff read window. A NUL byte anywhere in the first 8 KB marks the
// file binary → skipped (with a reason). Pinned at 8192 bytes per the plan.
export const BINARY_SNIFF_BYTES = 8192;

// Indexable extensions (g1). `.markdown` is a deliberate scope add over the
// pre-B-4 walkers (which matched `.md` only) — named explicitly in the plan.
const INDEXABLE_EXTENSIONS: readonly string[] = [".md", ".markdown"];

// Optional ignore-matcher hook (g5). INERT this lane — wired as a no-op so the
// future `.lytignore` fast-follow is a one-line activation. When supplied, a
// `true` return excludes the path (after the floor, which always wins).
export type IgnoreMatcher = (relPath: string) => boolean;

export type IndexVerdict = { include: true } | { include: false; reason: string };

// Normalize a vault-relative path to lowercase POSIX segments for case- and
// separator-insensitive matching (Windows `\`, mixed case).
function normSegments(relPath: string): string[] {
  return relPath
    .split(/[\\/]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

// g1 — extension gate. Case-insensitive `.md` / `.markdown`.
function hasIndexableExtension(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return INDEXABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// g2 — immutable floor. True when ANY path segment is a floor directory.
function isUnderFloor(segments: readonly string[]): boolean {
  const floor = new Set(INDEX_FLOOR.map((f) => f.toLowerCase()));
  // Every segment except the final (the filename) is a directory on the path.
  for (let i = 0; i < segments.length - 1; i++) {
    if (floor.has(segments[i]!)) return true;
  }
  return false;
}

// g4 — binary sniff: scan the first BINARY_SNIFF_BYTES for a NUL byte.
function looksBinary(absPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    // Unreadable → treat as non-binary here; the walker's own statSync/read
    // guards drop genuinely unreadable files. (A skip with no signal is worse
    // than letting the downstream read fail-soft.)
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// g6 — lyt-scaffold content gate (Phase A).
// Reads the leading frontmatter block of a markdown file and checks for the
// `lyt-scaffold: true` sentinel. When present, the file is a LYT-authored
// seed Figment and MUST NOT be FTS/primer/arc/lane/keyphrase-indexed.
//
// Only called when `vaultRoot` is supplied (the full funnel path) — it
// requires the file to exist on disk. Path-only callers cannot reach this
// gate; the isScaffoldNote basename gate handles README.md and index.md at
// path-level for those callers.
//
// Reads at most 4 KB of the file (enough to cover any realistic frontmatter
// block) to keep the hot path cheap.
// ---------------------------------------------------------------------------
const SCAFFOLD_SENTINEL_BYTES = 4096;
const SCAFFOLD_RE = /^lyt-scaffold\s*:\s*true\s*$/m;

function hasScaffoldSentinel(absPath: string): boolean {
  try {
    const buf = Buffer.alloc(SCAFFOLD_SENTINEL_BYTES);
    const fd = openSync(absPath, "r");
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, SCAFFOLD_SENTINEL_BYTES, 0);
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    const head = buf.subarray(0, bytesRead).toString("utf8");
    // Only look inside the frontmatter block ONLY when the file STARTS with
    // an (optional UTF-8 BOM) --- fence. The `^` is anchored to index 0 with
    // `﻿?` consuming a BOM if present. The `/m` flag is intentionally
    // NOT used — we want strict start-of-string anchoring, not start-of-any-line.
    // This prevents a body `---` horizontal-rule from being mistaken for a
    // frontmatter open fence (false-positive g6) and ensures a leading BOM
    // doesn't defeat the gate (false-negative g6).
    const match = head.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    if (match === null) return false;
    return SCAFFOLD_RE.test(match[1] ?? "");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// isIndexable — the funnel. Path-only gates (g1 extension, g2 floor, scaffold,
// g5 matcher) run on `relPath` alone. The CONTENT gates (g3 size, g4 binary,
// g6 lyt-scaffold sentinel) run ONLY when `vaultRoot` is supplied (the walker
// passes it); callers that hold only a vault-relative path (the reconcile gate,
// the capture/pattern-run index gates) call with 1 arg and get the path-only
// verdict.
//
//   isIndexable(relPath)                       → path-only verdict
//   isIndexable(relPath, ignoreMatcher)        → path-only + g5
//   isIndexable(relPath, ignoreMatcher, root)  → full funnel incl. g3/g4/g6
// ---------------------------------------------------------------------------
export function isIndexable(
  relPath: string,
  ignoreMatcher?: IgnoreMatcher,
  vaultRoot?: string,
): IndexVerdict {
  const segments = normSegments(relPath);

  // g1 — extension
  if (!hasIndexableExtension(relPath)) {
    return { include: false, reason: `not a markdown file: ${relPath}` };
  }
  // g2 — immutable floor (wins over g5)
  if (isUnderFloor(segments)) {
    return { include: false, reason: `under system floor: ${relPath}` };
  }
  // scaffold gate (named, load-bearing FTS-noise exclusion — preserved from the
  // pre-B-4 FTS/doctor/reconcile walkers, now applied UNIFORMLY to all READ tiers;
  // Phase A: extended to also exclude README.md by basename — see isScaffoldNote)
  if (isScaffoldNote(relPath)) {
    return { include: false, reason: `scaffold file (index.md / README.md): ${relPath}` };
  }
  // g5 — optional ignore matcher (INERT this lane)
  if (ignoreMatcher !== undefined && ignoreMatcher(relPath)) {
    return { include: false, reason: `ignored by matcher: ${relPath}` };
  }

  // Content gates only when we can resolve the absolute file.
  if (vaultRoot !== undefined) {
    const abs = join(vaultRoot, relPath);
    let sizeBytes: number;
    try {
      sizeBytes = statSync(abs).size;
    } catch {
      // Can't stat → let the walker's own guards decide; path gates passed.
      return { include: true };
    }
    // g3 — size cap
    if (sizeBytes > MAX_INDEXABLE_BYTES) {
      return {
        include: false,
        reason: `exceeds size cap (${sizeBytes} > ${MAX_INDEXABLE_BYTES} bytes): ${relPath}`,
      };
    }
    // g4 — binary sniff
    if (looksBinary(abs)) {
      return { include: false, reason: `binary content (NUL byte in first 8KB): ${relPath}` };
    }
    // g6 — lyt-scaffold sentinel (Phase A). A Figment with `lyt-scaffold: true`
    // in its frontmatter is a LYT-authored seed Figment and MUST NOT be indexed.
    // Content gate: only reachable when we have the file on disk (vaultRoot supplied).
    if (hasScaffoldSentinel(abs)) {
      return { include: false, reason: `lyt-scaffold sentinel (excluded from index): ${relPath}` };
    }
  }

  return { include: true };
}

// Convenience boolean wrapper for the call sites (reconcile gate, capture-index
// index gate) that just want yes/no. Pass `vaultRoot` at any seam that holds a
// real on-disk file so the CONTENT gates (g3 size, g4 binary) run too — this is
// what keeps incremental ⊆ full: a seam that omits vaultRoot indexes a file the
// full walker (which always passes vaultRoot) would DROP, and the row then
// vanishes on the next reindex. Omit vaultRoot ONLY at seams that run BEFORE the
// file exists on disk (pattern-run, where the path is gated before the write).
export function isIndexablePath(
  relPath: string,
  ignoreMatcher?: IgnoreMatcher,
  vaultRoot?: string,
): boolean {
  return isIndexable(relPath, ignoreMatcher, vaultRoot).include;
}

// ---------------------------------------------------------------------------
// walkVaultMarkdownFiles — THE single re-root point. Recursive walk over the
// VAULT ROOT (not `notes/`), returning absolute paths of every indexable
// markdown file, applying `predicate` per file. Deterministic sort applied
// UNIFORMLY at every directory level (resolves the Phase-0 sort divergence).
// `statSync` follows symlinks (matches the pre-B-4 read walkers; the
// symlink-floor decision is a deferred fast-follow).
//
// Walk continues past unreadable/permission-denied directories and stat
// failures (skip-and-continue — a single bad dir never aborts a reindex).
//
// `onSkip` (optional) is invoked with the reason for each EXCLUDED markdown
// file (size/binary/floor/scaffold/ignored) so a real (non-dry-run) reindex can
// surface skipped files instead of dropping them silently.
// ---------------------------------------------------------------------------
export interface WalkOptions {
  ignoreMatcher?: IgnoreMatcher;
  onSkip?: (relPath: string, reason: string) => void;
}

export function walkVaultMarkdownFiles(
  vaultRoot: string,
  predicate: (relPath: string, ignoreMatcher?: IgnoreMatcher, vaultRoot?: string) => IndexVerdict,
  options: WalkOptions = {},
): string[] {
  const out: string[] = [];

  const walk = (dirAbs: string, dirRelSegments: string[]): void => {
    let names: string[];
    try {
      // readdirSync mirrors the pre-B-4 walkers; skip-and-continue on failure
      // (permission-denied / unreadable dir never aborts the whole reindex).
      names = readdirSync(dirAbs);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      const childAbs = join(dirAbs, name);
      const childRelSegments = [...dirRelSegments, name];
      const childRel = childRelSegments.join("/");
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(childAbs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // Prune floor dirs early (avoids descending the whole .git/.lyt tree).
        if (INDEX_FLOOR.some((f) => f.toLowerCase() === name.toLowerCase())) continue;
        walk(childAbs, childRelSegments);
      } else if (stat.isFile()) {
        const verdict = predicate(childRel, options.ignoreMatcher, vaultRoot);
        if (verdict.include) {
          out.push(childAbs);
        } else if (
          // Only surface skips for files that LOOK like markdown (the
          // extension gate); a `.txt` is not a "skipped figment", it's
          // out-of-scope by design and would be noise.
          hasIndexableExtension(name) &&
          options.onSkip !== undefined
        ) {
          options.onSkip(childRel, verdict.reason);
        }
      }
    }
  };

  walk(vaultRoot, []);
  return out;
}
