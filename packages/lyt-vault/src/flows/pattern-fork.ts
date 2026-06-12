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

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { getUserPatternsDir } from "../util/pattern-paths.js";

export interface PatternForkArgs {
  source: string;
  asName: string;
}

export interface PatternForkResult {
  source: string;
  asName: string;
  sourceDir: string;
  targetDir: string;
}

// Copy ~/lyt/patterns/<source>/ → ~/lyt/patterns/<asName>/. User then edits the copy
// without modifying the master. Replace any vault-side symlink via unlink + link.
export async function patternForkFlow(args: PatternForkArgs): Promise<PatternForkResult> {
  const patternsDir = getUserPatternsDir();
  const sourceDir = join(patternsDir, args.source);
  const targetDir = join(patternsDir, args.asName);
  if (!existsSync(sourceDir)) {
    throw new Error(`pattern fork: source '${args.source}' not installed at ${sourceDir}.`);
  }
  if (existsSync(targetDir)) {
    throw new Error(
      `pattern fork: target '${args.asName}' already exists at ${targetDir}. Pick a different --as name or uninstall first.`,
    );
  }
  mkdirSync(patternsDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  return { source: args.source, asName: args.asName, sourceDir, targetDir };
}
