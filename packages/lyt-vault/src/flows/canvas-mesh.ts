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

// v1.D.5 — mesh canvas builder. Emits a JSON Canvas
// (https://jsoncanvas.org/spec/1.0/) visualisation of one mesh: mesh
// group at the top, vault nodes in the middle row, cross-mesh
// subscriptions in the bottom row (when present).
//
// Write path (default): `<mesh-main-vault>/.lyt/canvases/mesh-graph.canvas`.
// The mesh's main vault is the canonical anchor — meshes are logical
// groupings without a dedicated filesystem path, so the canvas lives
// alongside the main vault's content. If the mesh has no main vault
// assigned yet (v1.B.1 fresh state), fall back to the first home vault
// by name (mirrors primer-generator.ts:310-325 `resolveMeshWriteAnchor`).
//
// Layout (default — grid-by-tier):
// y=0 mesh group (w=MESH_WIDTH, h=MESH_HEIGHT, x=0)
// y=200 vault i at (x = i*VAULT_STRIDE, w=VAULT_WIDTH, h=VAULT_HEIGHT)
// y=400 external subscription i at (x = i*VAULT_STRIDE, w=VAULT_WIDTH, h=VAULT_HEIGHT)
//
// Edges:
// "5" cyan — mesh → vault (membership)
// "6" purple — mesh → external subscription (cross-mesh reference)
//
// Determinism (Lock 0.3): vaults sorted by name ASC; subscriptions sorted
// by external-mesh-name ASC; nodes by id ASC; edges by (fromNode, toNode, id).

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "@libsql/client";

import {
  edge,
  groupNode,
  serializeCanvas,
  textNode,
  type JsonCanvas,
  type JsonCanvasEdge,
  type JsonCanvasNode,
} from "../canvas/json-canvas.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import {
  listSubscriptionsForMesh,
  type MeshSubscriptionRow,
} from "../registry/mesh-subscriptions-repo.js";
import { listVaultsInMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName, type MeshRow } from "../registry/meshes-repo.js";
import { getVaultByRid, type VaultRow } from "../registry/repo.js";

import {
  EDGE_COLOR_MESH_VAULT,
  EDGE_COLOR_SUBSCRIPTION,
  MESH_HEIGHT,
  MESH_WIDTH,
  MESH_Y,
  VAULT_HEIGHT,
  VAULT_STRIDE,
  VAULT_WIDTH,
  VAULT_Y,
} from "./canvas-federation.js";

const SUBSCRIPTION_Y = VAULT_Y + VAULT_HEIGHT + 80;
const MESH_GROUP_Y = 0;

export interface GenerateMeshCanvasArgs {
  meshName: string;
  nowIso?: string;
  registryDb?: Client;
}

export interface CanvasMeshResult {
  canvasPath: string;
  meshRid: string;
  meshName: string;
  vaultCount: number;
  crossMeshSubscriptionCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

export async function generateMeshCanvasFlow(
  args: GenerateMeshCanvasArgs,
): Promise<CanvasMeshResult> {
  const startedAt = Date.now();
  if (args.meshName === undefined || args.meshName.length === 0) {
    throw new Error("canvas-mesh: --mesh <name> is required.");
  }
  const nowIso = args.nowIso ?? new Date().toISOString();

  const callerSuppliedRegistry = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());
  try {
    const mesh = await getMeshByName(registryDb, args.meshName);
    if (mesh === null) {
      throw new Error(
        `canvas-mesh: no mesh registered with name ${JSON.stringify(args.meshName)}. Run 'lyt mesh list' to see available meshes.`,
      );
    }

    const memberRows = await listVaultsInMesh(registryDb, mesh.rid);
    const vaultRows: VaultRow[] = [];
    for (const m of memberRows) {
      const v = await getVaultByRid(registryDb, m.vaultRid);
      if (v !== null) vaultRows.push(v);
    }
    const vaults = vaultRows.sort(byVaultNameAsc);

    const writeAnchor = await resolveMeshWriteAnchor(registryDb, mesh, vaults);

    const subscriptions = [...(await listSubscriptionsForMesh(registryDb, mesh.rid))].sort(
      bySubscriptionExternalVaultAsc,
    );

    const nodes: JsonCanvasNode[] = [];
    const edges: JsonCanvasEdge[] = [];

    const meshNodeId = `mesh:${mesh.ridHex}`;
    nodes.push(
      groupNode(
        meshNodeId,
        { x: 0, y: MESH_GROUP_Y, width: MESH_WIDTH, height: MESH_HEIGHT },
        `Mesh: ${mesh.name}`,
      ),
    );

    for (let i = 0; i < vaults.length; i++) {
      const v = vaults[i]!;
      const vaultNodeId = `vault:${v.ridHex}`;
      const isMain = mesh.mainVaultRid !== null && v.ridHex === bytesToHexLower(mesh.mainVaultRid);
      const marker = isMain ? "★ " : "";
      nodes.push(
        textNode(
          vaultNodeId,
          {
            x: i * VAULT_STRIDE,
            y: MESH_Y,
            width: VAULT_WIDTH,
            height: VAULT_HEIGHT,
          },
          `**${marker}${v.name}**\n\n_status:_ \`${v.status}\``,
        ),
      );
      edges.push(
        edge(`edge:mesh-vault:${mesh.ridHex}:${v.ridHex}`, meshNodeId, vaultNodeId, {
          color: EDGE_COLOR_MESH_VAULT,
        }),
      );
    }

    for (let i = 0; i < subscriptions.length; i++) {
      const s = subscriptions[i]!;
      const subNodeId = `sub:${s.externalVaultRidHex}`;
      nodes.push(
        textNode(
          subNodeId,
          {
            x: i * VAULT_STRIDE,
            y: SUBSCRIPTION_Y,
            width: VAULT_WIDTH,
            height: VAULT_HEIGHT,
          },
          `**subscribed vault**\n\n_external vault rid:_ \`vault:${s.externalVaultRidHex}\``,
        ),
      );
      edges.push(
        edge(`edge:mesh-sub:${mesh.ridHex}:${s.externalVaultRidHex}`, meshNodeId, subNodeId, {
          color: EDGE_COLOR_SUBSCRIPTION,
        }),
      );
    }

    // Generated-by note.
    nodes.push(
      textNode(
        "generated-by:note",
        {
          x: 0,
          y: SUBSCRIPTION_Y + VAULT_HEIGHT + 60,
          width: 480,
          height: 80,
        },
        `_Generated by \`lyt mesh canvas --mesh ${mesh.name}\` at ${nowIso}._`,
      ),
    );

    const canvas = finaliseCanvas(nodes, edges);
    const canvasPath = join(writeAnchor.path, ".lyt", "canvases", "mesh-graph.canvas");
    atomicWriteFile(canvasPath, serializeCanvas(canvas));

    return {
      canvasPath,
      meshRid: `mesh:${mesh.ridHex}`,
      meshName: mesh.name,
      vaultCount: vaults.length,
      crossMeshSubscriptionCount: subscriptions.length,
      nodeCount: canvas.nodes.length,
      edgeCount: canvas.edges.length,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSuppliedRegistry) await closeRegistry(registryDb);
  }
}

async function resolveMeshWriteAnchor(
  registryDb: Client,
  mesh: MeshRow,
  vaults: readonly VaultRow[],
): Promise<VaultRow> {
  if (mesh.mainVaultRid !== null) {
    const main = await getVaultByRid(registryDb, mesh.mainVaultRid);
    if (main !== null) return main;
  }
  if (vaults.length > 0) return vaults[0]!;
  throw new Error(
    `canvas-mesh: mesh ${JSON.stringify(mesh.name)} has no member vaults to anchor the canvas. Add at least one vault via 'lyt vault init' (auto-normalises to <mesh>/<name>) or 'lyt mesh init'.`,
  );
}

function finaliseCanvas(
  nodes: readonly JsonCanvasNode[],
  edges: readonly JsonCanvasEdge[],
): JsonCanvas {
  const sortedNodes = [...nodes].sort(byNodeIdAsc);
  const sortedEdges = [...edges].sort(byEdgeAsc);
  return { nodes: sortedNodes, edges: sortedEdges };
}

function byNodeIdAsc(a: JsonCanvasNode, b: JsonCanvasNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byEdgeAsc(a: JsonCanvasEdge, b: JsonCanvasEdge): number {
  if (a.fromNode !== b.fromNode) return a.fromNode < b.fromNode ? -1 : 1;
  if (a.toNode !== b.toNode) return a.toNode < b.toNode ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byVaultNameAsc(a: VaultRow, b: VaultRow): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Fed-v2 D1c: the subscription cache row no longer carries the foreign mesh
// name (external_mesh_* dropped), so the deterministic canvas ordering keys on
// the surviving external_vault_rid (hex-lex ASC).
function bySubscriptionExternalVaultAsc(a: MeshSubscriptionRow, b: MeshSubscriptionRow): number {
  return a.externalVaultRidHex < b.externalVaultRidHex
    ? -1
    : a.externalVaultRidHex > b.externalVaultRidHex
      ? 1
      : 0;
}

function bytesToHexLower(b: Uint8Array): string {
  return Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

function atomicWriteFile(targetPath: string, contents: string): void {
  const parent = targetPath.slice(
    0,
    Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\")),
  );
  if (parent.length > 0) mkdirSync(parent, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}-${tmpCounter()}.tmp`;
  writeFileSync(tmpPath, contents, "utf8");
  renameSync(tmpPath, targetPath);
}

let tmpCounterValue = 0;
function tmpCounter(): number {
  tmpCounterValue += 1;
  return tmpCounterValue;
}
