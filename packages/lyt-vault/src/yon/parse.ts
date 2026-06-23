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
  // Anchored to a `\n`/BOF line-start ONLY (lookbehind `(?<![^\n])`, no `m`
  // flag) — for ONE consistent line-start notion across the parser. The prior
  // `^...|m` form admitted U+2028/U+2029 as logical line-starts;
  // lower-exploitability here (first-match favors the top-of-file record + the
  // clone re-mints the rid) but kept in parity with the @META/@TAG readers.
  const ridMatch = content.match(/(?<![^\n])@VAULT\s+rid=([^\s|]+)/);
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
  // Anchored to a `\n`/BOF line-start ONLY (lookbehind `(?<![^\n])`, no `m`
  // flag) — same one consistent line-start notion as the @VAULT rid / @META /
  // @TAG readers.
  const headerMatch = content.match(
    /(?<![^\n])@VAULT_HOME_MESH\s+vault_rid=(?:")?vault:([0-9a-fA-F-]+)(?:")?/,
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
  // Anchored to a `\n`/BOF line-start ONLY — a zero-width lookbehind
  // `(?<![^\n])` (≡ at BOF or immediately after a `\n`) plus a `[ \t]*` indent,
  // and NO `m` flag. This is deliberately NARROWER than the `^\s*` + `m`-flag
  // form it replaces: the `m`-flag `^` treats U+2028 (LINE SEPARATOR)
  // and U+2029 (PARAGRAPH SEPARATOR) as logical line-starts, and `\s` matches
  // them — so a forged @META smuggled after a U+2028 INSIDE a quoted `desc`
  // value (no physical `\n`, no C0 byte) was matched first-match-wins.
  // The parser's line-start notion now AGREES with the splitter's (`/\r?\n/`)
  // and the clone-door guard's: `\n`/BOF only. `[ \t]*` (space/tab — the sole
  // indent renderVaultYon emits) NOT `\s*`, so the indent can't swallow a
  // Unicode line separator either.
  const re = new RegExp(`(?<![^\\n])[ \\t]*@META\\s+key=${escapeRegex(key)}\\s*\\|\\s*value=([^\\s|"]+)`);
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
  // single-line quoted-value discipline: exclude raw `\n` from the
  // value class (`[^"\\\n]`) so a quoted field that carries a raw newline
  // FAILS to match (terminates at the `\n`) rather than spanning lines. YON is
  // line-based and renderVaultYon (yon/vault.ts) emits every quoted field on
  // ONE line, so legit single-line content is unaffected; but a `\n`-carrier
  // field can no longer hide a forged record on a continuation line within the
  // capture. (`\\.` still consumes an escaped char, including `\n` written as
  // the two-char escape `\\n` — only a RAW newline byte terminates the field.)
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}="((?:\\\\.|[^"\\\\\\n])*)"`);
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
  // single-line discipline: exclude raw `\n` from the bracketed-list
  // inner class (`[^\]\n]`) so a `[...]` list cannot span lines. renderVaultYon
  // emits share_with/accepts_from on one line, so legit content is unaffected.
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}=\\[([^\\]\\n]*)\\]`);
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
  // Anchored to a `\n`/BOF line-start ONLY (lookbehind `(?<![^\n])` + `[ \t]*`,
  // no `m` flag) — see readMetaBare. A forged @META key=git_url smuggled inside
  // a quoted desc value after a U+2028/U+2029 or mid-line is no
  // longer matched first-match-wins; only a `\n`/BOF-delimited record is read.
  // single-line quoted-value discipline: exclude raw `\n` from the
  // value class (`[^"\\\n]`) so a forged record on a continuation line cannot
  // be smuggled INSIDE the captured git_url value. Pairs with the `\n`/BOF
  // record anchor: the anchor stops a forged @META from being READ as
  // its own record; this value-class change stops a `\n`-carrier git_url value
  // from spanning into the next line as hidden content.
  const re = new RegExp(`(?<![^\\n])[ \\t]*@META\\s+key=${escapeRegex(key)}\\s*\\|\\s*value="((?:\\\\.|[^"\\\\\\n])*)"`);
  const m = content.match(re);
  if (!m) return null;
  return unescapeQuoted(m[1]!);
}

function readTopicTags(content: string): string[] {
  // Anchored to a `\n`/BOF line-start ONLY (zero-width lookbehind `(?<![^\n])` +
  // `[ \t]*`, keeping the existing `g`/global flag, dropping `m`) — a forged
  // @TAG key=topic smuggled inside a quoted value after a U+2028/U+2029
  // or mid-line is no longer collected. The lookbehind is ZERO-WIDTH on
  // purpose: it does NOT consume the preceding `\n`, so two ADJACENT @TAG lines
  // both still match (a `\n`-consuming anchor would swallow the second line's
  // boundary). renderVaultYon emits @TAG at column 0.
  // single-line quoted-value discipline: exclude raw `\n` from the
  // topic value class (`[^"\\\n]`) so a `\n`-carrier topic value cannot span
  // into a continuation line. Keeps the `g` flag (collect every @TAG) and the
  // zero-width `\n`/BOF lookbehind (hardening pass; does NOT consume the preceding `\n`,
  // so two ADJACENT @TAG lines both still match).
  const re = /(?<![^\n])[ \t]*@TAG\s+key=topic\s*\|\s*value="((?:\\.|[^"\\\n])*)"/g;
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
