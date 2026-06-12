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

import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName } from "../registry/repo.js";
import { getUserPatternsDir, listPatternNames } from "../util/pattern-paths.js";
import { parsePatternYon } from "../yon/pattern.js";

export interface PatternListEntry {
  id: string;
  name: string;
  version: string;
  dir: string;
  verbCount: number;
  linkedToVault: boolean | null;
}

export interface PatternListResult {
  patternsDir: string;
  entries: PatternListEntry[];
}

// List patterns at ~/lyt/patterns/. If `vaultName` is provided, also report whether
// each pattern is currently linked into that vault (by checking for a symlink at
// <vault>/Patterns/<pattern-name>).
export async function patternListFlow(vaultName?: string): Promise<PatternListResult> {
  const patternsDir = getUserPatternsDir();
  const names = listPatternNames(patternsDir);

  let vaultPath: string | null = null;
  if (vaultName) {
    const db = await openRegistry();
    try {
      const row = await getVaultByName(db, vaultName);
      vaultPath = row?.path ?? null;
    } finally {
      await closeRegistry(db);
    }
  }

  const entries: PatternListEntry[] = [];
  for (const name of names) {
    const dir = join(patternsDir, name);
    const yonPath = join(dir, "pattern.yon");
    const parsed = parsePatternYon(readFileSync(yonPath, "utf8"));
    const linkedToVault = vaultPath ? isLinkedInto(vaultPath, name) : null;
    entries.push({
      id: parsed.pattern?.id ?? name,
      name: parsed.pattern?.name ?? name,
      version: parsed.pattern?.version ?? "0.0.0",
      dir,
      verbCount: parsed.verbs.length,
      linkedToVault,
    });
  }

  return { patternsDir, entries };
}

function isLinkedInto(vaultPath: string, patternName: string): boolean {
  const linkPath = join(vaultPath, "Patterns", patternName);
  if (!existsSync(linkPath)) return false;
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      readlinkSync(linkPath);
      return true;
    }
  } catch {
    return false;
  }
  // Directory but not a symlink — could be a manual copy; treat as linked.
  return true;
}
