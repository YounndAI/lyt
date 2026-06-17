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

// W1.2 (2026-06-03) — idempotent pod heal.
//
// `healPod` re-aligns the three things a `lyt init` is meant to keep fresh,
// composing primitives from lyt-skills + lyt-vault (the meta package is the
// natural composer — see init-bootstrap.ts header):
//
// 1. SKILLS — symlinkSkillsTriRuntime into every DETECTED runtime
// (collision-safe per a user dir at a target is renamed
// aside, never destroyed; a pristine copy is upgraded to a link;
// an already-correct link short-circuits to already-linked).
// 2. MANUAL — the agent manual marker block, replaced-or-appended in each
// detected runtime's global instructions file. Malformed markers
// are REFUSED — heal never silently mutates a hand-edited
// file; it leaves it and reports `refused-malformed`.
// 3. PATTERNS — healPatterns version-update : add missing, replace
// pristine-older (with backup), leave forks untouched.
//
// EVERY step is idempotent and non-fatal: a heal on an aligned pod is a no-op;
// a per-runtime failure is recorded, not thrown, so a single `lyt init` never
// fails because of heal (never-fail). The CLI command runs this on the
// fresh + re-init branches; unit tests drive it directly with seams so no real
// ~/.claude / ~/.codex / ~/.agents is ever touched in CI.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { symlinkSkillsTriRuntime, type Runtime, type SymlinkResult } from "@younndai/lyt-skills";
import {
  AgentManualMalformedMarkersError,
  detectInstalledRuntimes,
  generateAgentManual,
  healPatterns,
  replaceMarkerBlock,
  type AgentManualRuntime,
  type PatternHealResult,
} from "@younndai/lyt-vault";

export type ManualHealAction =
  | "installed" // fresh block appended (no prior marker)
  | "updated" // existing block replaced
  | "skipped-symlink" // destination is a symlink → refused (unsafe write)
  | "refused-malformed" // malformed markers, no --force → left untouched
  | "no-destination"; // generic / unresolved destination

export interface ManualHealEntry {
  runtime: AgentManualRuntime;
  action: ManualHealAction;
  destinationPath: string | null;
  message?: string;
}

export interface HealResult {
  runtimes: readonly Runtime[];
  skills: SymlinkResult;
  manual: ManualHealEntry[];
  patterns: PatternHealResult;
}

export interface HealPodOptions {
  // Skip runtime detection — drive an explicit set (test seam).
  runtimesOverride?: readonly Runtime[] | undefined;
  // Skills seams.
  skillsSourceDir?: string | undefined;
  skillTargetOverrides?: Partial<Record<Runtime, string>> | undefined;
  collisionStampFn?: (() => string) | undefined;
  // Manual seams (homedirOverride also drives runtime detection).
  homedirOverride?: string | undefined;
  skillsCatalogDir?: string | undefined;
  manualVersionOverride?: string | undefined;
  // Patterns seams.
  patternsBundledDirOverride?: string | undefined;
  patternBackupStampFn?: (() => string) | undefined;
}

export async function healPod(opts: HealPodOptions = {}): Promise<HealResult> {
  // Runtimes: explicit override, else detect installed ones (~/.claude, etc.).
  const runtimes: readonly Runtime[] =
    opts.runtimesOverride ?? detectInstalledRuntimes(opts.homedirOverride);

  // 1. Skills — collision-safe symlink into each detected runtime.
  const skills = symlinkSkillsTriRuntime({
    ...(opts.skillsSourceDir !== undefined ? { sourceDir: opts.skillsSourceDir } : {}),
    runtimes,
    ...(opts.skillTargetOverrides !== undefined
      ? { targetDirOverrides: opts.skillTargetOverrides }
      : {}),
    ...(opts.collisionStampFn !== undefined ? { collisionStampFn: opts.collisionStampFn } : {}),
  });

  // 2. Manual — inject/refresh the marker block per runtime (non-fatal).
  const manual: ManualHealEntry[] = [];
  for (const runtime of runtimes) {
    manual.push(await injectManual(runtime, opts));
  }

  // 3. Patterns — version-update heal.
  const patterns = healPatterns({
    ...(opts.patternsBundledDirOverride !== undefined
      ? { bundledDirOverride: opts.patternsBundledDirOverride }
      : {}),
    ...(opts.patternBackupStampFn !== undefined ? { stampFn: opts.patternBackupStampFn } : {}),
  });

  return { runtimes, skills, manual, patterns };
}

async function injectManual(runtime: Runtime, opts: HealPodOptions): Promise<ManualHealEntry> {
  const gen = await generateAgentManual({
    runtime: runtime as AgentManualRuntime,
    install: true,
    ...(opts.homedirOverride !== undefined ? { homedirOverride: opts.homedirOverride } : {}),
    ...(opts.skillsCatalogDir !== undefined ? { skillsDirOverride: opts.skillsCatalogDir } : {}),
    ...(opts.manualVersionOverride !== undefined
      ? { versionOverride: opts.manualVersionOverride }
      : {}),
  });
  const dest = gen.destinationPath;
  if (dest === null) {
    return { runtime, action: "no-destination", destinationPath: null };
  }
  // Symlink-refuse (mirrors the command's Sec-M1 defense): writeFileSync
  // follows symlinks, so never write the manual through a planted link.
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    return {
      runtime,
      action: "skipped-symlink",
      destinationPath: dest,
      message: `${dest} is a symlink; refused to write the agent manual through it`,
    };
  }
  let existing = "";
  if (existsSync(dest)) existing = readFileSync(dest, "utf8");
  try {
    // force=false → malformed markers REFUSE. Heal never silently
    // overwrites a hand-edited file; it leaves it and reports.
    const { result: next, replaced } = replaceMarkerBlock(existing, gen.content, dest, false);
    const dir = dirname(dest);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(dest, next, "utf8");
    return {
      runtime,
      action: replaced ? "updated" : "installed",
      destinationPath: dest,
    };
  } catch (err) {
    if (err instanceof AgentManualMalformedMarkersError) {
      return {
        runtime,
        action: "refused-malformed",
        destinationPath: dest,
        message: err.message,
      };
    }
    throw err;
  }
}

// Compact one-line summary for the CLI human output.
export function summarizeHeal(heal: HealResult): string {
  const skillCounts = new Map<string, number>();
  for (const r of heal.skills.results) {
    skillCounts.set(r.status, (skillCounts.get(r.status) ?? 0) + 1);
  }
  const skillsParts = [...skillCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, n]) => `${n} ${status}`);
  const manualParts = heal.manual.map((m) => `${m.runtime}:${m.action}`);
  const patCounts = new Map<string, number>();
  for (const e of heal.patterns.entries) {
    patCounts.set(e.action, (patCounts.get(e.action) ?? 0) + 1);
  }
  const patParts = [...patCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([action, n]) => `${n} ${action}`);
  const runtimeList = heal.runtimes.length > 0 ? heal.runtimes.join(", ") : "(none detected)";
  return [
    `Heal — runtimes: ${runtimeList}`,
    `  skills:   ${skillsParts.length > 0 ? skillsParts.join(", ") : "(no runtimes)"}`,
    `  manual:   ${manualParts.length > 0 ? manualParts.join(", ") : "(no runtimes)"}`,
    `  patterns: ${patParts.length > 0 ? patParts.join(", ") : "(none)"}`,
  ].join("\n");
}
