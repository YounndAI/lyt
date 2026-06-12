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

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  closeRegistry,
  getDefaultVaultsRoot,
  getVaultByPath,
  joinVaultFlow,
  openRegistry,
} from "@younndai/lyt-vault";

import { walk, type SourceAdapter, type WalkResult } from "../discovery/walk.js";
import { listSources } from "../source/repo.js";
import type { GhExecutor } from "../discovery/github.js";

export interface GitCloneFn {
  (cloneUrl: string, dest: string): Promise<void>;
}

const defaultGitClone: GitCloneFn = (cloneUrl, dest) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["clone", "--quiet", cloneUrl, dest], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(new Error("`git` not found on PATH. Install Git: https://git-scm.com/."));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git clone exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });

export interface CloneAllOptions {
  sourceFilter?: string;
  dryRun?: boolean;
  gh?: GhExecutor;
  adapters?: readonly SourceAdapter[];
  gitClone?: GitCloneFn;
  destRoot?: string;
}

export interface CloneAllOutcome {
  cloned: { name: string; cloneUrl: string; path: string }[];
  skipped_already_registered: { name: string; path: string }[];
  skipped_sources: { name: string; reason: string }[];
  errored: { name: string; cloneUrl: string; reason: string }[];
  dry_run: boolean;
  dry_run_plan: { name: string; cloneUrl: string; destPath: string; sourceName: string }[];
  source_count: number;
  walk_duplicates: number;
}

export interface CloneAllResult {
  ok: true;
  outcome: CloneAllOutcome;
}

export interface CloneAllNoSources {
  ok: false;
  reason: "no-sources";
  message: string;
}

export async function cloneAllFlow(
  opts: CloneAllOptions = {},
): Promise<CloneAllResult | CloneAllNoSources> {
  const dryRun = opts.dryRun === true;
  const gitClone = opts.gitClone ?? defaultGitClone;
  const destRoot = opts.destRoot ?? getDefaultVaultsRoot();
  const db = await openRegistry();
  let walkResult: WalkResult;
  try {
    const sources = await listSources(db);
    if (sources.length === 0) {
      return {
        ok: false,
        reason: "no-sources",
        message:
          "No vault sources configured. Run 'lyt mesh source add <name> --host <host> --owner <owner>' first.",
      };
    }
    walkResult = await walk({
      sources,
      sourceFilter: opts.sourceFilter,
      adapters: opts.adapters,
      gh: opts.gh,
    });
    const outcome: CloneAllOutcome = {
      cloned: [],
      skipped_already_registered: [],
      skipped_sources: walkResult.skippedSources,
      errored: [],
      dry_run: dryRun,
      dry_run_plan: [],
      source_count: opts.sourceFilter
        ? sources.filter((s) => s.name === opts.sourceFilter).length
        : sources.length,
      walk_duplicates: walkResult.duplicates,
    };
    for (const { repo, source } of walkResult.discovered) {
      const destPath = join(destRoot, repo.name);
      if (dryRun) {
        outcome.dry_run_plan.push({
          name: repo.name,
          cloneUrl: repo.cloneUrl,
          destPath,
          sourceName: source.name,
        });
        continue;
      }
      const existing = await getVaultByPath(db, destPath);
      if (existing) {
        outcome.skipped_already_registered.push({ name: repo.name, path: destPath });
        continue;
      }
      if (existsSync(destPath)) {
        outcome.errored.push({
          name: repo.name,
          cloneUrl: repo.cloneUrl,
          reason: `destination already exists on disk but is not registered: ${destPath}`,
        });
        continue;
      }
      try {
        mkdirSync(destRoot, { recursive: true });
        await gitClone(repo.cloneUrl, destPath);
        await joinVaultFlow(destPath);
        outcome.cloned.push({ name: repo.name, cloneUrl: repo.cloneUrl, path: destPath });
      } catch (err) {
        outcome.errored.push({
          name: repo.name,
          cloneUrl: repo.cloneUrl,
          reason: (err as Error).message,
        });
      }
    }
    return { ok: true, outcome };
  } finally {
    await closeRegistry(db);
  }
}
