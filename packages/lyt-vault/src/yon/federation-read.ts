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

// Hand-rolled parser for `pod.yon`. Counterpart to federation-write.ts.
// Same precedent rationale: matches `yon/parse.ts` shape; `@younndai/yon-parser`
// dep deferred to v1.A.3.
//
// Returns null for malformed input only at the top-level @FEDERATION (no rid
// → unparseable). @FED_MESH records that fail validation are skipped
// (best-effort recovery) — pod.yon is recoverable from `lyt
// federation rebuild` if individual records corrupt.

import { existsSync, readFileSync } from "node:fs";

import type { Client } from "@libsql/client";

import { listFederationStates } from "../registry/federation-state.js";
import { getFederationYonPath, vaultRepoName } from "../util/federation-paths.js";
import type {
  FedMeshPushKind,
  FedMeshRecord,
  FedMeshRole,
  FedVaultRecord,
  FedVaultStatus,
  FederationDoc,
  FederationRecord,
  FederationVisibility,
} from "./federation-write.js";
import { unescapeQuoted } from "./_helpers.js";

// Phase E — read the pod.yon SoT across every federation state and return the set
// of vault NAMES whose per-vault `visibility === "public"` (FedVaultRecord;
// default "private"). This is the LOCKED `lyt-public` trigger — NOT
// `mesh-visibility` (the per-note frontmatter field). Best-effort + fail-closed:
// ANY failure (no pod yet, unparseable manifest, missing handle) returns an EMPTY
// set, so no vault is ever mistakenly tagged public.
//
// Extracted from the byte-identical resolvers that previously lived in
// flows/sync-metadata.ts and flows/doctor.ts (Phase E release review de-dupe). Both
// import this single function; behavior is unchanged.
export async function resolvePublicVaultNames(db: Client): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const states = await listFederationStates(db);
    for (const state of states) {
      const podYonPath = getFederationYonPath(state.handle);
      if (!existsSync(podYonPath)) continue;
      const doc = parseFederationYon(readFileSync(podYonPath, "utf8"));
      for (const v of doc.vaults) {
        if (v.visibility === "public") out.add(v.vaultName);
      }
    }
  } catch {
    // No pod / unparseable manifest → every vault falls back to private.
  }
  return out;
}

export function parseFederationYon(content: string): FederationDoc {
  const fed = parseFederation(content);
  const meshes = parseFedMeshes(content);
  const vaults = parseFedVaults(content);
  const lastSyncedAt = readMetaBare(content, "last_synced_at") ?? "";
  return {
    federation: fed,
    meshes,
    vaults,
    lastSyncedAt,
  };
}

const VALID_VAULT_STATUS: ReadonlySet<string> = new Set([
  "active",
  "disconnected",
  "missing",
  "tombstoned",
  "access_lost",
]);

function parseFederation(content: string): FederationRecord {
  const ridMatch = content.match(/^@FEDERATION\s+rid=fed:([0-9a-f]+)/m);
  if (!ridMatch) {
    throw new Error("pod.yon is missing a @FEDERATION rid=fed:... declaration");
  }
  const fedRidHex = ridMatch[1]!;

  const handle = readQuotedField(content, "handle") ?? "";
  const visibilityRaw = readBareField(content, "visibility");
  const visibility: FederationVisibility = visibilityRaw === "public" ? "public" : "private";
  const createdAt = readTimestampField(content, "created_at") ?? "";

  return { fedRidHex, handle, visibility, createdAt };
}

// Line-based block extraction: a @FED_MESH block runs from its header line
// through every following continuation line (`  | ...`) plus blanks, until
// the next line starting with `@`. JS regex has no `\Z` anchor — the prior
// lookahead-based extractor stopped on literal `Z` inside timestamps. The
// line-walk is unambiguous and immune to that class of bug.
function parseFedMeshes(content: string): FedMeshRecord[] {
  const lines = content.split(/\r?\n/);
  const out: FedMeshRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("@FED_MESH ") && !line.startsWith("@FED_MESH\t")) {
      i++;
      continue;
    }
    const blockLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.length > 0 && next.startsWith("@")) break;
      blockLines.push(next);
      i++;
    }
    const block = blockLines.join("\n");

    const fedRidMatch = block.match(/^@FED_MESH\s+fed_rid=fed:([0-9a-f]+)/m);
    if (!fedRidMatch) continue;
    const meshRidMatch = block.match(/\|\s*mesh_rid=mesh:([0-9a-f]+)/);
    if (!meshRidMatch) continue;

    const meshName = readQuotedField(block, "mesh_name");
    const pushTarget = readQuotedField(block, "push_target");
    const pushKindRaw = readBareField(block, "push_kind");
    const roleRaw = readBareField(block, "role");
    const addedAt = readTimestampField(block, "added_at");

    if (
      meshName === null ||
      pushTarget === null ||
      pushKindRaw === null ||
      roleRaw === null ||
      addedAt === null
    ) {
      continue;
    }
    const pushKind: FedMeshPushKind = pushKindRaw === "org" ? "org" : "handle";
    const role: FedMeshRole = roleRaw === "join" ? "join" : "own";

    out.push({
      fedRidHex: fedRidMatch[1]!,
      meshRidHex: meshRidMatch[1]!,
      meshName,
      pushTarget,
      pushKind,
      role,
      addedAt,
    });
  }
  return out;
}

// Counterpart to parseFedMeshes for @FED_VAULT blocks. Same line-walk block
// extraction; same best-effort recovery (a record that fails validation is
// skipped — pod.yon is regenerable from the registry). `home_mesh_rid=mesh:none`
// decodes to null (orphan vault).
function parseFedVaults(content: string): FedVaultRecord[] {
  const lines = content.split(/\r?\n/);
  const out: FedVaultRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("@FED_VAULT ") && !line.startsWith("@FED_VAULT\t")) {
      i++;
      continue;
    }
    const blockLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.length > 0 && next.startsWith("@")) break;
      blockLines.push(next);
      i++;
    }
    const block = blockLines.join("\n");

    const vaultRidMatch = block.match(/^@FED_VAULT\s+vault_rid=vault:([0-9a-f]+)/m);
    if (!vaultRidMatch) continue;

    const vaultName = readQuotedField(block, "vault_name");
    const homeMeshMatch = block.match(/\|\s*home_mesh_rid=mesh:([0-9a-f]+|none)/);
    const statusRaw = readBareField(block, "status");
    const registeredAt = readTimestampField(block, "registered_at");

    if (
      vaultName === null ||
      homeMeshMatch === null ||
      statusRaw === null ||
      registeredAt === null ||
      !VALID_VAULT_STATUS.has(statusRaw)
    ) {
      continue;
    }

    // Brief B — `repo` + `visibility` are LENIENT on read: a pod.yon written
    // before these fields existed (a Brief-A manifest) parses cleanly. `repo`
    // defaults to the canonical chokepoint name derived from vault_name;
    // `visibility` defaults to "private" (the safe default). The WRITER always
    // emits both, so a round-trip through render→parse is exact.
    const repoRaw = readQuotedField(block, "repo");
    const repo = repoRaw ?? vaultRepoName(vaultName);
    const visibilityRaw = readBareField(block, "visibility");
    const visibility: FederationVisibility = visibilityRaw === "public" ? "public" : "private";

    out.push({
      vaultRidHex: vaultRidMatch[1]!,
      vaultName,
      homeMeshRidHex: homeMeshMatch[1] === "none" ? null : homeMeshMatch[1]!,
      repo,
      visibility,
      status: statusRaw as FedVaultStatus,
      registeredAt,
    });
  }
  return out;
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

function readTimestampField(content: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}:ts=(\\S+)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1]!;
}

function readMetaBare(content: string, key: string): string | null {
  const re = new RegExp(`@META\\s+key=${escapeRegex(key)}\\s*\\|\\s*value=([^\\s|"]+)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1]!;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
