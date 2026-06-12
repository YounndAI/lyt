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

// Mesh manifest parser — handles bulk-init manifests with @MESH, @VAULT, @SHARE_WITH records.
// Distinct from parse.ts (which parses a single vault.yon @VAULT record), this scans a
// document for multiple records of different kinds. Used by `lyt mesh init --from <manifest>`.

export interface ManifestMesh {
  name: string;
  desc: string | null;
  ghOrg: string | null;
  ghPrefix: string | null;
  branding: boolean;
}

export interface ManifestVault {
  name: string;
  desc: string | null;
  tier: string | null;
  parent: string | null;
  seed: string | null;
}

export interface ManifestShareWith {
  a: string;
  b: string;
}

export interface ParsedManifest {
  mesh: ManifestMesh | null;
  vaults: ManifestVault[];
  shareWith: ManifestShareWith[];
}

export function parseMeshManifest(content: string): ParsedManifest {
  return {
    mesh: parseMesh(content),
    vaults: parseVaults(content),
    shareWith: parseShareWith(content),
  };
}

function parseMesh(content: string): ManifestMesh | null {
  const lineRe = /^@MESH\s+(.+)$/m;
  const m = content.match(lineRe);
  if (!m) return null;
  const body = m[1]!;
  const name = readQuoted(body, "name");
  if (name === null) return null;
  return {
    name,
    desc: readQuoted(body, "desc"),
    ghOrg: readQuoted(body, "gh-org") ?? readBare(body, "gh-org"),
    ghPrefix: readQuoted(body, "gh-prefix") ?? readBare(body, "gh-prefix"),
    branding: readBoolWithDefault(body, "branding", true),
  };
}

function parseVaults(content: string): ManifestVault[] {
  const re = /^@VAULT\s+(.+)$/gm;
  const out: ManifestVault[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = m[1]!;
    // Skip the local-vault shape: parse.ts's @VAULT carries `rid=...` as first field.
    // Manifest @VAULT records carry `name="..."` as first field and never have rid.
    if (/^\s*rid=/.test(body)) continue;
    const name = readQuoted(body, "name");
    if (name === null) continue;
    out.push({
      name,
      desc: readQuoted(body, "desc"),
      tier: readQuoted(body, "tier"),
      parent: readQuoted(body, "parent") ?? readBare(body, "parent"),
      seed: readQuoted(body, "seed"),
    });
  }
  return out;
}

function parseShareWith(content: string): ManifestShareWith[] {
  const re = /^@SHARE_WITH\s+(.+)$/gm;
  const out: ManifestShareWith[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = m[1]!;
    const a = readQuoted(body, "a") ?? readBare(body, "a");
    const b = readQuoted(body, "b") ?? readBare(body, "b");
    if (a === null || b === null) continue;
    out.push({ a, b });
  }
  return out;
}

function readQuoted(body: string, key: string): string | null {
  const re = new RegExp(`(?:^|\\|)\\s*${escapeRegex(key)}="((?:\\\\.|[^"\\\\])*)"`);
  const m = body.match(re);
  if (!m) return null;
  return unescape(m[1]!);
}

function readBare(body: string, key: string): string | null {
  const re = new RegExp(`(?:^|\\|)\\s*${escapeRegex(key)}=([^\\s|"]+)`);
  const m = body.match(re);
  if (!m) return null;
  return m[1]!;
}

function readBoolWithDefault(body: string, key: string, dflt: boolean): boolean {
  const raw = readBare(body, key);
  if (raw === null) return dflt;
  return raw === "true" || raw === "1" || raw === "yes";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescape(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// GitHub repo-name shape: 1-100 chars from [A-Za-z0-9._-]. `/`, `:`, space,
// and other separators are NOT valid in a GH repo name — they would break
// `gh repo create {org}/{repoName}` downstream. Validated when `gh-prefix`
// is non-null so a malformed manifest is rejected early.
const GH_REPO_NAME_INVALID = /[^A-Za-z0-9._-]/;

// Apply `gh-prefix` soft-prefix to a vault name to derive its GitHub REPO
// NAME (the segment after `github.com/{gh-org}/`). GH repo names are
// inherently flat — they cannot contain `/` — so this concatenation is
// flat by design. Distinct from the local vault NAME, which the soft
// naming convention (lyt-naming-convention.md) recommends shaping as
// `owner/repo`. The two identifiers are different surfaces; the
// convention governs the local vault name, not the GH repo name. The
// deeper desync between local vault names and gh-org-prefixed names is
// design-level (handoff 2026-05-28 M-5), tracked separately.
//
// Naming-audit M-4 (handoff 2026-05-28-code-scope-findings-c123-m4):
// validate that `ghPrefix`, when set, produces a GH-valid repo name when
// concatenated. If the vault name already starts with the prefix, no
// double-prefix.
export function applyGhPrefix(vaultName: string, ghPrefix: string | null): string {
  if (!ghPrefix || ghPrefix.length === 0) return vaultName;
  if (GH_REPO_NAME_INVALID.test(ghPrefix)) {
    throw new Error(
      `gh-prefix ${JSON.stringify(ghPrefix)} contains characters invalid in a GitHub repo name. ` +
        `Allowed: letters, digits, '.', '_', '-'. ` +
        `gh-prefix is concatenated with the vault name to produce the GH repo name (e.g. gh-prefix='cats-' + name='master' → repo 'cats-master').`,
    );
  }
  const repoName = vaultName.startsWith(ghPrefix) ? vaultName : `${ghPrefix}${vaultName}`;
  if (GH_REPO_NAME_INVALID.test(repoName)) {
    throw new Error(
      `Derived GH repo name ${JSON.stringify(repoName)} (from gh-prefix=${JSON.stringify(ghPrefix)} + vault name=${JSON.stringify(vaultName)}) ` +
        `contains characters invalid in a GitHub repo name. Allowed: letters, digits, '.', '_', '-'.`,
    );
  }
  if (repoName.length > 100) {
    throw new Error(
      `Derived GH repo name ${JSON.stringify(repoName)} exceeds GitHub's 100-character repo-name limit.`,
    );
  }
  return repoName;
}
