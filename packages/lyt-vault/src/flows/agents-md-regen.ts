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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveAgentsMdReadPath } from "../util/agent-file-paths.js";
import {
  AGENTS_MD_TEMPLATE_VERSION,
  getAgentsMdContent,
  regenInstalledPatternsSection,
  regenInstalledPrimerSection,
  type InstalledPatternSummary,
} from "../templates/priming.js";
import { getUserPatternsDir } from "../util/pattern-paths.js";
import { parsePatternYon } from "../yon/pattern.js";
import { parseVaultYon } from "../yon/parse.js";

// Read the vault's canonical init date (`created_at`) from `.lyt/vault.yon` —
// the same instant init.ts stamps into the vault manifest. Falls back to real
// wall-clock `now` only when the manifest is absent or carries no timestamp
// (never the 1970 sentinel). Used by the FRESH agents.md branch so a first
// regen stamps the vault's creation date, not the regen moment.
function readVaultCreatedAt(vaultPath: string): string {
  try {
    const yonPath = join(vaultPath, ".lyt", "vault.yon");
    if (existsSync(yonPath)) {
      const createdAt = parseVaultYon(readFileSync(yonPath, "utf8")).createdAt;
      if (createdAt) return createdAt;
    }
  } catch {
    // fall through to now
  }
  return new Date().toISOString();
}

// Suggested skills-by-pattern mapping (matches the 10 default skills shipped in
// @younndai/lyt-skills@0.2.0). Used to populate the "→ skills:" annotation.
// External patterns get an empty skills list (the meta `/lyt-pattern` skill covers
// arbitrary-pattern dispatch).
const DEFAULT_PATTERN_SKILLS: Record<string, string[]> = {
  "work-management": [
    "/lyt-plan",
    "/lyt-progress",
    "/lyt-result",
    "/lyt-retro",
    "/lyt-insight",
    "/lyt-handoff",
  ],
  "knowledge-capture": ["/lyt-capture", "/lyt-recall"],
  "decision-log": ["/lyt-decision"],
};

// Walk <vaultPath>/Patterns/ and return a summary per linked pattern (with verbs from
// the master ~/lyt/patterns/<name>/pattern.yon and a best-effort skill mapping).
export function collectInstalledPatterns(vaultPath: string): InstalledPatternSummary[] {
  const patternsDir = join(vaultPath, "Patterns");
  if (!existsSync(patternsDir)) return [];
  const masterDir = getUserPatternsDir();
  const out: InstalledPatternSummary[] = [];
  for (const name of readdirSync(patternsDir)) {
    const linkPath = join(patternsDir, name);
    try {
      if (!statSync(linkPath).isDirectory()) continue;
    } catch {
      continue;
    }
    // Read from master (always has pattern.yon); fallback to the link path if master is gone.
    const yonPathMaster = join(masterDir, name, "pattern.yon");
    const yonPathLocal = join(linkPath, "pattern.yon");
    const yonPath = existsSync(yonPathMaster) ? yonPathMaster : yonPathLocal;
    if (!existsSync(yonPath)) continue;
    const parsed = parsePatternYon(readFileSync(yonPath, "utf8"));
    if (!parsed.pattern) continue;
    out.push({
      id: parsed.pattern.id,
      name: parsed.pattern.name,
      version: parsed.pattern.version,
      verbIds: parsed.verbs.map((v) => v.id),
      skills: DEFAULT_PATTERN_SKILLS[parsed.pattern.id] ?? undefined,
    });
  }
  return out;
}

export interface RegenAgentsMdResult {
  path: string;
  written: boolean;
  templateVersion: number;
  patternCount: number;
}

// Regenerate agents.md for a vault. If the file exists with LYT_PATTERNS markers,
// only the markers' content is replaced. Otherwise the whole file is rewritten from
// the current template.
//
// v1.D.5: also chains `regenInstalledPrimerSection` after the patterns
// regen. The primer-section regen is a no-op when LYT_PRIMER markers are
// absent (existing v2 files stay untouched per "What was decided" §8);
// when present (NEW v3 files from getAgentsMdContent OR users who hand-
// added the markers), the section content refreshes in-place.
export function regenAgentsMd(vaultPath: string, vaultName: string): RegenAgentsMdResult {
  // Phase D (SC6) — route through the resolver: regen an EXISTING agents.md
  // in place (whether it lives under `.lyt/` post-move or at the legacy root
  // pre-migration — back-compat), and write a FRESH one under `.lyt/`. The
  // resolver returns the `.lyt/` target when neither copy exists, so a brand-new
  // file is born in the new location.
  const path = resolveAgentsMdReadPath(vaultPath);
  const installed = collectInstalledPatterns(vaultPath);
  let written = false;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    // MJ-2 — thread the on-disk path so the full-rewrite branch can DERIVE a real
    // date (git-first-commit → mtime → now) for a legacy seed with no preservable
    // `created`, instead of re-emitting the 1970 sentinel.
    const afterPatterns = regenInstalledPatternsSection(existing, vaultName, installed, path);
    const next = regenInstalledPrimerSection(afterPatterns, vaultName);
    if (next !== existing) {
      writeFileSync(path, next, "utf8");
      written = true;
    }
  } else {
    // Fresh file (init or an adopt/clone with no prior agents.md). Phase A
    // (UNIT 1 / C2) — stamp the real creation instant into the seed frontmatter,
    // not the 1970 sentinel. This is the only regen branch that CREATES the
    // frontmatter; the marker-bounded branch above preserves whatever is on disk,
    // and the full-rewrite branch (inside regenInstalledPatternsSection) reads
    // back + preserves the existing dates.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      getAgentsMdContent({
        vaultName,
        installedPatterns: installed,
        dates: { created: readVaultCreatedAt(vaultPath) },
      }),
      "utf8",
    );
    written = true;
  }
  return {
    path,
    written,
    templateVersion: AGENTS_MD_TEMPLATE_VERSION,
    patternCount: installed.length,
  };
}
