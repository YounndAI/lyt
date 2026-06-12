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

import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { getUserPatternsDir } from "../util/pattern-paths.js";

export interface PatternInstallArgs {
  // v1 supports local-path install only ("--from <local-dir>"). Git-URL install is a
  // shallow git-clone wrapper added later; npm-package install is v1.5.
  fromDir: string;
  // Override the installed name (default = basename of fromDir).
  asName?: string | undefined;
  // Overwrite the target dir if it exists.
  force?: boolean | undefined;
}

export interface PatternInstallResult {
  name: string;
  sourceDir: string;
  targetDir: string;
  status: "installed" | "skipped-exists" | "overwritten";
}

export async function patternInstallFlow(args: PatternInstallArgs): Promise<PatternInstallResult> {
  const sourceDir = resolve(args.fromDir);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`pattern install: '${sourceDir}' is not a directory.`);
  }
  const yonPath = join(sourceDir, "pattern.yon");
  if (!existsSync(yonPath)) {
    throw new Error(`pattern install: '${sourceDir}' has no pattern.yon at its root.`);
  }
  const name =
    args.asName ??
    sourceDir
      .split(/[\\/]+/)
      .filter((s) => s.length > 0)
      .pop()!;
  const targetDir = join(getUserPatternsDir(), name);

  const exists = existsSync(targetDir);
  if (exists && args.force !== true) {
    return { name, sourceDir, targetDir, status: "skipped-exists" };
  }

  mkdirSync(getUserPatternsDir(), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  return { name, sourceDir, targetDir, status: exists ? "overwritten" : "installed" };
}
