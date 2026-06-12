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

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getUserPatternsDir } from "../util/pattern-paths.js";
import { patternLinkFlow, type PatternLinkResult } from "./pattern-link.js";

// On vault adopt/join, auto-rebuild symlinks for every installed pattern. Symlinks are
// gitignored from vault repos; this restores them on the local machine.
export async function relinkAllPatternsForVault(vaultName: string): Promise<PatternLinkResult[]> {
  const patternsDir = getUserPatternsDir();
  if (!existsSync(patternsDir)) return [];
  const patternNames = readdirSync(patternsDir).filter((n) => {
    const full = join(patternsDir, n);
    if (!statSync(full).isDirectory()) return false;
    return existsSync(join(full, "pattern.yon"));
  });

  const results: PatternLinkResult[] = [];
  for (const name of patternNames) {
    try {
      const r = await patternLinkFlow({ patternName: name, vaultName });
      results.push(r);
    } catch {
      // Best-effort; one pattern's failure doesn't block the rest.
    }
  }
  return results;
}
