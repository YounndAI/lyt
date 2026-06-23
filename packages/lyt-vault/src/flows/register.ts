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
import { join, resolve } from "node:path";

import type { Client } from "@libsql/client";

import { addKnownPath } from "../registry/known-paths.js";
import { getMeshByRid } from "../registry/meshes-repo.js";
import { upsertVault, type VaultStatus } from "../registry/repo.js";
import { readGitRemoteOriginUrl } from "../util/git.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { hexToUuid7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import { parseVaultYon } from "../yon/parse.js";

export interface RegisterVaultArgs {
  vaultPath: string;
  status?: VaultStatus;
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
  constructor(vaultName: string, meshName: string, meshRidHex: string) {
    super(
      `lyt vault register: vault '${vaultName}' declares home mesh '${meshName}' ` +
        `(mesh:${meshRidHex}), which is not a registered mesh on this machine. ` +
        `To consume another owner's vault, run ` +
        `'lyt mesh subscribe --vault ${vaultName} --from-mesh <your-mesh>' ` +
        `(registers the external mesh record automatically), or re-clone it into ` +
        `one of your own meshes with 'lyt vault clone <url> --to-mesh <local-mesh>'. ` +
        `Run 'lyt mesh init ${meshName}' only if '${meshName}' is YOUR mesh — ` +
        `never scaffold another owner's mesh locally.`,
    );
    this.name = "VaultHomeMeshNotRegisteredError";
    this.meshName = meshName;
    this.meshRidHex = meshRidHex;
    this.vaultName = vaultName;
  }
}

export async function registerVaultFromYon(
  db: Client,
  args: RegisterVaultArgs,
): Promise<RegisteredVault> {
  const absPath = resolve(args.vaultPath);
  const yonPath = join(absPath, ".lyt", "vault.yon");
  const content = readFileSync(yonPath, "utf8");
  const parsed = parseVaultYon(content);

  // Per Phase 5.5 smoke Observation #1: fall back to .git/config remote.origin.url
  // when vault.yon was written before the remote was added (the init→push→clone
  // workflow leaves vault.yon's @META git_url empty even though the remote exists).
  const gitUrl = parsed.gitUrl ?? readGitRemoteOriginUrl(absPath);

  // v1.A.1b boundary: vault.yon serialises rid as the 8-4-4-4-12 dashed
  // UUIDv7 string; parser returns it as a string; flip to bytes here at the
  // edge so the registry/repo CRUD only sees Uint8Array rids.
  const ridBytes = hexToUuid7Bytes(parsed.rid);
  const memscopeBytes = parsed.memscopeRid ? hexToUuid7Bytes(parsed.memscopeRid) : null;
  const parentBytes = parsed.parentVault ? hexToUuid7Bytes(parsed.parentVault) : null;
  // v1.B.3 — when vault.yon carries a @VAULT_HOME_MESH record, prime
  // vaults.home_mesh_rid from the parsed rid. FK requires the meshes row
  // exists; callers (flows/init.ts auto-personal branch, flows/clone.ts
  // --to-mesh, flows/move.ts) ensure the mesh is registered BEFORE this
  // call. Absence (pre-v1.B.3 vault.yons; vaults bound to no mesh) → null.
  const homeMeshBytes = parsed.homeMesh ? hexToUuid7Bytes(parsed.homeMesh.meshRid) : null;

  // guard the home-mesh FK BEFORE the insert. Without this,
  // clone/join on a vault with a foreign (unregistered) home mesh surfaces a
  // raw SQLITE_CONSTRAINT_FOREIGNKEY to the user.
  if (homeMeshBytes !== null) {
    const homeMeshRow = await getMeshByRid(db, homeMeshBytes);
    if (homeMeshRow === null) {
      throw new VaultHomeMeshNotRegisteredError(
        parsed.name,
        parsed.homeMesh!.meshName,
        uuid7BytesToHex(homeMeshBytes),
      );
    }
  }

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
      gitUrl,
      createdAt: parsed.createdAt,
    },
    { trustedReconstruction: args.trustedReconstruction === true },
  );

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

export function isUnderDefaultVaultsRoot(path: string): boolean {
  const root = resolve(getDefaultVaultsRoot());
  const target = resolve(path);
  return (
    target === root ||
    target.startsWith(root + (root.endsWith("/") ? "" : "/")) ||
    target.startsWith(root + "\\")
  );
}
