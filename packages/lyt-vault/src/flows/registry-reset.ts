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

import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { getKnownPathsFile } from "../registry/known-paths.js";
import { getDefaultVaultsRoot, getLytHome, validateLytHome } from "../util/paths.js";
import { getRegistryPath } from "../registry/client.js";

export interface RegistryResetArgs {
  confirmed: boolean;
}

export interface RegistryResetSkippedEntry {
  name: string;
  reason: string;
}

export interface RegistryResetResult {
  schemaVersion: 1;
  lytHome: string;
  registryRemoved: boolean;
  knownPathsRemoved: boolean;
  vaultDirsRemoved: string[];
  skipped: RegistryResetSkippedEntry[];
}

export async function registryResetFlow(args: RegistryResetArgs): Promise<RegistryResetResult> {
  if (!args.confirmed) {
    throw new Error(
      "Refusing to reset without explicit confirmation. Pass --yes to proceed " +
        "(this removes ~/lyt/registry.db, ~/lyt/known-paths.txt, and every directory under ~/lyt/vaults/).",
    );
  }

  const lytHome = resolve(getLytHome());
  validateLytHome(lytHome);

  const registryPath = getRegistryPath();
  let registryRemoved = false;
  if (existsSync(registryPath) && isUnder(registryPath, lytHome)) {
    await rmWithRetry(registryPath);
    registryRemoved = true;
  }

  const knownPathsPath = getKnownPathsFile();
  let knownPathsRemoved = false;
  if (existsSync(knownPathsPath) && isUnder(knownPathsPath, lytHome)) {
    await rmWithRetry(knownPathsPath);
    knownPathsRemoved = true;
  }

  const vaultsRoot = resolve(getDefaultVaultsRoot());
  const vaultDirsRemoved: string[] = [];
  const skipped: RegistryResetSkippedEntry[] = [];
  if (
    existsSync(vaultsRoot) &&
    statSync(vaultsRoot).isDirectory() &&
    isUnder(vaultsRoot, lytHome)
  ) {
    for (const entry of readdirSync(vaultsRoot, { withFileTypes: true })) {
      const abs = join(vaultsRoot, entry.name);
      // lstat (not stat) so symlinks-to-directories don't masquerade as directories.
      // rmSync(recursive) on a symlink-to-dir would delete the TARGET's contents.
      const ls = lstatSync(abs);
      if (ls.isSymbolicLink()) {
        skipped.push({ name: entry.name, reason: "symlink" });
        continue;
      }
      if (!ls.isDirectory()) continue;
      if (!isUnder(abs, lytHome)) continue;
      await rmWithRetry(abs);
      vaultDirsRemoved.push(entry.name);
    }
  }

  return {
    schemaVersion: 1,
    lytHome,
    registryRemoved,
    knownPathsRemoved,
    vaultDirsRemoved,
    skipped,
  };
}

async function rmWithRetry(path: string): Promise<void> {
  // 720 × 250ms = 180s — matches the test helper's v1.C.4.2 second-raise
  // budget. v1.C.4.2 diagnosis observed a 126s outlier in this exact flow
  // when registry-reset rm'd 3 vault dirs back-to-back after a slow
  // preceding test had drained DB closes; 180s is the budget that survived
  // 5/5 stress runs.
  // SEE ALSO: tests/_helpers/fs-retry.ts rmStrict — keep budgets in sync (180s).
  // SEE ALSO: src/scaffold/delete.ts rmWithRetry — keep budgets in sync (180s).
  // SEE ALSO: src/flows/rename.ts renameDirWithRetry — keep budgets in sync (180s).
  const attempts = process.platform === "win32" ? 720 : 60;
  const delayMs = 250;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES" && code !== "ENOTEMPTY") {
        throw err;
      }
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function isUnder(target: string, root: string): boolean {
  const t = resolve(target);
  const r = resolve(root);
  if (t === r) return true;
  const sep = r.endsWith("/") || r.endsWith("\\") ? "" : process.platform === "win32" ? "\\" : "/";
  return t.startsWith(r + sep) || t.startsWith(r + "/") || t.startsWith(r + "\\");
}
