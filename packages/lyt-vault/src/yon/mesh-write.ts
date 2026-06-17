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
// v1.B.6 extension — adds two PUBLIC-MESH record types: @MESH_PUBLIC (single
// record per mesh, publisher-declared discoverable metadata; emitted when
// MeshDoc.publicMeta is defined) and @UPDATE_CADENCE (zero-or-more per
// mesh; one per home vault with publisher-declared sync rhythm). The
// existing @MESH header gains an optional `default_vault_update_cadence`
// cron-string field. Determinism per the ratified default: @MESH_PUBLIC trivially sorted
// (one record); @UPDATE_CADENCE sorted by vault_rid ASC (hex-lex). Per
// no new yai.lyt parser primitives — CSV-string for topics and
// peak_hours rather than array (reconciles lyt-public-mesh.md §2.3 example
// which showed array syntax; v1.B.6 ships CSV to fit the existing
// readQuotedField primitive).
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
  // v1.B.6 — optional mesh-level default cadence applied to home vaults
  // without their own @UPDATE_CADENCE row. Cron expression (POSIX 5-field).
  // Set via `lyt mesh update-cadence <mesh> --default-vault-cadence <spec>`.
  defaultVaultUpdateCadence?: string | undefined;
}

// v1.B.6 — @MESH_PUBLIC record. Publisher-declared discoverable metadata
// for a mesh advertised as a public mesh. Single record per mesh; the
// publish surface is a property of the mesh's identity. Required:
// mesh_rid, description. All other fields optional. Field shapes derived
// from lyt-public-mesh.md §2.3.
export interface MeshPublicRecord {
  meshRid: Uint8Array;
  description: string;
  // CSV-string per v1.B.6 (lyt-public-mesh.md §2.3 example shows array;
  // ships as CSV to fit existing readQuotedField). Empty string = absent.
  topics?: string | undefined;
  maintainerContact?: string | undefined;
  maintainerHandle?: string | undefined;
  licenseOverride?: string | undefined;
  acceptContributions?: boolean | undefined;
  contributionUrl?: string | undefined;
  homepageUrl?: string | undefined;
  chatUrl?: string | undefined;
  // ISO 8601 timestamp the mesh was first published. Defaults at first
  // write time (the publishMeshFlow stamps this). May be omitted in
  // hand-authored mesh.yon files.
  createdAt?: string | undefined;
}

// v1.B.6 — @UPDATE_CADENCE record. Publisher-declared sync rhythm for a
// specific home vault. Zero-or-more per mesh; one per vault. Required:
// vault_rid, cadence_type. cron required when cadence_type=cron;
// interval_seconds required when cadence_type=interval. Field shapes
// derived from lyt-public-mesh.md §2.3.
export type MeshUpdateCadenceType = "cron" | "interval" | "on-demand";

export interface MeshUpdateCadenceRecord {
  vaultRid: Uint8Array;
  cadenceType: MeshUpdateCadenceType;
  cron?: string | undefined;
  intervalSeconds?: number | undefined;
  timezone?: string | undefined;
  // CSV string per v1.B.6 (lyt-public-mesh.md §2.3 showed array; ships as
  // CSV). Hours 0-23 separated by commas.
  peakHours?: string | undefined;
  onDemandAllowed?: boolean | undefined;
}

export interface MeshHomeRecord {
  meshRid: Uint8Array;
  vaultRid: Uint8Array;
  vaultName: string;
}

// v1.B.2 — @MESH_EDGE record. Field shape per lyt-federation-design.md
// §3:139-145. `kind` narrows to `parent` in v1; v1.C.1 may widen.
export interface MeshEdgeRecord {
  refMeshRid: Uint8Array;
  refVaultRid: Uint8Array;
  homeMeshRid: Uint8Array;
  homeVaultRid: Uint8Array;
  kind: "parent";
}

// v1.B.2 — @MESH_SUBSCRIPTION record. Field shape per
// lyt-federation-design.md §3:147-150.
export interface MeshSubscriptionRecord {
  meshRid: Uint8Array;
  externalVaultRid: Uint8Array;
  externalMeshRid: Uint8Array;
  externalMeshName: string;
}

export interface MeshDoc {
  mesh: MeshRecord;
  homeVaults: readonly MeshHomeRecord[];
  // v1.B.2 — edges/subscriptions default to empty (v1.B.1 initial-state
  // shape). Populated when the reader extracts them from disk or a
  // future v1.C.1 / v1.C.2 verb builds them.
  edges: readonly MeshEdgeRecord[];
  subscriptions: readonly MeshSubscriptionRecord[];
  // v1.B.6 — publisher metadata for public meshes. Absent (undefined)
  // when the mesh has not been published. Single record per mesh.
  publicMeta?: MeshPublicRecord | undefined;
  // v1.B.6 — zero-or-more @UPDATE_CADENCE rows, one per home vault that
  // has a publisher-declared sync rhythm. Empty array = no vault-specific
  // cadences declared.
  updateCadences: readonly MeshUpdateCadenceRecord[];
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
  if (m.defaultVaultUpdateCadence !== undefined && m.defaultVaultUpdateCadence.length > 0) {
    lines.push(`  | default_vault_update_cadence="${escapeQuoted(m.defaultVaultUpdateCadence)}"`);
  }
  lines.push(``);

  // v1.B.6 — @MESH_PUBLIC emitted directly after the @MESH header so the
  // publisher metadata is co-located with the mesh identity. Single record
  // per mesh (the publish surface is a property of the mesh's identity);
  // sort is trivial. Canonical key order: header `mesh_rid`, then
  // description, topics, maintainer_contact, maintainer_handle,
  // license_override, accept_contributions, contribution_url,
  // homepage_url, chat_url, created_at — emitted only when defined.
  if (doc.publicMeta !== undefined) {
    const p = doc.publicMeta;
    lines.push(`@MESH_PUBLIC mesh_rid=mesh:${uuid7BytesToDashedString(p.meshRid)}`);
    lines.push(`  | description="${escapeQuoted(p.description)}"`);
    if (p.topics !== undefined && p.topics.length > 0) {
      lines.push(`  | topics="${escapeQuoted(p.topics)}"`);
    }
    if (p.maintainerContact !== undefined && p.maintainerContact.length > 0) {
      lines.push(`  | maintainer_contact="${escapeQuoted(p.maintainerContact)}"`);
    }
    if (p.maintainerHandle !== undefined && p.maintainerHandle.length > 0) {
      lines.push(`  | maintainer_handle="${escapeQuoted(p.maintainerHandle)}"`);
    }
    if (p.licenseOverride !== undefined && p.licenseOverride.length > 0) {
      lines.push(`  | license_override="${escapeQuoted(p.licenseOverride)}"`);
    }
    if (p.acceptContributions !== undefined) {
      lines.push(`  | accept_contributions:bool=${p.acceptContributions ? "true" : "false"}`);
    }
    if (p.contributionUrl !== undefined && p.contributionUrl.length > 0) {
      lines.push(`  | contribution_url="${escapeQuoted(p.contributionUrl)}"`);
    }
    if (p.homepageUrl !== undefined && p.homepageUrl.length > 0) {
      lines.push(`  | homepage_url="${escapeQuoted(p.homepageUrl)}"`);
    }
    if (p.chatUrl !== undefined && p.chatUrl.length > 0) {
      lines.push(`  | chat_url="${escapeQuoted(p.chatUrl)}"`);
    }
    if (p.createdAt !== undefined && p.createdAt.length > 0) {
      lines.push(`  | created_at:ts=${p.createdAt}`);
    }
    lines.push(``);
  }

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

  // v1.B.6 — @UPDATE_CADENCE records sorted by vault_rid ASC. Emitted
  // after @MESH_HOME so each cadence sits near its vault's home row in
  // the canonical order. Canonical key order: header `vault_rid`, then
  // cadence_type, cron (when cadence_type=cron), interval_seconds (when
  // cadence_type=interval), timezone, peak_hours, on_demand_allowed —
  // each emitted only when defined.
  const sortedCadences = [...doc.updateCadences].sort((a, b) => compareHex(a.vaultRid, b.vaultRid));
  for (const c of sortedCadences) {
    lines.push(`@UPDATE_CADENCE vault_rid=vault:${uuid7BytesToDashedString(c.vaultRid)}`);
    lines.push(`  | cadence_type=${c.cadenceType}`);
    if (c.cron !== undefined && c.cron.length > 0) {
      lines.push(`  | cron="${escapeQuoted(c.cron)}"`);
    }
    if (c.intervalSeconds !== undefined) {
      lines.push(`  | interval_seconds:int=${c.intervalSeconds}`);
    }
    if (c.timezone !== undefined && c.timezone.length > 0) {
      lines.push(`  | timezone="${escapeQuoted(c.timezone)}"`);
    }
    if (c.peakHours !== undefined && c.peakHours.length > 0) {
      lines.push(`  | peak_hours="${escapeQuoted(c.peakHours)}"`);
    }
    if (c.onDemandAllowed !== undefined) {
      lines.push(`  | on_demand_allowed:bool=${c.onDemandAllowed ? "true" : "false"}`);
    }
    lines.push(``);
  }

  // @MESH_EDGE records sorted by (home_mesh_rid ASC, home_vault_rid ASC).
  // Canonical key order: header `ref_mesh_rid`, then `ref_vault_rid`,
  // `home_mesh_rid`, `home_vault_rid`, `kind`.
  const sortedEdges = [...doc.edges].sort((a, b) => {
    const byHomeMesh = compareHex(a.homeMeshRid, b.homeMeshRid);
    if (byHomeMesh !== 0) return byHomeMesh;
    return compareHex(a.homeVaultRid, b.homeVaultRid);
  });
  for (const e of sortedEdges) {
    lines.push(`@MESH_EDGE ref_mesh_rid=mesh:${uuid7BytesToDashedString(e.refMeshRid)}`);
    lines.push(`  | ref_vault_rid=vault:${uuid7BytesToDashedString(e.refVaultRid)}`);
    lines.push(`  | home_mesh_rid=mesh:${uuid7BytesToDashedString(e.homeMeshRid)}`);
    lines.push(`  | home_vault_rid=vault:${uuid7BytesToDashedString(e.homeVaultRid)}`);
    lines.push(`  | kind=${e.kind}`);
    lines.push(``);
  }

  // @MESH_SUBSCRIPTION records sorted by external_vault_rid ASC. Canonical
  // key order: header `mesh_rid`, then `external_vault_rid`,
  // `external_mesh_rid`, `external_mesh_name`.
  const sortedSubs = [...doc.subscriptions].sort((a, b) =>
    compareHex(a.externalVaultRid, b.externalVaultRid),
  );
  for (const s of sortedSubs) {
    lines.push(`@MESH_SUBSCRIPTION mesh_rid=mesh:${uuid7BytesToDashedString(s.meshRid)}`);
    lines.push(`  | external_vault_rid=vault:${uuid7BytesToDashedString(s.externalVaultRid)}`);
    lines.push(`  | external_mesh_rid=mesh:${uuid7BytesToDashedString(s.externalMeshRid)}`);
    lines.push(`  | external_mesh_name="${escapeQuoted(s.externalMeshName)}"`);
    lines.push(``);
  }

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
