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

import { hexToUuid7Bytes } from "../util/uuid7.js";

import type {
  MeshDoc,
  MeshEdgeRecord,
  MeshHomeRecord,
  MeshPublicRecord,
  MeshPushKind,
  MeshRecord,
  MeshSubscriptionRecord,
  MeshUpdateCadenceRecord,
  MeshUpdateCadenceType,
} from "./mesh-write.js";

// v1.B.2 — hand-rolled parser for `.lyt/mesh.yon`. Counterpart to
// mesh-write.ts.
//
// Mirrors `yon/federation-read.ts` + `yon/lanes-read.ts` line-walk block
// extraction (JS regex has no `\Z` anchor — the v1.A.0 phase surfaced this
// gotcha when timestamps with trailing `Z` confused lookahead-based
// extractors). Each `@MESH_*` block runs from its header line through
// every following continuation line (`  | ...`) plus blanks, until the
// next line starting with `@`.
//
// v1.B.2 hardening:
// - Parses @MESH (single record, required)
// - Parses @MESH_HOME (zero-or-more records)
// - Parses @MESH_EDGE (zero-or-more records) — NEW in v1.B.2
// - Parses @MESH_SUBSCRIPTION (zero-or-more records) — NEW in v1.B.2
// - SILENTLY ignores @TAGs that aren't recognised (preserves v1.B.1's
// tolerance — but note: the v1.B.2 writer does NOT round-trip-preserve
// fully-unknown @TAGs. If a future record type ships, both reader and
// writer must be extended together for full round-trip. Documented as
// a known v2 candidate.)
//
// String → bytes conversion happens at the on-disk → in-memory boundary
// via `hexToUuid7Bytes` (matches the v1.A.1b vault.yon boundary pattern).
//
// Source contract (verbatim): lyt-federation-design.md §3 lines 121-151.

export function parseMeshYon(content: string): MeshDoc {
  const mesh = parseMesh(content);
  const homeVaults = parseMeshHomes(content);
  const edges = parseMeshEdges(content);
  const subscriptions = parseMeshSubscriptions(content);
  // v1.B.6 — @MESH_PUBLIC + @UPDATE_CADENCE additions. Both default to
  // absent (publicMeta undefined, updateCadences empty) for legacy
  // mesh.yon files that don't carry them — preserves pre-release
  // compatibility (the parser tolerates absence).
  const publicMeta = parseMeshPublic(content);
  const updateCadences = parseMeshUpdateCadences(content);
  const doc: MeshDoc = {
    mesh,
    homeVaults,
    edges,
    subscriptions,
    updateCadences,
  };
  if (publicMeta !== null) {
    doc.publicMeta = publicMeta;
  }
  return doc;
}

function parseMesh(content: string): MeshRecord {
  const ridMatch = content.match(/^@MESH\s+rid=(?:")?mesh:([0-9a-fA-F-]+)(?:")?/m);
  if (!ridMatch) {
    throw new Error("mesh.yon is missing a @MESH rid=mesh:... declaration");
  }
  const rid = hexToUuid7Bytes(ridMatch[1]!);

  const name = readQuotedField(content, "name") ?? "";
  const pushTarget = readQuotedField(content, "push_target");
  const pushKindRaw = readBareField(content, "push_kind");
  let pushKind: MeshPushKind | undefined;
  if (pushKindRaw === "handle" || pushKindRaw === "org") {
    pushKind = pushKindRaw;
  }
  const mainVaultRidRaw = readPrefixedField(content, "main_vault_rid", "vault");
  if (mainVaultRidRaw === null) {
    throw new Error("mesh.yon is missing @MESH | main_vault_rid=vault:...");
  }
  const mainVaultRid = hexToUuid7Bytes(mainVaultRidRaw);
  const createdAt = readTimestampField(content, "created_at") ?? "";
  // v1.B.6 — optional default_vault_update_cadence on @MESH header. Read
  // from the full content (the field can only appear on @MESH per the ratified default).
  const defaultVaultUpdateCadence = readQuotedField(content, "default_vault_update_cadence");

  return {
    rid,
    name,
    ...(pushTarget !== null ? { pushTarget } : {}),
    ...(pushKind !== undefined ? { pushKind } : {}),
    mainVaultRid,
    createdAt,
    ...(defaultVaultUpdateCadence !== null ? { defaultVaultUpdateCadence } : {}),
  };
}

// Generic block extractor — yields each `@<HEADER>`-prefixed block as a
// joined string, runs through subsequent continuation lines (`  | ...`)
// and blanks until the next `@`-prefixed line. Mirrors lanes-read.ts +
// arcs-read.ts shape so any future @MESH_* record type plugs in
// uniformly.
function* iterateBlocks(content: string, header: string): Generator<string> {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith(`${header} `) && !line.startsWith(`${header}\t`)) {
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
    yield blockLines.join("\n");
  }
}

function parseMeshHomes(content: string): MeshHomeRecord[] {
  const out: MeshHomeRecord[] = [];
  for (const block of iterateBlocks(content, "@MESH_HOME")) {
    const meshRidRaw = readBlockPrefixedHeader(block, "@MESH_HOME", "mesh_rid", "mesh");
    if (meshRidRaw === null) continue;
    const vaultRidRaw = readPrefixedField(block, "vault_rid", "vault");
    if (vaultRidRaw === null) continue;
    const vaultName = readQuotedField(block, "vault_name");
    if (vaultName === null) continue;
    out.push({
      meshRid: hexToUuid7Bytes(meshRidRaw),
      vaultRid: hexToUuid7Bytes(vaultRidRaw),
      vaultName,
    });
  }
  return out;
}

function parseMeshEdges(content: string): MeshEdgeRecord[] {
  const out: MeshEdgeRecord[] = [];
  for (const block of iterateBlocks(content, "@MESH_EDGE")) {
    const refMeshRidRaw = readBlockPrefixedHeader(block, "@MESH_EDGE", "ref_mesh_rid", "mesh");
    if (refMeshRidRaw === null) continue;
    const refVaultRidRaw = readPrefixedField(block, "ref_vault_rid", "vault");
    if (refVaultRidRaw === null) continue;
    const homeMeshRidRaw = readPrefixedField(block, "home_mesh_rid", "mesh");
    if (homeMeshRidRaw === null) continue;
    const homeVaultRidRaw = readPrefixedField(block, "home_vault_rid", "vault");
    if (homeVaultRidRaw === null) continue;
    const kindRaw = readBareField(block, "kind");
    // Schema CHECK constraint at registry/migrations.ts narrows kind to
    // 'parent' in v1; widening lands in v1.C.1 if needed. Reject other
    // values silently (mirrors the v1.B.1 reader's posture for unknown
    // header tokens).
    if (kindRaw !== "parent") continue;
    out.push({
      refMeshRid: hexToUuid7Bytes(refMeshRidRaw),
      refVaultRid: hexToUuid7Bytes(refVaultRidRaw),
      homeMeshRid: hexToUuid7Bytes(homeMeshRidRaw),
      homeVaultRid: hexToUuid7Bytes(homeVaultRidRaw),
      kind: kindRaw,
    });
  }
  return out;
}

function parseMeshSubscriptions(content: string): MeshSubscriptionRecord[] {
  const out: MeshSubscriptionRecord[] = [];
  for (const block of iterateBlocks(content, "@MESH_SUBSCRIPTION")) {
    const meshRidRaw = readBlockPrefixedHeader(block, "@MESH_SUBSCRIPTION", "mesh_rid", "mesh");
    if (meshRidRaw === null) continue;
    const externalVaultRidRaw = readPrefixedField(block, "external_vault_rid", "vault");
    if (externalVaultRidRaw === null) continue;
    const externalMeshRidRaw = readPrefixedField(block, "external_mesh_rid", "mesh");
    if (externalMeshRidRaw === null) continue;
    const externalMeshName = readQuotedField(block, "external_mesh_name");
    if (externalMeshName === null) continue;
    out.push({
      meshRid: hexToUuid7Bytes(meshRidRaw),
      externalVaultRid: hexToUuid7Bytes(externalVaultRidRaw),
      externalMeshRid: hexToUuid7Bytes(externalMeshRidRaw),
      externalMeshName,
    });
  }
  return out;
}

// v1.B.6 — @MESH_PUBLIC parser. Single record per mesh; null when the
// mesh.yon has no @MESH_PUBLIC block (mesh is not publicly published).
// Required fields: mesh_rid, description. All other fields optional.
export function parseMeshPublic(content: string): MeshPublicRecord | null {
  for (const block of iterateBlocks(content, "@MESH_PUBLIC")) {
    const meshRidRaw = readBlockPrefixedHeader(block, "@MESH_PUBLIC", "mesh_rid", "mesh");
    if (meshRidRaw === null) continue;
    const description = readQuotedField(block, "description");
    if (description === null) continue;

    const topics = readQuotedField(block, "topics");
    const maintainerContact = readQuotedField(block, "maintainer_contact");
    const maintainerHandle = readQuotedField(block, "maintainer_handle");
    const licenseOverride = readQuotedField(block, "license_override");
    const acceptContributions = readBoolField(block, "accept_contributions");
    const contributionUrl = readQuotedField(block, "contribution_url");
    const homepageUrl = readQuotedField(block, "homepage_url");
    const chatUrl = readQuotedField(block, "chat_url");
    const createdAt = readTimestampField(block, "created_at");

    const rec: MeshPublicRecord = {
      meshRid: hexToUuid7Bytes(meshRidRaw),
      description,
    };
    if (topics !== null) rec.topics = topics;
    if (maintainerContact !== null) rec.maintainerContact = maintainerContact;
    if (maintainerHandle !== null) rec.maintainerHandle = maintainerHandle;
    if (licenseOverride !== null) rec.licenseOverride = licenseOverride;
    if (acceptContributions !== null) rec.acceptContributions = acceptContributions;
    if (contributionUrl !== null) rec.contributionUrl = contributionUrl;
    if (homepageUrl !== null) rec.homepageUrl = homepageUrl;
    if (chatUrl !== null) rec.chatUrl = chatUrl;
    if (createdAt !== null) rec.createdAt = createdAt;
    return rec;
  }
  return null;
}

// v1.B.6 — @UPDATE_CADENCE parser. Zero-or-more records, one per home
// vault that has a publisher-declared sync rhythm. Required fields:
// vault_rid, cadence_type. cadence_type narrows to cron|interval|on-demand;
// other values are silently dropped (mirrors v1.B.2 parseMeshEdges kind
// gating).
export function parseMeshUpdateCadences(content: string): MeshUpdateCadenceRecord[] {
  const out: MeshUpdateCadenceRecord[] = [];
  for (const block of iterateBlocks(content, "@UPDATE_CADENCE")) {
    const vaultRidRaw = readBlockPrefixedHeader(block, "@UPDATE_CADENCE", "vault_rid", "vault");
    if (vaultRidRaw === null) continue;
    const cadenceTypeRaw = readBareField(block, "cadence_type");
    if (cadenceTypeRaw === null) continue;
    let cadenceType: MeshUpdateCadenceType;
    if (
      cadenceTypeRaw === "cron" ||
      cadenceTypeRaw === "interval" ||
      cadenceTypeRaw === "on-demand"
    ) {
      cadenceType = cadenceTypeRaw;
    } else {
      continue;
    }
    const cron = readQuotedField(block, "cron");
    const intervalSeconds = readIntField(block, "interval_seconds");
    const timezone = readQuotedField(block, "timezone");
    const peakHours = readQuotedField(block, "peak_hours");
    const onDemandAllowed = readBoolField(block, "on_demand_allowed");

    const rec: MeshUpdateCadenceRecord = {
      vaultRid: hexToUuid7Bytes(vaultRidRaw),
      cadenceType,
    };
    if (cron !== null) rec.cron = cron;
    if (intervalSeconds !== null) rec.intervalSeconds = intervalSeconds;
    if (timezone !== null) rec.timezone = timezone;
    if (peakHours !== null) rec.peakHours = peakHours;
    if (onDemandAllowed !== null) rec.onDemandAllowed = onDemandAllowed;
    out.push(rec);
  }
  return out;
}

// Read `<key>=<prefix>:<value>` where the value is a UUID-shaped hex string
// (32 chars or dashed 8-4-4-4-12). Value may be quoted ("…") or bare.
function readPrefixedField(content: string, key: string, prefix: string): string | null {
  const re = new RegExp(
    `\\|\\s*${escapeRegex(key)}=(?:")?${escapeRegex(prefix)}:([0-9a-fA-F-]+)(?:")?`,
  );
  const m = content.match(re);
  if (!m) return null;
  return m[1]!;
}

// Read the prefix-anchored header field (e.g. `@MESH_HOME mesh_rid=mesh:…`).
function readBlockPrefixedHeader(
  block: string,
  header: string,
  key: string,
  prefix: string,
): string | null {
  const re = new RegExp(
    `^${escapeRegex(header)}\\s+${escapeRegex(key)}=(?:")?${escapeRegex(prefix)}:([0-9a-fA-F-]+)(?:")?`,
    "m",
  );
  const m = block.match(re);
  if (!m) return null;
  return m[1]!;
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

// v1.B.6 — read `<key>:int=<digits>` field.
function readIntField(content: string, key: string): number | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}:int=(-?\\d+)`);
  const m = content.match(re);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

// v1.B.6 — read `<key>:bool=true|false` field.
function readBoolField(content: string, key: string): boolean | null {
  const re = new RegExp(`\\|\\s*${escapeRegex(key)}:bool=(true|false)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1] === "true";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
