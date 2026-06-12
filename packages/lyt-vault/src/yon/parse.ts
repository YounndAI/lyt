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

export interface ParsedVaultHomeMesh {
  // Hex-shaped strings (matches the rest of the parser's rid convention;
  // boundary callers convert to bytes via hexToUuid7Bytes).
  vaultRid: string;
  meshRid: string;
  meshName: string;
  assignedAt: string;
}

export interface ParsedVaultYon {
  rid: string;
  name: string;
  desc: string | null;
  parentVault: string | null;
  shareWith: string[];
  acceptsFrom: string[];
  tierHint: string | null;
  memscopeRid: string | null;
  createdAt: string | null;
  version: string | null;
  gitUrl: string | null;
  primaryOwner: string | null;
  lifecycle: string | null;
  topics: string[];
  agentTemplateVersion: number | null;
  frozenAt: string | null;
  frozenUntil: string | null;
  // v1.B.3 — present when vault.yon carries a @VAULT_HOME_MESH record.
  // Absence (pre-v1.B.3 vaults; vaults created without a home-mesh
  // assignment) returns null.
  homeMesh: ParsedVaultHomeMesh | null;
}

export function parseVaultYon(content: string): ParsedVaultYon {
  const ridMatch = content.match(/^@VAULT\s+rid=([^\s|]+)/m);
  if (!ridMatch) {
    throw new Error("vault.yon is missing a @VAULT rid declaration");
  }
  const rid = ridMatch[1]!;

  return {
    rid,
    name: readQuotedField(content, "name") ?? "",
    desc: readQuotedField(content, "desc"),
    parentVault: readBareField(content, "parent_vault"),
    shareWith: readListField(content, "share_with"),
    acceptsFrom: readListField(content, "accepts_from"),
    tierHint: readQuotedField(content, "tier_hint"),
    memscopeRid: readBareField(content, "memscope"),
    createdAt: readTimestampField(content, "created_at"),
    version: readQuotedField(content, "version"),
    gitUrl: readMetaQuoted(content, "git_url"),
    primaryOwner: readMetaBare(content, "primary_owner"),
    lifecycle: readMetaBare(content, "lifecycle"),
    topics: readTopicTags(content),
    agentTemplateVersion: readMetaInt(content, "agent_template_version"),
    frozenAt: readTimestampField(content, "frozen_at"),
    frozenUntil: readTimestampField(content, "frozen_until"),
    homeMesh: parseVaultHomeMesh(content),
  };
}

// v1.B.3 — parse the @VAULT_HOME_MESH block, if present. The record is a
// header line `@VAULT_HOME_MESH vault_rid=vault:<hex>` followed by 3
// continuation lines (mesh_rid, mesh_name, assigned_at:ts). Returns null
// when absent (pre-v1.B.3 vaults).
function parseVaultHomeMesh(content: string): ParsedVaultHomeMesh | null {
  const headerMatch = content.match(
    /^@VAULT_HOME_MESH\s+vault_rid=(?:")?vault:([0-9a-fA-F-]+)(?:")?/m,
  );
  if (!headerMatch) return null;

  // Scope the field reads to the block — find the @VAULT_HOME_MESH header
  // and the next `@`-prefixed line.
  const lines = content.split(/\r?\n/);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("@VAULT_HOME_MESH ") || lines[i]!.startsWith("@VAULT_HOME_MESH\t")) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;
  const blockLines: string[] = [lines[startIdx]!];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const ln = lines[i]!;
    if (ln.length > 0 && ln.startsWith("@")) break;
    blockLines.push(ln);
  }
  const block = blockLines.join("\n");

  const vaultRid = headerMatch[1]!;
  const meshRidMatch = block.match(/\|\s*mesh_rid=(?:")?mesh:([0-9a-fA-F-]+)(?:")?/);
  if (!meshRidMatch) return null;
  const meshName = readQuotedField(block, "mesh_name");
  if (meshName === null) return null;
  const assignedAt = readTimestampField(block, "assigned_at");
  if (assignedAt === null) return null;

  return {
    vaultRid,
    meshRid: meshRidMatch[1]!,
    meshName,
    assignedAt,
  };
}

function readMetaBare(content: string, key: string): string | null {
  const re = new RegExp(`@META\\s+key=${escapeRegex(key)}\\s*\\|\\s*value=([^\\s|"]+)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1]!;
}

function readMetaInt(content: string, key: string): number | null {
  const v = readMetaBare(content, key);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function readQuotedField(content: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}="((?:\\\\.|[^"\\\\])*)"`);
  const m = content.match(re);
  if (!m) return null;
  return unescapeQuoted(m[1]!);
}

function readBareField(content: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}=([^\\s|"\\[][^\\s|]*)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1]!;
}

function readListField(content: string, key: string): string[] {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}=\\[([^\\]]*)\\]`);
  const m = content.match(re);
  if (!m) return [];
  const inner = m[1]!.trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readTimestampField(content: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}:ts=(\\S+)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1]!;
}

function readMetaQuoted(content: string, key: string): string | null {
  const re = new RegExp(`@META\\s+key=${escapeRegex(key)}\\s*\\|\\s*value="((?:\\\\.|[^"\\\\])*)"`);
  const m = content.match(re);
  if (!m) return null;
  return unescapeQuoted(m[1]!);
}

function readTopicTags(content: string): string[] {
  const re = /@TAG\s+key=topic\s*\|\s*value="((?:\\.|[^"\\])*)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(unescapeQuoted(m[1]!));
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
