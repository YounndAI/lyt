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

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";

type MainVaultRemovalVerb = "abandon" | "delete" | "forget";

export class MainVaultRemovalRefusedError extends Error {
  readonly errorCode = "main-vault-removal-refused";
  readonly meshName: string;
  readonly vaultName: string;

  constructor(verb: MainVaultRemovalVerb, meshName: string, vaultName: string) {
    super(
      `Refusing to ${verb} main vault '${vaultName}': it anchors mesh '${meshName}'. ` +
        `Removing a main vault means deleting the mesh and cannot run through ` +
        `'lyt vault ${verb}'. Move or remove the mesh's member vaults first. ` +
        `A safe, explicit mesh-delete operation is not available in this release.`,
    );
    this.name = "MainVaultRemovalRefusedError";
    this.meshName = meshName;
    this.vaultName = vaultName;
  }
}

export async function findMeshAnchoredByVault(
  db: Client,
  vault: VaultRow,
): Promise<MeshRow | null> {
  return (await listMeshes(db)).find((mesh) => mesh.mainVaultRidHex === vault.ridHex) ?? null;
}

export async function assertNotMeshMainVault(
  db: Client,
  vault: VaultRow,
  verb: MainVaultRemovalVerb,
): Promise<void> {
  const ownerMesh = await findMeshAnchoredByVault(db, vault);
  if (ownerMesh !== null) {
    throw new MainVaultRemovalRefusedError(verb, ownerMesh.name, vault.name);
  }
}

export async function assertNamedVaultNotMeshMainVault(
  name: string,
  verb: MainVaultRemovalVerb,
): Promise<void> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, name);
    if (vault !== null) {
      await assertNotMeshMainVault(db, vault, verb);
    }
  } finally {
    await closeRegistry(db);
  }
}
