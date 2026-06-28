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

import { uuid7BytesToDashedString } from "../util/uuid7.js";

// v1.A.1b — rid + memscope + parent_vault flip to Uint8Array on input.
// The renderer serialises every rid-shaped field as 8-4-4-4-12 dashed
// UUIDv7 on disk (canonical RFC 9562 string form via
// `uuid7BytesToDashedString` — already on `main` from commit 8811bd0).
// Parsers (yon/parse.ts) still return strings; callers convert via
// `hexToUuid7Bytes` at the boundary.
//
// `shareWith` / `acceptsFrom` stay as `readonly string[]` — these block-A
// shapes are deferred to v1.C.1 mesh edges + v1.C.2 subscriptions; no
// v1.A.1b call site writes them.
export interface VaultRecord {
  rid: Uint8Array;
  name: string;
  desc?: string | undefined;
  parentVault?: Uint8Array | undefined;
  shareWith?: readonly string[] | undefined;
  acceptsFrom?: readonly string[] | undefined;
  tierHint?: string | undefined;
  memscope?: Uint8Array | undefined;
  createdAt: string;
  version: string;
  frozenAt?: string | undefined;
  frozenUntil?: string | undefined;
}

// v1.B.3 — @VAULT_HOME_MESH record. Declares which mesh OWNS this vault;
// emitted into vault.yon alongside the @VAULT record. Companion to
// @MESH_HOME (which lives in the home mesh's mesh.yon — the mesh-side view
// of the same binding). Field shapes per lyt-federation-design.md §2
// (L95-107) + yai.lyt domain JSON v1.B.3.
//
// `vaultRid` round-trips to the sibling @VAULT.rid in the same file — kept
// as bytes per the v1.A.1b boundary pattern. Absence of this record in
// older vault.yons (pre-v1.B.3) is fine; reader returns `undefined`.
export interface VaultHomeMeshRecord {
  vaultRid: Uint8Array;
  meshRid: Uint8Array;
  meshName: string;
  assignedAt: string;
}

export interface VaultDoc {
  vault: VaultRecord;
  gitUrl?: string | undefined;
  primaryOwner: string;
  lifecycle: "active" | "archived" | "frozen";
  topics?: readonly string[] | undefined;
  agentTemplateVersion?: number | undefined;
  // v1.B.3 — set when the vault has a home mesh assignment. Emitted as a
  // dedicated @VAULT_HOME_MESH block AFTER the @VAULT block and BEFORE the
  // @TAG / @META trailer. Absent for vaults that haven't been bound to a
  // mesh (pre-v1.B.3 vaults; vaults created via direct `initVault` without
  // a `homeMesh` arg).
  homeMesh?: VaultHomeMeshRecord | undefined;
  // Phase A — scaffold-system version stamps. Emitted alongside
  // `agent_template_version` so consumers can detect schema evolution:
  //   template_version  — the scaffold template set generation (bumped when
  //                       the set of files written by initVault changes shape).
  //                       Uses the same integer as AGENTS_MD_TEMPLATE_VERSION
  //                       from templates/priming.ts (both describe the same
  //                       scaffold generation; sharing avoids a 3rd disjoint version).
  //   contract_version  — the yai.lyt v1 frontmatter contract revision (bumped
  //                       when FRONTMATTER_FIELDS or MANDATORY_FRONTMATTER_TOKENS
  //                       change in templates/contract.ts). Starts at 1 for
  //                       the Phase A baseline.
  templateVersion?: number | undefined;
  contractVersion?: number | undefined;
}

export function renderVaultYon(doc: VaultDoc): string {
  const v = doc.vault;
  const ridStr = uuid7BytesToDashedString(v.rid);
  const lines: string[] = [
    `@DOC ver=2.0 | id=${ridStr} | title="${escapeQuoted(v.name)}" | domain=yai.lyt@1.0 | kind=cfg | profile=agent`,
    ``,
    `@VAULT rid=${ridStr}`,
    `  | name="${escapeQuoted(v.name)}"`,
  ];

  if (v.desc !== undefined && v.desc.length > 0) {
    lines.push(`  | desc="${escapeQuoted(v.desc)}"`);
  }
  if (v.parentVault) {
    lines.push(`  | parent_vault=${uuid7BytesToDashedString(v.parentVault)}`);
  }
  if (v.shareWith && v.shareWith.length > 0) {
    lines.push(`  | share_with=[${v.shareWith.join(",")}]`);
  }
  if (v.acceptsFrom && v.acceptsFrom.length > 0) {
    lines.push(`  | accepts_from=[${v.acceptsFrom.join(",")}]`);
  }
  if (v.tierHint) lines.push(`  | tier_hint="${escapeQuoted(v.tierHint)}"`);
  if (v.memscope) {
    lines.push(`  | memscope=${uuid7BytesToDashedString(v.memscope)}`);
  }
  lines.push(`  | created_at:ts=${v.createdAt}`);
  if (v.frozenAt) lines.push(`  | frozen_at:ts=${v.frozenAt}`);
  if (v.frozenUntil) lines.push(`  | frozen_until:ts=${v.frozenUntil}`);
  lines.push(`  | version="${escapeQuoted(v.version)}"`);
  lines.push(``);

  if (doc.homeMesh !== undefined) {
    const hm = doc.homeMesh;
    lines.push(`@VAULT_HOME_MESH vault_rid=vault:${uuid7BytesToDashedString(hm.vaultRid)}`);
    lines.push(`  | mesh_rid=mesh:${uuid7BytesToDashedString(hm.meshRid)}`);
    lines.push(`  | mesh_name="${escapeQuoted(hm.meshName)}"`);
    lines.push(`  | assigned_at:ts=${hm.assignedAt}`);
    lines.push(``);
  }

  if (doc.topics && doc.topics.length > 0) {
    for (const topic of doc.topics) {
      lines.push(`@TAG key=topic | value="${escapeQuoted(topic)}"`);
    }
    lines.push(``);
  }

  if (doc.gitUrl) {
    lines.push(`@META key=git_url | value="${escapeQuoted(doc.gitUrl)}"`);
  }
  lines.push(`@META key=primary_owner | value=${doc.primaryOwner}`);
  lines.push(`@META key=lifecycle | value=${doc.lifecycle}`);
  if (doc.agentTemplateVersion !== undefined) {
    lines.push(`@META key=agent_template_version | value=${doc.agentTemplateVersion}`);
  }
  // Phase A — scaffold-system version stamps (template_version + contract_version).
  // Emitted AFTER agent_template_version to preserve backward-compat read order.
  if (doc.templateVersion !== undefined) {
    lines.push(`@META key=template_version | value=${doc.templateVersion}`);
  }
  if (doc.contractVersion !== undefined) {
    lines.push(`@META key=contract_version | value=${doc.contractVersion}`);
  }

  return lines.join("\n") + "\n";
}

function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
