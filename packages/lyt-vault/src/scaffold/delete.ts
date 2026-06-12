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

import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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
  await rmWithRetry(lytDir);
  return { removedLytDir: true, lytDirPath: lytDir };
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
