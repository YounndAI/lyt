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

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getLytHome } from "./paths.js";
import {
  hashPatternDir,
  parsePatternManifest,
  PATTERN_MANIFEST_FILENAME,
} from "./pattern-manifest.js";

// User-side patterns master location.
export function getUserPatternsDir(): string {
  return join(getLytHome(), "patterns");
}

// Where bundled patterns live in the source tree (dev) and in the published tarball
// (after build → dist/patterns/). The loader auto-detects both layouts.
export function getBundledPatternsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dev: src/util/pattern-paths.ts → src/patterns/
  // built: dist/util/pattern-paths.js → dist/patterns/
  return resolve(here, "..", "patterns");
}

export function listPatternNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) return false;
      return existsSync(join(full, "pattern.yon"));
    })
    .sort();
}

// POD-level patterns bootstrap. Mirrors the mechanism of
// scaffold/init.ts copyBundledAutomators (find source dir → copy each →
// additive / skip-existing), but at pod scope: copies the bundled patterns
// (getBundledPatternsDir → dist/patterns built, src/patterns dev) into the
// user's pod patterns master (getUserPatternsDir → ~/lyt/patterns).
//
// Fixes the HANDOFF-006 bug where ~/lyt/patterns/ was EMPTY after init
// because nothing copied the bundled defaults. Properties:
// - ADDITIVE: never overwrites a handler-customised pattern (skip when the
// destination pattern dir already exists).
// - BACKFILL: if ~/lyt/patterns/ exists but is empty (or partially
// populated), the missing defaults are populated.
// - IDEMPOTENT: a second call is a no-op (every dest already present).
//
// Returns the list of pattern names actually copied (empty when all were
// already present, or when the bundled dir is absent in a stale dev build).
export function copyBundledPatterns(): string[] {
  const sourceDir = getBundledPatternsDir();
  // Skip cleanly if the bundled dir isn't on disk (e.g. a dev build with a
  // stale dist) — mirrors copyBundledAutomators' missing-source tolerance.
  if (!existsSync(sourceDir)) return [];
  const targetRoot = getUserPatternsDir();
  mkdirSync(targetRoot, { recursive: true });
  const copied: string[] = [];
  for (const name of listPatternNames(sourceDir)) {
    const target = join(targetRoot, name);
    if (existsSync(target)) continue; // additive: respect handler overrides
    cpSync(join(sourceDir, name), target, { recursive: true });
    copied.push(name);
  }
  return copied;
}

// (2026-06-03) — version-gated, additive-safe pattern heal.
//
// Extends copyBundledPatterns' additive-only model with version awareness via
// the bundled manifest (manifest.yon). Per-pattern decision:
// - installed dir MISSING → ADD (copy bundled). Restores a
// deleted-default + first-run populate.
// - installed hash === bundled hash → CURRENT (no-op).
// - installed hash ∈ prior_hashes → pristine-but-older shipped version:
// BACKUP (→ ~/lyt/patterns/.bak/<ts>/)
// then REPLACE with the bundled version.
// - installed hash unknown → DIVERGENT (handler fork): LEAVE
// untouched + a non-blocking note.
//
// NEVER overwrites a fork. The backup-then-replace path copies the old dir to
// `.bak` BEFORE removing it, so a misclassification still loses nothing
// (honors the global destructive-delete directive). User pattern dirs are
// plain copies (no cross-repo junctions), so the rmSync is local + safe.

export interface PatternHealEntry {
  id: string;
  action: "added" | "current" | "replaced" | "left-divergent";
  note?: string;
  backupPath?: string;
}

export interface PatternHealResult {
  entries: PatternHealEntry[];
  backupRoot: string | null;
}

export interface HealPatternsOptions {
  // Test seam — override the bundled patterns source (+ its manifest.yon) so a
  // fixture can exercise the prior-hash "replaced" arm deterministically.
  bundledDirOverride?: string | undefined;
  // Test seam — override the `.bak/<ts>` backup-dir timestamp.
  stampFn?: (() => string) | undefined;
}

// Compact UTC stamp (`YYYYMMDDTHHMMSSZ`) for the `.bak/<ts>` backup dir.
// Colon-free (Windows-safe), sortable. Mirrors the collision stamp in
// @younndai/lyt-skills symlink.ts (kept local — trivial pure fn, not worth a
// cross-package import).
function defaultPatternBackupStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function healPatterns(opts: HealPatternsOptions = {}): PatternHealResult {
  const sourceDir = opts.bundledDirOverride ?? getBundledPatternsDir();
  const entries: PatternHealEntry[] = [];
  if (!existsSync(sourceDir)) return { entries, backupRoot: null };

  const manifestPath = join(sourceDir, PATTERN_MANIFEST_FILENAME);
  const manifest = existsSync(manifestPath)
    ? parsePatternManifest(readFileSync(manifestPath, "utf8"))
    : [];
  const byId = new Map(manifest.map((e) => [e.id, e] as const));

  const targetRoot = getUserPatternsDir();
  mkdirSync(targetRoot, { recursive: true });
  let backupRoot: string | null = null;

  for (const name of listPatternNames(sourceDir)) {
    const bundled = join(sourceDir, name);
    const installed = join(targetRoot, name);

    // 0.9.4 — a HOLLOW installed dir (exists but missing pattern.yon)
    // is BROKEN, not a handler customization. Treat it exactly like a missing
    // dir and (re)seed it. Without this, the version-gated arms below hashed a
    // hollow dir, never matched, and left it "divergent" — so `lyt capture`/
    // `recall` stayed dead pod-wide on an init-heal over a hollow pod (the
    // init-heal twin of the postinstall hollow-dir fix in postinstall.mjs).
    const installedHollow =
      existsSync(installed) && !existsSync(join(installed, "pattern.yon"));

    if (!existsSync(installed) || installedHollow) {
      cpSync(bundled, installed, { recursive: true });
      entries.push({ id: name, action: "added" });
      continue;
    }

    const m = byId.get(name);
    if (m === undefined) {
      // No manifest entry (manifest absent / stale) — conservative: never
      // touch an existing dir we can't reason about.
      entries.push({
        id: name,
        action: "left-divergent",
        note: "no manifest entry; left untouched",
      });
      continue;
    }

    const installedHash = hashPatternDir(installed);
    if (installedHash === m.hash) {
      entries.push({ id: name, action: "current" });
      continue;
    }

    if (m.priorHashes.includes(installedHash)) {
      // Pristine but an older shipped version → bundled is newer. Back up the
      // old dir, then replace with the bundled version.
      if (backupRoot === null) {
        const stamp = (opts.stampFn ?? defaultPatternBackupStamp)();
        backupRoot = join(targetRoot, ".bak", stamp);
      }
      const backupDir = join(backupRoot, name);
      mkdirSync(backupDir, { recursive: true });
      cpSync(installed, backupDir, { recursive: true });
      rmSync(installed, { recursive: true, force: true });
      cpSync(bundled, installed, { recursive: true });
      entries.push({
        id: name,
        action: "replaced",
        backupPath: backupDir,
        note: `replaced pristine v with bundled v${m.version}; old backed up to ${backupDir}`,
      });
      continue;
    }

    // Divergent (hash unknown) → handler/user fork. LEAVE + surface a note.
    entries.push({
      id: name,
      action: "left-divergent",
      note: `yours preserved; lyt v${m.version} available`,
    });
  }

  return { entries, backupRoot };
}
