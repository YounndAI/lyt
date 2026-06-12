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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getUserPatternsDir } from "../util/pattern-paths.js";
import { parsePatternYon, type VerbRecord } from "../yon/pattern.js";

export interface PatternVerbsResult {
  patternName: string;
  patternId: string;
  patternVersion: string;
  verbs: VerbRecord[];
}

export async function patternVerbsFlow(patternName: string): Promise<PatternVerbsResult> {
  const dir = join(getUserPatternsDir(), patternName);
  const yonPath = join(dir, "pattern.yon");
  if (!existsSync(yonPath)) {
    throw new Error(`pattern verbs: '${patternName}' not installed (no ${yonPath}).`);
  }
  const parsed = parsePatternYon(readFileSync(yonPath, "utf8"));
  return {
    patternName,
    patternId: parsed.pattern?.id ?? patternName,
    patternVersion: parsed.pattern?.version ?? "0.0.0",
    verbs: parsed.verbs,
  };
}
