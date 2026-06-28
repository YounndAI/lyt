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

// Phase D (SC6 — audience-split location). The SINGLE source of truth for where
// a vault's agent-priming files (`agents.md`, `lyt-overview.md`) live on disk.
//
// WHY ONE RESOLVER: pre-Phase-D, every reader + writer hardcoded
// `join(vaultPath, "agents.md")` / `join(vaultPath, "lyt-overview.md")` at the
// vault ROOT. Phase D relocates these AGENT-AUDIENCE files under `.lyt/` (so the
// vault tree the handler browses in Obsidian carries only README + Figments; the
// agent-priming surface lives in the system dir). Scattering `.lyt/` knowledge
// across ~10 call sites would guarantee drift; instead every site routes through
// this module.
//
// SEMANTICS:
//   • WRITE target — always `.lyt/<file>` (new vaults are born under `.lyt/`).
//   • READ resolution — `.lyt/<file>` if it exists, else the LEGACY root
//     `<vault>/<file>` (back-compat for vaults installed before Phase D, until
//     the doctor/repair migration relocates them).
//
// NOTE — this governs ON-DISK VAULT PATHS only. The shipped TEMPLATE basenames
// consumed by templates/render.ts (`renderTemplate("agents.md", …)`) are a
// template-dir lookup, NOT a vault path — they are deliberately NOT routed here.
//
// FTS INVARIANT (SC2 / g6): `.lyt/` is in indexable.ts INDEX_FLOOR, so a file
// under `.lyt/` is FTS/primer-excluded by the immutable floor gate (g2) — even
// MORE strongly than the legacy-root `lyt-scaffold:` sentinel gate. Relocating
// these files therefore strengthens, never weakens, the scaffold-exclusion
// contract.

import { existsSync } from "node:fs";
import { join } from "node:path";

// Bare filenames. Exported so call sites that need the basename (e.g. the
// scaffold "files written" relative-path lists) share the literals.
export const AGENTS_MD_FILENAME = "agents.md";
export const LYT_OVERVIEW_FILENAME = "lyt-overview.md";

// The system dir the agent-priming files now live under. Mirrors the `.lyt`
// segment used across the package (INDEX_FLOOR, vault.yon, etc.).
const LYT_DIR = ".lyt";

// ---------------------------------------------------------------------------
// WRITE targets — always `.lyt/<file>`. New vaults (and the migration
// destination) are born here.
// ---------------------------------------------------------------------------

/** Absolute write target for a vault's `agents.md`: always `<vault>/.lyt/agents.md`. */
export function agentsMdWritePath(vaultPath: string): string {
  return join(vaultPath, LYT_DIR, AGENTS_MD_FILENAME);
}

/** Absolute write target for a vault's `lyt-overview.md`: always `<vault>/.lyt/lyt-overview.md`. */
export function lytOverviewWritePath(vaultPath: string): string {
  return join(vaultPath, LYT_DIR, LYT_OVERVIEW_FILENAME);
}

// Vault-relative POSIX write targets — for the scaffold "files written" lists +
// `SCAFFOLD_COMMIT_PATHS` (git add uses forward slashes uniformly on Windows).
export const AGENTS_MD_REL_WRITE_PATH = `${LYT_DIR}/${AGENTS_MD_FILENAME}`;
export const LYT_OVERVIEW_REL_WRITE_PATH = `${LYT_DIR}/${LYT_OVERVIEW_FILENAME}`;

// ---------------------------------------------------------------------------
// Legacy-root paths — where these files lived BEFORE Phase D. Used by the read
// resolver's fallback and by the migration's source side.
// ---------------------------------------------------------------------------

/** Absolute LEGACY-root path: `<vault>/agents.md` (pre-Phase-D location). */
export function agentsMdLegacyPath(vaultPath: string): string {
  return join(vaultPath, AGENTS_MD_FILENAME);
}

/** Absolute LEGACY-root path: `<vault>/lyt-overview.md` (pre-Phase-D location). */
export function lytOverviewLegacyPath(vaultPath: string): string {
  return join(vaultPath, LYT_OVERVIEW_FILENAME);
}

// ---------------------------------------------------------------------------
// READ resolution — `.lyt/` first, legacy root as back-compat fallback.
// ---------------------------------------------------------------------------

// Generic helper: prefer the `.lyt/` location when it exists on disk, else fall
// back to the legacy root. Always returns a path (the `.lyt/` target when
// NEITHER exists, so a caller that "read-then-writes" defaults to the new home).
function resolveReadPath(newPath: string, legacyPath: string): string {
  if (existsSync(newPath)) return newPath;
  if (existsSync(legacyPath)) return legacyPath;
  return newPath;
}

/**
 * Resolve where to READ a vault's `agents.md`. `.lyt/agents.md` if present, else
 * the legacy `<vault>/agents.md` (back-compat). When neither exists, returns the
 * `.lyt/` target so a read-then-write caller writes into the new location.
 */
export function resolveAgentsMdReadPath(vaultPath: string): string {
  return resolveReadPath(agentsMdWritePath(vaultPath), agentsMdLegacyPath(vaultPath));
}

/**
 * Resolve where to READ a vault's `lyt-overview.md`. `.lyt/lyt-overview.md` if
 * present, else the legacy `<vault>/lyt-overview.md` (back-compat). When neither
 * exists, returns the `.lyt/` target.
 */
export function resolveLytOverviewReadPath(vaultPath: string): string {
  return resolveReadPath(lytOverviewWritePath(vaultPath), lytOverviewLegacyPath(vaultPath));
}

// ---------------------------------------------------------------------------
// Migration helpers (Phase D doctor/repair) — describe a legacy-root file that
// needs relocation under `.lyt/`. Pure path/presence reasoning; the repair flow
// owns the snapshot-first move.
// ---------------------------------------------------------------------------

export interface LegacyAgentFile {
  filename: string;
  legacyPath: string;
  newPath: string;
}

/**
 * Enumerate the agent-priming files that still live at the LEGACY vault root and
 * therefore need relocation under `.lyt/`. A file is a migration candidate ONLY
 * when its legacy-root copy exists. (If the `.lyt/` copy ALSO exists, the move
 * is still surfaced — the migration removes the orphaned legacy copy so there is
 * never a duplicate; see the repair apply step.)
 */
export function findLegacyAgentFiles(vaultPath: string): LegacyAgentFile[] {
  const out: LegacyAgentFile[] = [];
  const candidates: LegacyAgentFile[] = [
    {
      filename: AGENTS_MD_FILENAME,
      legacyPath: agentsMdLegacyPath(vaultPath),
      newPath: agentsMdWritePath(vaultPath),
    },
    {
      filename: LYT_OVERVIEW_FILENAME,
      legacyPath: lytOverviewLegacyPath(vaultPath),
      newPath: lytOverviewWritePath(vaultPath),
    },
  ];
  for (const c of candidates) {
    if (existsSync(c.legacyPath)) out.push(c);
  }
  return out;
}
