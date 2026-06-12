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

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Runtime = "claude" | "codex" | "agents";

export const ALL_RUNTIMES: readonly Runtime[] = ["claude", "codex", "agents"];

export type SymlinkStatus =
  | "installed-symlink"
  | "installed-copy"
  | "installed-copy-fallback"
  | "already-linked"
  | "replaced"
  | "divergent-symlink"
  // D30.4 / OD-1 (2026-06-03) — a non-lyt directory at the skill target was
  // renamed aside to `<skill>.local-<ts>` (preserved) and the lyt symlink was
  // installed. Replaces the prior refuse-or-destroy `copy-installed` branch.
  | "renamed-collision"
  | "target-not-a-directory";

export interface SkillRuntimeResult {
  skill: string;
  runtime: Runtime;
  targetPath: string;
  status: SymlinkStatus;
  message?: string;
}

export interface SymlinkResult {
  sourceDir: string;
  runtimes: readonly Runtime[];
  results: readonly SkillRuntimeResult[];
}

export interface SymlinkSkillsOptions {
  sourceDir?: string | undefined;
  runtimes?: readonly Runtime[] | undefined;
  skillNames?: readonly string[] | undefined;
  copy?: boolean | undefined;
  force?: boolean | undefined;
  targetDirOverrides?: Partial<Record<Runtime, string>> | undefined;
  /**
   * Test-only seam: override the low-level symlink call. Required for EPERM-
   * fallback coverage because ESM module exports are not vi.spyOn-configurable.
   * Production callers leave this undefined.
   */
  symlinkFnOverride?:
    | ((target: string, path: string, type: "junction" | "dir") => void)
    | undefined;
  /**
   * Test-only seam: override the collision-rename timestamp. Production
   * callers leave this undefined (real UTC clock). Tests inject a fixed stamp
   * to exercise the repeat-collision disambiguator deterministically (W1.1
   * test d).
   */
  collisionStampFn?: (() => string) | undefined;
}

const RUNTIME_DEFAULT_DIR: Record<Runtime, () => string> = {
  claude: () => join(homedir(), ".claude", "skills"),
  codex: () => join(homedir(), ".codex", "skills"),
  agents: () => join(homedir(), ".agents", "skills"),
};

export function getRuntimeTargetDir(runtime: Runtime): string {
  return RUNTIME_DEFAULT_DIR[runtime]();
}

export function getBundledSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "skills");
}

export function listBundledSkills(sourceDir: string): readonly string[] {
  if (!existsSync(sourceDir)) {
    return [];
  }
  return readdirSync(sourceDir).filter((name) => {
    const fullPath = join(sourceDir, name);
    if (!statSync(fullPath).isDirectory()) return false;
    return existsSync(join(fullPath, "SKILL.md"));
  });
}

function symlinkType(): "junction" | "dir" {
  return platform() === "win32" ? "junction" : "dir";
}

function createLink(
  sourceSkillDir: string,
  targetSkillDir: string,
  copy: boolean,
  symlinkFn: (target: string, path: string, type: "junction" | "dir") => void,
): SymlinkStatus {
  if (copy) {
    cpSync(sourceSkillDir, targetSkillDir, { recursive: true });
    return "installed-copy";
  }
  try {
    symlinkFn(sourceSkillDir, targetSkillDir, symlinkType());
    return "installed-symlink";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      cpSync(sourceSkillDir, targetSkillDir, { recursive: true });
      return "installed-copy-fallback";
    }
    throw err;
  }
}

const defaultSymlinkFn = (target: string, path: string, type: "junction" | "dir"): void => {
  symlinkSync(target, path, type);
};

export function symlinkSkillsTriRuntime(opts: SymlinkSkillsOptions = {}): SymlinkResult {
  const sourceDir = opts.sourceDir ? resolve(opts.sourceDir) : getBundledSkillsDir();
  const runtimes = opts.runtimes ?? ALL_RUNTIMES;
  const copy = opts.copy ?? false;
  const force = opts.force ?? false;

  if (!existsSync(sourceDir)) {
    throw new Error(
      `Bundled skills directory not found at: ${sourceDir}. Did the package build correctly?`,
    );
  }

  const allBundled = listBundledSkills(sourceDir);
  const skillNames = opts.skillNames
    ? allBundled.filter((n) => opts.skillNames!.includes(n))
    : allBundled;

  const symlinkFn = opts.symlinkFnOverride ?? defaultSymlinkFn;
  const collisionStampFn = opts.collisionStampFn ?? defaultCollisionStamp;
  const results: SkillRuntimeResult[] = [];

  for (const runtime of runtimes) {
    const targetBase = opts.targetDirOverrides?.[runtime] ?? getRuntimeTargetDir(runtime);
    mkdirSync(targetBase, { recursive: true });

    for (const skill of skillNames) {
      const sourceSkillDir = resolve(join(sourceDir, skill));
      const targetSkillDir = join(targetBase, skill);
      const result = installOne({
        sourceSkillDir,
        targetSkillDir,
        copy,
        force,
        symlinkFn,
        collisionStampFn,
      });
      results.push({ skill, runtime, targetPath: targetSkillDir, ...result });
    }
  }

  return { sourceDir, runtimes, results };
}

interface InstallOneInput {
  sourceSkillDir: string;
  targetSkillDir: string;
  copy: boolean;
  force: boolean;
  symlinkFn: (target: string, path: string, type: "junction" | "dir") => void;
  collisionStampFn: () => string;
}

interface InstallOneOutput {
  status: SymlinkStatus;
  message?: string;
}

function installOne(input: InstallOneInput): InstallOneOutput {
  const { sourceSkillDir, targetSkillDir, copy, force, symlinkFn, collisionStampFn } = input;

  if (!existsSync(targetSkillDir)) {
    return { status: createLink(sourceSkillDir, targetSkillDir, copy, symlinkFn) };
  }

  const stat = lstatSync(targetSkillDir);

  if (stat.isSymbolicLink()) {
    const existingTarget = resolve(readlinkSync(targetSkillDir));
    if (existingTarget === sourceSkillDir) {
      return { status: "already-linked" };
    }
    if (!force) {
      return {
        status: "divergent-symlink",
        message: `existing symlink points to ${existingTarget}; re-run with --force to replace`,
      };
    }
    rmSync(targetSkillDir, { recursive: true, force: true });
    const newStatus = createLink(sourceSkillDir, targetSkillDir, copy, symlinkFn);
    return {
      status: "replaced",
      message: `replaced symlink (was ${existingTarget}); now ${newStatus}`,
    };
  }

  if (stat.isDirectory()) {
    // Collision-safe install (D30.4 / OD-1 — P0). A NON-symlink directory
    // sits at the skill target. We NEVER `rmSync` a directory whose content
    // we did not write — that was the data-loss footgun in the prior
    // `--force` branch (and the silent-refuse without it).
    //
    // - Pristine lyt copy-fallback (content byte-identical to the bundled
    // source) → safe to upgrade in place to the symlink, no backup. This
    // is the heal path for EPERM copy-fallback installs (D30.2 caveat b).
    // - Anything else (the user's OWN dir, or a stale/divergent copy) →
    // RENAME it aside to `<skill>.local-<ts>` (preserve — never lose),
    // then install the lyt symlink over the now-free target.
    //
    // Note: `force` is intentionally NOT consulted here — collision-safety is
    // the default, not an opt-in. A pristine replace and a rename-aside are
    // both non-destructive, so there is nothing for `--force` to gate.
    if (dirsEqual(sourceSkillDir, targetSkillDir)) {
      rmSync(targetSkillDir, { recursive: true, force: true });
      const newStatus = createLink(sourceSkillDir, targetSkillDir, copy, symlinkFn);
      return {
        status: "replaced",
        message: `replaced pristine copy (content matched bundled); now ${newStatus}`,
      };
    }
    const renamedTo = renameAside(targetSkillDir, collisionStampFn);
    const newStatus = createLink(sourceSkillDir, targetSkillDir, copy, symlinkFn);
    return {
      status: "renamed-collision",
      message:
        `⚠ a non-lyt directory was already at this skill target; set it aside as ` +
        `'${basename(renamedTo)}' (preserved — nothing deleted) and installed the lyt skill (${newStatus})`,
    };
  }

  // `force` is referenced only in the divergent-symlink branch above; reference
  // it here too so the unused-param lint stays quiet on the collision-safe
  // directory branch that deliberately ignores it.
  void force;
  return {
    status: "target-not-a-directory",
    message: `${targetSkillDir} is neither a symlink nor a directory; refusing to touch`,
  };
}

// Compact UTC stamp for collision-rename suffixes: `YYYYMMDDTHHMMSSZ`.
// Colon-free (Windows forbids ':' in filenames), lexically sortable, and
// human-readable. OD-1 (2026-06-03): chosen over epoch-ms for legibility; the
// repeat-collision disambiguator in renameAside covers sub-second reruns.
function defaultCollisionStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// Rename a colliding non-lyt directory aside, preserving it. Appends a numeric
// `-N` disambiguator when the timestamped name already exists (covers two
// collisions within the same second / the same injected stamp — W1.1 test d).
// Returns the path it was renamed to. NEVER deletes.
function renameAside(targetSkillDir: string, stampFn: () => string): string {
  const base = `${targetSkillDir}.local-${stampFn()}`;
  let candidate = base;
  let n = 2;
  while (existsSync(candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  renameSync(targetSkillDir, candidate);
  return candidate;
}

// Recursively compare two directory trees for byte-equality (names + file
// contents + structure), WITHOUT following symlinks. Detects a pristine lyt
// copy-fallback (content === bundled source) that is safe to upgrade to a
// symlink in place. A symlink anywhere in either tree → not equal
// (conservative: never treat a link-bearing tree as pristine).
function dirsEqual(a: string, b: string): boolean {
  let aNames: string[];
  let bNames: string[];
  try {
    aNames = readdirSync(a).sort();
    bNames = readdirSync(b).sort();
  } catch {
    return false;
  }
  if (aNames.length !== bNames.length) return false;
  for (let i = 0; i < aNames.length; i++) {
    if (aNames[i] !== bNames[i]) return false;
    const an = join(a, aNames[i]!);
    const bn = join(b, bNames[i]!);
    const as = lstatSync(an);
    const bs = lstatSync(bn);
    if (as.isSymbolicLink() || bs.isSymbolicLink()) return false;
    if (as.isDirectory() !== bs.isDirectory()) return false;
    if (as.isDirectory()) {
      if (!dirsEqual(an, bn)) return false;
    } else {
      if (as.size !== bs.size) return false;
      if (!readFileSync(an).equals(readFileSync(bn))) return false;
    }
  }
  return true;
}
