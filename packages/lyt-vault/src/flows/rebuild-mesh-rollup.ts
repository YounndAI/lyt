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

// v1.E.2 — `lyt mesh rebuild-rollup` flow.
//
// Mesh-level wrapper around `rebuildRollupFlow`. For a given mesh (or
// every registered mesh when `meshName` is omitted), enumerates every
// home vault in that mesh and rebuilds its rollup. Each vault becomes
// its own rollup root — a leaf vault rolls up only its own keywords;
// a parent vault transitively pulls its descendants' keywords per the
// per-vault flow.
//
// Subscriptions are NOT walked (per the ratified default + master-plan §v1.E.2:897):
// `@MESH_SUBSCRIPTION` is a flat reference, not a parent-child edge.
//
// Open-once seam (v1.A.5 CR-B1): the mesh wrapper opens the registry
// once + passes the shared client into each per-vault flow so the
// per-mesh rebuild runs against a single connection.

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName, listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { listVaultsInMesh } from "../registry/mesh-vaults-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import {
  ROLLUP_DISCONNECTED_DAYS,
  rebuildRollupFlow,
  type RebuildRollupResult,
} from "./rebuild-rollup.js";

export type MeshRollupVaultStatus = "ok" | "skipped" | "failed";

export interface MeshRollupVaultOutcome {
  vaultName: string;
  vaultRidHex: string;
  status: MeshRollupVaultStatus;
  rollupRowsWritten: number;
  descendantsVisited: number;
  descendantsSkipped: number;
  cycleDetected: boolean;
  error?: string;
}

export interface MeshRollupOutcome {
  meshName: string;
  meshRidHex: string;
  vaults: MeshRollupVaultOutcome[];
}

export interface RebuildMeshRollupResult {
  meshes: MeshRollupOutcome[];
  totalRollupRowsWritten: number;
  totalVaults: number;
  totalCycles: number;
  thresholdDays: number;
  nowIso: string;
  durationMs: number;
}

export interface RebuildMeshRollupArgs {
  // Restrict to a single mesh by name. When omitted, every registered
  // mesh is rebuilt (mirrors rebuildMeshRegistryFlow default).
  meshName?: string;
  thresholdDays?: number;
  registryDb?: Client;
  nowIso?: string;
}

export class MeshRollupMeshNotFoundError extends Error {
  readonly errorCode = "mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh rebuild-rollup: no mesh registered with name '${meshName}'. Use 'lyt mesh list' to see registered meshes.`,
    );
    this.name = "MeshRollupMeshNotFoundError";
    this.meshName = meshName;
  }
}

export async function rebuildMeshRollupFlow(
  args: RebuildMeshRollupArgs = {},
): Promise<RebuildMeshRollupResult> {
  const startedAt = Date.now();
  const thresholdDays = args.thresholdDays ?? ROLLUP_DISCONNECTED_DAYS;
  const nowIso = args.nowIso ?? new Date().toISOString();

  const callerSupplied = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());

  try {
    const targets = await resolveTargets(registryDb, args.meshName);

    const meshOutcomes: MeshRollupOutcome[] = [];
    let totalRollupRowsWritten = 0;
    let totalVaults = 0;
    let totalCycles = 0;

    for (const mesh of targets) {
      const vaultOutcomes: MeshRollupVaultOutcome[] = [];
      const memberships = await listVaultsInMesh(registryDb, mesh.rid);
      const homeMembers = memberships.filter((m) => m.role === "home");

      for (const member of homeMembers) {
        const vault = await getVaultByRid(registryDb, member.vaultRid);
        if (vault === null) {
          vaultOutcomes.push({
            vaultName: `(unknown:${member.vaultRidHex})`,
            vaultRidHex: member.vaultRidHex,
            status: "skipped",
            rollupRowsWritten: 0,
            descendantsVisited: 0,
            descendantsSkipped: 0,
            cycleDetected: false,
            error: "vault row missing for mesh_vaults membership",
          });
          continue;
        }
        if (vault.status === "tombstoned") {
          vaultOutcomes.push({
            vaultName: vault.name,
            vaultRidHex: vault.ridHex,
            status: "skipped",
            rollupRowsWritten: 0,
            descendantsVisited: 0,
            descendantsSkipped: 0,
            cycleDetected: false,
            error: "vault is tombstoned",
          });
          continue;
        }
        try {
          const r: RebuildRollupResult = await rebuildRollupFlow({
            vaultRidOverride: vault.rid,
            thresholdDays,
            registryDb,
            nowIso,
          });
          vaultOutcomes.push({
            vaultName: r.vaultName,
            vaultRidHex: r.vaultRidHex,
            status: "ok",
            rollupRowsWritten: r.rollupRowsWritten,
            descendantsVisited: r.descendantsVisited,
            descendantsSkipped: r.descendantsSkipped,
            cycleDetected: r.cycleDetected,
          });
          totalRollupRowsWritten += r.rollupRowsWritten;
          totalVaults += 1;
          if (r.cycleDetected) totalCycles += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vaultOutcomes.push({
            vaultName: vault.name,
            vaultRidHex: vault.ridHex,
            status: "failed",
            rollupRowsWritten: 0,
            descendantsVisited: 0,
            descendantsSkipped: 0,
            cycleDetected: false,
            error: message,
          });
        }
      }

      meshOutcomes.push({
        meshName: mesh.name,
        meshRidHex: mesh.ridHex,
        vaults: vaultOutcomes,
      });
    }

    return {
      meshes: meshOutcomes,
      totalRollupRowsWritten,
      totalVaults,
      totalCycles,
      thresholdDays,
      nowIso,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(registryDb);
  }
}

async function resolveTargets(db: Client, meshName?: string): Promise<MeshRow[]> {
  if (meshName === undefined) {
    return listMeshes(db);
  }
  const one = await getMeshByName(db, meshName);
  if (one === null) {
    throw new MeshRollupMeshNotFoundError(meshName);
  }
  return [one];
}
