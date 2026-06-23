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

import { uuid7BytesToDashedString, uuid7BytesToHex } from "../util/uuid7.js";

// v1.B.2 — hand-rolled writer for `.lyt/mesh.yon` (SoT for a mesh's
// definition, lives in its main vault). Counterpart to mesh-read.ts.
//
// Mirrors `yon/vault.ts` + `yon/federation-write.ts` + `yon/lanes-write.ts`:
// - `@younndai/yon-parser` runtime dep still deferred (per project posture).
// - Rids serialised as 8-4-4-4-12 dashed UUIDv7 strings via
// `uuid7BytesToDashedString` (canonical RFC 9562 string form).
//
// fed-v2 Slice 1b (#13 DELETE) — the v1.B.6 PUBLIC-MESH record types
// @MESH_PUBLIC and @UPDATE_CADENCE (and the @MESH `default_vault_update_cadence`
// field) were removed here; the vault-scoped publish surface is rebuilt in a
// later layer.
//
// v1.B.2 hardening:
// - Emits ALL FOUR record types: @MESH, @MESH_HOME, @MESH_EDGE,
// @MESH_SUBSCRIPTION. @MESH_EDGE + @MESH_SUBSCRIPTION are preserve-only
// for round-trip (no NEW verb writes them in v1.B.2 — `lyt mesh
// add-edge` ships v1.C.1; `lyt mesh subscribe` ships v1.C.2). The
// writer emits them when present in the `MeshDoc` so a parse → render
// cycle is byte-stable for documents that carry edges/subscriptions
// hand-authored or written by future verbs.
// - Determinism contract per master-plan §v1.B.2:510:
// * Canonical key order inside each record (header first, then
// fields in spec order per lyt-federation-design.md §3:121-150)
// * @MESH_HOME records sorted by `vault_rid` ASC (hex-string lex)
// * @MESH_EDGE records sorted by `(home_mesh_rid, home_vault_rid)` ASC
// * @MESH_SUBSCRIPTION records sorted by `external_vault_rid` ASC
// - Idempotent re-render: `render(parse(render(doc))) === render(doc)`.
// For any `MeshDoc`, the rendered bytes are a fixed point under
// parse + render. Hand-authored mesh.yon files that don't match the
// canonical sort order canonicalise on first re-render.
//
// Round-trip contract (master-plan §v1.B.2:509):
// - `parse(render(doc)) ≡ doc` structurally (rids round-trip via
// `hexToUuid7Bytes(uuid7BytesToDashedString(...))`; strings
// round-trip via escapeQuoted/unescapeQuoted pair).
// - `render(parse(file)) ≡ file` byte-identical when `file` was itself
// emitted by `render` (idempotent re-render).
// - Hand-authored `file` that doesn't match canonical ordering will
// normalise on first `render(parse(file))`; the SECOND
// `render(parse(...))` is then a fixed point.
//
// Source contract (verbatim): lyt-federation-design.md §3 lines 121-151.

export type MeshPushKind = "handle" | "org";

export interface MeshRecord {
  rid: Uint8Array;
  name: string;
  // push_target / push_kind are optional — `lyt mesh init --no-push` skips
  // remote setup entirely; the resulting mesh.yon omits both fields rather
  // than serialising empty strings (matches the Brief §3 schema where both
  // fields appear under the @MESH header but are optional in --no-push mode).
  pushTarget?: string | undefined;
  pushKind?: MeshPushKind | undefined;
  mainVaultRid: Uint8Array;
  createdAt: string;
}

export interface MeshHomeRecord {
  meshRid: Uint8Array;
  vaultRid: Uint8Array;
  vaultName: string;
}

// Slice 2a — the @MESH_EDGE record TYPE was DELETED from mesh.yon. mesh.yon
// is no longer the edge SoT; the per-writer ledger shards
// (`<podRoot>/ledger/mesh-edges/<writerId>/`, yon/mesh-edge-ledger-{write,read})
// are, reconstituted into the `mesh_edges` cache by rebuildFederationCacheFlow.
// The writer stopped EMITTING @MESH_EDGE rows; the reader silently IGNORES any
// legacy @MESH_EDGE block (same tolerance any unknown @TAG gets). (Former
// interface MeshEdgeRecord removed here — mirror of the D1c @MESH_SUBSCRIPTION
// removal below.)

// Fed-v2 Layer-1 (Phase D1c) — the @MESH_SUBSCRIPTION record TYPE was DELETED
// (no-legacy, design §5). mesh.yon is no longer the subscription SoT; the
// per-writer ledger shards are, reconstituted into the mesh_subscriptions cache
// by rebuildFederationCacheFlow. The Phase-C writer had already stopped EMITTING
// the record; D1c removes the dangling type + parser + the MeshDoc.subscriptions
// field. (Former interface MeshSubscriptionRecord removed here.)

export interface MeshDoc {
  mesh: MeshRecord;
  homeVaults: readonly MeshHomeRecord[];
  // Fed-v2 D1c: the `subscriptions` field was removed (no-legacy) — mesh.yon no
  // longer carries subscriptions; the ledger does.
  // Fed-v2 Slice 1b: `publicMeta` and `updateCadences` removed (#13 DELETE).
  // Slice 2a: the `edges` field was removed (no-legacy) — mesh.yon no longer
  // carries @MESH_EDGE; the per-writer ledger does, reconstituted into the
  // mesh_edges cache by rebuildFederationCacheFlow.
}

export function renderMeshYon(doc: MeshDoc): string {
  const m = doc.mesh;
  const meshRidStr = uuid7BytesToDashedString(m.rid);
  const lines: string[] = [
    `@DOC ver=2.0 | id=mesh:${meshRidStr} | title="${escapeQuoted(m.name)}" | domain=yai.lyt@1.0 | kind=cfg | profile=agent`,
    ``,
    `@MESH rid=mesh:${meshRidStr}`,
    `  | name="${escapeQuoted(m.name)}"`,
  ];
  if (m.pushTarget !== undefined && m.pushTarget.length > 0) {
    lines.push(`  | push_target="${escapeQuoted(m.pushTarget)}"`);
  }
  if (m.pushKind !== undefined) {
    lines.push(`  | push_kind=${m.pushKind}`);
  }
  lines.push(`  | main_vault_rid=vault:${uuid7BytesToDashedString(m.mainVaultRid)}`);
  lines.push(`  | created_at:ts=${m.createdAt}`);
  lines.push(``);

  // @MESH_HOME records sorted by vault_rid ASC (hex-string lex) for
  // cross-platform stable ordering. Same canonical key order as v1.B.1
  // (header `mesh_rid`, then `vault_rid`, then `vault_name`).
  const sortedHomes = [...doc.homeVaults].sort((a, b) => compareHex(a.vaultRid, b.vaultRid));
  for (const home of sortedHomes) {
    lines.push(`@MESH_HOME mesh_rid=mesh:${uuid7BytesToDashedString(home.meshRid)}`);
    lines.push(`  | vault_rid=vault:${uuid7BytesToDashedString(home.vaultRid)}`);
    lines.push(`  | vault_name="${escapeQuoted(home.vaultName)}"`);
    lines.push(``);
  }

  // Fed-v2 Slice 1b (#13 DELETE) — @MESH_PUBLIC and @UPDATE_CADENCE writer
  // sections removed. Legacy mesh.yon files carrying those blocks parse with them
  // silently IGNORED.

  // Slice 2a — the @MESH_EDGE writer section was removed (no-legacy).
  // mesh.yon no longer carries edges; the per-writer append-only ledger does
  // (`<podRoot>/ledger/mesh-edges/<writerId>/`,
  // yon/mesh-edge-ledger-{write,read}.ts), reconstituted into the `mesh_edges`
  // cache by rebuildFederationCacheFlow. A legacy mesh.yon carrying @MESH_EDGE
  // rows now parses with those blocks IGNORED.

  // Fed-v2 Layer-1 (Phase D1c) — @MESH_SUBSCRIPTION is fully RETIRED (no-legacy,
  // design §5). The Phase-C writer stopped EMITTING it; D1c deleted the
  // record type, the parser, the YON tag, and the MeshDoc.subscriptions field.
  // Subscriptions now live ONLY in the per-writer append-only ledger
  // (`<podRoot>/ledger/subscriptions/<writerId>/`,
  // yon/subscription-ledger-{write,read}.ts), reconstituted into the
  // mesh_subscriptions cache by rebuildFederationCacheFlow. A legacy mesh.yon
  // carrying @MESH_SUBSCRIPTION rows now parses with those blocks IGNORED.

  return lines.join("\n");
}

function compareHex(a: Uint8Array, b: Uint8Array): number {
  const ah = uuid7BytesToHex(a);
  const bh = uuid7BytesToHex(b);
  if (ah < bh) return -1;
  if (ah > bh) return 1;
  return 0;
}

function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
