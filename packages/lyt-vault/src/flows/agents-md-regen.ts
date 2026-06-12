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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENTS_MD_TEMPLATE_VERSION,
  getAgentsMdContent,
  regenInstalledPatternsSection,
  regenInstalledPrimerSection,
  type InstalledPatternSummary,
} from "../templates/priming.js";
import { getUserPatternsDir } from "../util/pattern-paths.js";
import { parsePatternYon } from "../yon/pattern.js";

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
  const path = join(vaultPath, "agents.md");
  const installed = collectInstalledPatterns(vaultPath);
  let written = false;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    const afterPatterns = regenInstalledPatternsSection(existing, vaultName, installed);
    const next = regenInstalledPrimerSection(afterPatterns, vaultName);
    if (next !== existing) {
      writeFileSync(path, next, "utf8");
      written = true;
    }
  } else {
    writeFileSync(path, getAgentsMdContent({ vaultName, installedPatterns: installed }), "utf8");
    written = true;
  }
  return {
    path,
    written,
    templateVersion: AGENTS_MD_TEMPLATE_VERSION,
    patternCount: installed.length,
  };
}
