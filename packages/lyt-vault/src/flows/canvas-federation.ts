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

// v1.D.5 — federation canvas builder. Emits a JSON Canvas
// (https://jsoncanvas.org/spec/1.0/) visualisation of the handle's
// federation: federation group at the top, mesh groups in the middle
// row, vault nodes below each mesh.
//
// Two write modes per OD-5 default:
// POPULATED — pod.yon exists for the handle. Canvas writes
// to `<getFederationRepoDir(handle)>/canvases/federation-graph.canvas`
// and renders federation + meshes (from pod.yon)
// + vaults of each mesh (from local registry, when
// known).
// STUB — pod.yon missing for the handle. Canvas writes
// to `<first-vault-by-name>/.lyt/canvases/federation-graph.canvas`
// with an explicit `> [!warning]` callout (text node)
// noting "Federation-repo not shipped yet (v1.A.0
// pending); this canvas is a vault-local snapshot."
// Mirrors v1.D.4 OD-4 federation-primer stub pattern.
//
// Layout (OD-8 default — grid-by-tier):
// y=0 federation group (w=FEDERATION_WIDTH, h=FEDERATION_HEIGHT, x=0)
// y=200 mesh group i at (x = i*MESH_STRIDE, w=MESH_WIDTH, h=MESH_HEIGHT)
// y=400 vaults of mesh i at (x = i*MESH_STRIDE + j*VAULT_STRIDE, w=VAULT_WIDTH, h=VAULT_HEIGHT)
//
// Edge colors (per JSON Canvas spec 1.0 preset palette — yellow=3,
// cyan=5, purple=6; the brief at §Scope L157 labels color "4" as yellow
// but spec 1.0 puts green at "4" — using spec-correct mapping):
// "3" yellow — federation → mesh (hierarchical)
// "5" cyan — mesh → vault (membership)
// "6" purple — vault → vault (cross-mesh subscription; rare at federation scope)
//
// Determinism (Lock 0.3 per OD-9): meshes are sorted by name ASC; vaults
// under each mesh are sorted by name ASC; nodes are sorted by id ASC
// in the final array; edges are sorted by (fromNode ASC, toNode ASC).
// Same federation/mesh state + same `--now-iso` → byte-identical
// canvas JSON.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
import { listFederationStates } from "../registry/federation-state.js";
import { getMeshByName, type MeshRow } from "../registry/meshes-repo.js";
import { listVaultsInMesh } from "../registry/mesh-vaults-repo.js";
import { getVaultByRid, listVaults, type VaultRow } from "../registry/repo.js";
import { getFederationRepoDir, getFederationYonPath } from "../util/federation-paths.js";
import { getHandleFromIdentity } from "../util/identity.js";
import { parseFederationYon } from "../yon/federation-read.js";
import type { FedMeshRecord } from "../yon/federation-write.js";

// Layout constants — exposed for tests to assert canvas geometry.
export const FEDERATION_WIDTH = 400;
export const FEDERATION_HEIGHT = 100;
export const FEDERATION_Y = 0;
export const MESH_WIDTH = 320;
export const MESH_HEIGHT = 120;
export const MESH_Y = 200;
export const MESH_STRIDE = 400;
export const VAULT_WIDTH = 240;
export const VAULT_HEIGHT = 100;
export const VAULT_Y = 400;
export const VAULT_STRIDE = 280;
export const WARNING_WIDTH = 480;
export const WARNING_HEIGHT = 140;

export const EDGE_COLOR_FEDERATION_MESH = "3"; // yellow per spec 1.0
export const EDGE_COLOR_MESH_VAULT = "5"; // cyan
export const EDGE_COLOR_SUBSCRIPTION = "6"; // purple
export const NODE_COLOR_WARNING = "2"; // orange

export interface GenerateFederationCanvasArgs {
  target?: string; // handle override; otherwise resolved from identity / federation_state
  nowIso?: string;
  registryDb?: Client;
  identityProvider?: () => string;
}

export interface CanvasFederationResult {
  canvasPath: string;
  handle: string;
  federationRid: string | null;
  isVaultStub: boolean;
  meshCount: number;
  vaultCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

export async function generateFederationCanvasFlow(
  args: GenerateFederationCanvasArgs = {},
): Promise<CanvasFederationResult> {
  const startedAt = Date.now();
  const nowIso = args.nowIso ?? new Date().toISOString();

  const callerSuppliedRegistry = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());
  try {
    const handle = await resolveHandle(registryDb, args.target, args.identityProvider);
    const fedYonPath = getFederationYonPath(handle);

    if (existsSync(fedYonPath)) {
      return await emitPopulatedCanvas(registryDb, handle, fedYonPath, nowIso, startedAt);
    }
    return await emitVaultStubCanvas(registryDb, handle, nowIso, startedAt);
  } finally {
    if (!callerSuppliedRegistry) await closeRegistry(registryDb);
  }
}

// ---------------------------------------------------------------------------
// POPULATED branch
// ---------------------------------------------------------------------------

async function emitPopulatedCanvas(
  registryDb: Client,
  handle: string,
  fedYonPath: string,
  nowIso: string,
  startedAt: number,
): Promise<CanvasFederationResult> {
  const doc = parseFederationYon(readFileSync(fedYonPath, "utf8"));
  const meshes = [...doc.meshes].sort(byMeshNameAsc);

  // For each mesh in pod.yon, look up locally to enumerate vaults.
  const meshGroups: PopulatedMeshGroup[] = [];
  for (let i = 0; i < meshes.length; i++) {
    const fedMesh = meshes[i]!;
    const meshRow = await getMeshByName(registryDb, fedMesh.meshName);
    const meshVaults = meshRow !== null ? await listMeshVaultRows(registryDb, meshRow) : [];
    meshGroups.push({ fedMesh, meshRow, vaults: meshVaults, columnIndex: i });
  }

  const nodes: JsonCanvasNode[] = [];
  const edges: JsonCanvasEdge[] = [];

  const fedNodeId = `fed:${doc.federation.fedRidHex}`;
  const fedLabel = `Federation: ${handle}`;
  nodes.push(
    groupNode(
      fedNodeId,
      {
        x: 0,
        y: FEDERATION_Y,
        width: FEDERATION_WIDTH,
        height: FEDERATION_HEIGHT,
      },
      fedLabel,
    ),
  );

  let vaultCount = 0;
  for (const mg of meshGroups) {
    const meshNodeId = `mesh:${mg.fedMesh.meshRidHex}`;
    const meshLabel = `${mg.fedMesh.meshName} (${mg.fedMesh.role})`;
    const meshX = mg.columnIndex * MESH_STRIDE;
    nodes.push(
      groupNode(
        meshNodeId,
        { x: meshX, y: MESH_Y, width: MESH_WIDTH, height: MESH_HEIGHT },
        meshLabel,
      ),
    );
    edges.push(
      edge(`edge:fed-mesh:${mg.fedMesh.meshRidHex}`, fedNodeId, meshNodeId, {
        color: EDGE_COLOR_FEDERATION_MESH,
      }),
    );

    if (mg.meshRow === null) {
      // Mesh known to federation but not in local registry — surface a
      // text node alongside the mesh group so the handler sees the gap.
      const orphanId = `mesh-orphan:${mg.fedMesh.meshRidHex}`;
      nodes.push(
        textNode(
          orphanId,
          {
            x: meshX,
            y: VAULT_Y,
            width: VAULT_WIDTH,
            height: VAULT_HEIGHT,
          },
          `_Mesh \`${mg.fedMesh.meshName}\` is registered in the federation but not present in the local registry. Run \`lyt mesh join ${mg.fedMesh.meshName} --from ${mg.fedMesh.pushKind}:${mg.fedMesh.pushTarget}\` to clone it._`,
        ),
      );
      continue;
    }

    const sortedVaults = [...mg.vaults].sort(byVaultNameAsc);
    for (let j = 0; j < sortedVaults.length; j++) {
      const v = sortedVaults[j]!;
      const vaultNodeId = `vault:${v.ridHex}`;
      const vaultX = mg.columnIndex * MESH_STRIDE + j * VAULT_STRIDE;
      nodes.push(
        textNode(
          vaultNodeId,
          {
            x: vaultX,
            y: VAULT_Y,
            width: VAULT_WIDTH,
            height: VAULT_HEIGHT,
          },
          `**${v.name}**\n\n_status:_ \`${v.status}\``,
        ),
      );
      edges.push(
        edge(`edge:mesh-vault:${mg.fedMesh.meshRidHex}:${v.ridHex}`, meshNodeId, vaultNodeId, {
          color: EDGE_COLOR_MESH_VAULT,
        }),
      );
      vaultCount += 1;
    }
  }

  // Generated-by note in the bottom-left corner.
  nodes.push(buildGeneratedByNote(nowIso, `federation${arg(handle)}`));

  const canvas = finaliseCanvas(nodes, edges);
  const canvasPath = join(getFederationRepoDir(handle), "canvases", "federation-graph.canvas");
  atomicWriteFile(canvasPath, serializeCanvas(canvas));

  return {
    canvasPath,
    handle,
    federationRid: `fed:${doc.federation.fedRidHex}`,
    isVaultStub: false,
    meshCount: meshes.length,
    vaultCount,
    nodeCount: canvas.nodes.length,
    edgeCount: canvas.edges.length,
    durationMs: Date.now() - startedAt,
  };
}

interface PopulatedMeshGroup {
  fedMesh: FedMeshRecord;
  meshRow: MeshRow | null;
  vaults: VaultRow[];
  columnIndex: number;
}

async function listMeshVaultRows(registryDb: Client, mesh: MeshRow): Promise<VaultRow[]> {
  const memberRows = await listVaultsInMesh(registryDb, mesh.rid);
  const out: VaultRow[] = [];
  for (const m of memberRows) {
    const v = await getVaultByRid(registryDb, m.vaultRid);
    if (v !== null) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// STUB branch (federation-repo not populated)
// ---------------------------------------------------------------------------

async function emitVaultStubCanvas(
  registryDb: Client,
  handle: string,
  nowIso: string,
  startedAt: number,
): Promise<CanvasFederationResult> {
  const allVaults = [...(await listVaults(registryDb))].sort(byVaultNameAsc);
  if (allVaults.length === 0) {
    throw new Error(
      `canvas-federation: handle=${JSON.stringify(handle)} has neither a federation-repo (~/lyt/pod/pod.yon) nor any registered vaults. Run 'lyt vault init' or 'lyt federation init' first.`,
    );
  }
  const writeAnchor = allVaults[0]!;

  const nodes: JsonCanvasNode[] = [];
  const edges: JsonCanvasEdge[] = [];

  // Warning callout in a dedicated text node, positioned in the top-left
  // so handlers see it immediately on Obsidian canvas-open.
  const warningId = "warn:fed-stub";
  nodes.push(
    textNode(
      warningId,
      { x: 0, y: FEDERATION_Y, width: WARNING_WIDTH, height: WARNING_HEIGHT },
      [
        "> [!warning] Federation-repo v1.A.0-pending — vault-local snapshot",
        ">",
        `> No \`pod.yon\` exists for handle \`${handle}\` at \`~/lyt/pod/pod.yon\`.`,
        "> This canvas is a vault-local snapshot showing only the vaults currently registered on this machine.",
        ">",
        "> Run `lyt federation init` to forge a federation repo; v1.A.0 + v1.D.5d wire the full federation-aggregation canvas.",
      ].join("\n"),
      NODE_COLOR_WARNING,
    ),
  );

  for (let i = 0; i < allVaults.length; i++) {
    const v = allVaults[i]!;
    const vaultNodeId = `vault:${v.ridHex}`;
    nodes.push(
      textNode(
        vaultNodeId,
        {
          x: i * VAULT_STRIDE,
          y: MESH_Y,
          width: VAULT_WIDTH,
          height: VAULT_HEIGHT,
        },
        `**${v.name}**\n\n_status:_ \`${v.status}\``,
      ),
    );
  }

  nodes.push(buildGeneratedByNote(nowIso, "federation (vault-stub)"));

  const canvas = finaliseCanvas(nodes, edges);
  const canvasPath = join(writeAnchor.path, ".lyt", "canvases", "federation-graph.canvas");
  atomicWriteFile(canvasPath, serializeCanvas(canvas));

  return {
    canvasPath,
    handle,
    federationRid: null,
    isVaultStub: true,
    meshCount: 0,
    vaultCount: allVaults.length,
    nodeCount: canvas.nodes.length,
    edgeCount: canvas.edges.length,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildGeneratedByNote(nowIso: string, scopeLabel: string): JsonCanvasNode {
  // Y is below the deepest tier (vaults at y=400 + height 100 = 500); add
  // a small gap so the text node doesn't visually merge with the vault row.
  return textNode(
    "generated-by:note",
    { x: 0, y: VAULT_Y + VAULT_HEIGHT + 80, width: WARNING_WIDTH, height: 80 },
    `_Generated by \`lyt federation canvas\` (scope: ${scopeLabel}) at ${nowIso}._`,
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

function byMeshNameAsc(a: FedMeshRecord, b: FedMeshRecord): number {
  return a.meshName < b.meshName ? -1 : a.meshName > b.meshName ? 1 : 0;
}

function byVaultNameAsc(a: VaultRow, b: VaultRow): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function resolveHandle(
  registryDb: Client,
  target: string | undefined,
  identityProvider: (() => string) | undefined,
): Promise<string> {
  if (target !== undefined && target.length > 0) return target;
  const provider = identityProvider ?? getHandleFromIdentity;
  try {
    return provider();
  } catch {
    // Identity probe failed — fall back to federation_state on the
    // single-handle happy path. Mirrors federationListFlow.resolveHandle
    // semantics (federation/list.ts:60-85).
    const states = await listFederationStates(registryDb);
    if (states.length === 1) return states[0]!.handle;
    throw new Error(
      "canvas-federation: cannot resolve handle — gh identity unavailable AND no unique federation_state row. " +
        "Pass --target <handle>, run `lyt federation init`, or run `gh auth login`.",
    );
  }
}

function arg(handle: string): string {
  return ` --target ${handle}`;
}

// ---------------------------------------------------------------------------
// Atomic write (mirrors primer-generator.ts:671-683 / ledger-write.ts:159)
// ---------------------------------------------------------------------------

function atomicWriteFile(targetPath: string, contents: string): void {
  // Ensure the parent .canvases/ dir exists before tmp write.
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
