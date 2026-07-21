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

import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ALL_RUNTIMES,
  getBundledSkillsDir,
  getRuntimeTargetDir,
  listBundledSkills,
  type Runtime,
} from "./symlink.js";
import {
  readSkillMetadata,
  type SkillCompatibilityRefusal,
  type SkillCompatibilityStatus,
} from "./skill-metadata.js";

export type SkillRuntimeState = "symlink" | "copy" | "missing" | "divergent" | "not-a-dir";

export interface SkillRuntimeRow {
  name: string;
  skillVersion: string | null;
  requiresLyt: string | null;
  contractVersion: string | null;
  lytVersion: string | null;
  compatibility: SkillCompatibilityStatus;
  refusal: SkillCompatibilityRefusal | null;
  runtimes: Record<Runtime, SkillRuntimeState>;
}

export interface ListSkillsResult {
  sourceDir: string;
  runtimes: readonly Runtime[];
  skills: readonly SkillRuntimeRow[];
}

export interface ListSkillsOptions {
  sourceDir?: string | undefined;
  runtimes?: readonly Runtime[] | undefined;
  targetDirOverrides?: Partial<Record<Runtime, string>> | undefined;
}

export function listSkillsTriRuntime(opts: ListSkillsOptions = {}): ListSkillsResult {
  const sourceDir = opts.sourceDir ? resolve(opts.sourceDir) : getBundledSkillsDir();
  const runtimes = opts.runtimes ?? ALL_RUNTIMES;
  const skillNames = [...listBundledSkills(sourceDir)].sort();

  const skills: SkillRuntimeRow[] = skillNames.map((name) => {
    const skillSourceDir = resolve(join(sourceDir, name));
    const metadata = readSkillMetadata(join(skillSourceDir, "SKILL.md"));
    const runtimeStates: Record<Runtime, SkillRuntimeState> = {
      claude: "missing",
      codex: "missing",
      agents: "missing",
    };
    for (const runtime of runtimes) {
      const targetBase = opts.targetDirOverrides?.[runtime] ?? getRuntimeTargetDir(runtime);
      const targetSkillDir = join(targetBase, name);
      runtimeStates[runtime] = detectState(targetSkillDir, skillSourceDir);
    }
    return { name, ...metadata, runtimes: runtimeStates };
  });

  return { sourceDir, runtimes, skills };
}

function detectState(targetSkillDir: string, sourceSkillDir: string): SkillRuntimeState {
  if (!existsSync(targetSkillDir)) return "missing";
  const stat = lstatSync(targetSkillDir);
  if (stat.isSymbolicLink()) {
    const target = resolve(readlinkSync(targetSkillDir));
    return target === sourceSkillDir ? "symlink" : "divergent";
  }
  if (statSync(targetSkillDir).isDirectory()) return "copy";
  return "not-a-dir";
}
