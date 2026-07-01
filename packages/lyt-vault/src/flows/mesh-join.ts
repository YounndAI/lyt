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

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName, getMeshByRid, insertMesh } from "../registry/meshes-repo.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { getVaultByRid, setVaultHomeMesh } from "../registry/repo.js";
import { initVaultDbs } from "../registry/vault-db.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { isReservedMeshName } from "../util/identity.js";
import { ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import type { MeshPushKind } from "../yon/mesh-write.js";
import type { MeshGhClient } from "../util/gh-mesh.js";
import { realMeshGhClient } from "../util/gh-mesh.js";
import { registerVaultFromYon } from "./register.js";

// v1.B.1 — `lyt mesh join <name> --from <gh-target>` flow.
//
// Source: Brief steps 3-4 + lyt-federation-design.md §3 (mesh.yon
// schema) + lyt-master-plan.md §5 v1.B.1.
//
// Order of operations (Brief step 4):
// (a) MeshGhClient.cloneRepo(<gh-target>, '<vaults-root>/<name>/main')
// (b) read .lyt/mesh.yon from the clone via parseMeshYon
// (c) extract @MESH record fields
// (d) INSERT meshes row with parsed rid (round-trip dashed-UUIDv7 → bytes)
// (e) register the main vault row via registerVaultFromYon (vault.yon
// already present in the cloned repo — its rid bytes match the parsed
// mesh.yon's main_vault_rid)
// (f) UPDATE vaults.home_mesh_rid for the main vault → meshRid
// (g) INSERT mesh_vaults role='home' for the main vault
// (h) for each additional @MESH_HOME: if vault already locally registered
// with the same rid → INSERT mesh_vaults role='home'; else → deferred
// clone (out of v1.B.1 unless --clone-members; --clone-members is a
// no-op in v1.B.1 — v1.B.3 wires the cascading clone path).
//
// Source-of-truth contract: mesh.yon IS the SoT for mesh membership. Local
// registry rows are a per-machine cache. `lyt mesh rebuild-registry`
// (v1.B.2) will regenerate the rows from disk.

export interface MeshJoinOptions {
  name: string;
  from: string;
  cloneMembers?: boolean | undefined;
  ghClient?: MeshGhClient | undefined;
  registryPath?: string | undefined;
}

export interface MeshJoinResult {
  meshRid: Uint8Array;
  meshRidHex: string;
  meshName: string;
  pushTarget: string | null;
  pushKind: MeshPushKind | null;
  mainVault: {
    rid: Uint8Array;
    ridHex: string;
    name: string;
    path: string;
  };
  homeVaultsRegistered: number;
  homeVaultsDeferred: number;
}

export async function meshJoinFlow(opts: MeshJoinOptions): Promise<MeshJoinResult> {
  const ghClient = opts.ghClient ?? realMeshGhClient;

  // (a) clone the main vault repo. By naming-convention.md, the main vault's
  // repo name is 'main' (lives at github.com/<gh-target>/main). The local
  // path uses the standard vaults root + '<name>/main'.
  const localPath = resolve(join(getDefaultVaultsRoot(), opts.name, "main"));
  await ghClient.cloneRepo(opts.from, "main", localPath);

  // (b) read mesh.yon from the clone.
  const meshYonPath = join(localPath, ".lyt", "mesh.yon");
  let meshYonContent: string;
  try {
    meshYonContent = readFileSync(meshYonPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `lyt mesh join: cloned repo at ${localPath} has no .lyt/mesh.yon. ` +
        `The repo at github.com/${opts.from}/main may not be a Lyt mesh main vault. ` +
        `Underlying error: ${msg}`,
    );
  }
  const parsedMesh = parseMeshYon(meshYonContent);

  // Fed-v2 Layer-1 (Phase release review) — guard-bypass close. The mesh name
  // here is `[lyt.untrusted]` foreign input from a published mesh.yon; it is
  // inserted via insertMesh DIRECTLY (no validateMeshName). A foreign pod that
  // publishes a mesh literally named `subscriptions` (etc.) would collide with
  // the local system bucket namespace on join. A foreign mesh name is a bare
  // mesh slot, so assert it directly. The SYSTEM's own bucket creation
  // (rebuildFederationCacheFlow) does not route through here.
  if (isReservedMeshName(parsedMesh.mesh.name)) {
    throw new Error(
      `lyt mesh join: the foreign mesh name ${JSON.stringify(parsedMesh.mesh.name)} ` +
        `collides with a reserved Lyt bucket namespace (subscriptions, shared, agents, ` +
        `published). The system homes subscriptions into 'subscriptions/{owner}' and ` +
        `shared vaults into 'shared/{owner}' automatically; a joined mesh cannot occupy ` +
        `one of these names. This mesh's publisher must rename it before it can be joined.`,
    );
  }

  // (c) extract fields. (d-h) populate the registry under a single open.
  const db = await openRegistry(
    opts.registryPath !== undefined ? { path: opts.registryPath } : undefined,
  );
  try {
    // Duplicate guards: do not silently overwrite an existing mesh of the
    // same name OR rid. Both are structurally fatal — the caller must
    // explicitly remove the existing row before retrying.
    const sameName = await getMeshByName(db, parsedMesh.mesh.name);
    if (sameName !== null) {
      throw new Error(
        `Mesh '${parsedMesh.mesh.name}' is already registered (rid: ${sameName.ridHex}). ` +
          `Remove the existing row before joining a remote mesh with the same name.`,
      );
    }
    const sameRid = await getMeshByRid(db, parsedMesh.mesh.rid);
    if (sameRid !== null) {
      throw new Error(
        `Mesh rid mesh:${uuid7BytesToHex(parsedMesh.mesh.rid)} is already registered ` +
          `under name '${sameRid.name}'. Mesh rids are stable forever — the remote mesh ` +
          `appears to be a duplicate of a locally-registered mesh.`,
      );
    }

    // (d) Register the main vault FIRST so its row exists before the
    // meshes INSERT (meshes.main_vault_rid REFERENCES vaults(rid); inserting
    // the mesh with a non-existent main_vault_rid violates the FK). Per-vault
    // libSQL must exist on first touch (cloned repos have no
    // `.lyt/indexes/*.db` files post-v1.A.2c DB SPLIT — the entire
    // `.lyt/indexes/` subdir is `.gitignore`'d).
    await initVaultDbs(localPath);
    const registered = await registerVaultFromYon(db, { vaultPath: localPath });

    // Sanity check: the cloned vault.yon's rid SHOULD equal the parsed
    // mesh.yon's main_vault_rid. A mismatch is a serious mesh-corruption
    // signal — surface it loudly.
    if (!ridsEqual(registered.rid, parsedMesh.mesh.mainVaultRid)) {
      throw new Error(
        `mesh.yon @MESH | main_vault_rid (${uuid7BytesToHex(parsedMesh.mesh.mainVaultRid)}) ` +
          `does not match the cloned main vault's vault.yon rid (${registered.ridHex}). ` +
          `The remote mesh is structurally inconsistent.`,
      );
    }

    // (e) insert the mesh row (cache; SoT is mesh.yon on disk).
    await insertMesh(db, {
      rid: parsedMesh.mesh.rid,
      name: parsedMesh.mesh.name,
      pushTarget: parsedMesh.mesh.pushTarget ?? null,
      pushKind: parsedMesh.mesh.pushKind ?? null,
      mainVaultRid: parsedMesh.mesh.mainVaultRid,
      createdAt: parsedMesh.mesh.createdAt,
    });

    // (f) home_mesh_rid update + (g) mesh_vaults home row insert.
    await setVaultHomeMesh(db, registered.rid, parsedMesh.mesh.rid);
    await addVaultToMesh(db, parsedMesh.mesh.rid, registered.rid, "home");

    // (h) for each @MESH_HOME beyond the main vault: insert mesh_vaults
    // role='home' if the vault already exists locally with matching rid;
    // otherwise count as deferred-clone.
    let homeVaultsRegistered = 1; // the main vault, counted above
    let homeVaultsDeferred = 0;
    for (const home of parsedMesh.homeVaults) {
      // Skip the main vault entry (already handled).
      if (ridsEqual(home.vaultRid, registered.rid)) continue;
      const existingVault = await getVaultByRid(db, home.vaultRid);
      if (existingVault === null) {
        // Vault not present locally → deferred clone. v1.B.3 wires the
        // cascading clone path when --clone-members is wired in.
        homeVaultsDeferred++;
        continue;
      }
      await setVaultHomeMesh(db, home.vaultRid, parsedMesh.mesh.rid);
      await addVaultToMesh(db, parsedMesh.mesh.rid, home.vaultRid, "home");
      homeVaultsRegistered++;
    }

    return {
      meshRid: parsedMesh.mesh.rid,
      meshRidHex: uuid7BytesToHex(parsedMesh.mesh.rid),
      meshName: parsedMesh.mesh.name,
      pushTarget: parsedMesh.mesh.pushTarget ?? null,
      pushKind: parsedMesh.mesh.pushKind ?? null,
      mainVault: {
        rid: registered.rid,
        ridHex: registered.ridHex,
        name: registered.name,
        path: registered.path,
      },
      homeVaultsRegistered,
      homeVaultsDeferred,
    };
  } finally {
    await closeRegistry(db);
  }
}
