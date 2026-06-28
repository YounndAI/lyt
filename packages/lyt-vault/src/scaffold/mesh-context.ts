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

import { MESH_CONTEXT_AUTO_BANNER } from "../templates/priming.js";
import { hexToUuid7Bytes, ridsEqual } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { parseVaultYon } from "../yon/parse.js";

// Phase C (M1a fix) — the durable definer line. DERIVED from the structural
// SoT, never stored prose: this vault is the mesh definer iff `.lyt/mesh.yon`
// exists in this vault AND its `main_vault_rid` equals this vault's own rid
// (both files colocate in the main vault's `.lyt/`). Because it recomputes from
// mesh.yon + vault.yon on every render, it SURVIVES a regenMeshContextFromYon
// pass — unlike the old transient RICH_MESH_DIRECTIVE write, which lived only in
// the derived file and was erased on the first mesh op that regenerated it.
const MESH_DEFINER_LINE = "**Main vault** — defines this mesh and anchors its members.";

export interface MeshContextInput {
  vaultName: string;
  parentVaultRid: string | null;
  shareWith: readonly string[];
  acceptsFrom: readonly string[];
  desc: string | null;
  // True when this vault is the defining/main vault of its mesh (derived from
  // the mesh.yon ⟷ vault.yon rid match — see isMeshDefiner). A member vault is
  // false and emits no definer line.
  isMeshDefiner: boolean;
}

// Derive the durable structural fact: is `vaultPath` the defining vault of its
// mesh? True iff `.lyt/mesh.yon` exists AND its main_vault_rid === this vault's
// rid (from `.lyt/vault.yon`). Any read/parse failure or rid mismatch → false
// (a member vault, or a vault whose mesh.yon does not name it as main).
export function isMeshDefiner(vaultPath: string): boolean {
  const meshYonPath = join(vaultPath, ".lyt", "mesh.yon");
  const vaultYonPath = join(vaultPath, ".lyt", "vault.yon");
  if (!existsSync(meshYonPath) || !existsSync(vaultYonPath)) return false;
  try {
    const mesh = parseMeshYon(readFileSync(meshYonPath, "utf8"));
    const vault = parseVaultYon(readFileSync(vaultYonPath, "utf8"));
    const vaultRidBytes = hexToUuid7Bytes(vault.rid);
    return ridsEqual(mesh.mesh.mainVaultRid, vaultRidBytes);
  } catch {
    return false;
  }
}

export function renderMeshContext(input: MeshContextInput): string {
  const lines: string[] = [];
  lines.push(MESH_CONTEXT_AUTO_BANNER);
  lines.push("");
  lines.push(`**Vault:** \`${input.vaultName}\``);
  if (input.isMeshDefiner) {
    lines.push("");
    lines.push(MESH_DEFINER_LINE);
  }
  if (input.desc && input.desc.length > 0) {
    lines.push("");
    lines.push(`**Description:** ${input.desc}`);
  }
  lines.push("");

  if (input.parentVaultRid) {
    lines.push(`**Parent:** \`${input.parentVaultRid}\``);
    lines.push("");
  }

  const peers = [...input.shareWith].sort();
  if (peers.length > 0) {
    lines.push(`**Share-with peers (${peers.length}):**`);
    lines.push("");
    for (const peer of peers) {
      lines.push(`- \`${peer}\``);
    }
    lines.push("");
  }

  const accepts = [...input.acceptsFrom].sort();
  if (accepts.length > 0) {
    lines.push(`**Accepts-from (${accepts.length}):**`);
    lines.push("");
    for (const peer of accepts) {
      lines.push(`- \`${peer}\``);
    }
    lines.push("");
  }

  if (!input.parentVaultRid && peers.length === 0 && accepts.length === 0) {
    lines.push(`_This vault has no declared mesh edges yet._`);
    lines.push("");
  }

  return lines.join("\n");
}

export function writeMeshContextFile(vaultPath: string, input: MeshContextInput): string {
  const target = join(vaultPath, ".lyt", "mesh-context.md");
  const content = renderMeshContext(input);
  writeFileSync(target, content, "utf8");
  return target;
}

export function meshContextInputFromYon(vaultPath: string): MeshContextInput {
  const yonPath = join(vaultPath, ".lyt", "vault.yon");
  const parsed = parseVaultYon(readFileSync(yonPath, "utf8"));
  return {
    vaultName: parsed.name,
    parentVaultRid: parsed.parentVault,
    shareWith: parsed.shareWith,
    acceptsFrom: parsed.acceptsFrom,
    desc: parsed.desc,
    // M1a fix — recompute the definer fact from the colocated mesh.yon ⟷
    // vault.yon rid match on EVERY regen, so the definer line is durable by
    // construction (never erased by a regenMeshContextFromYon pass).
    isMeshDefiner: isMeshDefiner(vaultPath),
  };
}

export function regenMeshContextFromYon(vaultPath: string): string {
  const input = meshContextInputFromYon(vaultPath);
  return writeMeshContextFile(vaultPath, input);
}
