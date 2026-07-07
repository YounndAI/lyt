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

import { existsSync, lstatSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { getVaultPatternsLinkDir } from "../util/pattern-paths.js";

export interface DeleteScaffoldResult {
  removedLytDir: boolean;
  lytDirPath: string;
}

/**
 * Remove only the .lyt/ derived state directory. NEVER touches .md files.
 * The non-destructive invariant lives here.
 *
 * Block-A Commit 4: with the per-vault `.lyt/lyt.db` now part of the scaffold,
 * Windows can hold a brief file lock on the libSQL handle even after close().
 * Mirrors the rmWithRetry / rmStrict 720×250ms = 180s budget. Progression:
 * pre-A.3 = 30s; A.3 = 60s; v1.C.4.2 first raise = 120s; v1.C.4.2 second
 * raise = 180s (a 126s outlier was observed in flows-registry-reset stress).
 */
export async function deleteVaultDerivedState(vaultPath: string): Promise<DeleteScaffoldResult> {
  const lytDir = join(vaultPath, ".lyt");
  if (!existsSync(lytDir)) {
    return { removedLytDir: false, lytDirPath: lytDir };
  }
  const stat = statSync(lytDir);
  if (!stat.isDirectory()) {
    throw new Error(`.lyt at ${lytDir} is not a directory; refusing to delete`);
  }
  // 🔴 L0 DESTRUCTIVE-SAFETY (2026-07 adopt-core): pattern links now live NESTED
  // under `.lyt/patterns/<name>`. On Windows these are directory JUNCTIONS
  // (`symlinkSync(master, link, "junction")`) pointing at the shared pod master
  // `~/lyt/patterns/<name>`. A recursive `rmSync(lytDir, { recursive })` MUST NOT
  // be trusted to descend-safely into a nested junction — so we EXPLICITLY
  // unlink each pattern LINK first (unlink the link, NEVER recursive-descend it),
  // BEFORE the recursive teardown of `.lyt/`. Descending a junction would wipe
  // the shared master's contents (the 2026-06-03 incident vector). We NEVER swap
  // rmSync for a shell `rm -rf`/rimraf/PowerShell — those DO follow junctions.
  unlinkNestedPatternLinks(vaultPath);
  await rmWithRetry(lytDir);
  return { removedLytDir: true, lytDirPath: lytDir };
}

// Unlink each entry under `.lyt/patterns/` treating it as a LINK, never a tree.
// - A symlink/junction (`lstatSync().isSymbolicLink()` — true for Windows
//   directory junctions too) is removed with `unlinkSync` / `rmSync(recursive:
//   false)`, which detaches the LINK and leaves the master target untouched.
// - A plain copy-fallback directory (no-admin path) is NOT a junction and is
//   left for the subsequent recursive `.lyt/` teardown — it holds no outward
//   junction, so recursively removing it is safe.
// Best-effort + fail-soft: a missing dir or a per-entry error never aborts the
// delete (the recursive teardown below is the backstop for plain dirs). The one
// thing we guarantee is that we NEVER recursive-descend a junction.
function unlinkNestedPatternLinks(vaultPath: string): void {
  // SoT (2026-07-05 release review Minor): route through getVaultPatternsLinkDir so
  // the pattern-LINK dir is computed in exactly ONE place — if the location ever
  // moves, this destructive-safety guard follows it automatically (no coupled
  // constant to drift out of lockstep).
  const patternsLinkDir = getVaultPatternsLinkDir(vaultPath);
  let entries: string[];
  try {
    if (!existsSync(patternsLinkDir)) return;
    entries = readdirSync(patternsLinkDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const linkPath = join(patternsLinkDir, name);
    try {
      const lst = lstatSync(linkPath);
      if (lst.isSymbolicLink()) {
        // Junction or symlink → detach the LINK only, NEVER recursive. A Windows
        // directory junction reports isSymbolicLink()===true but `unlinkSync`
        // EPERMs on it (unlink is file-only), so `rmSync(recursive:false)` is the
        // primary junction-detach (removes just the reparse point, leaving the
        // master target intact); `unlinkSync` is the fallback for a plain file
        // symlink. Crucially: recursive:false — we detach, we never descend.
        try {
          rmSync(linkPath, { recursive: false, force: true });
        } catch {
          unlinkSync(linkPath);
        }
      }
      // Non-symlink (plain copy-fallback dir or stray file): leave it for the
      // recursive `.lyt/` teardown — it carries no outward junction.
    } catch {
      // best-effort per entry
    }
  }
}

// Exported: flows/clone.ts
// removeFailedCloneDir reuses this exact budget rather than duplicating a
// divergent copy — a failed clone's tree can hold the same per-vault libsql
// locks this budget was raised for.
export async function rmWithRetry(path: string): Promise<void> {
  // 720 × 250ms = 180s of patience on Windows. Matches the test helper
  // rmStrict + renameRetry in tests/_helpers/fs-retry.ts AND the production
  // registry-reset.ts rmWithRetry budget. v1.C.4.2 second raise: an extreme
  // 126s outlier was observed when 3 vault dirs were rm'd back-to-back.
  // SEE ALSO: src/flows/registry-reset.ts rmWithRetry — keep budgets in sync (180s).
  // SEE ALSO: tests/_helpers/fs-retry.ts rmStrict — keep budgets in sync (180s).
  // SEE ALSO: src/flows/rename.ts renameDirWithRetry — keep budgets in sync (180s).
  // SEE ALSO: src/flows/clone.ts removeFailedCloneDir — imports THIS function (no separate budget).
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
