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
  MeshHomeRecord,
  MeshPushKind,
  MeshRecord,
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
  // Fed-v2 Layer-1 (Phase D1c) — @MESH_SUBSCRIPTION is no longer parsed
  // (no-legacy, design §5). A legacy mesh.yon carrying @MESH_SUBSCRIPTION blocks
  // now has them silently IGNORED (same tolerance the parser already gives any
  // unknown @TAG). Subscriptions live in the per-writer ledger, not mesh.yon.
  // Fed-v2 Slice 1b (#13 DELETE) — @MESH_PUBLIC and @UPDATE_CADENCE are
  // fully removed. Any legacy mesh.yon carrying those blocks now has them
  // silently IGNORED (same tolerance the parser already gives any unknown @TAG).
  // Slice 2a — @MESH_EDGE is no longer parsed (no-legacy). A legacy mesh.yon
  // carrying @MESH_EDGE blocks now has them silently IGNORED; edges live in the
  // per-writer ledger, reconstituted into the mesh_edges cache.
  return {
    mesh,
    homeVaults,
  };
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

  return {
    rid,
    name,
    ...(pushTarget !== null ? { pushTarget } : {}),
    ...(pushKind !== undefined ? { pushKind } : {}),
    mainVaultRid,
    createdAt,
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

// Slice 2a — parseMeshEdges DELETED. The @MESH_EDGE record type is retired
// from mesh.yon (no-legacy); edges live in the per-writer ledger, so there is
// nothing to parse. Any residual @MESH_EDGE block in a legacy file is simply not
// walked. (Mirror of the D1c parseMeshSubscriptions removal below.)

// Fed-v2 Layer-1 (Phase D1c) — parseMeshSubscriptions DELETED. The
// @MESH_SUBSCRIPTION record type is retired (no-legacy, design §5);
// mesh.yon no longer carries subscriptions, so there is nothing to parse. Any
// residual @MESH_SUBSCRIPTION block in a legacy file is simply not walked.

// Fed-v2 Slice 1b (#13 DELETE) — parseMeshPublic and parseMeshUpdateCadences
// DELETED. The @MESH_PUBLIC and @UPDATE_CADENCE record families are fully removed.
// Any legacy mesh.yon carrying those blocks now has them silently IGNORED
// (same tolerance the parser already gives any unknown @TAG).

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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
