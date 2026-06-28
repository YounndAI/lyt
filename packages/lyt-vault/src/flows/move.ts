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
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { addVaultToMesh, removeVaultFromMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName, getMeshByRid } from "../registry/meshes-repo.js";
import {
  getVaultByName,
  getVaultByRid,
  setVaultHomeMesh,
  listMeshEdgesByHomeVault,
} from "../registry/repo.js";
import { assertVaultHomeMesh, type CommitVerdict } from "../registry/assert-committed.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { assertMeshNameNotReserved } from "../util/identity.js";
import { ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { renderMeshYon, type MeshDoc } from "../yon/mesh-write.js";
import { appendMeshEdgeTombstone } from "../yon/mesh-edge-ledger-write.js";
import { parseVaultYon } from "../yon/parse.js";
import { renderVaultYon } from "../yon/vault.js";
import { hexToUuid7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";

// v1.B.3 Commit 2 — `lyt vault move <name> --to-mesh <mesh> [--solo|--branch]`.
//
// Rid-stable cross-mesh transfer. The moved vault keeps its UUIDv7 rid
// across the move; only the home_mesh assignment + mesh.yon membership
// changes. Two-file disk write (source mesh.yon + target mesh.yon) is
// atomic via tmp+rename; registry tx wraps the mesh_vaults +
// mesh_edges updates in one BEGIN/COMMIT; on registry-tx failure both
// tmp files are cleaned up so disk is unchanged.
//
// Branch vs solo (master-plan §v1.B.3:526; brief ):
// - Default `branch` mode (or --branch): the moved vault BRINGS its
// child @MESH_EDGE rows with it — every edge where
// home_vault_rid === movingVault.rid gets re-rooted by rewriting
// home_mesh_rid → targetMesh.rid (preserves ref_* fields so the
// REFERENCING meshes keep pointing at the same vault rid via the
// same composite key).
// - `--solo` mode: child @MESH_EDGE rows are DROPPED from the source
// mesh.yon with a cold-warn (the dropped edges are surfaced in the
// result so the CLI can warn).
// - Without --solo / --branch + child edges present: the CLI layer
// fires a prompt. The flow itself REQUIRES an explicit mode — if
// called with `mode: 'prompt'` when children exist, throws
// BranchVsSoloPromptRequiredError so the caller (CLI / future MCP)
// can surface the prompt.
//
// Pre-flight refusals:
// - moving the main vault is forbidden (mesh would dissolve; per
// federation-design.md §3 the main vault is structurally locked)
// - moving to the same mesh is a no-op error
//
// Atomicity contract:
// 1. Parse both mesh.yons → MeshDoc
// 2. Compute updated docs in-memory
// 3. Write both tmp files (.tmp-<pid>-<ts>) — disk still untouched
// 4. BEGIN registry tx — UPDATE vaults.home_mesh_rid + UPDATE
// mesh_vaults rows + UPDATE/DELETE mesh_edges rows
// 5. On registry tx error: ROLLBACK + delete both tmp files; throw.
// 6. On registry tx success: COMMIT, then atomic tmp+rename for
// source + target mesh.yon
// 7. mesh.yon writes happen LAST so a registry tx failure leaves disk
// pristine.

export type MoveVaultMode = "branch" | "solo" | "prompt";

export class BranchVsSoloPromptRequiredError extends Error {
  readonly errorCode = "branch-vs-solo-prompt-required";
  readonly childEdgeCount: number;
  constructor(childEdgeCount: number) {
    super(
      `lyt vault move: vault has ${childEdgeCount} child @MESH_EDGE row${childEdgeCount === 1 ? "" : "s"} but neither --solo nor --branch was specified. ` +
        `Pass --branch to move the children with it (re-root edges), or --solo to drop the child edges with a warning.`,
    );
    this.name = "BranchVsSoloPromptRequiredError";
    this.childEdgeCount = childEdgeCount;
  }
}

export class MoveVaultNotFoundError extends Error {
  readonly errorCode = "move-vault-not-found";
  readonly vaultName: string;
  constructor(vaultName: string) {
    super(
      `lyt vault move: no vault registered with name '${vaultName}'. Use 'lyt vault list' to see registered vaults.`,
    );
    this.name = "MoveVaultNotFoundError";
    this.vaultName = vaultName;
  }
}

export class MoveTargetMeshNotFoundError extends Error {
  readonly errorCode = "move-target-mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt vault move --to-mesh: no mesh registered with name '${meshName}'. Run 'lyt mesh init ${meshName}' first.`,
    );
    this.name = "MoveTargetMeshNotFoundError";
    this.meshName = meshName;
  }
}

export class MoveSameMeshError extends Error {
  readonly errorCode = "move-same-mesh";
  constructor(meshName: string) {
    super(
      `lyt vault move: source and target mesh are both '${meshName}' — no-op refused. To rename the vault, use 'lyt vault rename'.`,
    );
    this.name = "MoveSameMeshError";
  }
}

export class MoveMainVaultForbiddenError extends Error {
  readonly errorCode = "move-main-vault-forbidden";
  constructor(vaultName: string) {
    super(
      `lyt vault move: '${vaultName}' is the main vault of its mesh — main vaults are structurally locked (per federation-design §3). Moving the main vault would dissolve the mesh.`,
    );
    this.name = "MoveMainVaultForbiddenError";
  }
}

export interface MoveVaultArgs {
  vaultName: string;
  toMeshName: string;
  mode?: MoveVaultMode | undefined;
  registryDb?: Client | undefined;
  nowIso?: string | undefined;
}

export interface DroppedEdgeSummary {
  homeMeshRidHex: string;
  refMeshRidHex: string;
  refVaultRidHex: string;
}

export interface ReRootedEdgeSummary {
  homeMeshRidHexBefore: string;
  homeMeshRidHexAfter: string;
  refMeshRidHex: string;
  refVaultRidHex: string;
}

export interface MoveVaultResult {
  vaultRidHex: string;
  vaultName: string;
  fromMeshName: string;
  fromMeshRidHex: string;
  toMeshName: string;
  toMeshRidHex: string;
  mode: "branch" | "solo";
  childEdgesReRooted: ReRootedEdgeSummary[];
  childEdgesDropped: DroppedEdgeSummary[];
  sourceMeshYonPath: string;
  targetMeshYonPath: string;
  vaultYonPath: string;
  durationMs: number;
  // 0.9.4 (3d) — read-back verdict. `verified` when the post-COMMIT re-read
  // confirms vaults.home_mesh_rid === target; `unverified` otherwise. The CLI
  // appends `unverifiedNote` to the success line on an unverified outcome
  // instead of printing an unconditional "Moved … atomically updated".
  committed: CommitVerdict;
  unverifiedNote: string | null;
}

export async function moveVaultFlow(args: MoveVaultArgs): Promise<MoveVaultResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // Fed-v2 Layer-1 (Phase release review) — guard-bypass close. `vault move
    // --to-mesh <reserved>` reached mesh homing WITHOUT routing through
    // validateMeshName / validateVaultName, so a user could occupy a system
    // bucket (`subscriptions/{owner}`) and reach the dormant display-vs-coordinate
    // overlap. Mirror validateVaultName's mesh-segment extraction: when the
    // target is qualified `{mesh}/{leaf}`, segments[0] is the mesh slot; a bare
    // target IS the mesh name. Assert non-reserved BEFORE any resolution. The
    // system's own bucket creation (rebuildFederationCacheFlow → insertMesh) does
    // not route through here, so it is unaffected.
    assertMeshNameNotReserved(args.toMeshName.split("/")[0]!);

    // 1. Resolve vault + source mesh + target mesh.
    const vault = await getVaultByName(db, args.vaultName);
    if (vault === null) throw new MoveVaultNotFoundError(args.vaultName);
    // hardening pass (fix-pass): a mesh-hop is a structural mutation of the vault's
    // home — F13 chokepoint at flow entry.
    await enforceNotFrozen(vault.path, vault.name);

    const targetMesh = await getMeshByName(db, args.toMeshName);
    if (targetMesh === null) throw new MoveTargetMeshNotFoundError(args.toMeshName);

    if (vault.homeMeshRid === null) {
      throw new Error(
        `lyt vault move: vault '${args.vaultName}' has no home mesh assignment. Run 'lyt vault init' or 'lyt vault clone --to-mesh' first to bind it to a mesh.`,
      );
    }
    if (ridsEqual(vault.homeMeshRid, targetMesh.rid)) {
      throw new MoveSameMeshError(args.toMeshName);
    }

    const sourceMesh = await getMeshByRid(db, vault.homeMeshRid);
    if (sourceMesh === null) {
      throw new Error(
        `lyt vault move: vault.home_mesh_rid points at a mesh that doesn't exist in the registry (defensive).`,
      );
    }

    // 2. Refuse moving a main vault.
    if (sourceMesh.mainVaultRid !== null && ridsEqual(sourceMesh.mainVaultRid, vault.rid)) {
      throw new MoveMainVaultForbiddenError(args.vaultName);
    }

    // 3. Find child edges (edges where THIS vault is the home_vault — i.e.
    // children of this vault in other meshes' mesh.yons).
    const childEdges = await listMeshEdgesByHomeVault(db, vault.rid);

    // 4. Resolve mode.
    let mode: "branch" | "solo";
    if (args.mode === "solo") mode = "solo";
    else if (args.mode === "branch") mode = "branch";
    else {
      // mode === 'prompt' or undefined.
      if (childEdges.length > 0) {
        throw new BranchVsSoloPromptRequiredError(childEdges.length);
      }
      mode = "branch"; // no children — branch and solo are equivalent
    }

    // 5. Resolve mesh.yon paths.
    const sourceMainVault = sourceMesh.mainVaultRid
      ? await getVaultByRid(db, sourceMesh.mainVaultRid)
      : null;
    if (sourceMainVault === null) {
      throw new Error(
        `lyt vault move: source mesh '${sourceMesh.name}' has no main vault; cannot locate mesh.yon.`,
      );
    }
    const targetMainVault = targetMesh.mainVaultRid
      ? await getVaultByRid(db, targetMesh.mainVaultRid)
      : null;
    if (targetMainVault === null) {
      throw new MoveTargetMeshNotFoundError(args.toMeshName);
    }
    const sourceMeshYonPath = join(sourceMainVault.path, ".lyt", "mesh.yon");
    const targetMeshYonPath = join(targetMainVault.path, ".lyt", "mesh.yon");
    const vaultYonPath = join(vault.path, ".lyt", "vault.yon");

    // 6. Compute updated docs in memory.
    const sourceDoc = parseMeshYon(readFileSync(sourceMeshYonPath, "utf8"));
    const targetDoc = parseMeshYon(readFileSync(targetMeshYonPath, "utf8"));

    // Source: drop the @MESH_HOME row for the moving vault.
    const movedHome = sourceDoc.homeVaults.find((h) => ridsEqual(h.vaultRid, vault.rid));
    if (movedHome === undefined) {
      throw new Error(
        `lyt vault move: vault '${args.vaultName}' not in source mesh '${sourceMesh.name}' .lyt/mesh.yon; SoT and registry are out of sync (run 'lyt mesh rebuild-registry' to re-derive).`,
      );
    }
    // Slice 2a — edges no longer live in mesh.yon (the per-writer mesh-edge
    // ledger is the SoT, reconstituted into the mesh_edges cache). So move no
    // longer rewrites @MESH_EDGE blocks. The two modes differ only in what they
    // do to the moving vault's CHILD edges (edges where home_vault === this
    // vault, sourced from the `mesh_edges` cache as `childEdges` above):
    //
    // - BRANCH mode: NO edge ledger write at all. `home_mesh_rid` is a VALUE,
    //   not part of the edge's OR-Set identity 3-tuple, and it is DERIVED at
    //   reconstitution from the live home vault's `home_mesh_rid`. Since this
    //   move re-homes the vault (`@MESH_HOME` membership + vaults.home_mesh_rid),
    //   the next reconstitution re-derives every child edge's home_mesh to the
    //   target mesh automatically — the edge "moves with" the vault for free.
    //   (Design build-stop addendum: branch-mode needs no edge write — proven by
    //   the reconstitution DERIVE.)
    //
    // - SOLO mode: drop the child edges by appending a TOMBSTONE for each one's
    //   identity 3-tuple to THIS writer's mesh-edge ledger shard. The add-wins
    //   fold then removes them from the live set (cache catches up on the next
    //   reconstitution). A partial solo self-heals on rebuild (idempotent
    //   reconstitution), so no commit gymnastics are needed.
    const reRootedEdges = mode === "branch" ? childEdges : [];
    const droppedEdges = mode === "solo" ? childEdges : [];

    // mesh.yon updates now manage ONLY @MESH_HOME membership.
    const sourceUpdated: MeshDoc = {
      ...sourceDoc,
      homeVaults: sourceDoc.homeVaults.filter((h) => !ridsEqual(h.vaultRid, vault.rid)),
    };
    const targetUpdated: MeshDoc = {
      ...targetDoc,
      homeVaults: [
        ...targetDoc.homeVaults.filter((h) => !ridsEqual(h.vaultRid, vault.rid)),
        {
          meshRid: targetMesh.rid,
          vaultRid: vault.rid,
          vaultName: vault.name,
        },
      ],
    };

    // 7. Write tmp files (no disk mutation of canonical paths yet).
    const sourceTmp = `${sourceMeshYonPath}.tmp-${process.pid}-${Date.now()}`;
    const targetTmp = `${targetMeshYonPath}.tmp-${process.pid}-${Date.now()}-2`;
    writeFileSync(sourceTmp, renderMeshYon(sourceUpdated), "utf8");
    writeFileSync(targetTmp, renderMeshYon(targetUpdated), "utf8");

    // Also re-render vault.yon with the new @VAULT_HOME_MESH binding (rid
    // stable; only mesh_rid + mesh_name + assigned_at flip).
    const vaultYonBefore = readFileSync(vaultYonPath, "utf8");
    const vaultParsed = parseVaultYon(vaultYonBefore);
    const memscopeBytes = vaultParsed.memscopeRid
      ? hexToUuid7Bytes(vaultParsed.memscopeRid)
      : undefined;
    const parentBytes = vaultParsed.parentVault
      ? hexToUuid7Bytes(vaultParsed.parentVault)
      : undefined;
    const nowIso = args.nowIso ?? new Date().toISOString();
    const newVaultYon = renderVaultYon({
      vault: {
        rid: vault.rid,
        name: vault.name,
        ...(vaultParsed.desc !== null ? { desc: vaultParsed.desc } : {}),
        ...(parentBytes !== undefined ? { parentVault: parentBytes } : {}),
        ...(vaultParsed.tierHint !== null ? { tierHint: vaultParsed.tierHint } : {}),
        ...(memscopeBytes !== undefined ? { memscope: memscopeBytes } : {}),
        createdAt: vaultParsed.createdAt ?? nowIso,
        version: vaultParsed.version ?? "0.1",
      },
      ...(vaultParsed.gitUrl !== null ? { gitUrl: vaultParsed.gitUrl } : {}),
      primaryOwner: vaultParsed.primaryOwner ?? "github:unknown",
      lifecycle:
        vaultParsed.lifecycle === "active" ||
        vaultParsed.lifecycle === "archived" ||
        vaultParsed.lifecycle === "frozen"
          ? vaultParsed.lifecycle
          : "active",
      topics: vaultParsed.topics,
      ...(vaultParsed.agentTemplateVersion !== null
        ? { agentTemplateVersion: vaultParsed.agentTemplateVersion }
        : {}),
      // Phase A — preserve scaffold-system version stamps across parse→render.
      // SEE ALSO: yon/parse.ts ParsedVaultYon + yon/vault.ts renderVaultYon.
      ...(vaultParsed.templateVersion !== null
        ? { templateVersion: vaultParsed.templateVersion }
        : {}),
      ...(vaultParsed.contractVersion !== null
        ? { contractVersion: vaultParsed.contractVersion }
        : {}),
      homeMesh: {
        vaultRid: vault.rid,
        meshRid: targetMesh.rid,
        meshName: targetMesh.name,
        assignedAt: nowIso,
      },
    });
    const vaultTmp = `${vaultYonPath}.tmp-${process.pid}-${Date.now()}-3`;
    writeFileSync(vaultTmp, newVaultYon, "utf8");

    // 8. Registry tx. On error: delete tmp files; throw.
    try {
      await db.execute("BEGIN");
      try {
        // Update vaults.home_mesh_rid.
        await setVaultHomeMesh(db, vault.rid, targetMesh.rid);
        // mesh_vaults: remove from source, add to target.
        await removeVaultFromMesh(db, sourceMesh.rid, vault.rid);
        await addVaultToMesh(db, targetMesh.rid, vault.rid, "home");
        // Slice 2a: NO mesh_edges mutation in this txn. The edge cache is
        // owned by rebuildFederationCacheFlow's ledger reconstitution. Branch
        // mode re-homes child edges via the DERIVE (no write); solo mode tombs
        // them on the ledger (below). Either way the cache catches up on the
        // next reconstitution — the move txn only touches vaults / mesh_vaults.
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
      // Registry tx failed — clean up tmp files; disk pristine.
      cleanupTmp(sourceTmp);
      cleanupTmp(targetTmp);
      cleanupTmp(vaultTmp);
      throw err;
    }

    // 9. Atomic tmp+rename for the three files. Order: vault.yon first,
    // then source mesh.yon, then target mesh.yon. If any rename throws
    // post-COMMIT, the registry is already mutated; we surface the error
    // but the registry is canonical — subsequent rebuild-registry will
    // re-derive the inconsistent mesh.yon.
    mkdirSync(dirname(vaultYonPath), { recursive: true });
    renameSync(vaultTmp, vaultYonPath);
    mkdirSync(dirname(sourceMeshYonPath), { recursive: true });
    renameSync(sourceTmp, sourceMeshYonPath);
    mkdirSync(dirname(targetMeshYonPath), { recursive: true });
    renameSync(targetTmp, targetMeshYonPath);

    // Slice 2a — SOLO mode: retract each child edge by appending a TOMBSTONE
    // for its identity 3-tuple to THIS writer's mesh-edge ledger shard. Done
    // AFTER the renames (the move is the durable event); a partial run self-heals
    // on the next idempotent reconstitution. BRANCH mode appends NOTHING — the
    // edge re-homes via the reconstitution DERIVE off the moved vault.
    if (mode === "solo") {
      for (const e of droppedEdges) {
        appendMeshEdgeTombstone({
          refMeshRid: uuid7BytesToDashedString(e.refMeshRid),
          refVaultRid: uuid7BytesToDashedString(e.refVaultRid),
          homeVaultRid: uuid7BytesToDashedString(e.homeVaultRid),
          homeMeshRid: uuid7BytesToDashedString(e.homeMeshRid),
          kind: "parent",
        });
      }
    }

    // 0.9.4 (3d) — read-back guard on top of the transaction. Re-read the row
    // and assert home_mesh_rid actually flipped to the target before claiming
    // success. Closes the "reported success without effect" class (the move-bug symptom).
    const committed = await assertVaultHomeMesh(db, vault.rid, targetMesh.rid);

    return {
      vaultRidHex: uuid7BytesToHex(vault.rid),
      vaultName: vault.name,
      fromMeshName: sourceMesh.name,
      fromMeshRidHex: sourceMesh.ridHex,
      toMeshName: targetMesh.name,
      toMeshRidHex: targetMesh.ridHex,
      mode,
      // Slice 2a — branch-mode child edges are DERIVED-re-homed at
      // reconstitution (no ledger write). The "after" home mesh is the target,
      // reflecting where the derive will home them on the next rebuild.
      childEdgesReRooted: reRootedEdges.map((e) => ({
        homeMeshRidHexBefore: uuid7BytesToHex(sourceMesh.rid),
        homeMeshRidHexAfter: uuid7BytesToHex(targetMesh.rid),
        refMeshRidHex: e.refMeshRidHex,
        refVaultRidHex: e.refVaultRidHex,
      })),
      // Solo-mode child edges are TOMBSTONED on the ledger (count reflects the
      // tombstones appended).
      childEdgesDropped: droppedEdges.map((e) => ({
        homeMeshRidHex: e.homeMeshRidHex,
        refMeshRidHex: e.refMeshRidHex,
        refVaultRidHex: e.refVaultRidHex,
      })),
      sourceMeshYonPath,
      targetMeshYonPath,
      vaultYonPath,
      durationMs: Date.now() - startedAt,
      committed: committed.verdict,
      unverifiedNote: committed.unverifiedNote,
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
