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

import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { insertMeshEdge } from "../registry/mesh-edges-repo.js";
import { getMeshByRid } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByRid } from "../registry/repo.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { renderMeshYon, type MeshDoc, type MeshEdgeRecord } from "../yon/mesh-write.js";

// v1.C.1 — `lyt mesh add-edge --child <ref-vault> --parent <home-vault>`.
//
// Writes a single @MESH_EDGE row into the REFERENCING mesh's mesh.yon
// (the parent's home mesh) per lyt-federation-design.md §3:155-157
// asymmetric-awareness invariant — the referenced (child's) home mesh's
// mesh.yon is never touched. The same transaction inserts the row into
// the per-machine `mesh_edges` cache (regenerable per master-plan §G-6;
// `lyt mesh rebuild-registry` would re-derive it from mesh.yon SoT on
// any later reset).
//
// Order of operations:
// 1. Resolve child + parent vaults via getVaultByName (both must exist).
// 2. Resolve parent's home mesh + its main vault (main vault must be
// registered locally — mesh.yon writes only land on main vaults per
// naming-convention "main vault locked to main").
// 3. Read + parse the parent's home mesh's `.lyt/mesh.yon`.
// 4. Construct the MeshEdgeRecord using the parent as the ref side and
// the child as the home side (so the @MESH_EDGE record reads as
// "ref vault is parent of home vault").
// 5. Idempotent re-emit guard: if MeshDoc.edges already contains a row
// with the same (ref_mesh_rid, ref_vault_rid, home_mesh_rid,
// home_vault_rid, kind=parent) tuple, return `edge-already-present`
// without mutating disk or cache (per OD-6 + v1.B.6 D2 mesh.yon-
// mutation-discipline + v1.B.2 Lock 0.3 byte-stability).
// 6. Render the updated MeshDoc → tmp file (no disk mutation yet).
// 7. BEGIN tx → insertMeshEdge into `mesh_edges` cache. On failure:
// ROLLBACK + abandon tmp file (disk pristine).
// 8. COMMIT, then atomic rename tmp → mesh.yon.
//
// Open-once seam (v1.A.5 CR-B1 vindicated 12 times): callers may pass
// `registryDb`; the flow opens its own client only when omitted.
//
// Atomicity contract (mirrors flows/move.ts:308-404):
// - Cache insert happens INSIDE the registry tx, BEFORE the mesh.yon
// rename. If the cache insert throws, the tx rolls back and the tmp
// file is removed — disk is unchanged.
// - Once the registry tx COMMITs the cache row exists; the rename then
// publishes mesh.yon atomically. A crash between COMMIT and rename
// leaves a registry row pointing at content that exists only in the
// tmp file; `lyt mesh rebuild-registry` re-derives the cache from
// mesh.yon (SoT primacy) and clears the orphan row on its next run.

export type AddMeshEdgeResultStatus = "edge-written" | "edge-already-present";

export interface AddMeshEdgeArgs {
  childVaultName: string;
  parentVaultName: string;
  // Open-once seam — when omitted the flow opens its own registry client
  // + closes it; when supplied the caller owns lifecycle.
  registryDb?: Client | undefined;
}

export interface AddMeshEdgeEdgeSummary {
  refMeshRidHex: string;
  refVaultRidHex: string;
  homeMeshRidHex: string;
  homeVaultRidHex: string;
  kind: "parent";
}

export interface AddMeshEdgeResult {
  status: AddMeshEdgeResultStatus;
  child: {
    ridHex: string;
    name: string;
    homeMeshRidHex: string;
  };
  parent: {
    ridHex: string;
    name: string;
    homeMeshRidHex: string;
    homeMeshName: string;
  };
  meshYonPath: string;
  edge: AddMeshEdgeEdgeSummary;
  durationMs: number;
}

// v1.C.1 — structured errors. CLI maps these to per-command exit codes
// per OD-5 (1 vault-not-found / vault-no-home-mesh; 4 main-vault-missing).

export class AddMeshEdgeVaultNotFoundError extends Error {
  readonly errorCode = "vault-not-found";
  readonly vaultName: string;
  readonly side: "child" | "parent";
  constructor(vaultName: string, side: "child" | "parent") {
    super(
      `lyt mesh add-edge: no vault registered with name '${vaultName}' (--${side}). Use 'lyt vault list' to see registered vaults.`,
    );
    this.name = "AddMeshEdgeVaultNotFoundError";
    this.vaultName = vaultName;
    this.side = side;
  }
}

export class AddMeshEdgeNoHomeMeshError extends Error {
  readonly errorCode = "vault-no-home-mesh";
  readonly vaultName: string;
  readonly side: "child" | "parent";
  constructor(vaultName: string, side: "child" | "parent") {
    super(
      `lyt mesh add-edge: vault '${vaultName}' (--${side}) has no home_mesh_rid assignment. Run 'lyt vault clone --to-mesh' or 'lyt mesh rebuild-registry' to bind it to a mesh.`,
    );
    this.name = "AddMeshEdgeNoHomeMeshError";
    this.vaultName = vaultName;
    this.side = side;
  }
}

export class AddMeshEdgeMainVaultMissingError extends Error {
  readonly errorCode = "main-vault-missing";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh add-edge: parent's home mesh '${meshName}' has no main vault registered locally; cannot write mesh.yon. Run 'lyt vault clone ${meshName}/main' or 'lyt mesh rebuild-registry' to restore the main vault.`,
    );
    this.name = "AddMeshEdgeMainVaultMissingError";
    this.meshName = meshName;
  }
}

export async function addMeshEdgeFlow(args: AddMeshEdgeArgs): Promise<AddMeshEdgeResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // 1. Resolve child + parent vaults.
    const childVault = await getVaultByName(db, args.childVaultName);
    if (childVault === null) {
      throw new AddMeshEdgeVaultNotFoundError(args.childVaultName, "child");
    }
    const parentVault = await getVaultByName(db, args.parentVaultName);
    if (parentVault === null) {
      throw new AddMeshEdgeVaultNotFoundError(args.parentVaultName, "parent");
    }
    // hardening pass (fix-pass): closes the sharpest seam pair the register pinned —
    // `vault add-edge` REFUSED a frozen child while `mesh add-edge` (this
    // flow) proceeded on the same user-visible operation. Same chokepoint,
    // same child-vault gate as flows/add-edge.ts.
    await enforceNotFrozen(childVault.path, childVault.name);
    if (childVault.homeMeshRid === null) {
      throw new AddMeshEdgeNoHomeMeshError(childVault.name, "child");
    }
    if (parentVault.homeMeshRid === null) {
      throw new AddMeshEdgeNoHomeMeshError(parentVault.name, "parent");
    }

    // 2. Resolve parent's home mesh + its main vault (mesh.yon write
    // target). The main vault MUST be registered locally — mesh.yon
    // writes only land on main vaults per naming-convention.
    const parentMesh = await getMeshByRid(db, parentVault.homeMeshRid);
    if (parentMesh === null) {
      // Defensive: vaults.home_mesh_rid points at no row. Treat as the
      // main-vault-missing class so the CLI exit code is 4.
      throw new AddMeshEdgeMainVaultMissingError(
        `(unknown mesh; parent vault home_mesh_rid=${parentVault.homeMeshRidHex})`,
      );
    }
    if (parentMesh.mainVaultRid === null) {
      throw new AddMeshEdgeMainVaultMissingError(parentMesh.name);
    }
    const parentMainVault = await getVaultByRid(db, parentMesh.mainVaultRid);
    if (parentMainVault === null) {
      throw new AddMeshEdgeMainVaultMissingError(parentMesh.name);
    }

    // 3. Locate + parse the parent's home mesh's mesh.yon. Per v1.B.1
    // every mesh-init writes the initial mesh.yon, so for a healthy
    // mesh the file exists. If it's absent treat as main-vault-missing
    // (the mesh dir state has drifted from the registry).
    const meshYonPath = join(parentMainVault.path, ".lyt", "mesh.yon");
    if (!existsSync(meshYonPath)) {
      throw new AddMeshEdgeMainVaultMissingError(parentMesh.name);
    }
    const before = readFileSync(meshYonPath, "utf8");
    const doc = parseMeshYon(before);

    // 4. Build the @MESH_EDGE record. Parent is the REFERENCING side
    // (ref_mesh + ref_vault). Child is the REFERENCED side (home_mesh
    // = child's actual home mesh + home_vault = child vault). kind
    // reads as "ref IS parent of home" per registry/migrations.ts
    // CHECK (kind IN ('parent')) + mesh-read.ts:160 reader gate.
    const newEdge: MeshEdgeRecord = {
      refMeshRid: parentMesh.rid,
      refVaultRid: parentVault.rid,
      homeMeshRid: childVault.homeMeshRid,
      homeVaultRid: childVault.rid,
      kind: "parent",
    };

    const edgeHexes: AddMeshEdgeEdgeSummary = {
      refMeshRidHex: uuid7BytesToHex(newEdge.refMeshRid),
      refVaultRidHex: uuid7BytesToHex(newEdge.refVaultRid),
      homeMeshRidHex: uuid7BytesToHex(newEdge.homeMeshRid),
      homeVaultRidHex: uuid7BytesToHex(newEdge.homeVaultRid),
      kind: "parent",
    };

    const childSummary = {
      ridHex: uuid7BytesToHex(childVault.rid),
      name: childVault.name,
      homeMeshRidHex: uuid7BytesToHex(childVault.homeMeshRid),
    };
    const parentSummary = {
      ridHex: uuid7BytesToHex(parentVault.rid),
      name: parentVault.name,
      homeMeshRidHex: uuid7BytesToHex(parentMesh.rid),
      homeMeshName: parentMesh.name,
    };

    // 5. Idempotent re-emit guard. Match on the full 5-tuple per brief
    // spec; structurally home_mesh_rid is determined by home_vault_rid
    // (a vault has exactly one home mesh) but matching all five keeps
    // parity with the migrations.ts mesh_edges PK projection.
    const alreadyPresent = doc.edges.some(
      (e) =>
        ridsEqual(e.refMeshRid, newEdge.refMeshRid) &&
        ridsEqual(e.refVaultRid, newEdge.refVaultRid) &&
        ridsEqual(e.homeMeshRid, newEdge.homeMeshRid) &&
        ridsEqual(e.homeVaultRid, newEdge.homeVaultRid) &&
        e.kind === newEdge.kind,
    );
    if (alreadyPresent) {
      return {
        status: "edge-already-present",
        child: childSummary,
        parent: parentSummary,
        meshYonPath,
        edge: edgeHexes,
        durationMs: Date.now() - startedAt,
      };
    }

    // 6. Render the updated MeshDoc → tmp file.
    const updatedDoc: MeshDoc = {
      ...doc,
      edges: [...doc.edges, newEdge],
    };
    const rendered = renderMeshYon(updatedDoc);
    const tmpPath = `${meshYonPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, rendered, "utf8");

    // 7. Registry tx + cache insert. On failure: ROLLBACK + abandon tmp.
    try {
      await db.execute("BEGIN");
      try {
        await insertMeshEdge(db, {
          refMeshRid: newEdge.refMeshRid,
          refVaultRid: newEdge.refVaultRid,
          homeMeshRid: newEdge.homeMeshRid,
          homeVaultRid: newEdge.homeVaultRid,
          kind: newEdge.kind,
        });
        await db.execute("COMMIT");
      } catch (innerErr) {
        try {
          await db.execute("ROLLBACK");
        } catch {
          /* best-effort */
        }
        throw innerErr;
      }
    } catch (err) {
      cleanupTmp(tmpPath);
      throw err;
    }

    // 8. Atomic rename tmp → mesh.yon. dirname is the existing main vault
    // `.lyt/`; mkdir is a defensive no-op (the parse above proves the
    // file existed, hence the dir does too).
    mkdirSync(dirname(meshYonPath), { recursive: true });
    renameSync(tmpPath, meshYonPath);

    return {
      status: "edge-written",
      child: childSummary,
      parent: parentSummary,
      meshYonPath,
      edge: edgeHexes,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

function cleanupTmp(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}
