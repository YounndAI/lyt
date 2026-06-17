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
import { getMeshByRid } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByRid } from "../registry/repo.js";
import { ridsEqual } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import {
  renderMeshYon,
  type MeshDoc,
  type MeshUpdateCadenceRecord,
  type MeshUpdateCadenceType,
} from "../yon/mesh-write.js";

// v1.B.6 — `lyt vault update-cadence <vault> [--cron <spec> | --interval
// <seconds> | --on-demand] [--timezone <tz>] [--json]`. Publisher-side
// CLI for setting @UPDATE_CADENCE per-vault. The record is mesh-scoped
// (per the ratified default + lyt-public-mesh §2.3): we look up the vault's home
// mesh, load that mesh's main-vault mesh.yon, upsert the @UPDATE_CADENCE
// row keyed by vault_rid, atomic tmp+rename write. Cadence-type flags are
// mutually exclusive at the CLI layer; the flow asserts exactly one is set.
// Idempotent re-emit: same args produce same mesh.yon bytes per v1.B.2
// Lock 0.3.

export class VaultUpdateCadenceNotFoundError extends Error {
  readonly errorCode = "vault-update-cadence-not-found";
  readonly vaultName: string;
  constructor(vaultName: string) {
    super(
      `lyt vault update-cadence: no vault registered with name '${vaultName}'. Use 'lyt vault list' to see registered vaults.`,
    );
    this.name = "VaultUpdateCadenceNotFoundError";
    this.vaultName = vaultName;
  }
}

export class VaultUpdateCadenceNoHomeMeshError extends Error {
  readonly errorCode = "vault-update-cadence-no-home-mesh";
  readonly vaultName: string;
  constructor(vaultName: string) {
    super(
      `lyt vault update-cadence: vault '${vaultName}' has no home mesh assignment; cadence is a mesh-scoped declaration. Run 'lyt vault init' or 'lyt vault move' to bind the vault to a mesh first.`,
    );
    this.name = "VaultUpdateCadenceNoHomeMeshError";
    this.vaultName = vaultName;
  }
}

export class VaultUpdateCadenceFlagComboError extends Error {
  readonly errorCode = "vault-update-cadence-invalid-flag-combo";
  constructor(message: string) {
    super(`lyt vault update-cadence: ${message}`);
    this.name = "VaultUpdateCadenceFlagComboError";
  }
}

export interface VaultUpdateCadenceArgs {
  vaultName: string;
  cadenceType: MeshUpdateCadenceType;
  cron?: string | undefined;
  intervalSeconds?: number | undefined;
  timezone?: string | undefined;
  peakHours?: string | undefined;
  onDemandAllowed?: boolean | undefined;
  registryDb?: Client | undefined;
}

export interface VaultUpdateCadenceResult {
  vaultName: string;
  vaultRidHex: string;
  meshName: string;
  meshRidHex: string;
  meshYonPath: string;
  cadenceType: MeshUpdateCadenceType;
  previousCadence: MeshUpdateCadenceRecord | null;
  writtenCadence: MeshUpdateCadenceRecord;
  durationMs: number;
}

export async function setVaultUpdateCadenceFlow(
  args: VaultUpdateCadenceArgs,
): Promise<VaultUpdateCadenceResult> {
  const startedAt = Date.now();

  // Mutually-exclusive sanity check (the CLI also enforces this; flow guards
  // for non-CLI callers).
  if (args.cadenceType === "cron" && (args.cron === undefined || args.cron.length === 0)) {
    throw new VaultUpdateCadenceFlagComboError("cadence_type=cron requires --cron <spec>");
  }
  if (
    args.cadenceType === "interval" &&
    (args.intervalSeconds === undefined || args.intervalSeconds <= 0)
  ) {
    throw new VaultUpdateCadenceFlagComboError(
      "cadence_type=interval requires --interval <positive-seconds>",
    );
  }

  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    const vault = await getVaultByName(db, args.vaultName);
    if (vault === null) throw new VaultUpdateCadenceNotFoundError(args.vaultName);
    if (vault.homeMeshRid === null) {
      throw new VaultUpdateCadenceNoHomeMeshError(args.vaultName);
    }

    const mesh = await getMeshByRid(db, vault.homeMeshRid);
    if (mesh === null || mesh.mainVaultRid === null) {
      throw new Error(
        `lyt vault update-cadence: vault '${args.vaultName}' home_mesh_rid points at a mesh with no main vault.`,
      );
    }
    const mainVault = await getVaultByRid(db, mesh.mainVaultRid);
    if (mainVault === null || !existsSync(mainVault.path)) {
      throw new Error(`lyt vault update-cadence: mesh '${mesh.name}' main vault missing on disk.`);
    }
    const meshYonPath = join(mainVault.path, ".lyt", "mesh.yon");
    if (!existsSync(meshYonPath)) {
      throw new Error(`lyt vault update-cadence: mesh '${mesh.name}' is missing .lyt/mesh.yon.`);
    }

    const doc = parseMeshYon(readFileSync(meshYonPath, "utf8"));
    const previousCadence =
      doc.updateCadences.find((c) => ridsEqual(c.vaultRid, vault.rid)) ?? null;

    // Build the new cadence record. Empty/absent optional fields are
    // omitted from the record so the renderer skips them in output.
    const newCadence: MeshUpdateCadenceRecord = {
      vaultRid: vault.rid,
      cadenceType: args.cadenceType,
    };
    if (args.cron !== undefined && args.cron.length > 0) newCadence.cron = args.cron;
    if (args.intervalSeconds !== undefined) newCadence.intervalSeconds = args.intervalSeconds;
    if (args.timezone !== undefined && args.timezone.length > 0)
      newCadence.timezone = args.timezone;
    if (args.peakHours !== undefined && args.peakHours.length > 0)
      newCadence.peakHours = args.peakHours;
    if (args.onDemandAllowed !== undefined) newCadence.onDemandAllowed = args.onDemandAllowed;

    const updatedCadences = [
      ...doc.updateCadences.filter((c) => !ridsEqual(c.vaultRid, vault.rid)),
      newCadence,
    ];
    const updated: MeshDoc = { ...doc, updateCadences: updatedCadences };

    const tmp = `${meshYonPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, renderMeshYon(updated), "utf8");
    renameSync(tmp, meshYonPath);

    return {
      vaultName: vault.name,
      vaultRidHex: vault.ridHex,
      meshName: mesh.name,
      meshRidHex: mesh.ridHex,
      meshYonPath,
      cadenceType: args.cadenceType,
      previousCadence,
      writtenCadence: newCadence,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
