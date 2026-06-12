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

// v1.A.1b — rid + vaultRid flip to Uint8Array; renderer serialises both as
// 8-4-4-4-12 dashed UUIDv7 on disk (canonical RFC 9562 form).
export interface MemscopeRecord {
  rid: Uint8Array;
  scopeLevel: "vault" | "project" | "workspace" | "global";
  readRoles: readonly string[];
  writeRoles: readonly string[];
  adminRoles: readonly string[];
  region?: string | undefined;
  dataResidency?: string | undefined;
  redactPii?: boolean | undefined;
  defaultView: "private" | "group" | "public";
}

export interface MemscopeDoc {
  vaultRid: Uint8Array;
  vaultName: string;
  scope: MemscopeRecord;
  allowExpandToProject: boolean;
  allowExpandToWorkspace: boolean;
}

export function renderMemscopeYon(doc: MemscopeDoc): string {
  const s = doc.scope;
  const sRid = uuid7BytesToDashedString(s.rid);
  const vRid = uuid7BytesToDashedString(doc.vaultRid);
  const lines: string[] = [
    `@DOC ver=2.0 | id=${sRid} | title="${escapeQuoted(doc.vaultName)} — default memscope" | domain=yai.lyt@1.0 | kind=cfg | profile=agent`,
    ``,
    `@MEMSCOPE rid=${sRid}`,
    `  | scope_level=${s.scopeLevel}`,
    `  | read_roles=[${formatRoleList(s.readRoles)}]`,
    `  | write_roles=[${formatRoleList(s.writeRoles)}]`,
    `  | admin_roles=[${formatRoleList(s.adminRoles)}]`,
  ];

  if (s.region) lines.push(`  | region="${escapeQuoted(s.region)}"`);
  if (s.dataResidency) {
    lines.push(`  | data_residency="${escapeQuoted(s.dataResidency)}"`);
  }
  if (s.redactPii !== undefined) {
    lines.push(`  | redact_pii:bool=${s.redactPii}`);
  }
  lines.push(`  | default_view=${s.defaultView}`);
  lines.push(``);

  lines.push(`@META key=allow_expand_to_project | value=${doc.allowExpandToProject}`);
  lines.push(`@META key=allow_expand_to_workspace | value=${doc.allowExpandToWorkspace}`);
  lines.push(`@META key=applies_to_vault | value=${vRid}`);

  return lines.join("\n") + "\n";
}

function formatRoleList(roles: readonly string[]): string {
  return roles.map((r) => `"${escapeQuoted(r)}"`).join(",");
}

function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
