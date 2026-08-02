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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// 0.20.17 — PROOF THAT A CLONE ACTUALLY LANDED ITS CONTENT.
//
// The receive paths used to treat the mere presence of `.lyt/vault.yon` as
// proof that a vault had been cloned. It is not. `git clone` can fail PART WAY
// THROUGH CHECKOUT — on Windows a long path yields a per-file
// "unable to create file ...: Filename too long" and git exits non-zero having
// already written the `.git` dir and whatever files it managed — and a later
// retry, seeing the marker file present, SKIPPED the clone and registered the
// incomplete worktree. Observed live: 16 vaults registered, content missing.
//
// This is NOT a Windows-specific hazard. Any interrupted clone reaches the same
// state: a dropped connection, a full disk, a cancelled command. Windows long
// paths were merely the reproducible trigger.
//
// The discriminator is git's own view of the worktree: after a successful
// checkout every tracked file exists, so `git status --porcelain` reports
// nothing deleted. A checkout that failed part way leaves tracked files missing,
// which git reports as deletions. A tracked deletion proves content is absent,
// but it does not prove why: the same status can represent a legitimate local
// edit. Callers may refuse registration on this signal, but must not use it as
// authority to delete a pre-existing tree.

export type CheckoutCompleteness =
  | { complete: true }
  | { complete: false; reason: string };

// Returns whether `vaultPath` holds a COMPLETE git checkout. Fails closed: if
// the state cannot be established, the answer is "not complete" with the reason,
// because the caller's next step is registering the vault as real.
export function inspectCheckoutCompleteness(vaultPath: string): CheckoutCompleteness {
  if (!existsSync(vaultPath)) {
    return { complete: false, reason: "the directory does not exist" };
  }
  if (!existsSync(join(vaultPath, ".git"))) {
    return { complete: false, reason: "the directory is not a git repository (no .git)" };
  }

  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
      cwd: vaultPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { complete: false, reason: `git could not report worktree state: ${msg}` };
  }

  // A tracked file that git expected to write and could not shows as deleted.
  // Porcelain v1 puts the worktree column second (" D path"); a staged delete
  // ("D  path") would also mean content is absent from the tree. Either way the
  // checkout cannot be proven complete, so match a 'D' in the first two columns.
  const missing = porcelain
    .split("\n")
    .filter((line) => line.length > 2 && (line[0] === "D" || line[1] === "D"))
    .map((line) => line.slice(3).trim());

  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join(", ");
    const more = missing.length > 3 ? ` (and ${missing.length - 3} more)` : "";
    return {
      complete: false,
      reason: `the checkout is incomplete — ${missing.length} tracked file(s) never landed: ${shown}${more}`,
    };
  }

  return { complete: true };
}
