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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MESH_CONTEXT_AUTO_BANNER } from "../templates/priming.js";
import { parseVaultYon } from "../yon/parse.js";

export interface MeshContextInput {
  vaultName: string;
  parentVaultRid: string | null;
  shareWith: readonly string[];
  acceptsFrom: readonly string[];
  desc: string | null;
}

export function renderMeshContext(input: MeshContextInput): string {
  const lines: string[] = [];
  lines.push(MESH_CONTEXT_AUTO_BANNER);
  lines.push("");
  lines.push(`**Vault:** \`${input.vaultName}\``);
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
  };
}

export function regenMeshContextFromYon(vaultPath: string): string {
  const input = meshContextInputFromYon(vaultPath);
  return writeMeshContextFile(vaultPath, input);
}
