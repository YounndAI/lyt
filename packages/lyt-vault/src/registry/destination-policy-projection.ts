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

import { isValidGhHandle } from "../util/identity.js";
import { vaultRepoName } from "../util/federation-paths.js";
import {
  DestinationPolicyValidationError,
  validateDestinationPolicyValue,
  type DestinationKind,
  type DestinationTargetKind,
  type MeshDestinationSource,
  type VaultDestinationSource,
} from "./destination-policy.js";
import { normalizeGithubPublicationCoordinate } from "../util/publication-coordinate.js";

export interface MeshDestinationProjection {
  destinationKind: DestinationKind;
  targetOwner: string | null;
  targetKind: DestinationTargetKind | null;
  source: MeshDestinationSource;
}

export interface VaultDestinationProjection {
  destinationKind: DestinationKind;
  targetOwner: string | null;
  targetKind: DestinationTargetKind | null;
  repositoryName: string | null;
  source: VaultDestinationSource;
}

export class ForeignDestinationProjectionError extends Error {
  readonly errorCode = "foreign-destination-projection";
}

// Backward-compatible ownership transition. Kept here so the legacy push
// columns and semantic projection change atomically under one owner.
export async function projectLegacyMeshOwnership(
  db: Client,
  meshRid: Uint8Array,
  args: { pushTarget: string; pushKind: "handle" | "org"; ownCreated: boolean },
): Promise<void> {
  if (!isValidGhHandle(args.pushTarget)) {
    throw new DestinationPolicyValidationError("Legacy mesh target is malformed.");
  }
  const result = await db.execute({
    sql: `UPDATE meshes
          SET own_created = ?, push_target = ?, push_kind = ?,
              destination_kind = ?, destination_source = ?
          WHERE rid = ?`,
    args: [
      args.ownCreated ? 1 : 0,
      args.pushTarget,
      args.pushKind,
      args.ownCreated ? "github" : null,
      args.ownCreated ? "legacy-derived" : null,
      meshRid,
    ],
  });
  if (result.rowsAffected !== 1) {
    throw new ForeignDestinationProjectionError(
      "Mesh ownership projection requires an existing mesh.",
    );
  }
}

// Sole owned-mesh projection writer. The legacy push columns are updated in the
// same statement as the semantic projection, so they cannot become a second
// independently writable policy truth.
export async function projectOwnedMeshDestination(
  db: Client,
  meshRid: Uint8Array,
  projection: MeshDestinationProjection,
): Promise<void> {
  validateDestinationPolicyValue("mesh", projection);
  const result = await db.execute({
    sql: `UPDATE meshes
          SET destination_kind = ?, destination_source = ?, push_target = ?, push_kind = ?
          WHERE rid = ? AND own_created = 1`,
    args: [
      projection.destinationKind,
      projection.source,
      projection.targetOwner,
      projection.targetKind === "user" ? "handle" : projection.targetKind,
      meshRid,
    ],
  });
  if (result.rowsAffected !== 1) {
    throw new ForeignDestinationProjectionError(
      "Refusing to project destination policy onto a missing or foreign mesh.",
    );
  }
}

/** Claim an already-authenticated mesh for an authoritative policy projection. */
export async function prepareOwnedMeshDestinationProjection(
  db: Client,
  meshRid: Uint8Array,
): Promise<void> {
  const result = await db.execute({
    sql: `UPDATE meshes
          SET own_created = 1, push_target = NULL, push_kind = NULL,
              destination_kind = NULL, destination_source = NULL
          WHERE rid = ?`,
    args: [meshRid],
  });
  if (result.rowsAffected !== 1) {
    throw new ForeignDestinationProjectionError(
      "Owned mesh projection requires an existing authenticated mesh.",
    );
  }
}

export async function clearOwnedMeshDestinationProjection(
  db: Client,
  meshRid: Uint8Array,
): Promise<void> {
  const result = await db.execute({
    sql: `UPDATE meshes
          SET push_target = NULL, push_kind = NULL,
              destination_kind = NULL, destination_source = NULL
          WHERE rid = ? AND own_created = 1`,
    args: [meshRid],
  });
  if (result.rowsAffected !== 1) {
    throw new ForeignDestinationProjectionError(
      "Clearing owned mesh policy requires an existing owned mesh.",
    );
  }
}

// Foreign topology may retain its declared legacy origin hint, but never gains
// a local owned-policy projection.
export async function ingestForeignLegacyMeshDestination(
  db: Client,
  meshRid: Uint8Array,
  pushTarget: string | null,
  pushKind: "handle" | "org" | null,
): Promise<void> {
  if (pushTarget !== null && !isValidGhHandle(pushTarget)) {
    throw new DestinationPolicyValidationError("Foreign legacy mesh target is malformed.");
  }
  const result = await db.execute({
    sql: `UPDATE meshes
          SET push_target = ?, push_kind = ?, destination_kind = NULL,
              destination_source = NULL
          WHERE rid = ? AND own_created = 0`,
    args: [pushTarget, pushKind, meshRid],
  });
  if (result.rowsAffected !== 1) {
    throw new ForeignDestinationProjectionError(
      "Foreign legacy ingestion requires an existing non-owned mesh.",
    );
  }
}

export async function projectOwnedVaultDestination(
  db: Client,
  vaultRid: Uint8Array,
  projection: VaultDestinationProjection,
): Promise<void> {
  validateDestinationPolicyValue("vault", projection);
  const result = await db.execute({
    sql: `UPDATE vaults
          SET destination_kind = ?, destination_source = ?, destination_target = ?,
              destination_target_kind = ?, destination_repository_name = ?
          WHERE rid = ? AND source = 'own'`,
    args: [
      projection.destinationKind,
      projection.source,
      projection.targetOwner,
      projection.targetKind,
      projection.repositoryName ?? null,
      vaultRid,
    ],
  });
  if (result.rowsAffected !== 1) {
    throw new ForeignDestinationProjectionError(
      "Refusing to project destination policy onto a missing or foreign vault.",
    );
  }
}

export async function clearForeignVaultDestination(
  db: Client,
  vaultRid: Uint8Array,
): Promise<void> {
  await db.execute({
    sql: `UPDATE vaults
          SET destination_kind = NULL, destination_source = NULL,
              destination_target = NULL, destination_target_kind = NULL,
              destination_repository_name = NULL
          WHERE rid = ? AND source <> 'own'`,
    args: [vaultRid],
  });
}

export async function clearOwnedVaultDestinationProjection(
  db: Client,
  vaultRid: Uint8Array,
): Promise<void> {
  const result = await db.execute({
    sql: `UPDATE vaults
          SET destination_kind = NULL, destination_source = NULL,
              destination_target = NULL, destination_target_kind = NULL,
              destination_repository_name = NULL
          WHERE rid = ? AND source = 'own'`,
    args: [vaultRid],
  });
  if (result.rowsAffected !== 1) {
    throw new ForeignDestinationProjectionError(
      "Clearing owned vault policy requires an existing owned vault.",
    );
  }
}

// Safe legacy backfill. It classifies only facts the registry can prove. An
// owned origin that cannot be matched to the mesh owner without fresh
// authorization remains legacy-derived quarantine (no effective target).
export async function backfillLegacyDestinationProjections(db: Client): Promise<void> {
  await db.execute("BEGIN");
  try {
    const meshes = await db.execute(
      `SELECT rid, push_target, push_kind, own_created, destination_source FROM meshes`,
    );
    for (const row of meshes.rows) {
      const rid = asBytes(row["rid"]);
      if (Number(row["own_created"]) !== 1) {
        await db.execute({
          sql: `UPDATE meshes SET destination_kind = NULL, destination_source = NULL WHERE rid = ?`,
          args: [rid],
        });
        continue;
      }
      // A retry after a concurrent/new-writer projection must never demote an
      // explicit 0.20 policy back to legacy-derived migration evidence.
      if (
        row["destination_source"] === "explicit" ||
        row["destination_source"] === "authenticated-default" ||
        row["destination_source"] === "auto-fallback-local"
      ) {
        continue;
      }
      const target = row["push_target"] == null ? null : String(row["push_target"]);
      const kind =
        row["push_kind"] === "handle" ? "user" : row["push_kind"] === "org" ? "org" : null;
      if (target === null && kind === null) {
        await projectOwnedMeshDestination(db, rid, {
          destinationKind: "local",
          targetOwner: null,
          targetKind: null,
          source: "legacy-derived",
        });
      } else if (target !== null && kind !== null && isValidGhHandle(target)) {
        await projectOwnedMeshDestination(db, rid, {
          destinationKind: "github",
          targetOwner: target,
          targetKind: kind,
          source: "legacy-derived",
        });
      } else {
        await quarantineMesh(db, rid);
      }
    }

    const vaults = await db.execute(
      `SELECT v.rid, v.name, v.source, v.git_url, v.destination_kind,
              v.destination_source, v.destination_target, v.destination_target_kind,
              v.destination_repository_name,
              m.destination_kind AS mesh_destination_kind,
              m.push_target AS mesh_target, m.push_kind AS mesh_target_kind
       FROM vaults v LEFT JOIN meshes m ON m.rid = v.home_mesh_rid`,
    );
    for (const row of vaults.rows) {
      const rid = asBytes(row["rid"]);
      if (String(row["source"]) !== "own") {
        await clearForeignVaultDestination(db, rid);
        continue;
      }
      if (row["destination_repository_name"] != null) continue;

      const meshKind = row["mesh_destination_kind"];
      const meshTarget = row["mesh_target"] == null ? null : String(row["mesh_target"]);
      const meshTargetKind: DestinationTargetKind | null =
        row["mesh_target_kind"] === "handle"
          ? "user"
          : row["mesh_target_kind"] === "org"
            ? "org"
            : null;
      const gitUrl = row["git_url"] == null ? null : String(row["git_url"]);
      if (gitUrl !== null) {
        const exact = normalizeGithubPublicationCoordinate(gitUrl);
        if (
          exact !== null &&
          meshKind === "github" &&
          meshTarget !== null &&
          meshTargetKind !== null &&
          exact.owner === meshTarget.toLowerCase()
        ) {
          await projectOwnedVaultDestination(db, rid, {
            destinationKind: "github",
            targetOwner: meshTarget,
            targetKind: meshTargetKind,
            repositoryName: exact.repositoryName,
            source: "mesh-inherited",
          });
        } else {
          // The URL is authoritative repository evidence, but migration cannot
          // authorize a different owner or an unparseable forge coordinate.
          await quarantineVault(db, rid);
        }
        continue;
      }

      if (meshKind === "local") {
        await projectOwnedVaultDestination(db, rid, {
          destinationKind: "local",
          targetOwner: null,
          targetKind: null,
          repositoryName: null,
          source: "mesh-inherited",
        });
        continue;
      }
      if (
        meshKind === "github" &&
        meshTarget !== null &&
        meshTargetKind !== null &&
        isValidGhHandle(meshTarget)
      ) {
        await projectOwnedVaultDestination(db, rid, {
          destinationKind: "github",
          targetOwner: meshTarget,
          targetKind: meshTargetKind,
          repositoryName: vaultRepoName(String(row["name"])),
          source: "mesh-inherited",
        });
      } else {
        await quarantineVault(db, rid);
      }
    }
    await db.execute("COMMIT");
  } catch (err) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // best effort; the original semantic migration error remains primary
    }
    throw err;
  }
}

async function quarantineMesh(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: `UPDATE meshes SET destination_kind = NULL, destination_source = 'legacy-derived' WHERE rid = ? AND own_created = 1`,
    args: [rid],
  });
}

async function quarantineVault(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: `UPDATE vaults
          SET destination_kind = NULL, destination_source = 'legacy-derived',
              destination_target = NULL, destination_target_kind = NULL,
              destination_repository_name = NULL
          WHERE rid = ? AND source = 'own'`,
    args: [rid],
  });
}

function asBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new DestinationPolicyValidationError("Destination projection row has an invalid RID.");
}
