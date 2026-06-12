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
import { join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { deleteAllEdgesByRefMesh, insertMeshEdge } from "../registry/mesh-edges-repo.js";
import {
  addSubscription,
  deleteAllSubscriptionsByMesh,
} from "../registry/mesh-subscriptions-repo.js";
import {
  addVaultToMesh,
  deleteAllVaultsByMesh,
  listVaultsInMesh,
} from "../registry/mesh-vaults-repo.js";
import {
  getMeshByName,
  listMeshes,
  updateMeshMainVault,
  type MeshRow,
} from "../registry/meshes-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import { resolveMainVaultPathByConvention } from "./mesh-link-reconcile.js";
import { ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";

// v1.B.2 — `lyt mesh rebuild-registry` flow. The trust-the-disk verb
// that re-derives every per-machine registry mesh table row from the
// SoT YON files on each main vault's disk (per Lock 0.2).
//
// Walks `listMeshes(db)` (or filters to one mesh when --mesh <name>
// is set); for each mesh:
// 1. Resolve the main vault path (via mesh_vaults role='home' for the
// mesh's main_vault_rid → vaults.path)
// 2. Try readFile + parseMeshYon on <main-vault>/.lyt/mesh.yon — a
// per-mesh try/catch around the I/O so one corrupted mesh.yon
// does not poison the rebuild for healthy meshes (OD-6
// skip-and-warn default)
// 3. BEGIN TRANSACTION
// 4. UPDATE meshes row from parsed @MESH fields (no DELETE on
// meshes — preserves the FK from vaults.home_mesh_rid)
// 5. deleteAllVaultsByMesh + deleteAllEdgesByRefMesh +
// deleteAllSubscriptionsByMesh on the 3 child tables
// 6. re-INSERT @MESH_HOME rows via addVaultToMesh(role='home');
// re-INSERT @MESH_EDGE rows via insertMeshEdge; re-INSERT
// @MESH_SUBSCRIPTION rows via addSubscription
// 7. COMMIT
//
// Per-mesh transactions (OD-7 default) keep the blast radius small —
// one mesh's parse error doesn't roll back successful rebuilds for the
// others.
//
// Open-once seam from the start (v1.A.5 CR-B1 + v1.D.1-5 vindication):
// accept optional `registryDb?: Client`; only `openRegistry()` when
// omitted; caller owns lifecycle when supplied. Mirrors rebuild-lanes,
// rebuild-arcs, rebuild-fts.
//
// Lock 0.3 deterministic output: same set of registered meshes + same
// disk state + same `nowIso` seam = byte-identical JSON. Per-mesh
// outcome ordering follows `listMeshes` (ORDER BY name ASC).

export type MeshRebuildStatus = "ok" | "parse-error" | "skipped";

export interface MeshRebuildOutcome {
  meshName: string;
  meshRidHex: string;
  parsedFrom: string;
  homeVaults: number;
  edges: number;
  subscriptions: number;
  status: MeshRebuildStatus;
  error?: string;
}

export interface RebuildMeshRegistryTotalsByTable {
  meshes: number;
  mesh_vaults: number;
  mesh_edges: number;
  mesh_subscriptions: number;
}

export interface RebuildMeshRegistryResult {
  meshes: MeshRebuildOutcome[];
  totalsByTable: RebuildMeshRegistryTotalsByTable;
  durationMs: number;
}

export interface RebuildMeshRegistryArgs {
  // When set, scope the rebuild to a single mesh by name. When omitted,
  // every registered mesh is rebuilt.
  meshName?: string;
  // Open-once seam — when omitted the flow opens its own registry
  // client + closes it; when supplied the caller owns lifecycle.
  registryDb?: Client;
  // Reserved for callers that want a deterministic "now" timestamp in
  // future output fields. Currently unused (the flow has no fields that
  // need it); accepted at the signature so v1.B.2d / v1.C.x can add one
  // without changing the call surface.
  nowIso?: string;
}

// v1.B.2 — structured error for `--mesh <name>` not found in registry.
// Carries an `errorCode` so the CLI layer can distinguish "no such
// mesh" (exit 2) from "rebuild failed" (exit 1).
export class MeshNotFoundError extends Error {
  readonly errorCode = "mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh rebuild-registry: no mesh registered with name '${meshName}'. Use 'lyt mesh list' to see registered meshes.`,
    );
    this.name = "MeshNotFoundError";
    this.meshName = meshName;
  }
}

export async function rebuildMeshRegistryFlow(
  args: RebuildMeshRegistryArgs = {},
): Promise<RebuildMeshRegistryResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // 1. Enumerate target meshes.
    const targets = await resolveTargets(db, args.meshName);

    // 2. Per-mesh rebuild.
    const outcomes: MeshRebuildOutcome[] = [];
    for (const mesh of targets) {
      outcomes.push(await rebuildOneMesh(db, mesh));
    }

    const totalsByTable = outcomes.reduce<RebuildMeshRegistryTotalsByTable>(
      (acc, o) => {
        if (o.status === "ok") {
          acc.meshes += 1;
          acc.mesh_vaults += o.homeVaults;
          acc.mesh_edges += o.edges;
          acc.mesh_subscriptions += o.subscriptions;
        }
        return acc;
      },
      { meshes: 0, mesh_vaults: 0, mesh_edges: 0, mesh_subscriptions: 0 },
    );

    return {
      meshes: outcomes,
      totalsByTable,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

async function resolveTargets(db: Client, meshName?: string): Promise<MeshRow[]> {
  if (meshName === undefined) {
    return listMeshes(db);
  }
  const one = await getMeshByName(db, meshName);
  if (one === null) {
    throw new MeshNotFoundError(meshName);
  }
  return [one];
}

async function rebuildOneMesh(db: Client, mesh: MeshRow): Promise<MeshRebuildOutcome> {
  const meshRidHex = mesh.ridHex;
  // 1. Resolve main vault path.
  let mainVaultPath: string | null = null;
  if (mesh.mainVaultRid !== null) {
    const vault = await getVaultByRid(db, mesh.mainVaultRid);
    if (vault !== null) mainVaultPath = vault.path;
  } else {
    // Fall back to first home vault when the main_vault_rid is null —
    // matches the canvas-mesh.ts main-vault fallback shape.
    const homes = await listVaultsInMesh(db, mesh.rid);
    const firstHome = homes.find((h) => h.role === "home");
    if (firstHome !== undefined) {
      const vault = await getVaultByRid(db, firstHome.vaultRid);
      if (vault !== null) mainVaultPath = vault.path;
    }
  }

  // V-B-8b fix-pass (2026-06-09) — non-circular bootstrap. When BOTH
  // meshes.main_vault_rid is null AND mesh_vaults has no `home` row (the V-B-4
  // adopt drift), neither resolution above finds the main vault, and rebuild
  // used to "circular-fail" — it needs main_vault to locate the very mesh.yon it
  // would rebuild main_vault FROM. Break the cycle by resolving the main vault
  // path from the VAULT-SIDE home_mesh_rid + the `<mesh>/main` convention (still
  // populated in the drift). Once the path resolves, the parse below re-anchors
  // main_vault + re-inserts the @MESH_HOME rows from the on-disk SoT.
  if (mainVaultPath === null) {
    mainVaultPath = await resolveMainVaultPathByConvention(db, mesh);
  }

  if (mainVaultPath === null) {
    return {
      meshName: mesh.name,
      meshRidHex,
      parsedFrom: "",
      homeVaults: 0,
      edges: 0,
      subscriptions: 0,
      status: "skipped",
      error: "no main vault registered for this mesh; cannot resolve .lyt/mesh.yon path",
    };
  }

  const meshYonPath = join(mainVaultPath, ".lyt", "mesh.yon");

  // 2. Try read + parse — per-mesh try/catch so a single corrupted file
  // doesn't poison the rebuild for other meshes (OD-6 skip-and-warn).
  let parsed;
  try {
    const content = readFileSync(meshYonPath, "utf8");
    parsed = parseMeshYon(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      meshName: mesh.name,
      meshRidHex,
      parsedFrom: meshYonPath,
      homeVaults: 0,
      edges: 0,
      subscriptions: 0,
      status: "parse-error",
      error: message,
    };
  }

  // 3+4+5+6+7. Per-mesh transaction.
  try {
    await db.execute("BEGIN");
    try {
      // 4. UPDATE meshes row from parsed @MESH fields. No DELETE — the FK
      // from vaults.home_mesh_rid points at meshes(rid); deleting the
      // row mid-rebuild would null out home_mesh_rid on every vault
      // that points at this mesh. UPDATE keeps the rid stable.
      await db.execute({
        sql: `UPDATE meshes
 SET name = ?, push_target = ?, push_kind = ?, created_at = ?
              WHERE rid = ?`,
        args: [
          parsed.mesh.name,
          parsed.mesh.pushTarget ?? null,
          parsed.mesh.pushKind ?? null,
          parsed.mesh.createdAt,
          mesh.rid,
        ],
      });
      // Re-anchor the main_vault_rid in case the parsed mesh.yon has
      // moved it (shouldn't happen in v1, but the SoT wins).
      if (!ridsEqual(parsed.mesh.mainVaultRid, mesh.mainVaultRid)) {
        await updateMeshMainVault(db, mesh.rid, parsed.mesh.mainVaultRid);
      }

      // 5. Wipe the 3 child tables for this mesh.
      await deleteAllVaultsByMesh(db, mesh.rid);
      await deleteAllEdgesByRefMesh(db, mesh.rid);
      await deleteAllSubscriptionsByMesh(db, mesh.rid);

      // 6. Re-INSERT from parsed records.
      for (const home of parsed.homeVaults) {
        await addVaultToMesh(db, mesh.rid, home.vaultRid, "home");
      }
      for (const e of parsed.edges) {
        await insertMeshEdge(db, {
          refMeshRid: e.refMeshRid,
          refVaultRid: e.refVaultRid,
          homeMeshRid: e.homeMeshRid,
          homeVaultRid: e.homeVaultRid,
          kind: e.kind,
        });
      }
      for (const s of parsed.subscriptions) {
        await addSubscription(db, {
          meshRid: s.meshRid,
          externalVaultRid: s.externalVaultRid,
          externalMeshRid: s.externalMeshRid,
          externalMeshName: s.externalMeshName,
        });
      }

      await db.execute("COMMIT");
    } catch (innerErr) {
      try {
        await db.execute("ROLLBACK");
      } catch {
        // best-effort
      }
      throw innerErr;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      meshName: mesh.name,
      meshRidHex,
      parsedFrom: meshYonPath,
      homeVaults: 0,
      edges: 0,
      subscriptions: 0,
      status: "parse-error",
      error: message,
    };
  }

  return {
    meshName: parsed.mesh.name,
    meshRidHex: uuid7BytesToHex(parsed.mesh.rid),
    parsedFrom: meshYonPath,
    homeVaults: parsed.homeVaults.length,
    edges: parsed.edges.length,
    subscriptions: parsed.subscriptions.length,
    status: "ok",
  };
}
