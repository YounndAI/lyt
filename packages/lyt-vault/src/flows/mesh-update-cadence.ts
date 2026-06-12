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

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { renderMeshYon, type MeshDoc } from "../yon/mesh-write.js";

// v1.B.6 — `lyt mesh update-cadence <mesh> --default-vault-cadence <spec>
// [--json]`. Sets @MESH.default_vault_update_cadence (an optional field
// added in Commit 1 per OD-10 default). Subscribers fall back to this
// when a vault has no @UPDATE_CADENCE row of its own. Atomic tmp+rename
// write; idempotent re-emit per Lock 0.3.

export class MeshUpdateCadenceNotFoundError extends Error {
  readonly errorCode = "mesh-update-cadence-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh update-cadence: no mesh registered with name '${meshName}'. Use 'lyt mesh list' to see registered meshes.`,
    );
    this.name = "MeshUpdateCadenceNotFoundError";
    this.meshName = meshName;
  }
}

export interface MeshUpdateCadenceArgs {
  meshName: string;
  defaultCadence: string;
  registryDb?: Client | undefined;
}

export interface MeshUpdateCadenceResult {
  meshName: string;
  meshRidHex: string;
  meshYonPath: string;
  previousDefault: string | null;
  newDefault: string;
  durationMs: number;
}

export async function setMeshDefaultCadenceFlow(
  args: MeshUpdateCadenceArgs,
): Promise<MeshUpdateCadenceResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    const mesh = await getMeshByName(db, args.meshName);
    if (mesh === null) throw new MeshUpdateCadenceNotFoundError(args.meshName);
    if (mesh.mainVaultRid === null) {
      throw new Error(
        `lyt mesh update-cadence: mesh '${args.meshName}' has no main_vault_rid; cannot resolve mesh.yon.`,
      );
    }
    const mainVault = await getVaultByRid(db, mesh.mainVaultRid);
    if (mainVault === null || !existsSync(mainVault.path)) {
      throw new Error(
        `lyt mesh update-cadence: mesh '${args.meshName}' main vault missing on disk.`,
      );
    }
    const meshYonPath = join(mainVault.path, ".lyt", "mesh.yon");
    if (!existsSync(meshYonPath)) {
      throw new Error(`lyt mesh update-cadence: mesh '${args.meshName}' is missing .lyt/mesh.yon.`);
    }

    const doc = parseMeshYon(readFileSync(meshYonPath, "utf8"));
    const previousDefault = doc.mesh.defaultVaultUpdateCadence ?? null;

    const updated: MeshDoc = {
      ...doc,
      mesh: { ...doc.mesh, defaultVaultUpdateCadence: args.defaultCadence },
    };

    const tmp = `${meshYonPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, renderMeshYon(updated), "utf8");
    renameSync(tmp, meshYonPath);

    return {
      meshName: mesh.name,
      meshRidHex: mesh.ridHex,
      meshYonPath,
      previousDefault,
      newDefault: args.defaultCadence,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
