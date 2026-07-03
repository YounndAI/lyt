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

import {
  MESH_CONTEXT_AUTO_BANNER,
  scaffoldFrontmatter,
  type ScaffoldDates,
} from "../templates/priming.js";
import { readFrontmatterDates } from "../templates/contract.js";
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
  // fg-scaffold-frontmatter — the frontmatter dates for the prepended
  // scaffold-frontmatter block. On first scaffold this is the REAL vault init
  // time (threaded from scaffold/init.ts). On regen (writeMeshContextFile reads
  // back the on-disk `created`), it is the PRESERVED original date so a re-emit
  // never churns to a fresh date or the 1970 sentinel. Omit → sentinel fallback
  // (defensive default only; production paths always supply/preserve a real date).
  dates?: ScaffoldDates | undefined;
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
  // fg-scaffold-frontmatter (handler rule, from real-vault dogfood): EVERY file
  // Lyt scaffolds MUST carry valid contract frontmatter with REAL dates — no
  // exemption. .lyt/mesh-context.md previously shipped WITH NO frontmatter (the
  // dogfood defect); it now leads with a scaffold-frontmatter block via the same
  // SoT. The auto-regen banner + body follow. Preserve-on-regen (real `created`
  // read back in writeMeshContextFile) keeps a re-emit from churning the date.
  const frontmatter = scaffoldFrontmatter(
    `Mesh context: ${input.vaultName}`,
    "Lyt mesh context (auto-regenerated scaffold seed)",
    input.dates,
  );
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

  // frontmatter (ends in "\n") is prepended so the file leads with a valid
  // contract frontmatter block, then the auto-regen banner + body.
  return frontmatter + lines.join("\n");
}

export function writeMeshContextFile(vaultPath: string, input: MeshContextInput): string {
  const target = join(vaultPath, ".lyt", "mesh-context.md");
  // fg-scaffold-frontmatter — preserve-on-regen (mirrors priming.ts C3): this
  // file is REGENERATED on every edge change. Read back the on-disk `created`
  // (when present) and re-emit it, so a regen never churns the date to a fresh
  // `now` nor re-introduces the 1970 sentinel. First scaffold (no file yet, or a
  // legacy file with no frontmatter) falls through to the threaded init date the
  // caller supplied via `input.dates`.
  const preserved = preservedMeshContextDates(target);
  const effectiveInput: MeshContextInput = preserved ? { ...input, dates: preserved } : input;
  const content = renderMeshContext(effectiveInput);
  writeFileSync(target, content, "utf8");
  return target;
}

// Read back the on-disk `created`/`modified` of an existing mesh-context.md so a
// regen re-emits the PRESERVED dates. Returns undefined when the file is absent
// or has no `created` (a legacy no-frontmatter file), letting the caller fall
// back to the threaded init date. `modified` defaults to the preserved `created`.
function preservedMeshContextDates(target: string): ScaffoldDates | undefined {
  if (!existsSync(target)) return undefined;
  try {
    const { created, modified } = readFrontmatterDates(readFileSync(target, "utf8"));
    if (created === null) return undefined;
    return { created, modified: modified ?? created };
  } catch {
    return undefined;
  }
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
    // fg-scaffold-frontmatter — the DURABLE real date for the scaffold
    // frontmatter is vault.yon's `created_at` (the true init instant, same value
    // threaded at first scaffold). writeMeshContextFile still PREFERS the
    // on-disk mesh-context.md `created` (read-back) when present, so genuine
    // regens preserve the original; this vault.yon fallback fires only when the
    // file is absent/garbage — and it is the SAME init date, so a regen after a
    // clobber is byte-identical (never the 1970 sentinel).
    //
    // The `!== null` guard is DEFENSIVE and effectively unreachable for any
    // Lyt-written manifest: renderVaultYon ALWAYS emits `created_at:ts=`
    // (unconditional; VaultDoc.createdAt is a required field), so
    // parseVaultYon(...).createdAt is null only for a hand-corrupted / legacy
    // vault.yon missing the field. On that null path we omit `dates`, and
    // scaffoldFrontmatter falls back to its own sentinel — no behavioral change
    // intended here; the guard just avoids threading a null created downstream.
    ...(parsed.createdAt !== null ? { dates: { created: parsed.createdAt } } : {}),
  };
}

export function regenMeshContextFromYon(vaultPath: string): string {
  const input = meshContextInputFromYon(vaultPath);
  return writeMeshContextFile(vaultPath, input);
}
