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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import type { Client } from "@libsql/client";

import { getMeshByRid } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByRid, type VaultRow } from "../registry/repo.js";
import { regenMeshContextFromYon } from "../scaffold/mesh-context.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { hexToUuid7Bytes, ridsEqual, uuid7BytesToDashedString } from "../util/uuid7.js";
import { appendMeshEdgeTombstone } from "../yon/mesh-edge-ledger-write.js";
import { parseVaultYon } from "../yon/parse.js";
import { renderVaultYon, type VaultDoc } from "../yon/vault.js";
import {
  addMeshEdgeFlow,
  AddMeshEdgeMainVaultMissingError,
  AddMeshEdgeNoHomeMeshError,
} from "./add-mesh-edge.js";

export type AddEdgeKind = "share_with" | "parent";

// hardening pass (hardening fix-pass) — a parent edge to an UNREGISTERED peer used
// to die inside `UPDATE vaults SET parent_vault` with a raw
// SQLITE_CONSTRAINT_FOREIGNKEY (vaults.parent_vault FK references a local
// vault row). Guard the FK at the flow boundary with an actionable refusal
// naming the rid + the registration remedy. share_with edges keep accepting
// unregistered peers (vault.yon-only, cross-machine by design).
export class AddEdgeParentNotRegisteredError extends Error {
  readonly errorCode = "add-edge-parent-not-registered";
  readonly peerRid: string;
  constructor(peerRid: string, vaultName: string) {
    super(
      `lyt vault add-edge: parent rid '${peerRid}' is not a registered vault on this machine — ` +
        `a parent edge must reference a locally-registered vault. Register the parent first ` +
        `('lyt vault clone <url> --to-mesh <mesh>', 'lyt vault init', or 'lyt vault adopt'), then re-run ` +
        `'lyt vault add-edge ${vaultName} --peer ${peerRid} --edge parent'. ` +
        `(share_with edges accept unregistered peers; parent edges cannot.)`,
    );
    this.name = "AddEdgeParentNotRegisteredError";
    this.peerRid = peerRid;
  }
}

export interface AddEdgeArgs {
  vaultName: string;
  // CLI-supplied rid for the peer (dashed-UUIDv7 or 32-char hex form);
  // converted to bytes at the flow boundary via hexToUuid7Bytes.
  peerRid: string;
  edge: AddEdgeKind;
  force?: boolean;
  // Suppress the synchronous regen of .lyt/mesh-context.md after the edge write.
  // Bulk-init / batch flows pass true and call regen once per affected vault at the end
  // to avoid N noisy commits to mesh-context.md on a manifest with many edges.
  skipRegenContext?: boolean;
}

export interface AddEdgeResult {
  vaultName: string;
  vaultRidHex: string;
  edge: AddEdgeKind;
  peerRidHex: string;
  peerInLocalRegistry: boolean;
  yonPath: string;
  yonAlreadyHadEdge: boolean;
  meshContextRegenerated: boolean;
  // Track C Wave 3 F6 — whether the rollup-visible edge landed DURABLY
  // (@MESH_EDGE in the parent's home mesh.yon SoT + mesh_edges cache row,
  // via addMeshEdgeFlow). false + reason when the durable write isn't
  // possible (peer not local / missing home mesh / mesh main vault absent).
  meshEdgeWritten: boolean;
  meshEdgeSkipReason: string | null;
  // a review finding — what happened to the REPLACED parent's edge on a --force
  // re-parent ("removed" cleanup note, or why cleanup couldn't complete);
  // null when no prior parent was replaced.
  oldParentEdgeNote: string | null;
}

export async function addEdgeFlow(args: AddEdgeArgs): Promise<AddEdgeResult> {
  const peerRidBytes = hexToUuid7Bytes(args.peerRid);
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, args.vaultName);
    if (!vault) {
      throw new Error(`No vault named '${args.vaultName}' in the registry.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(
        `Vault '${args.vaultName}' is tombstoned; cannot add edges to a buried vault.`,
      );
    }
    await enforceNotFrozen(vault.path, vault.name);

    const peer = await getVaultByRid(db, peerRidBytes);
    const peerInLocalRegistry = peer !== null;
    const peerRidHexNorm = peer?.ridHex ?? args.peerRid;

    // refuse BEFORE the parent_vault UPDATE reaches the FK.
    if (args.edge === "parent" && peer === null) {
      throw new AddEdgeParentNotRegisteredError(args.peerRid, vault.name);
    }

    if (args.edge === "parent") {
      if (vault.parentVault && !ridsEqual(vault.parentVault, peerRidBytes) && !args.force) {
        throw new Error(
          `Vault '${args.vaultName}' already has parent ${vault.parentVaultHex}. ` +
            `Pass --force to replace it with ${peerRidHexNorm}.`,
        );
      }
    }

    // Track C Wave 3 F6 (+ release review/a review finding) — this flow was a
    // v1.A.1b fossil: it stopped at the `vaults.parent_vault` BLOB FK and
    // never grew the mesh_edges write after v1.B.1 shipped, while the rollup
    // walk reads ONLY mesh_edges — so edges added here were silently
    // invisible to rollup. A cache-only insert is not enough either: the
    // mesh_edges table is a cache over the mesh.yon @MESH_EDGE SoT, so
    // `lyt mesh validate` flags a cache-only row as orphaned and
    // `lyt mesh rebuild-registry` deletes it. Delegate to addMeshEdgeFlow —
    // the SoT+cache writer `lyt mesh add-edge` uses (idempotent, atomic) —
    // and report honestly when the durable write isn't possible.
    let meshEdgeWritten = false;
    let meshEdgeSkipReason: string | null = null;
    let oldParentEdgeNote: string | null = null;
    if (args.edge === "parent") {
      // a review finding — capture the replaced parent BEFORE overwriting, so a --force
      // re-parent can clean up the old edge (cache row + @MESH_EDGE SoT);
      // otherwise rollup traverses BOTH parents forever.
      const oldParentRid =
        vault.parentVault && !ridsEqual(vault.parentVault, peerRidBytes) ? vault.parentVault : null;

      await db.execute({
        sql: "UPDATE vaults SET parent_vault = ? WHERE rid = ?",
        args: [peerRidBytes, vault.rid],
      });

      if (oldParentRid !== null) {
        oldParentEdgeNote = await removeStaleParentEdge(db, oldParentRid, vault);
      }

      if (peer === null) {
        // UNREACHABLE for parent edges since the hardening pass guard above throws
        // first — kept as defense-in-depth (and for TS narrowing of `peer`).
        meshEdgeSkipReason =
          "parent vault is not in the local registry — rollup will not see this edge until it is registered and the edge re-added";
      } else {
        try {
          await addMeshEdgeFlow({
            childVaultName: vault.name,
            parentVaultName: peer.name,
            registryDb: db,
          });
          meshEdgeWritten = true; // edge-written OR edge-already-present
        } catch (err) {
          if (
            err instanceof AddMeshEdgeNoHomeMeshError ||
            err instanceof AddMeshEdgeMainVaultMissingError
          ) {
            // parent_vault + vault.yon updated; the rollup-visible edge is
            // NOT durable yet. No cache-only fallback (it would be wiped by
            // the system's own rebuild-registry maintenance).
            meshEdgeSkipReason = `${err.message} Then re-run 'lyt mesh add-edge --parent ${peer.name} --child ${vault.name}' so rollup sees the edge.`;
          } else {
            throw err;
          }
        }
      }
    } else {
      // share_with edges stay on-disk-only (vault.yon) — mesh_edges' kind
      // CHECK only admits 'parent' and rollup doesn't traverse share_with.
      meshEdgeSkipReason = "share_with edges are recorded in vault.yon only";
    }

    const yonPath = join(vault.path, ".lyt", "vault.yon");
    const beforeContent = readFileSync(yonPath, "utf8");
    const parsed = parseVaultYon(beforeContent);

    let yonAlreadyHadEdge = false;
    let shareWith = [...parsed.shareWith];
    let parentVaultStr: string | undefined = parsed.parentVault ?? undefined;

    if (args.edge === "share_with") {
      if (shareWith.includes(args.peerRid)) {
        yonAlreadyHadEdge = true;
      } else {
        shareWith = [...shareWith, args.peerRid];
      }
    } else {
      if (parsed.parentVault === args.peerRid) {
        yonAlreadyHadEdge = true;
      } else {
        parentVaultStr = args.peerRid;
      }
    }

    if (!yonAlreadyHadEdge) {
      const doc: VaultDoc = {
        vault: {
          rid: hexToUuid7Bytes(parsed.rid),
          name: parsed.name,
          desc: parsed.desc ?? undefined,
          parentVault: parentVaultStr ? hexToUuid7Bytes(parentVaultStr) : undefined,
          shareWith,
          acceptsFrom: parsed.acceptsFrom,
          tierHint: parsed.tierHint ?? undefined,
          memscope: parsed.memscopeRid ? hexToUuid7Bytes(parsed.memscopeRid) : undefined,
          createdAt: parsed.createdAt ?? new Date().toISOString(),
          version: parsed.version ?? "0.1",
        },
        gitUrl: parsed.gitUrl ?? undefined,
        primaryOwner: parsed.primaryOwner ?? "unknown",
        lifecycle: parseLifecycle(parsed.lifecycle),
        topics: parsed.topics,
        agentTemplateVersion: parsed.agentTemplateVersion ?? undefined,
      };
      writeFileSync(yonPath, renderVaultYon(doc), "utf8");
    }

    let meshContextRegenerated = false;
    if (!yonAlreadyHadEdge && args.skipRegenContext !== true) {
      if (existsSync(join(vault.path, ".lyt", "mesh-context.md"))) {
        regenMeshContextFromYon(vault.path);
        meshContextRegenerated = true;
      } else {
        // No prior mesh-context.md (vault scaffolded before Phase 7A); regenerate so the file lands.
        regenMeshContextFromYon(vault.path);
        meshContextRegenerated = true;
      }
    }

    return {
      vaultName: vault.name,
      vaultRidHex: vault.ridHex,
      edge: args.edge,
      peerRidHex: peerRidHexNorm,
      peerInLocalRegistry,
      yonPath,
      yonAlreadyHadEdge,
      meshContextRegenerated,
      meshEdgeWritten,
      meshEdgeSkipReason,
      oldParentEdgeNote,
    };
  } finally {
    await closeRegistry(db);
  }
}

function parseLifecycle(s: string | null): "active" | "archived" | "frozen" {
  if (s === "archived" || s === "frozen") return s;
  return "active";
}

// Slice 2a — best-effort retraction of the REPLACED parent's edge on --force
// re-parent. The edge SoT is now the per-writer mesh-edge ledger (no mesh.yon
// block, no cache-row delete). Append a TOMBSTONE for the old edge's 3-tuple
// `(ref_mesh = old parent's home mesh, ref_vault = old parent, home_vault =
// child)` to THIS writer's shard — the add-wins OR-Set fold then drops the old
// edge from the live set (cache catches up on the next reconstitution). Never
// throws — re-parenting must not fail on old-edge cleanup; returns a note.
async function removeStaleParentEdge(
  db: Client,
  oldParentRid: Uint8Array,
  childVault: VaultRow,
): Promise<string> {
  try {
    const oldParent = await getVaultByRid(db, oldParentRid);
    if (oldParent === null || oldParent.homeMeshRid === null) {
      // Cannot resolve the old parent's home mesh = the edge's ref_mesh; the
      // 3-tuple is incomplete, so no well-formed tombstone can be appended.
      return "not retracted (old parent not local or has no home mesh — cannot derive the edge's ref_mesh; run 'lyt repair')";
    }
    const oldMesh = await getMeshByRid(db, oldParent.homeMeshRid);
    if (oldMesh === null) {
      return "not retracted (old parent's home mesh not in registry — run 'lyt repair')";
    }
    // ref_mesh = the old parent's home mesh; ref_vault = old parent; home_vault
    // = child. (home_mesh + kind are VALUES, not identity — carried for audit.)
    appendMeshEdgeTombstone({
      refMeshRid: uuid7BytesToDashedString(oldMesh.rid),
      refVaultRid: uuid7BytesToDashedString(oldParentRid),
      homeVaultRid: uuid7BytesToDashedString(childVault.rid),
      homeMeshRid:
        childVault.homeMeshRid !== null
          ? uuid7BytesToDashedString(childVault.homeMeshRid)
          : uuid7BytesToDashedString(oldMesh.rid),
      kind: "parent",
    });
    return "retracted (tombstone appended to the mesh-edge ledger; cache catches up on next reconstitution)";
  } catch (err) {
    // No rethrow — the re-parent itself succeeded.
    const msg = err instanceof Error ? err.message : String(err);
    return `retraction incomplete (${msg}) — run 'lyt repair' to reconcile the old parent edge`;
  }
}
