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

import { join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByRid } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByRid } from "../registry/repo.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { uuid7BytesToDashedString, uuid7BytesToHex } from "../util/uuid7.js";
import { appendMeshEdgeActive } from "../yon/mesh-edge-ledger-write.js";
import { liveMeshEdges } from "../yon/mesh-edge-ledger-read.js";

// v1.C.1 Slice 2a — `lyt mesh add-edge --child <ref-vault> --parent <home-vault>`.
//
// Slice 2a REFIT: an edge is no longer a @MESH_EDGE block in the parent
// mesh's mesh.yon. It is now an `active` record in THIS writer's append-only
// mesh-edge ledger shard (`<podRoot>/ledger/mesh-edges/<writerId>/`,
// yon/mesh-edge-ledger-{write,read}.ts), reconstituted into the `mesh_edges`
// cache by rebuildFederationCacheFlow. This flow APPENDS the ledger record; it
// no longer reads/renders/renames mesh.yon and no longer does an in-txn cache
// insert. The cache goes stale until the next reconstitution (mirrors the
// subscribe.ts:378-407 rewiring off the @MESH_SUBSCRIPTION block).
//
// Order of operations:
// 1. Resolve child + parent vaults via getVaultByName (both must exist).
// 2. Resolve parent's home mesh + its main vault (main vault must still be
//    registered locally — the structural pre-flight refusals are preserved so
//    `lyt vault add-edge` / `lyt mesh add-edge` keep their actionable errors
//    + exit-code contract).
// 3. Build the edge's identity 3-tuple `(ref_mesh, ref_vault, home_vault)` +
//    its home_mesh VALUE: parent is the REF side, child is the HOME side.
// 4. Idempotent re-emit guard: if `liveMeshEdges()` already contains a live
//    edge with the same 3-tuple, return `edge-already-present` without
//    appending a duplicate active record (mirrors subscribe.ts idempotence).
// 5. Append one `active` @MESH_EDGE record to THIS writer's own shard — the
//    durable convergent side-effect.
//
// Open-once seam (v1.A.5 CR-B1 vindicated 12 times): callers may pass
// `registryDb`; the flow opens its own client only when omitted. (The registry
// is still consulted for the resolution/refusal pre-flight; the edge write
// itself targets the ledger.)

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
// per the ratified default (1 vault-not-found vault-no-home-mesh; 4 main-vault-missing).

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

    // 3. Locate the parent's home mesh's mesh.yon path for the result summary
    //    (no longer read/written — the edge lives in the ledger now). The
    //    main-vault-missing refusal is preserved structurally; the path is
    //    reported so callers/CLI still surface where the parent mesh lives.
    const meshYonPath = join(parentMainVault.path, ".lyt", "mesh.yon");

    // 4. Build the edge identity 3-tuple + its home_mesh VALUE. Parent is the
    //    REFERENCING side (ref_mesh + ref_vault). Child is the REFERENCED side
    //    (home_vault = child vault; home_mesh = child's actual home mesh, a
    //    VALUE/free-rider — NOT part of the 3-tuple identity). kind reads as
    //    "ref IS parent of home". Rids serialised as bare dashed-UUIDv7 for the
    //    ledger (subscription/alias parity).
    const refMeshRidStr = uuid7BytesToDashedString(parentMesh.rid);
    const refVaultRidStr = uuid7BytesToDashedString(parentVault.rid);
    const homeVaultRidStr = uuid7BytesToDashedString(childVault.rid);
    const homeMeshRidStr = uuid7BytesToDashedString(childVault.homeMeshRid);

    const edgeHexes: AddMeshEdgeEdgeSummary = {
      refMeshRidHex: uuid7BytesToHex(parentMesh.rid),
      refVaultRidHex: uuid7BytesToHex(parentVault.rid),
      homeMeshRidHex: uuid7BytesToHex(childVault.homeMeshRid),
      homeVaultRidHex: uuid7BytesToHex(childVault.rid),
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

    // 5. Idempotent re-emit guard — re-keyed onto the OR-Set 2-tuple (FU-1). The
    //    live set is the add-wins fold over every writer's append-only shard; an
    //    edge already live (active in some shard, not tombstone-superseded) means
    //    this add-edge is a no-op. (ref_mesh + home_mesh + kind are VALUES,
    //    excluded from the identity comparison — they are derived/fixed.)
    const alreadyPresent = liveMeshEdges().some(
      (e) => e.refVaultRid === refVaultRidStr && e.homeVaultRid === homeVaultRidStr,
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

    // 6. Append one `active` @MESH_EDGE record to THIS writer's own shard — the
    //    durable convergent side-effect. The mesh.yon write + the in-txn
    //    mesh_edges cache insert are RETIRED (no-legacy): mesh.yon no longer
    //    carries edges, and the cache is EXPECTED to go stale until the next
    //    reconstitution (rebuildFederationCacheFlow). Mirrors subscribe.ts:403.
    appendMeshEdgeActive({
      refMeshRid: refMeshRidStr,
      refVaultRid: refVaultRidStr,
      homeVaultRid: homeVaultRidStr,
      homeMeshRid: homeMeshRidStr,
      kind: "parent",
    });

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
