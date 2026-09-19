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

import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { Client } from "@libsql/client";

import { addKnownPath } from "../registry/known-paths.js";
import {
  addVaultToMesh,
  listMeshesForVault,
  removeVaultFromMesh,
} from "../registry/mesh-vaults-repo.js";
import { ensureBucketMesh, getMeshByName, getMeshByRid } from "../registry/meshes-repo.js";
import { upsertVault, type VaultSource, type VaultStatus } from "../registry/repo.js";
import { parseBucketRelDir, type ParsedBucketRelDir } from "../util/bucket-mesh.js";
import { readGitRemoteOriginUrl } from "../util/git.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { hexToUuid7Bytes, ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { parseVaultYon } from "../yon/parse.js";

export interface RegisterVaultArgs {
  vaultPath: string;
  status?: VaultStatus;
  // The pod manifest is the cross-machine identity source during a trusted
  // reconstruction. Its rid can differ from stale vault.yon metadata in an
  // older repository, so recover-pod supplies the manifest rid explicitly.
  // Other registration paths continue to use vault.yon.
  ridOverride?: Uint8Array | undefined;
  // fed-v2 Layer-2 P1 — identity-preserving restore capability. When
  // true, a re-registration of a rid ALREADY held locally under the SAME name
  // may re-home it to a new on-disk path (genuine cross-machine reconstitution:
  // recover-pod / rebuild re-point an existing vault to a new location). This
  // NEVER relaxes the name-mismatch refusal: a clone whose vault.yon asserts a
  // rid owned by a DIFFERENT-named local vault is refused regardless (the
  // load-bearing impersonation defense). Default false: only re-mint / brand-new
  // (clone, adopt, init, join, mesh-*) and perfectly-idempotent re-registers
  // pass. Set true ONLY on the genuine restore axis. NOTE: a no-op today —
  // upsertVault (:267) `void`s the flag; pre-wired for the P5 same-name-arm gate.
  trustedReconstruction?: boolean | undefined;
  // fix-pass (final review) — FROM-DISK RECONSTRUCTION AUTHORITY, and the
  // ONLY key that opens the owner-bucket arm below. It is DISTINCT from
  // `trustedReconstruction` (which is relocation authority: permission to
  // re-point an already-registered identity at a new path) because the two
  // authorities are not the same claim and their caller sets differ.
  //
  // `lyt vault join <path>` is a USER-driven registration and legitimately
  // carries relocation authority; it must NEVER carry this one. Gating the
  // bucket arm on `trustedReconstruction` meant `lyt vault join
  // <vaultsRoot>/shared/<owner>/<leaf>` on the user's OWN vault inserted it as
  // source='shared' inside a minted system bucket mesh — and `source` is STICKY
  // (registry/repo.ts upsert omits it ON CONFLICT), so the mislabel never
  // self-corrected.
  //
  // Passed by EXACTLY three callers, all of which re-derive rows from a
  // directory tree THIS pod's receive path wrote: flows/rebuild.ts (registry
  // rebuild), flows/repair-foreign-homing.ts (the stranded-vault heal) and
  // flows/federation/recover-pod.ts. join / adopt / init / mesh-init / mesh-join
  // never pass it and therefore keep the pre-D147 rid/name-fallback behaviour.
  fromDiskReconstruction?: boolean | undefined;
  // (Phase-0 A2b, CRIT-1) — registry-side home-mesh REBIND. When set, the
  // vault is homed into THIS local mesh rid instead of the one its (untrusted,
  // publisher-authored) `.lyt/vault.yon` @VAULT_HOME_MESH declares. The
  // preserve-rid subscribe/adopt clone keeps the publisher's committed vault.yon
  // BYTE-UNCHANGED (its @VAULT_HOME_MESH is the PUBLISHER's view of its own
  // mesh, whose rid is NOT registered on the subscriber's machine), while the
  // subscriber's registry legitimately files the vault under the LOCAL target
  // mesh (the `--to-mesh` target). The FK guard below then checks THIS rid —
  // which exists locally — instead of the publisher's foreign mesh rid, so
  // `lyt mesh adopt` no longer hard-breaks with VaultHomeMeshNotRegisteredError.
  homeMeshRidOverride?: Uint8Array | undefined;
  // Inc-2 Phase B / own-vs-clone provenance for the FRESH-INSERT arm.
  // Omitted → fail-closed 'own' (init / adopt / graduate-a-template clone /
  // `lyt vault join`). The foreign clone-on-subscribe / mesh-adopt member paths
  // pass 'subscribed' so the received vault is positively marked a clone. On a
  // re-register (ON CONFLICT) upsertVault PRESERVES the existing provenance —
  // this only sets it on the first INSERT.
  source?: VaultSource | undefined;
}

export interface RegisteredVault {
  rid: Uint8Array;
  ridHex: string;
  name: string;
  path: string;
}

// hardening pass (subscriber-onboarding fix-pass, 2026-06-11) — registering a
// vault whose vault.yon declares a home mesh with no local `meshes` row used
// to die inside the INSERT with a raw SQLITE_CONSTRAINT_FOREIGNKEY
// (vaults.home_mesh_rid FK). Both live caller paths share this chokepoint:
// `lyt vault clone <url>` (default path, via joinVaultFlow) and
// `lyt vault join <path>` on a clone whose home mesh is foreign. Guard the FK
// at the flow boundary with an actionable refusal naming the missing mesh +
// the remedy verbs (the hardening pass AddEdgeParentNotRegisteredError precedent shape).
export class VaultHomeMeshNotRegisteredError extends Error {
  readonly errorCode = "vault-home-mesh-not-registered";
  readonly meshName: string;
  readonly meshRidHex: string;
  readonly vaultName: string;
  // true when the vault sits inside a reserved FOREIGN owner-bucket tree
  // (`subscriptions/{owner}/{leaf}` | `shared/{owner}/{leaf}`). The declared
  // home mesh is then the PUBLISHER's claim about its OWN mesh, and scaffolding
  // it locally is precisely the wrong remedy — it mints a plain mesh named after
  // another owner's and commingles a foreign vault into it.
  readonly bucketHomed: boolean;
  constructor(vaultName: string, meshName: string, meshRidHex: string, bucketHomed = false) {
    super(
      `lyt vault register: vault '${vaultName}' declares home mesh '${meshName}' ` +
        `(mesh:${meshRidHex}), which is not a registered mesh on this machine. ` +
        (bucketHomed
          ? `This vault lives in a reserved foreign bucket directory, so ` +
            `'${meshName}' is the PUBLISHER's own mesh name, not yours — never ` +
            `scaffold it locally. Run 'lyt repair --apply' to re-register it under ` +
            `its owner bucket mesh. ` +
            // fix-pass (cold review) - scope the remedy honestly: the heal
            // only INSERTS a missing row (`source` is set on the fresh insert
            // only; upsertVault never updates it ON CONFLICT).
            `That heal restores a MISSING registry row only - it does NOT correct ` +
            `a row already recorded as source='own'; re-receive that vault ` +
            `('lyt vault forget <name>', then 'lyt mesh subscribe' / ` +
            `'lyt vault accept-share') to reset its provenance.`
          : `To consume another owner's vault, run ` +
            `'lyt mesh subscribe --vault ${vaultName} --from-mesh <your-mesh>' ` +
            `(registers the external mesh record automatically), or re-clone it into ` +
            `one of your own meshes with 'lyt vault clone <url> --to-mesh <local-mesh>'. ` +
            `Run 'lyt mesh init ${meshName}' only if '${meshName}' is YOUR mesh — ` +
            `never scaffold another owner's mesh locally.`),
    );
    this.name = "VaultHomeMeshNotRegisteredError";
    this.meshName = meshName;
    this.meshRidHex = meshRidHex;
    this.vaultName = vaultName;
    this.bucketHomed = bucketHomed;
  }
}

export async function registerVaultFromYon(
  db: Client,
  args: RegisterVaultArgs,
): Promise<RegisteredVault> {
  const absPath = resolve(args.vaultPath);
  // RECEIVER-SIDE coordinates recovered from the on-disk LOCATION, before
  // anything is read out of the (publisher-authored, untrusted) vault.yon. See
  // `bucketHomingFor` below for why the path is the authority here.
  //
  // fix-pass (final review) — GATED on `fromDiskReconstruction`, NOT on
  // `trustedReconstruction`. Path shape ALONE is not sufficient authority to mark
  // a vault foreign: `flows/adopt.ts` and `flows/init.ts` call this with a bare
  // `vaultPath`, and `lyt vault join` calls it with RELOCATION authority — so a
  // user who joins/adopts/inits a vault at `<vaultsRoot>/shared/x/y` would
  // otherwise have an OWN vault inserted as `source='shared'` and homed into a
  // system bucket mesh, and `source` is STICKY (registry/repo.ts upsert omits it
  // ON CONFLICT) so that mislabel would never self-correct. Only the three
  // FROM-DISK reconstruction callers (registry rebuild, the stranded-vault heal,
  // recover-pod) pass `fromDiskReconstruction: true`; those are exactly the
  // callers whose input directory WAS written by this pod's receive path. Every
  // other caller keeps the pre-D147 rid/name-fallback behaviour.
  const bucketHoming =
    args.fromDiskReconstruction === true ? bucketHomingFor(absPath) : null;
  const yonPath = join(absPath, ".lyt", "vault.yon");
  const content = readFileSync(yonPath, "utf8");
  const parsed = parseVaultYon(content);

  if (args.ridOverride !== undefined && args.trustedReconstruction !== true) {
    throw new Error("ridOverride is restricted to trusted reconstruction flows");
  }

  // Per Phase 5.5 smoke Observation #1: fall back to .git/config remote.origin.url
  // when vault.yon was written before the remote was added (the init→push→clone
  // workflow leaves vault.yon's @META git_url empty even though the remote exists).
  const gitUrl = parsed.gitUrl ?? readGitRemoteOriginUrl(absPath);

  // v1.A.1b boundary: vault.yon serialises rid as the 8-4-4-4-12 dashed
  // UUIDv7 string; parser returns it as a string; flip to bytes here at the
  // edge so the registry/repo CRUD only sees Uint8Array rids.
  const ridBytes = args.ridOverride ?? hexToUuid7Bytes(parsed.rid);
  const memscopeBytes = parsed.memscopeRid ? hexToUuid7Bytes(parsed.memscopeRid) : null;
  const parentBytes = parsed.parentVault ? hexToUuid7Bytes(parsed.parentVault) : null;
  // v1.B.3 — when vault.yon carries a @VAULT_HOME_MESH record, prime
  // vaults.home_mesh_rid from the parsed rid. FK requires the meshes row
  // exists; callers (flows/init.ts auto-personal branch, flows/clone.ts
  // --to-mesh, flows/move.ts) ensure the mesh is registered BEFORE this
  // call. Absence (pre-v1.B.3 vault.yons; vaults bound to no mesh) → null.
  const parsedHomeMeshBytes = parsed.homeMesh ? hexToUuid7Bytes(parsed.homeMesh.meshRid) : null;

  // Resolve the home-mesh rid to file under, guarding the vaults.home_mesh_rid FK
  // BEFORE the insert. Without this guard, clone/join on a vault with a foreign
  // (unregistered) home mesh surfaces a raw SQLITE_CONSTRAINT_FOREIGNKEY.
  //
  // Precedence : homeMeshRidOverride ?? (rid-match ?? name-fallback).
  let homeMeshBytes: Uint8Array | null;
  // Final review — set ONLY when the owner-bucket arm below resolved the home
  // mesh. The bucket arm mints the bucket mesh itself, so it also owes the
  // mesh-side view of that binding (the `mesh_vaults` role='home' row) — the
  // stranded-vault heal already writes it, and without it a registry rebuild
  // produced a bucket mesh whose `listVaultsInMesh` was empty.
  let bucketHomeMeshRid: Uint8Array | null = null;
  if (args.homeMeshRidOverride !== undefined) {
    // (CRIT-1) — a caller-supplied override (the LOCAL `--to-mesh` target,
    // meshRow.rid) wins over the publisher's declared @VAULT_HOME_MESH rid. The
    // preserve-rid subscribe/adopt clone passes it so the vault is filed under a
    // mesh that exists locally, while the committed vault.yon stays byte-unchanged.
    // The caller GUARANTEES this local mesh exists; guard it directly (no
    // name-fallback — the caller already resolved the local target).
    homeMeshBytes = args.homeMeshRidOverride;
    if ((await getMeshByRid(db, homeMeshBytes)) === null) {
      throw new VaultHomeMeshNotRegisteredError(
        parsed.name,
        parsed.homeMesh?.meshName ?? "<local-target-mesh>",
        uuid7BytesToHex(homeMeshBytes),
        bucketHoming !== null,
      );
    }
  } else if (bucketHoming !== null) {
    // BUCKET-HOMED FOREIGN VAULT, re-derived FROM DISK (registry rebuild,
    // the stranded-vault heal, recover-pod) with NO caller override. `lyt vault
    // join` is NOT one of these callers: it is a user-driven registration and
    // never passes `fromDiskReconstruction`.
    //
    // The vault was received via subscribe / accept-share, cloned with
    // `preserveRid` into `<vaultsRoot>/<subscriptions|shared>/{owner}/{leaf}`, and
    // its committed `.lyt/vault.yon` was deliberately left BYTE-UNCHANGED (
    // clean-tree contract). That file therefore states the PUBLISHER's
    // `@VAULT_HOME_MESH mesh_name` — a claim about the PUBLISHER's own mesh. Both
    // remaining fallbacks are wrong for it:
    //   - the rid lookup MISSES (the publisher's mesh rid is not local); and
    //   - the by-NAME fallback would home a foreign `personal/main` into the
    //     RECEIVER's own `personal` mesh (the live commingling defect), or, with
    //     no same-named mesh, throw and invite the user to `lyt mesh init
    //     <publisher-mesh>` — minting a plain mesh named after another owner's.
    //
    // The on-disk LOCATION is the receiver-owned fact that survived: it is
    // exactly the tree the receive path chose, derived from the SAME
    // bucket-mesh.ts rules. So reconstruct the receiver's coordinates from it —
    // home mesh `<subscriptions|shared>/{owner}` and `source` from the prefix —
    // while `name` and `rid` stay the PUBLISHER's (the preserve-rid contract is
    // untouched; nothing is written back to vault.yon).
    //
    // The by-name fallback is NEVER taken for a bucket-homed vault. Genuinely OWN
    // vaults cannot reach this arm (a user cannot occupy the reserved
    // `subscriptions`/`shared` mesh prefixes), so their name-fallback behaviour
    // is unchanged.
    homeMeshBytes = (await ensureBucketMesh(db, bucketHoming.bucketMesh)).mesh.rid;
    bucketHomeMeshRid = homeMeshBytes;
  } else if (parsedHomeMeshBytes !== null) {
    // (R1) — from-disk re-registration (`lyt registry rebuild`,
    // recover-pod, the stranded-vault heal) re-registers a vault from its
    // FROZEN, committed `.lyt/vault.yon` with NO override. A preserve-rid
    // subscribe/adopt clone kept the PUBLISHER's committed @VAULT_HOME_MESH
    // (byte-unchanged on ingest), whose mesh rid is the publisher's — NOT
    // registered on this machine. The rid lookup misses, and (since rebuild has
    // already deleteAllVaults'd) the member would be DROPPED. FALL BACK to
    // resolving the home mesh by NAME: if a local same-named mesh exists, home
    // into THAT local mesh's rid. This resolves to an ALREADY-LOCAL mesh
    // (trusted reconstruction from the user's own disk) and does NOT weaken the
    // subscribe/adopt-time identity guard (that guard lives in clone.ts and
    // still runs on the ingest path). Only if NEITHER the rid NOR the name
    // resolves locally do we throw.
    if ((await getMeshByRid(db, parsedHomeMeshBytes)) !== null) {
      homeMeshBytes = parsedHomeMeshBytes;
    } else {
      const byName = parsed.homeMesh ? await getMeshByName(db, parsed.homeMesh.meshName) : null;
      if (byName !== null) {
        homeMeshBytes = byName.rid;
      } else {
        throw new VaultHomeMeshNotRegisteredError(
          parsed.name,
          parsed.homeMesh?.meshName ?? "<local-target-mesh>",
          uuid7BytesToHex(parsedHomeMeshBytes),
          false,
        );
      }
    }
  } else {
    homeMeshBytes = null;
  }

  const effectiveSource: VaultSource | undefined = args.source ?? bucketHoming?.source;

  await upsertVault(
    db,
    {
      rid: ridBytes,
      name: parsed.name,
      path: absPath,
      memscopeRid: memscopeBytes,
      parentVault: parentBytes,
      homeMeshRid: homeMeshBytes,
      tierHint: parsed.tierHint,
      status: args.status ?? "active",
      // an explicit caller `source` still wins (the live receive path passes
      // it). Absent one, a bucket-homed vault is positively marked from its bucket
      // prefix, so a from-disk re-registration cannot silently fail closed to
      // 'own' and strip a foreign vault's provenance. Only ever applied on the
      // fresh INSERT — upsertVault never updates `source` on conflict.
      ...(effectiveSource !== undefined ? { source: effectiveSource } : {}),
      gitUrl,
      createdAt: parsed.createdAt,
    },
    { trustedReconstruction: args.trustedReconstruction === true },
  );

  // Final review — the mesh-side half of the bucket binding. `upsertVault` writes
  // `vaults.home_mesh_rid`; `mesh_vaults` role='home' is the same fact seen from
  // the mesh, and `listVaultsInMesh` (mesh explore, prune's emptiness check, the
  // mesh rollup) reads THAT table. flows/repair-foreign-homing.ts wrote it and
  // this chokepoint did not, so `registry rebuild` and `repair --apply` disagreed
  // about the same vault. Written here so both paths converge on one row.
  if (bucketHomeMeshRid !== null) {
    const homeRows = (await listMeshesForVault(db, ridBytes)).filter((r) => r.role === "home");
    if (!homeRows.some((r) => ridsEqual(r.meshRid, bucketHomeMeshRid))) {
      for (const h of homeRows) await removeVaultFromMesh(db, h.meshRid, ridBytes);
      await addVaultToMesh(db, bucketHomeMeshRid, ridBytes, "home");
    }
  }

  // v1.A.1b: cross-mesh mesh_edges insertion is gated on real `meshes` rows
  // (which v1.B.1 lands). For now, `vaults.parent_vault` carries the parent
  // FK directly and is the traversal surface (see flows/sync-metadata.ts).
  // The legacy single-mesh `share_with` / `accepts_from` edge_types collapse
  // to mesh subscriptions in v1.C.1; parsed.shareWith / parsed.acceptsFrom
  // are retained on the parser surface as a forward-compatibility hint but
  // not written to the registry until the cross-mesh surface ships.

  if (!isUnderDefaultVaultsRoot(absPath)) {
    addKnownPath(absPath);
  }

  return { rid: ridBytes, ridHex: uuid7BytesToHex(ridBytes), name: parsed.name, path: absPath };
}

// is `absPath` a FOREIGN owner-bucket vault directory under the default
// vaults root? Returns the receiver-side coordinates recovered from the path, or
// null for anything else (own vaults, out-of-root vaults, the bucket roots
// themselves, a subdirectory INSIDE a foreign vault).
//
// Path-derived, deliberately: the bucket directory IS the receive decision made
// visible, it is written by us and never by the publisher, and it survives every
// registry wipe — which is the exact failure this repairs. It is computed with
// the same `util/bucket-mesh.ts` rules the receive path used, so the two can not
// drift. A vault held OUTSIDE the vaults root is out of scope by construction
// (there is no bucket tree to sit in) and keeps the pre-existing behaviour.
function bucketHomingFor(absPath: string): ParsedBucketRelDir | null {
  const root = resolve(getDefaultVaultsRoot());
  const rel = relative(root, resolve(absPath));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return parseBucketRelDir(rel);
}

export function isUnderDefaultVaultsRoot(path: string): boolean {
  const root = resolve(getDefaultVaultsRoot());
  const target = resolve(path);
  return (
    target === root ||
    target.startsWith(root + (root.endsWith("/") ? "" : "/")) ||
    target.startsWith(root + "\\")
  );
}
