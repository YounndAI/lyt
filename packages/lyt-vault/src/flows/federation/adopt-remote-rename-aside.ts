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

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { listVaults } from "../../registry/repo.js";
import { renameWithRetry } from "../../registry/vault-db.js";
import { getLytHome, validateLytHome } from "../../util/paths.js";
import {
  listNestedReparsePoints,
  stripNestedReparsePoints,
} from "../../util/reparse-safe.js";
import type { FederationGhClient } from "../../util/gh-federation.js";
import { adoptAndPrimeFlow, type AdoptAndPrimeResult } from "../adopt-and-prime.js";
import type { RecoverDrop, VaultCloneFn } from "./recover-pod.js";
import { relinkAllPatternsForVault } from "../pattern-relink-vault.js";

// 🔴 Phase C — the rename-aside ACTIONABLE connect path (B4). L0
// DESTRUCTIVE-DELETE TERRITORY. This is the one novel, load-bearing piece the
// design flags for a mandatory ≥3-POV release review: it renames the user's WHOLE
// LYT_HOME (~/lyt/ — the notes + manifest + pattern SoT, three junction-bound
// sibling trees) aside as a backup, strips that backup's junctions so a later
// delete of it can never traverse back into the fresh pattern SoT, then adopts
// the remote pod fresh. One wrong filesystem op destroys a user's notes.
//
// Flow (design §Flow, amendments 1/2/5 locked):
//  1. L0 — enumerate reparse points under ~/lyt/ BEFORE any rename (pre-check).
//  2. Back up — rename the WHOLE ~/lyt/ → ~/lyt-backup-<ts>/ as ONE atomic
//     same-volume rename (amendment 1). Verify it completed.
//  3. 🔴 Strip the backup's junctions IMMEDIATELY (amendment 2, mandatory L0) —
//     detach every reparse point inside the backup so it becomes pure inert
//     files. WHY: step 4 recreates ~/lyt/patterns; the backup's ABSOLUTE
//     junctions (~/lyt-backup/vaults/*/.lyt/patterns → ~/lyt/patterns) would
//     otherwise resolve to the NEW SoT, so a later `rm -rf ~/lyt-backup` would
//     traverse into and destroy the fresh pattern store. Stripping first makes
//     the backup safe to keep OR delete.
//  4. Adopt the remote fresh — clone the remote pod into a clean ~/lyt/ and
//     recover its vaults (adoptAndPrimeFlow → recoverVaultsFromPodManifest),
//     collision-free now the old home is renamed aside. Relink pattern
//     junctions for the fresh vaults (per-machine, gitignored).
//  5. Hand off the merge — connect's automated job ENDS here. Point the handler
//     at ~/lyt-backup-<ts>/vaults/ as plain files + the Obsidian-import funnel
//     (amendment 3: REUSE the funnel, do NOT build a bespoke connect-merge).
//
// Restore-on-failure: if the fresh adopt fails AFTER the rename, roll back —
// strip the partial fresh home's junctions, remove it, and rename the backup
// back into place so the local pod is intact (with a note to `lyt repair` any
// pattern junctions the strip removed).
//
// DB-LOCK PRECONDITION: the rename of ~/lyt/ must run with NO open libSQL handle
// under it (a Windows directory rename fails on a locked file). The caller MUST
// have closed connectPodFlow's registry BEFORE invoking this flow. This flow
// opens no registry before the rename; adoptAndPrimeFlow opens+closes its own
// fresh registry under the new home.

export type RenameAsideStatus =
  // Full success: home backed up + stripped + remote adopted fresh.
  | "adopted"
  // A step AFTER the rename failed → the backup was renamed back; local pod intact.
  | "restored"
  // Failed BEFORE/AT the rename (nothing moved) → local pod untouched.
  | "aborted";

export interface AdoptRemoteRenameAsideArgs {
  // The real gh handle whose remote pod is being adopted (from connectPodFlow).
  realHandle: string;
  // The existing remote full name (e.g. "allemaar/lyt-pod"), for the handoff.
  existingRemote: string;
  // Test seam — fix the backup-dir timestamp (default: now).
  nowMs?: number | undefined;
  // Test seam — override the fresh-adopt engine (default: adoptAndPrimeFlow).
  runAdopt?: ((handle: string) => Promise<AdoptAndPrimeResult>) | undefined;
  // Test seam — observe each junction the strip pass detaches from the backup.
  onDetach?: ((linkPath: string) => void) | undefined;
  // Injectable seams threaded to the default adopt engine (real CLI uses
  // defaults; tests pass fakes so no network/gh is required).
  federationGhClient?: FederationGhClient | undefined;
  vaultCloneFn?: VaultCloneFn | undefined;
  skipDiscover?: boolean | undefined;
  skipReconcile?: boolean | undefined;
}

export interface AdoptRemoteRenameAsideResult {
  status: RenameAsideStatus;
  lytHome: string;
  backupPath: string | null;
  // L0 enumeration of reparse points under ~/lyt/ taken BEFORE the rename.
  reparsePointsBeforeRename: string[];
  // The junctions the mandatory strip pass detached from the backup.
  junctionsStripped: string[];
  // Reparse points STILL under the backup after the strip — MUST be [] on
  // success (the load-bearing safety assertion: a stripped backup is inert).
  reparsePointsAfterStrip: string[];
  // Vaults recovered into the fresh home (from the remote pod.yon).
  vaultsRecovered: number;
  // G1 parity (a review finding/R3) — vaults the reconstruction clone-walk DROPPED. Mirrors
  // the wizard path: a non-empty list means the fresh adopt is INCOMPLETE, and
  // the `lyt sync (connect)` command surfaces it loudly + exits nonzero
  // (reconstructionExitCode) rather than reporting a clean "adopted". [] on a
  // clean adopt / any pre-adopt abort.
  manifestDrops: RecoverDrop[];
  // Pattern-junction relinks attempted on the fresh vaults.
  patternsRelinked: number;
  handoffMessage: string;
  warnings: string[];
  error?: string;
}

// Compact UTC stamp `YYYYMMDDTHHMMSSZ` — colon-free (Windows path-safe) and
// sortable. Mirrors the pattern-heal backup stamp.
function compactStamp(nowMs: number | undefined): string {
  const d = nowMs !== undefined ? new Date(nowMs) : new Date();
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function adoptRemoteRenameAsideFlow(
  args: AdoptRemoteRenameAsideArgs,
): Promise<AdoptRemoteRenameAsideResult> {
  const warnings: string[] = [];
  const lytHome = getLytHome();

  const fail = (
    status: RenameAsideStatus,
    partial: Partial<AdoptRemoteRenameAsideResult>,
  ): AdoptRemoteRenameAsideResult => ({
    status,
    lytHome,
    backupPath: null,
    reparsePointsBeforeRename: [],
    junctionsStripped: [],
    reparsePointsAfterStrip: [],
    vaultsRecovered: 0,
    manifestDrops: [],
    patternsRelinked: 0,
    handoffMessage: "",
    warnings,
    ...partial,
  });

  // Safety floor: refuse a destructive op against a non-lyt-shaped home / the
  // filesystem root / the user's home dir (validateLytHome throws on those).
  try {
    validateLytHome(lytHome);
  } catch (err) {
    return fail("aborted", { error: errMsg(err) });
  }

  if (!existsSync(lytHome)) {
    return fail("aborted", {
      error: `No Lyt home at ${lytHome} to back up — nothing to connect.`,
    });
  }

  // 1. L0 — enumerate reparse points BEFORE any rename (pre-check + report).
  const reparsePointsBeforeRename = listNestedReparsePoints(lytHome);

  // 2. Compute the backup path (a SIBLING of ~/lyt/, so the rename is same-
  // volume + atomic). Refuse to clobber an existing backup dir.
  const backupPath = join(dirname(lytHome), `${basename(lytHome)}-backup-${compactStamp(args.nowMs)}`);
  if (existsSync(backupPath)) {
    return fail("aborted", {
      reparsePointsBeforeRename,
      error: `Backup path ${backupPath} already exists — refusing to overwrite it.`,
    });
  }

  // 3. Back up — ONE atomic same-volume rename of the WHOLE home. On failure the
  // home is untouched (a rename is all-or-nothing). C-2 — via renameWithRetry so
  // a lingering libSQL handle under ~/lyt/ (connectPodFlow just closed its
  // registry; Windows holds the handle briefly post-close) retries for up to 10s
  // rather than EBUSY-aborting a healthy backup.
  let backedUp: boolean;
  try {
    backedUp = await renameWithRetry(lytHome, backupPath);
  } catch (err) {
    return fail("aborted", {
      reparsePointsBeforeRename,
      error: `Couldn't back up your Lyt home (${errMsg(err)}) — nothing was moved; your notes are untouched.`,
    });
  }
  // A `false` return = the lock-retry budget exhausted (home still in use). The
  // rename never happened, so the home is untouched — abort cleanly.
  if (!backedUp) {
    return fail("aborted", {
      reparsePointsBeforeRename,
      error: `Couldn't back up your Lyt home — it's still in use after retrying; nothing was moved; your notes are untouched.`,
    });
  }
  // Verify the rename completed before proceeding (defensive; a rename either
  // fully succeeds or throws above, but the L0 requires an explicit check).
  if (!existsSync(backupPath) || existsSync(lytHome)) {
    // Best-effort undo if the source somehow survived.
    try {
      if (existsSync(backupPath) && !existsSync(lytHome)) await renameWithRetry(backupPath, lytHome);
    } catch {
      /* fail-soft */
    }
    return fail("aborted", {
      reparsePointsBeforeRename,
      error: `Backup rename did not complete cleanly — aborted without touching your notes.`,
    });
  }

  // 4. 🔴 Strip the backup's junctions IMMEDIATELY (mandatory L0). Detach every
  // reparse point inside the backup so it is pure inert files — a later delete
  // of the backup can then NEVER traverse an absolute junction back into the
  // fresh ~/lyt/patterns SoT that step 5 recreates.
  const junctionsStripped: string[] = [];
  stripNestedReparsePoints(backupPath, {
    onDetach: (p) => {
      junctionsStripped.push(p);
      args.onDetach?.(p);
    },
  });
  // The load-bearing safety assertion: the backup now carries NO reparse points.
  const reparsePointsAfterStrip = listNestedReparsePoints(backupPath);
  if (reparsePointsAfterStrip.length > 0) {
    // A junction survived the strip — the backup is NOT safe to keep near the
    // fresh SoT. Roll back rather than proceed into an unsafe state.
    try {
      await renameWithRetry(backupPath, lytHome);
    } catch {
      warnings.push(
        `Couldn't automatically restore your Lyt home after an incomplete backup-strip — ` +
          `your notes are at ${backupPath}. Run 'lyt doctor'.`,
      );
    }
    return fail("aborted", {
      reparsePointsBeforeRename,
      junctionsStripped,
      reparsePointsAfterStrip,
      backupPath: existsSync(backupPath) ? backupPath : null,
      error: `Couldn't fully detach the backup's links — aborted for safety; your notes are intact.`,
    });
  }

  // 5. Adopt the remote fresh into a clean ~/lyt/.
  let adopt: AdoptAndPrimeResult;
  try {
    // C-2 — mkdir the fresh home INSIDE the guarded try. Previously it sat
    // OUTSIDE, so an EPERM/EACCES/etc. throw here (the home was already renamed
    // aside) escaped the flow WITHOUT restoring the backup — stranding the user's
    // notes as a `lyt-backup-*` folder with no handoff. Now a mkdir throw routes
    // to restoreFromBackup exactly like an adopt throw.
    mkdirSync(lytHome, { recursive: true });
    if (args.runAdopt !== undefined) {
      adopt = await args.runAdopt(args.realHandle);
    } else {
      adopt = await adoptAndPrimeFlow({
        handle: args.realHandle,
        ...(args.federationGhClient !== undefined
          ? { federationGhClient: args.federationGhClient }
          : {}),
        ...(args.vaultCloneFn !== undefined ? { vaultCloneFn: args.vaultCloneFn } : {}),
        ...(args.skipDiscover !== undefined ? { skipDiscover: args.skipDiscover } : {}),
        ...(args.skipReconcile !== undefined ? { skipReconcile: args.skipReconcile } : {}),
      });
    }
  } catch (err) {
    // Restore-on-failure: the rename SUCCEEDED but the fresh adopt failed. Roll
    // back so the local pod is intact. First L0-strip the partial fresh home's
    // junctions (adopt may have relinked some), remove it, then rename the
    // backup back into place.
    return await restoreFromBackup(lytHome, backupPath, reparsePointsBeforeRename, junctionsStripped, warnings, errMsg(err));
  }

  // A structured recovery refusal is a failed adopt, not success. Restore the
  // renamed local pod and relay the source-generated, kind-specific remedy.
  if (adopt.manifestRefused === true) {
    const refusedReason =
      `Pod reconstruction refused; no vault cloned. ` +
      `${adopt.manifestRefusedReason ?? ""}`.trimEnd();
    return await restoreFromBackup(
      lytHome,
      backupPath,
      reparsePointsBeforeRename,
      junctionsStripped,
      warnings,
      refusedReason,
    );
  }

  // Relink pattern junctions for the fresh vaults (design step 5; per-machine,
  // gitignored). Best-effort — a relink miss degrades to a `lyt repair` hint,
  // never fails the adopt.
  let patternsRelinked = 0;
  try {
    const db = await openRegistry();
    try {
      const vaults = await listVaults(db);
      for (const v of vaults) {
        if (v.status === "tombstoned") continue;
        try {
          await relinkAllPatternsForVault(v.name);
          patternsRelinked += 1;
        } catch {
          /* best-effort per vault */
        }
      }
    } finally {
      await closeRegistry(db);
    }
  } catch (err) {
    warnings.push(
      `Adopted your team pod, but couldn't relink every pattern shortcut (${errMsg(err)}) — run 'lyt repair' if patterns look missing.`,
    );
  }

  const backupVaults = join(backupPath, "vaults");
  const handoffMessage =
    `Connected to your team pod (${args.existingRemote}). Your PREVIOUS notes are safely backed up as plain ` +
    `files at ${backupVaults} — nothing was deleted. To bring them into your now-connected pod, use Lyt's ` +
    `Obsidian-import funnel: for each backed-up vault, import its notes as a new vault or merge them into the ` +
    `matching one. Want help importing them?`;

  // G1 parity (a review finding/R3) — the fresh adopt may have DROPPED vaults during the
  // clone-walk (the recover-pod flow already console.error'd the classified
  // per-vault summary). Surface it in the structured result + a loud warning so
  // the `lyt sync (connect)` command reports an INCOMPLETE reconstruction and
  // exits nonzero, exactly like the wizard path — never a silent clean "adopted".
  const manifestDrops = adopt.manifestDrops ?? [];
  if (manifestDrops.length > 0) {
    warnings.push(
      `Reconstruction INCOMPLETE — dropped ${manifestDrops.length} vault(s) during the ` +
        `clone-walk: ${manifestDrops.map((d) => d.vaultName).join(", ")}. See the per-vault ` +
        `classification above (owner-misresolved = bug; repo-moved-or-deleted = state).`,
    );
  }

  return {
    status: "adopted",
    lytHome,
    backupPath,
    reparsePointsBeforeRename,
    junctionsStripped,
    reparsePointsAfterStrip,
    vaultsRecovered: adopt.vaultsRecoveredFromManifest,
    manifestDrops,
    patternsRelinked,
    handoffMessage,
    warnings,
  };
}

// Roll the whole-home rename back after a post-rename failure: strip the partial
// fresh home's junctions (L0 — adopt may have relinked some), remove it, then
// rename the backup back into place.
async function restoreFromBackup(
  lytHome: string,
  backupPath: string,
  reparsePointsBeforeRename: string[],
  junctionsStripped: string[],
  warnings: string[],
  adoptError: string,
): Promise<AdoptRemoteRenameAsideResult> {
  try {
    if (existsSync(lytHome)) {
      // L0 — detach any junction the partial adopt created before the recursive
      // teardown, so the rm can never traverse a link out of the fresh home.
      stripNestedReparsePoints(lytHome);
      // C-2 — the teardown of the partial fresh home may EBUSY on a lingering
      // libSQL handle (adoptAndPrimeFlow opened+closed its own registry under
      // it); retry on the same budget rather than throwing mid-restore.
      await rmDirWithRetry(lytHome);
    }
    // C-2 — the load-bearing restore rename, via the retry budget.
    await renameWithRetry(backupPath, lytHome);
  } catch (err) {
    warnings.push(
      `Couldn't automatically restore your Lyt home (${errMsg(err)}) — your notes are safe at ${backupPath}. Run 'lyt doctor'.`,
    );
    return {
      status: "aborted",
      lytHome,
      backupPath: existsSync(backupPath) ? backupPath : null,
      reparsePointsBeforeRename,
      junctionsStripped,
      reparsePointsAfterStrip: [],
      vaultsRecovered: 0,
      manifestDrops: [],
      patternsRelinked: 0,
      handoffMessage: "",
      warnings,
      error: `Adopt failed (${adoptError}) and automatic restore also failed.`,
    };
  }
  warnings.push(
    `Note: the restored home's per-machine pattern shortcuts were removed during backup and not rebuilt — run 'lyt repair' to relink them.`,
  );
  return {
    status: "restored",
    lytHome,
    backupPath: null,
    reparsePointsBeforeRename,
    junctionsStripped,
    reparsePointsAfterStrip: [],
    vaultsRecovered: 0,
    manifestDrops: [],
    patternsRelinked: 0,
    handoffMessage:
      `Couldn't finish connecting to the team pod (${adoptError}). Your local pod was restored unchanged — ` +
      `nothing was lost. You can try again later.`,
    warnings,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Phase C (C-2) — EBUSY/EPERM retry for the restore-path `rmSync` of the partial
// fresh home. Mirrors renameWithRetry's win32 budget (40 × 250ms = 10s) so a
// lingering libSQL handle under the freshly-adopted home (adoptAndPrimeFlow
// opened+closed its own registry) can't make the restore teardown throw and
// leave the home un-restorable. Non-lock errors propagate; ENOENT is success.
// The tree has already had its reparse points stripped by the caller, so this
// recursive rm is junction-safe (destructive-delete L0).
async function rmDirWithRetry(target: string): Promise<void> {
  const attempts = process.platform === "win32" ? 40 : 5;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw err;
      await sleep(250);
    }
  }
  // Budget exhausted — fall through; the caller's catch surfaces the failure as
  // a fail-soft warning + a `lyt doctor` pointer (never a crash).
  rmSync(target, { recursive: true, force: true });
}
