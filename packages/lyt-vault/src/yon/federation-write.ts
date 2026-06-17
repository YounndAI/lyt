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

// Hand-rolled writer for the pod manifest (`pod.yon`, formerly `federation.yon`
// pre-D5) — the user-facing DERIVED view of `{handle}/lyt-pod`.
//
// Why hand-rolled: matches the `yon/vault.ts` precedent. `@younndai/yon-parser`
// dependency is explicitly deferred to v1.A.3 (per master plan §5 Lane B note).
//
// Determinism contract: identical input → byte-identical output. Required for
// the v1.A.0 acceptance item "rebuild is deterministic" (plan §3 + master-plan
// §5 v1.A.0) AND for 's one-SoT invariant (regen from the registry must be
// stable). The `last_synced_at` stamp is the ONLY field allowed to drift.
//
// Sorting rules:
// - @FED_MESH records sorted by mesh_name ascending (stable tiebreak by mesh_rid)
// - @FED_VAULT records sorted by vault_name ascending (stable tiebreak by vault_rid)
// - Fields within each record emitted in fixed canonical order (declaration order)
//
// Emits @FEDERATION + @FED_MESH + @FED_VAULT. @FED_AUTOMATOR / @FED_PRIMER /
// @FED_CANVAS are reserved for later phases (v1.E.5, v1.D.4, v1.D.5).
//
// ── (Brief A, 2026-06-04) — INTERNAL-TECHNICAL identifiers, INTENTIONALLY
// retained (NOT a missed rename site for release review R3): "federation"
// stays the internal-technical term. renamed only the on-disk FILE
// (federation.yon → pod.yon) + user-facing prose. The `@DOC id=federation:`
// record id and the `@FEDERATION` / `@FED_MESH` / `@FED_VAULT` YON tags are the
// internal schema vocabulary (yai.lyt domain) and are DELIBERATELY left as-is —
// renaming them would (a) cascade into the hand-rolled parser + canvas node-id
// scheme (`fed:<rid>`), and (b) violate that convention. The user opens a file named
// `pod.yon`; the schema tags inside it are the technical layer.

import { escapeQuoted } from "./_helpers.js";

export type FederationVisibility = "private" | "public";
export type FedMeshRole = "own" | "join";
export type FedMeshPushKind = "handle" | "org";

export interface FederationRecord {
  fedRidHex: string;
  handle: string;
  visibility: FederationVisibility;
  createdAt: string;
}

export interface FedMeshRecord {
  fedRidHex: string;
  meshRidHex: string;
  meshName: string;
  pushTarget: string;
  pushKind: FedMeshPushKind;
  role: FedMeshRole;
  addedAt: string;
}

// (Brief A) — @FED_VAULT record: the pod manifest now LISTS the registry's
// vaults so `pod.yon` reflects the actual pod (dissolving the empty-manifest
// limitation + the 2-SoT divergence). Built from `registry.db` VaultRow on regen.
// `homeMeshRidHex` is null for an orphan vault (registered but in no mesh).
export type FedVaultStatus = "active" | "disconnected" | "missing" | "tombstoned" | "access_lost";

export interface FedVaultRecord {
  vaultRidHex: string;
  vaultName: string;
  homeMeshRidHex: string | null; // null → orphan (no mesh membership)
  // Brief B (scheme D) — the GitHub repo that holds this vault
  // (lyt-vault-<mesh>--<vault>). Computed via the vaultRepoName chokepoint at
  // regen time and materialized here so pod.yon is SELF-DESCRIBING: the
  // recovery loop (B.5) reads the repo directly from the manifest, and a human
  // can see which repo holds each vault without running code.
  repo: string;
  // Brief B — per-vault repo visibility. Default "private"; making a
  // vault public is a conscious, explicit per-vault action (a deferred seam),
  // never a default. Modeled per-vault (NOT per-mesh) because meshes hold mixed
  // private/semi-public/public vaults (handler 2026-06-04).
  visibility: FederationVisibility;
  status: FedVaultStatus;
  registeredAt: string;
}

export interface FederationDoc {
  federation: FederationRecord;
  meshes: readonly FedMeshRecord[];
  vaults: readonly FedVaultRecord[];
  lastSyncedAt: string;
}

export function renderFederationYon(doc: FederationDoc): string {
  const lines: string[] = [
    `@DOC ver=2.0 | id=federation:${doc.federation.handle} | domain=yai.lyt@1.0 | kind=cfg | profile=agent`,
    ``,
    `@FEDERATION rid=fed:${doc.federation.fedRidHex}`,
    `  | handle="${escapeQuoted(doc.federation.handle)}"`,
    `  | visibility=${doc.federation.visibility}`,
    `  | created_at:ts=${doc.federation.createdAt}`,
    ``,
  ];

  const sortedMeshes = [...doc.meshes].sort(compareFedMesh);
  for (const m of sortedMeshes) {
    lines.push(`@FED_MESH fed_rid=fed:${m.fedRidHex}`);
    lines.push(`  | mesh_rid=mesh:${m.meshRidHex}`);
    lines.push(`  | mesh_name="${escapeQuoted(m.meshName)}"`);
    lines.push(`  | push_target="${escapeQuoted(m.pushTarget)}"`);
    lines.push(`  | push_kind=${m.pushKind}`);
    lines.push(`  | role=${m.role}`);
    lines.push(`  | added_at:ts=${m.addedAt}`);
    lines.push(``);
  }

  // @FED_VAULT records — the registry's vaults, listed deterministically by
  // name (stable tiebreak by rid). `home_mesh_rid=mesh:none` encodes an orphan
  // vault (registered but in no mesh) so the field is always present + the
  // parser round-trips it without a sentinel-vs-missing ambiguity.
  const sortedVaults = [...doc.vaults].sort(compareFedVault);
  for (const v of sortedVaults) {
    lines.push(`@FED_VAULT vault_rid=vault:${v.vaultRidHex}`);
    lines.push(`  | vault_name="${escapeQuoted(v.vaultName)}"`);
    lines.push(`  | home_mesh_rid=mesh:${v.homeMeshRidHex ?? "none"}`);
    lines.push(`  | repo="${escapeQuoted(v.repo)}"`);
    lines.push(`  | visibility=${v.visibility}`);
    lines.push(`  | status=${v.status}`);
    lines.push(`  | registered_at:ts=${v.registeredAt}`);
    lines.push(``);
  }

  // `@META key=last_synced_at` is the canonical drift point per acceptance
  // item (b) — "lyt federation rebuild is deterministic … modulo
  // last_synced_at". Tests assert byte-identical output when this value
  // is held constant across rebuilds.
  lines.push(`@META key=last_synced_at | value=${doc.lastSyncedAt}`);

  return lines.join("\n") + "\n";
}

// Compare for stable deterministic ordering. Primary by mesh_name, tiebreak
// by mesh_rid (hex) — two meshes can in principle share a name in v1.A.0
// (multi-mesh tables ship in v1.A.1; today the "vaults" table is single-mesh).
// Tiebreak guarantees identical output across machines even in that corner.
function compareFedMesh(a: FedMeshRecord, b: FedMeshRecord): number {
  if (a.meshName < b.meshName) return -1;
  if (a.meshName > b.meshName) return 1;
  if (a.meshRidHex < b.meshRidHex) return -1;
  if (a.meshRidHex > b.meshRidHex) return 1;
  return 0;
}

// Primary by vault_name, tiebreak by vault_rid (hex). Two vaults can share a
// display name across meshes (e.g. `personal/main` vs `younndai/main` collapse
// to different full names, but defensive tiebreak guarantees stable output).
function compareFedVault(a: FedVaultRecord, b: FedVaultRecord): number {
  if (a.vaultName < b.vaultName) return -1;
  if (a.vaultName > b.vaultName) return 1;
  if (a.vaultRidHex < b.vaultRidHex) return -1;
  if (a.vaultRidHex > b.vaultRidHex) return 1;
  return 0;
}
