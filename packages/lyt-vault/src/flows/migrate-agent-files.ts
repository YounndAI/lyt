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

// Phase D (SC6) — relocate an EXISTING vault's legacy-root agent-priming files
// (`agents.md`, `lyt-overview.md`) into `.lyt/`.
//
// ONE-WAY DOOR on the installed base: a vault scaffolded before Phase D carries
// these files at the vault ROOT. This migration moves them under `.lyt/` so the
// vault tree the handler browses matches a freshly-init'd vault (README + seed
// Figments only).
//
// PROPERTIES:
//   • IDEMPOTENT — second run is a no-op (no legacy-root copy left to move).
//   • NO ORPHAN — when a `.lyt/` copy already exists (a partially-migrated or
//     adopt-conformed vault), the legacy-root copy is DELETED, not left behind.
//     The `.lyt/` copy is treated as authoritative in that collision (it is the
//     post-Phase-D write target; the legacy copy is the stale one).
//   • SNAPSHOT-FIRST is owned by the CALLER (repair flow) — this module performs
//     only the on-disk relocation; the caller takes a `vault snapshot` before
//     invoking it so the move is recoverable.
//
// The detect side (findLegacyAgentFiles) lives in util/agent-file-paths.ts (the
// resolver), so detection + relocation share one notion of "where these files
// live".

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { findLegacyAgentFiles } from "../util/agent-file-paths.js";

export interface MigratedAgentFile {
  filename: string;
  from: string;
  to: string;
  // "moved" — the legacy copy was relocated into `.lyt/`.
  // "removed-duplicate" — a `.lyt/` copy already existed, so the legacy copy was
  //   deleted (the `.lyt/` copy is authoritative; no orphan left behind).
  action: "moved" | "removed-duplicate";
}

export interface MigrateAgentFilesResult {
  migrated: MigratedAgentFile[];
  // True when there was nothing to do (already migrated / never had legacy files).
  noop: boolean;
}

/**
 * Relocate a vault's legacy-root `agents.md` / `lyt-overview.md` into `.lyt/`.
 *
 * Idempotent + leaves no orphaned tree copy. Caller is responsible for taking a
 * snapshot first (the repair flow does). Returns the per-file outcomes; `noop`
 * is true when no legacy file was present.
 */
export function migrateAgentFiles(vaultPath: string): MigrateAgentFilesResult {
  const legacy = findLegacyAgentFiles(vaultPath);
  if (legacy.length === 0) {
    return { migrated: [], noop: true };
  }

  const migrated: MigratedAgentFile[] = [];
  for (const f of legacy) {
    if (existsSync(f.newPath)) {
      // A `.lyt/` copy already exists — the new location is authoritative. Remove
      // the stale legacy-root copy so there is no duplicate / orphan.
      rmSync(f.legacyPath, { force: true });
      migrated.push({ filename: f.filename, from: f.legacyPath, to: f.newPath, action: "removed-duplicate" });
      continue;
    }
    // Move the legacy-root copy under `.lyt/`. renameSync is atomic within a
    // filesystem (vault root → `<vault>/.lyt/` is always same-volume).
    mkdirSync(dirname(f.newPath), { recursive: true });
    renameSync(f.legacyPath, f.newPath);
    migrated.push({ filename: f.filename, from: f.legacyPath, to: f.newPath, action: "moved" });
  }

  return { migrated, noop: false };
}
