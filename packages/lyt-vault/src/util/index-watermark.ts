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

// V-C-1 (Lane V Track C) — per-vault index watermark.
//
// A single epoch-ms timestamp recording when the vault's content caches
// (FTS + lanes + arcs) were last (re)built by a Lyt-mediated path
// (capture index-on-write, reindex, sync-pull reindex, adopt/subscribe).
//
// Purpose: the L3 empty-result self-heal (search-cascade) compares the
// newest figment-file mtime in `notes/` against this watermark. A figment
// FILE newer than the watermark means an UN-indexed write happened OUTSIDE
// a Lyt path (an Obsidian edit, a `git pull`, a manual file drop) — the
// exact case L1/L2 can't catch — so search self-heals before reporting
// "no matches". (A capture-counter would be blind to non-Lyt writes; the
// filesystem mtime is the robust signal — see the brief §0.5 #1 + Phase C.)
//
// Storage (Lock 0.2 — regenerable machine-local state): a tiny sidecar at
// `<vault>/.lyt/indexes/.index-watermark`. It sits under `.lyt/indexes/`,
// which the vault scaffold gitignores alongside the libSQL `.db` caches
// (templates/index.ts getVaultGitignore) — so it is never committed/synced
// and is fully rebuildable. Deliberately NOT a libSQL row: no schema
// migration, no DB open just to read a single number on the search hot path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The watermark file path for a vault. Lives beside the gitignored libSQL
// caches under `.lyt/indexes/` so it inherits their machine-local posture.
export function getIndexWatermarkPath(vaultPath: string): string {
  return join(vaultPath, ".lyt", "indexes", ".index-watermark");
}

// Stamp the watermark to `ms` (default: now). Best-effort, never throws —
// a watermark write failure must NOT fail the index or the capture that
// triggered it (the markdown SoT is already on disk; a stale watermark only
// means L3 may self-heal a touch more often, never less safely). Writes the
// indexes dir if absent (a vault may not have opened its caches yet).
export function writeIndexWatermark(vaultPath: string, ms?: number): void {
  const stamp = ms ?? Date.now();
  const target = getIndexWatermarkPath(vaultPath);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(stamp), "utf8");
  } catch {
    // best-effort — see contract above.
  }
}

// Read the watermark as epoch-ms, or null when absent/unreadable/garbled.
// A null watermark means "never indexed via a Lyt path" — the L3 caller
// treats that as maximally stale (any figment file present → heal).
export function readIndexWatermark(vaultPath: string): number | null {
  const target = getIndexWatermarkPath(vaultPath);
  if (!existsSync(target)) return null;
  try {
    const raw = readFileSync(target, "utf8").trim();
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
