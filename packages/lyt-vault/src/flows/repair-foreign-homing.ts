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

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName, insertMesh } from "../registry/meshes-repo.js";
import {
  addVaultToMesh,
  listMeshesForVault,
  removeVaultFromMesh,
} from "../registry/mesh-vaults-repo.js";
import {
  listVaults,
  setVaultHomeMesh,
  updateVaultPath,
  type VaultRow,
} from "../registry/repo.js";
import { vaultLeaf, vaultOriginCoordinate } from "../registry/vault-addressing.js";
import { bucketMeshName, bucketVaultRelDir, entryModeForSource } from "../util/bucket-mesh.js";
import { slugifyHandle } from "../util/federation-paths.js";
import { canonicalizeVaultPath, getDefaultVaultsRoot } from "../util/paths.js";
import { hexToUuid7Bytes, newUuidv7Bytes, ridsEqual } from "../util/uuid7.js";
import { isGitRepo } from "../util/git-run.js";
import { parseVaultYon } from "../yon/parse.js";
import { snapshotVaultFlow } from "./snapshot.js";

// Inc-2 Phase B / IDEMPOTENT LAZY REPAIR for already-commingled foreign
// vaults. Before a foreign vault could be homed on-disk inside the user's
// own `vaults/{mesh}/…` tree (the collides-only rule only bucketed on a name
// collision). This flow relocates any foreign vault (source ∈ {shared,subscribed})
// that is sitting in the WRONG tree into its correct owner-keyed bucket home
// (`subscriptions/{owner}` | `shared/{owner}`), and heals its registry pointer +
// home mesh. Designed to be called best-effort on `sync` / `reindex --all`.
//
// SAFETY CONTRACT (MED break-risk — migration/pathing):
//   - SNAPSHOT (best-effort ADVISORY recovery aid, NOT a gate): when the vault is
//     a git repo a snapshot branch of the pre-move working tree is taken before a
//     move, as a convenience recovery point. A snapshot failure (no git identity,
//     not a repo, etc.) NEVER blocks the move — the rename is non-destructive on
//     its own; the snapshot is advisory, never a precondition.
//   - IDEMPOTENT: a vault already under its correct bucket tree is a no-op; a
//     second run relocates nothing.
//   - NO-ORPHAN: the registry pointer is only ever repointed to a directory that
//     EXISTS on disk. If the source dir is gone, or BOTH the old and new dirs
//     exist (ambiguous), the vault is SKIPPED (never left unreachable, never
//     clobbered). On a registry-only heal (the dir is already at the bucket tree)
//     the target's `.lyt/vault.yon` rid MUST match the vault's rid before we
//     repoint — so a same-owner/same-leaf collision can never point one vault at
//     another's dir.
//   - JUNCTION-SAFE: the move is a single `fs.renameSync` (a directory-entry
//     relink), which NEVER recurses into the tree — so it cannot traverse a
//     junction/symlink into a source-of-truth outside the move root (the L0
//     destructive-delete concern is a RECURSIVE-DELETE concern; rename does no
//     recursion and no delete). A write-path symlink guard additionally refuses
//     if any EXISTING component of the target's parent chain is a reparse point.

export interface RepairForeignHomingArgs {
  // Open-once seam — the flow opens its own registry when omitted.
  registryDb?: Client | undefined;
  // Test override for the vaults root the bucket tree is computed under.
  vaultsRoot?: string | undefined;
  // Snapshot-first toggle. Default TRUE (snapshot before every move). Set false
  // only in tests that deliberately exercise the non-git path.
  snapshot?: boolean | undefined;
}

export interface RelocatedForeignVault {
  vaultRidHex: string;
  name: string;
  source: "shared" | "subscribed";
  fromPath: string;
  toPath: string;
  bucketMesh: string;
  // The git snapshot branch taken before the move, or null when none could be
  // taken (not a git repo, or a registry-only heal with no move).
  snapshotBranch: string | null;
  // true = a directory was physically relocated; false = a registry-only heal
  // (the dir was already at the bucket tree; only the stale pointer was fixed).
  moved: boolean;
}

export interface RepairForeignHomingResult {
  scanned: number;
  relocated: RelocatedForeignVault[];
  skipped: { name: string; reason: string }[];
  durationMs: number;
}

// WRITE-PATH SYMLINK GUARD (standing directive). Walks from `root` (the
// vaults root, inclusive) down to the target's parent and refuses if any EXISTING
// component is a reparse point (symlink / Windows junction) — never follows it.
// A missing ancestor is fine (created fresh by our own mkdir). Mirrors the
// clone-flow guard so a bucket parent swapped for a junction can't redirect the
// move outside the vaults root.
function assertNoSymlinkOnWritePath(root: string, target: string): void {
  const rootR = resolve(root);
  const chain: string[] = [];
  let cur = resolve(dirname(target));
  for (;;) {
    chain.push(cur);
    if (cur === rootR) break;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const p of chain) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to relocate a foreign vault into ${target}: the write-path component ` +
          `${JSON.stringify(p)} is a symlink/junction. A reparse point on the target's parent ` +
          `chain could redirect the move outside the vaults root. Remove or replace the link ` +
          `with a real directory and retry.`,
      );
    }
  }
}

// extract the OWNER segment from a vault's origin coordinate. The
// coordinate is `lyt:vault:<host>/<owner>/<repo>`; the owner is the 2nd path
// segment after the `lyt:vault:` prefix. Returns null when the vault has no
// resolvable origin (a foreign vault with no coordinate cannot be owner-homed).
//
// EXPORTED (Inc-2 Phase C #6 release review R1) so the `lyt mesh prune` bucket-backing
// guard REUSES the exact owner-derivation the resurrection path (this flow's
// insertMesh bucket re-creation below) uses — the same anti-drift discipline
// coordinateOwner already gets. A prune guard that re-implemented the extractor
// could drift from repair and delete a bucket that repair then resurrects.
export function foreignVaultOwner(vault: VaultRow): string | null {
  const coord = vaultOriginCoordinate(vault);
  if (coord === null) return null;
  const TYPED_PREFIX = "lyt:vault:";
  const bare = coord.startsWith(TYPED_PREFIX) ? coord.slice(TYPED_PREFIX.length) : coord;
  const segs = bare.split("/").filter((s) => s.length > 0);
  if (segs.length < 3) return null;
  const owner = segs[1]!;
  return owner.length > 0 ? slugifyHandle(owner) : null;
}

// read the `.lyt/vault.yon` rid of an on-disk vault dir. Returns the rid
// bytes, or null if the file is absent/unparseable. Used by the registry-only
// heal branch below to CONFIRM a pre-existing bucket-tree dir actually IS this
// vault before repointing the registry at it (identity guard — never repoint one
// vault at another vault's dir on a same-owner/same-leaf collision).
function readVaultYonRid(vaultDir: string): Uint8Array | null {
  try {
    const content = readFileSync(join(vaultDir, ".lyt", "vault.yon"), "utf8");
    const parsed = parseVaultYon(content);
    return hexToUuid7Bytes(parsed.rid);
  } catch {
    return null;
  }
}

export async function repairForeignHomingFlow(
  args: RepairForeignHomingArgs = {},
): Promise<RepairForeignHomingResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  const vaultsRoot = resolve(args.vaultsRoot ?? getDefaultVaultsRoot());
  const doSnapshot = args.snapshot !== false;

  const relocated: RelocatedForeignVault[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let scanned = 0;

  try {
    const foreign = (await listVaults(db)).filter((v) => v.source !== "own");
    for (const vault of foreign) {
      scanned += 1;
      const source = vault.source as "shared" | "subscribed";

      const owner = foreignVaultOwner(vault);
      if (owner === null) {
        skipped.push({ name: vault.name, reason: "no-owner-coordinate" });
        continue;
      }

      const relDir = bucketVaultRelDir(source, owner, vaultLeaf(vault.name));
      const expectedAbs = resolve(join(vaultsRoot, relDir));
      const currentAbs = resolve(vault.path);

      // IDEMPOTENT — already correctly homed (registry points at the bucket tree).
      if (canonicalizeVaultPath(currentAbs) === canonicalizeVaultPath(expectedAbs)) {
        skipped.push({ name: vault.name, reason: "already-homed" });
        continue;
      }

      const currentExists = existsSync(currentAbs);
      const expectedExists = existsSync(expectedAbs);

      // NO-ORPHAN discriminator over the (currentExists, expectedExists) matrix:
      //   (T,T) ambiguous — both dirs present → skip (never clobber the target).
      //   (F,F) the vault dir is gone entirely → skip (never repoint at nothing).
      //   (F,T) the dir is already at the bucket tree but the registry pointer is
      //         stale → registry-only heal (no move).
      //   (T,F) the canonical case → snapshot, then move, then heal.
      if (currentExists && expectedExists) {
        skipped.push({ name: vault.name, reason: "target-exists-conflict" });
        continue;
      }
      if (!currentExists && !expectedExists) {
        skipped.push({ name: vault.name, reason: "vault-dir-missing" });
        continue;
      }

      let snapshotBranch: string | null = null;
      let moved = false;

      if (currentExists && !expectedExists) {
        // SNAPSHOT (best-effort, advisory) — a git snapshot branch of the pre-move
        // working tree. The .git moves WITH the vault on rename, so the branch
        // survives the relocation and remains a recovery point. NOT a gate.
        if (doSnapshot && (await isGitRepo(currentAbs))) {
          try {
            const snap = await snapshotVaultFlow({ name: vault.name, label: "d146-rehome" });
            snapshotBranch = snap.branch;
          } catch {
            // best-effort — a snapshot failure (no identity, etc.) does not block
            // the non-destructive rename below.
            snapshotBranch = null;
          }
        }
        // Write-path symlink guard on the target's parent chain, then claim the
        // parent and relink the directory entry (rename = no recursion, no delete).
        assertNoSymlinkOnWritePath(vaultsRoot, expectedAbs);
        mkdirSync(dirname(expectedAbs), { recursive: true });
        // EXDEV/EPERM per-vault isolation — a cross-volume rename (the bucket tree
        // on a different filesystem than the commingled dir) throws EXDEV; a
        // locked/permission-denied entry throws EPERM. Skip ONLY this vault and
        // let the pass continue for the rest. DELIBERATELY no recursive copy+delete
        // fallback: that would be a recursive delete near possibly-junctioned trees
        // (destructive-delete L0). Skip-and-log is the correct posture.
        try {
          renameSync(currentAbs, expectedAbs);
        } catch (renameErr) {
          const code = (renameErr as NodeJS.ErrnoException).code ?? "UNKNOWN";
          if (code === "EXDEV" || code === "EPERM") {
            console.warn(
              `repairForeignHomingFlow: skipping ${JSON.stringify(vault.name)} — ` +
                `cross-volume/permission rename (${code}) from ${JSON.stringify(currentAbs)} ` +
                `to ${JSON.stringify(expectedAbs)}. Relocate this vault manually; the pass continues.`,
            );
            skipped.push({ name: vault.name, reason: `move-failed-${code.toLowerCase()}` });
            continue;
          }
          throw renameErr;
        }
        moved = true;
      } else {
        // (!currentExists && expectedExists) — registry-only heal: the dir is
        // already at the bucket tree; only the stale pointer + home mesh are fixed.
        // IDENTITY GUARD (#6): we are about to repoint the registry at a
        // pre-existing dir we did NOT just create. Confirm it actually IS this
        // vault — its `.lyt/vault.yon` rid must match. A same-owner/same-leaf
        // collision (two vaults resolving to the SAME bucket relDir) would
        // otherwise repoint/alias one vault at another's directory. On mismatch or
        // unreadable vault.yon, SKIP (never repoint at a foreign/unverifiable dir).
        const targetRid = readVaultYonRid(expectedAbs);
        if (targetRid === null || !ridsEqual(targetRid, vault.rid)) {
          console.warn(
            `repairForeignHomingFlow: skipping ${JSON.stringify(vault.name)} — the bucket-tree ` +
              `dir ${JSON.stringify(expectedAbs)} does not carry this vault's rid in its ` +
              `.lyt/vault.yon (rid mismatch or unreadable). Not repointing one vault at another's dir.`,
          );
          skipped.push({ name: vault.name, reason: "target-rid-mismatch" });
          continue;
        }
      }

      // Ensure the reserved owner-bucket mesh exists, then rehome + repoint under
      // one txn so the vault never lands half-homed. removeVaultFromMesh clears
      // any prior home-role membership first (the one-home-per-vault partial
      // unique index forbids a second home row).
      const bucketMesh = bucketMeshName(entryModeForSource(source), owner);
      let bucket = await getMeshByName(db, bucketMesh);
      if (bucket === null) {
        await insertMesh(db, { rid: newUuidv7Bytes(), name: bucketMesh, pushTarget: null, pushKind: null });
        bucket = await getMeshByName(db, bucketMesh);
      }
      if (bucket === null) {
        skipped.push({ name: vault.name, reason: "bucket-mesh-unresolved" });
        continue;
      }

      await db.execute("BEGIN");
      try {
        const homeRows = (await listMeshesForVault(db, vault.rid)).filter((r) => r.role === "home");
        for (const h of homeRows) {
          if (!ridsEqual(h.meshRid, bucket.rid)) await removeVaultFromMesh(db, h.meshRid, vault.rid);
        }
        await setVaultHomeMesh(db, vault.rid, bucket.rid);
        await addVaultToMesh(db, bucket.rid, vault.rid, "home");
        await updateVaultPath(db, vault.rid, expectedAbs);
        await db.execute("COMMIT");
      } catch (innerErr) {
        try {
          await db.execute("ROLLBACK");
        } catch {
          /* best-effort */
        }
        throw innerErr;
      }

      relocated.push({
        vaultRidHex: vault.ridHex,
        name: vault.name,
        source,
        fromPath: currentAbs,
        toPath: expectedAbs,
        bucketMesh,
        snapshotBranch,
        moved,
      });
    }

    return {
      scanned,
      relocated,
      skipped,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
