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

import type { Client } from "@libsql/client";

import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { setVaultHomeMesh } from "../registry/repo.js";
import { meshInitFlow } from "./mesh-init.js";

// G1 — guided-adopt mesh default. A bare `lyt vault adopt <path>` used to land
// the vault as an ORPHAN (no home mesh), so `mesh list` / writability / `mesh
// info` had nothing to key on. This helper is the small "give the adopted vault
// a home" primitive: find-or-create a `personal` mesh and assign the vault into
// it (`personal/<leaf>`) instead of leaving it orphan.
//
// Built on `meshInitFlow` (the single mesh-create surface). Guarded like
// adopt-and-prime.ts: only call meshInitFlow when no `personal` mesh exists, so
// a re-run over an already-personal pod does NOT trip meshInitFlow's
// duplicate-name throw. Assignment itself is idempotent (addVaultToMesh upserts;
// setVaultHomeMesh is a plain UPDATE).
//
// Deliberately does NOT import from `@younndai/lyt` — that package DEPENDS on
// lyt-vault, so importing it here would create a package cycle. Everything used
// (meshInitFlow, the registry repos) is lyt-vault-local.

export interface EnsurePersonalMeshResult {
  meshName: string;
  meshRidHex: string;
  // true when this call created the `personal` mesh (vs. found an existing one).
  created: boolean;
  // true when the vault's home_mesh was (re)assigned to the personal mesh.
  assigned: boolean;
}

export interface EnsurePersonalMeshArgs {
  db: Client;
  vaultRid: Uint8Array;
  // The mesh name to find-or-create. Defaults to "personal" (the guided-adopt
  // default); threaded so the CLI/skill can honor an explicit `--mesh <name>`.
  meshName?: string | undefined;
  // Test seam — passed through to meshInitFlow when it has to create the mesh.
  noPush?: boolean | undefined;
}

export async function ensurePersonalMesh(
  args: EnsurePersonalMeshArgs,
): Promise<EnsurePersonalMeshResult> {
  const meshName = args.meshName ?? "personal";
  const { db } = args;

  // Find-or-create the target mesh. Guard the create so a pre-existing mesh does
  // not throw (meshInitFlow's duplicate-name guard); reuse the open registry
  // connection (open-once seam) so we never open a nested connection.
  let mesh = await getMeshByName(db, meshName);
  let created = false;
  if (mesh === null) {
    await meshInitFlow({
      name: meshName,
      db,
      ...(args.noPush !== undefined ? { noPush: args.noPush } : {}),
    });
    mesh = await getMeshByName(db, meshName);
    created = mesh !== null;
  }

  if (mesh === null) {
    // Defensive: create reported success but the row is unreadable. Surface a
    // no-assignment result rather than throwing — the vault stays orphan but the
    // adopt does not abort (never-fail posture, matching adopt-and-prime).
    return { meshName, meshRidHex: "", created, assigned: false };
  }

  // Assign the adopted vault into the mesh: set the vault-side home_mesh_rid AND
  // add the mesh_vaults `home` row (what `mesh list` / writability read from).
  // Both are idempotent, so a re-run is a safe no-op.
  await setVaultHomeMesh(db, args.vaultRid, mesh.rid);
  await addVaultToMesh(db, mesh.rid, args.vaultRid, "home");

  return {
    meshName,
    meshRidHex: mesh.ridHex,
    created,
    assigned: true,
  };
}
