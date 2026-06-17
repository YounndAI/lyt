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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listEdgesByRefMesh } from "../registry/mesh-edges-repo.js";
import { listSubscriptionsForMesh } from "../registry/mesh-subscriptions-repo.js";
import { getMeshByName, getMeshByRid, listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import type { CheckResult } from "./doctor.js";
import { ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";

// v1.C.1 — `lyt mesh validate [--mesh <name>] [--json]`.
//
// Read-only diagnostic. Walks every registered mesh (or one filtered by
// `--mesh <name>`); parses each mesh's mesh.yon SoT; for each @MESH_EDGE
// row verifies:
// (a) ref_vault_rid resolves to a registered vault (the parent vault
// exists in the local registry)
// (b) home_vault_rid resolves to a registered vault (the child vault
// exists in the local registry)
// (c) home_mesh_rid resolves to a registered mesh AND that mesh's main
// vault directory exists on disk (the referenced vault's home mesh
// is reachable per brief default + master-plan §v1.C.1:609)
// Cross-references the libSQL `mesh_edges` cache via listEdgesByRefMesh
// and emits a separate warn-row per cache-drift case (mesh.yon row not
// in cache OR cache row not in mesh.yon) per brief default —
// remediation: `lyt mesh rebuild-registry`.
//
// Reuse from flows/doctor.ts: the `CheckResult` shape only. Per brief
// default, mesh-validate does NOT call doctorFlow; a v1.C.4+
// micro-commit can add a doctor check that delegates to this flow.
//
// Exit-code mapping (per brief default; matches v1.B.5 doctor
// `2 = warnings only` posture):
// 0 — every edge resolves (or no edges)
// 2 — one or more warn-rows present (never fail; diagnostic, not
// enforcement)
//
// Open-once seam (v1.A.5 CR-B1): callers may pass `registryDb`; the
// flow opens its own client only when omitted.

export interface ValidateMeshEdgesArgs {
  // When set, scope the validation to a single mesh by name. When
  // omitted, every registered mesh is validated.
  meshName?: string | undefined;
  // Open-once seam.
  registryDb?: Client | undefined;
}

export interface MeshEdgeFinding {
  // Source mesh name (the REFERENCING mesh whose mesh.yon recorded the
  // edge under inspection).
  refMeshName: string;
  refMeshRidHex: string;
  refVaultRidHex: string;
  homeMeshRidHex: string;
  homeVaultRidHex: string;
  kind: "parent";
  // Reason class: which leg of the resolve check failed.
  reason:
    | "ref-vault-not-registered"
    | "home-vault-not-registered"
    | "home-mesh-not-registered"
    | "home-mesh-main-vault-missing-on-disk"
    | "cache-row-missing-for-soT-edge"
    | "cache-row-orphaned-no-soT-edge";
  message: string;
  remediation: string;
}

// v1.C.4 — sibling-shape per the ratified default + v1.C.2 precedent. A
// MeshFileFinding describes a fault discovered at the mesh.yon-FILE level
// (parse error, future: checksum mismatch). Distinct from
// MeshEdgeFinding (per-edge row) and MeshSubscriptionFinding (per-row)
// — the file itself is the failure surface, not a row inside it. Sibling
// rather than widening MeshEdgeFinding.reason preserves JSON-shape
// stability for v1.C.1/v1.C.2 consumers that walk only `findings` /
// `subscriptionFindings`.
export interface MeshFileFinding {
  meshName: string;
  meshRidHex: string;
  meshYonPath: string;
  reason: "mesh-yon-parse-error";
  parseError: string;
  message: string;
  remediation: string;
}

// v1.C.2 — sibling-shape per the ratified default (lower coupling than widening
// MeshEdgeFinding.reason enum + the discriminating union). A
// MeshSubscriptionFinding describes a broken @MESH_SUBSCRIPTION row in
// the SUBSCRIBING mesh's mesh.yon: the subscribed vault no longer
// resolves OR the external mesh isn't registered OR the libSQL cache
// row drifted from the SoT.
export interface MeshSubscriptionFinding {
  // The mesh that recorded the @MESH_SUBSCRIPTION row (the subscriber).
  meshName: string;
  meshRidHex: string;
  externalVaultRidHex: string;
  externalMeshRidHex: string;
  externalMeshName: string;
  reason:
    | "external-vault-not-registered"
    | "external-mesh-not-registered"
    | "cache-row-missing-for-soT-subscription"
    | "cache-row-orphaned-no-soT-subscription";
  message: string;
  remediation: string;
}

export interface ValidateMeshEdgesResult {
  // CheckResult emitted per broken edge OR subscription (status='warn')
  // OR per clean mesh (status='pass'). Aggregate exitCode = 0 if no
  // warn-rows.
  checks: CheckResult[];
  findings: MeshEdgeFinding[];
  // v1.C.2 — additive sibling collection per the ratified default. Empty when
  // no subscription-side findings, preserving JSON-shape stability for
  // v1.C.1 consumers that read only `findings`.
  subscriptionFindings: MeshSubscriptionFinding[];
  // v1.C.4 — additive sibling collection per the ratified default. Empty when no
  // file-level findings (mesh.yon parses cleanly across every walked
  // mesh). Preserves JSON-shape stability for v1.C.1/v1.C.2 consumers.
  fileFindings: MeshFileFinding[];
  summary: {
    meshesValidated: number;
    edgesValidated: number;
    // v1.C.2 — additive counter alongside edgesValidated. Counts every
    // @MESH_SUBSCRIPTION row walked, broken or healthy.
    subscriptionsValidated: number;
    warnings: number;
  };
  exitCode: 0 | 2;
  durationMs: number;
}

// v1.C.1 — structured error for `--mesh <name>` not found in registry.
// Mirrors the rebuild-mesh-registry MeshNotFoundError shape so the CLI
// layer can map both to exit code 2.
export class MeshValidateNotFoundError extends Error {
  readonly errorCode = "mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh validate: no mesh registered with name '${meshName}'. Use 'lyt mesh list' to see registered meshes.`,
    );
    this.name = "MeshValidateNotFoundError";
    this.meshName = meshName;
  }
}

export async function validateMeshEdgesFlow(
  args: ValidateMeshEdgesArgs = {},
): Promise<ValidateMeshEdgesResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // 1. Enumerate target meshes.
    const targets = await resolveTargets(db, args.meshName);

    const checks: CheckResult[] = [];
    const findings: MeshEdgeFinding[] = [];
    const subscriptionFindings: MeshSubscriptionFinding[] = [];
    const fileFindings: MeshFileFinding[] = [];
    let edgesValidated = 0;
    let subscriptionsValidated = 0;

    for (const mesh of targets) {
      const meshEdgeChecks = await validateOneMesh(db, mesh, findings, fileFindings);
      for (const c of meshEdgeChecks.checks) checks.push(c);
      edgesValidated += meshEdgeChecks.edgesSeen;
      const meshSubChecks = await validateOneMeshSubscriptions(db, mesh, subscriptionFindings);
      for (const c of meshSubChecks.checks) checks.push(c);
      subscriptionsValidated += meshSubChecks.subscriptionsSeen;
    }

    const warnings = checks.filter((c) => c.status === "warn").length;
    const exitCode: 0 | 2 = warnings > 0 ? 2 : 0;

    return {
      checks,
      findings,
      subscriptionFindings,
      fileFindings,
      summary: {
        meshesValidated: targets.length,
        edgesValidated,
        subscriptionsValidated,
        warnings,
      },
      exitCode,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

async function resolveTargets(db: Client, meshName?: string): Promise<MeshRow[]> {
  if (meshName === undefined) {
    return listMeshes(db);
  }
  const one = await getMeshByName(db, meshName);
  if (one === null) {
    throw new MeshValidateNotFoundError(meshName);
  }
  return [one];
}

async function validateOneMesh(
  db: Client,
  mesh: MeshRow,
  findings: MeshEdgeFinding[],
  fileFindings: MeshFileFinding[],
): Promise<{ checks: CheckResult[]; edgesSeen: number }> {
  // Resolve the mesh's main vault to locate its mesh.yon.
  let mainVaultPath: string | null = null;
  if (mesh.mainVaultRid !== null) {
    const v = await getVaultByRid(db, mesh.mainVaultRid);
    if (v !== null) mainVaultPath = v.path;
  }
  if (mainVaultPath === null || !existsSync(mainVaultPath)) {
    return {
      checks: [
        {
          id: `mesh.edges.validate:${mesh.name}`,
          group: "mesh-validate",
          label: `mesh.yon edges (${mesh.name})`,
          status: "info",
          message: `mesh '${mesh.name}' has no resolvable main vault path; skipping edge validation`,
          remediation: `Run: lyt mesh rebuild-registry --mesh ${mesh.name}`,
        },
      ],
      edgesSeen: 0,
    };
  }
  const meshYonPath = join(mainVaultPath, ".lyt", "mesh.yon");
  if (!existsSync(meshYonPath)) {
    return {
      checks: [
        {
          id: `mesh.edges.validate:${mesh.name}`,
          group: "mesh-validate",
          label: `mesh.yon edges (${mesh.name})`,
          status: "info",
          message: `mesh '${mesh.name}' main vault has no .lyt/mesh.yon; skipping edge validation`,
          remediation: `Run: lyt mesh rebuild-registry --mesh ${mesh.name}`,
        },
      ],
      edgesSeen: 0,
    };
  }

  let parsed;
  try {
    parsed = parseMeshYon(readFileSync(meshYonPath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // v1.C.4 — emit a MeshFileFinding sibling alongside the CheckResult
    // warn-row so write-side consumers (`lyt repair`) can classify the
    // failure structurally per the ratified default. The CheckResult row stays
    // for human-summary output + JSON-shape stability of v1.C.1/v1.C.2
    // consumers.
    const remediation = `Run: lyt repair --target ${mesh.name} --apply --from-revision <sha>`;
    fileFindings.push({
      meshName: mesh.name,
      meshRidHex: mesh.ridHex,
      meshYonPath,
      reason: "mesh-yon-parse-error",
      parseError: msg,
      message: `mesh '${mesh.name}' mesh.yon parse failed: ${msg}`,
      remediation,
    });
    return {
      checks: [
        {
          id: `mesh.edges.validate:${mesh.name}:mesh-yon-parse-error`,
          group: "mesh-validate",
          label: `mesh.yon parse (${mesh.name})`,
          status: "warn",
          message: `mesh '${mesh.name}' mesh.yon parse failed: ${msg}`,
          remediation,
          detail: {
            reason: "mesh-yon-parse-error",
            meshYonPath,
            parseError: msg,
          },
        },
      ],
      edgesSeen: 0,
    };
  }

  const checks: CheckResult[] = [];

  if (parsed.edges.length === 0) {
    checks.push({
      id: `mesh.edges.validate:${mesh.name}`,
      group: "mesh-validate",
      label: `mesh.yon edges (${mesh.name})`,
      status: "pass",
      message: `mesh '${mesh.name}' has 0 edges; nothing to validate`,
    });
    return { checks, edgesSeen: 0 };
  }

  // Per-edge SoT resolution checks.
  for (const e of parsed.edges) {
    const refVault = await getVaultByRid(db, e.refVaultRid);
    if (refVault === null) {
      const f = buildFinding(
        mesh,
        e,
        "ref-vault-not-registered",
        `ref_vault_rid not in local registry`,
        `Run: lyt vault clone <missing-vault-name> OR lyt mesh rebuild-registry`,
      );
      findings.push(f);
      checks.push(findingToCheck(f));
      continue;
    }
    const homeVault = await getVaultByRid(db, e.homeVaultRid);
    if (homeVault === null) {
      const f = buildFinding(
        mesh,
        e,
        "home-vault-not-registered",
        `home_vault_rid not in local registry`,
        `Run: lyt vault clone <home-vault-name> OR lyt mesh rebuild-registry`,
      );
      findings.push(f);
      checks.push(findingToCheck(f));
      continue;
    }
    const homeMesh = await getMeshByRid(db, e.homeMeshRid);
    if (homeMesh === null) {
      const f = buildFinding(
        mesh,
        e,
        "home-mesh-not-registered",
        `home_mesh_rid not in local registry`,
        `Run: lyt mesh join <home-mesh-name> --from <gh-target> OR lyt mesh rebuild-registry`,
      );
      findings.push(f);
      checks.push(findingToCheck(f));
      continue;
    }
    // The referenced (child) vault's home mesh main vault directory
    // must exist on disk per brief Commit 2 spec (c).
    let homeMeshMainPath: string | null = null;
    if (homeMesh.mainVaultRid !== null) {
      const hmv = await getVaultByRid(db, homeMesh.mainVaultRid);
      if (hmv !== null) homeMeshMainPath = hmv.path;
    }
    if (homeMeshMainPath === null || !existsSync(homeMeshMainPath)) {
      const f = buildFinding(
        mesh,
        e,
        "home-mesh-main-vault-missing-on-disk",
        `home mesh '${homeMesh.name}' main vault directory missing on disk`,
        `Run: lyt vault reconnect ${homeMesh.name}/main --path <new> OR lyt mesh rebuild-registry`,
      );
      findings.push(f);
      checks.push(findingToCheck(f));
      continue;
    }
    // This edge resolves cleanly.
    checks.push({
      id: edgeCheckId(mesh, e),
      group: "mesh-validate",
      label: `edge ${shortHex(e.refVaultRid)} → ${shortHex(e.homeVaultRid)} (${mesh.name})`,
      status: "pass",
      message: `edge resolves: ref ${refVault.name} → home ${homeVault.name} (${homeMesh.name})`,
    });
  }

  // Cache-drift detection: for each SoT edge, check the cache
  // contains a row with the same composite key; for each cache row, check
  // the SoT contains a row with the same composite key.
  const cacheRows = await listEdgesByRefMesh(db, mesh.rid);
  for (const e of parsed.edges) {
    const inCache = cacheRows.some(
      (r) =>
        ridsEqual(r.refMeshRid, e.refMeshRid) &&
        ridsEqual(r.refVaultRid, e.refVaultRid) &&
        ridsEqual(r.homeMeshRid, e.homeMeshRid) &&
        ridsEqual(r.homeVaultRid, e.homeVaultRid),
    );
    if (!inCache) {
      const f = buildFinding(
        mesh,
        e,
        "cache-row-missing-for-soT-edge",
        `SoT edge present but cache row missing (drift)`,
        `Run: lyt mesh rebuild-registry --mesh ${mesh.name}`,
      );
      findings.push(f);
      checks.push(findingToCheck(f));
    }
  }
  for (const r of cacheRows) {
    const inSoT = parsed.edges.some(
      (e) =>
        ridsEqual(e.refMeshRid, r.refMeshRid) &&
        ridsEqual(e.refVaultRid, r.refVaultRid) &&
        ridsEqual(e.homeMeshRid, r.homeMeshRid) &&
        ridsEqual(e.homeVaultRid, r.homeVaultRid),
    );
    if (!inSoT) {
      const f: MeshEdgeFinding = {
        refMeshName: mesh.name,
        refMeshRidHex: uuid7BytesToHex(r.refMeshRid),
        refVaultRidHex: uuid7BytesToHex(r.refVaultRid),
        homeMeshRidHex: uuid7BytesToHex(r.homeMeshRid),
        homeVaultRidHex: uuid7BytesToHex(r.homeVaultRid),
        kind: "parent",
        reason: "cache-row-orphaned-no-soT-edge",
        message: `cache row present but SoT (mesh.yon) has no matching @MESH_EDGE`,
        remediation: `Run: lyt mesh rebuild-registry --mesh ${mesh.name}`,
      };
      findings.push(f);
      checks.push({
        id: `${edgeCheckIdFromHexes(mesh.name, f.refVaultRidHex, f.homeVaultRidHex)}:cache-drift`,
        group: "mesh-validate",
        label: `cache-drift (${mesh.name})`,
        status: "warn",
        message: f.message,
        remediation: f.remediation,
        detail: {
          refMeshRidHex: f.refMeshRidHex,
          refVaultRidHex: f.refVaultRidHex,
          homeMeshRidHex: f.homeMeshRidHex,
          homeVaultRidHex: f.homeVaultRidHex,
          reason: f.reason,
        },
      });
    }
  }

  return { checks, edgesSeen: parsed.edges.length };
}

function buildFinding(
  mesh: MeshRow,
  edge: {
    refMeshRid: Uint8Array;
    refVaultRid: Uint8Array;
    homeMeshRid: Uint8Array;
    homeVaultRid: Uint8Array;
    kind: "parent";
  },
  reason: MeshEdgeFinding["reason"],
  message: string,
  remediation: string,
): MeshEdgeFinding {
  return {
    refMeshName: mesh.name,
    refMeshRidHex: uuid7BytesToHex(edge.refMeshRid),
    refVaultRidHex: uuid7BytesToHex(edge.refVaultRid),
    homeMeshRidHex: uuid7BytesToHex(edge.homeMeshRid),
    homeVaultRidHex: uuid7BytesToHex(edge.homeVaultRid),
    kind: edge.kind,
    reason,
    message,
    remediation,
  };
}

function findingToCheck(f: MeshEdgeFinding): CheckResult {
  return {
    id: `${edgeCheckIdFromHexes(f.refMeshName, f.refVaultRidHex, f.homeVaultRidHex)}:${f.reason}`,
    group: "mesh-validate",
    label: `broken edge (${f.refMeshName})`,
    status: "warn",
    message: `${f.message} — edge ${shortHexStr(f.refVaultRidHex)} → ${shortHexStr(f.homeVaultRidHex)}`,
    remediation: f.remediation,
    detail: {
      refMeshRidHex: f.refMeshRidHex,
      refVaultRidHex: f.refVaultRidHex,
      homeMeshRidHex: f.homeMeshRidHex,
      homeVaultRidHex: f.homeVaultRidHex,
      reason: f.reason,
    },
  };
}

function edgeCheckId(
  mesh: MeshRow,
  edge: { refVaultRid: Uint8Array; homeVaultRid: Uint8Array },
): string {
  return `mesh.edges.validate:${mesh.name}:${uuid7BytesToHex(edge.refVaultRid)}->${uuid7BytesToHex(edge.homeVaultRid)}`;
}

function edgeCheckIdFromHexes(meshName: string, refVaultHex: string, homeVaultHex: string): string {
  return `mesh.edges.validate:${meshName}:${refVaultHex}->${homeVaultHex}`;
}

function shortHex(b: Uint8Array): string {
  return shortHexStr(uuid7BytesToHex(b));
}

function shortHexStr(h: string): string {
  return h.length > 8 ? `${h.slice(0, 8)}…` : h;
}

// v1.C.2 — subscription-side walker. Mirrors `validateOneMesh` shape
// but operates over `MeshDoc.subscriptions` + `mesh_subscriptions`
// cache rows. Per default the walk lives inside the same flow
// so `lyt mesh validate` stays the single canonical mesh validator;
// per the ratified default findings land in a separate `subscriptionFindings`
// collection (sibling, not widened-enum) to keep MeshEdgeFinding
// reason-class semantics tight.
async function validateOneMeshSubscriptions(
  db: Client,
  mesh: MeshRow,
  subscriptionFindings: MeshSubscriptionFinding[],
): Promise<{ checks: CheckResult[]; subscriptionsSeen: number }> {
  // Resolve the mesh's main vault to locate its mesh.yon. Edge-walker
  // already emitted `info` rows for the no-main / no-mesh.yon /
  // parse-failed cases — we deliberately re-probe + skip silently here
  // so the JSON output for the subscription leg only emits rows when
  // there's something subscription-specific to say.
  let mainVaultPath: string | null = null;
  if (mesh.mainVaultRid !== null) {
    const v = await getVaultByRid(db, mesh.mainVaultRid);
    if (v !== null) mainVaultPath = v.path;
  }
  if (mainVaultPath === null || !existsSync(mainVaultPath)) {
    return { checks: [], subscriptionsSeen: 0 };
  }
  const meshYonPath = join(mainVaultPath, ".lyt", "mesh.yon");
  if (!existsSync(meshYonPath)) {
    return { checks: [], subscriptionsSeen: 0 };
  }

  let parsed;
  try {
    parsed = parseMeshYon(readFileSync(meshYonPath, "utf8"));
  } catch {
    // Edge walker already surfaced the parse failure with full
    // context + remediation; suppress duplicate emission here.
    return { checks: [], subscriptionsSeen: 0 };
  }

  const checks: CheckResult[] = [];

  if (parsed.subscriptions.length === 0) {
    // No-subscription state is the silent default; the edge walker's
    // "0 edges; nothing to validate" pass-row covers the per-mesh slot.
    return { checks, subscriptionsSeen: 0 };
  }

  // Per-subscription SoT resolution checks.
  for (const s of parsed.subscriptions) {
    const extVault = await getVaultByRid(db, s.externalVaultRid);
    if (extVault === null) {
      const f = buildSubscriptionFinding(
        mesh,
        s,
        "external-vault-not-registered",
        `external_vault_rid not in local registry (subscribed vault gone)`,
        `Run: lyt vault clone ${s.externalMeshName}/<vault-name> OR lyt mesh rebuild-registry`,
      );
      subscriptionFindings.push(f);
      checks.push(subscriptionFindingToCheck(f));
      continue;
    }
    const extMesh = await getMeshByRid(db, s.externalMeshRid);
    if (extMesh === null) {
      const f = buildSubscriptionFinding(
        mesh,
        s,
        "external-mesh-not-registered",
        `external_mesh_rid not in local registry`,
        `Run: lyt mesh join ${s.externalMeshName} --from <gh-target> OR lyt mesh rebuild-registry`,
      );
      subscriptionFindings.push(f);
      checks.push(subscriptionFindingToCheck(f));
      continue;
    }
    // This subscription resolves cleanly.
    checks.push({
      id: subscriptionCheckId(mesh, s),
      group: "mesh-validate",
      label: `subscription ${shortHex(s.externalVaultRid)} ← ${mesh.name}`,
      status: "pass",
      message: `subscription resolves: ${mesh.name} → ${extVault.name} (${extMesh.name})`,
    });
  }

  // Cache-drift detection (same shape as edge cache-drift): for
  // each SoT subscription, check the cache contains a row with the
  // same composite (mesh_rid, external_vault_rid) key; for each cache
  // row, check the SoT contains a matching subscription.
  const cacheRows = await listSubscriptionsForMesh(db, mesh.rid);
  for (const s of parsed.subscriptions) {
    const inCache = cacheRows.some(
      (r) => ridsEqual(r.meshRid, s.meshRid) && ridsEqual(r.externalVaultRid, s.externalVaultRid),
    );
    if (!inCache) {
      const f = buildSubscriptionFinding(
        mesh,
        s,
        "cache-row-missing-for-soT-subscription",
        `SoT subscription present but cache row missing (drift)`,
        `Run: lyt mesh rebuild-registry --mesh ${mesh.name}`,
      );
      subscriptionFindings.push(f);
      checks.push(subscriptionFindingToCheck(f));
    }
  }
  for (const r of cacheRows) {
    const inSoT = parsed.subscriptions.some(
      (s) => ridsEqual(s.meshRid, r.meshRid) && ridsEqual(s.externalVaultRid, r.externalVaultRid),
    );
    if (!inSoT) {
      const f: MeshSubscriptionFinding = {
        meshName: mesh.name,
        meshRidHex: uuid7BytesToHex(r.meshRid),
        externalVaultRidHex: uuid7BytesToHex(r.externalVaultRid),
        externalMeshRidHex: uuid7BytesToHex(r.externalMeshRid),
        externalMeshName: r.externalMeshName,
        reason: "cache-row-orphaned-no-soT-subscription",
        message: `cache row present but SoT (mesh.yon) has no matching @MESH_SUBSCRIPTION`,
        remediation: `Run: lyt mesh rebuild-registry --mesh ${mesh.name}`,
      };
      subscriptionFindings.push(f);
      checks.push({
        id: `${subscriptionCheckIdFromHexes(mesh.name, f.externalVaultRidHex)}:cache-drift`,
        group: "mesh-validate",
        label: `subscription cache-drift (${mesh.name})`,
        status: "warn",
        message: f.message,
        remediation: f.remediation,
        detail: {
          meshRidHex: f.meshRidHex,
          externalVaultRidHex: f.externalVaultRidHex,
          externalMeshRidHex: f.externalMeshRidHex,
          externalMeshName: f.externalMeshName,
          reason: f.reason,
        },
      });
    }
  }

  return { checks, subscriptionsSeen: parsed.subscriptions.length };
}

function buildSubscriptionFinding(
  mesh: MeshRow,
  s: {
    meshRid: Uint8Array;
    externalVaultRid: Uint8Array;
    externalMeshRid: Uint8Array;
    externalMeshName: string;
  },
  reason: MeshSubscriptionFinding["reason"],
  message: string,
  remediation: string,
): MeshSubscriptionFinding {
  return {
    meshName: mesh.name,
    meshRidHex: uuid7BytesToHex(s.meshRid),
    externalVaultRidHex: uuid7BytesToHex(s.externalVaultRid),
    externalMeshRidHex: uuid7BytesToHex(s.externalMeshRid),
    externalMeshName: s.externalMeshName,
    reason,
    message,
    remediation,
  };
}

function subscriptionFindingToCheck(f: MeshSubscriptionFinding): CheckResult {
  return {
    id: `${subscriptionCheckIdFromHexes(f.meshName, f.externalVaultRidHex)}:${f.reason}`,
    group: "mesh-validate",
    label: `broken subscription (${f.meshName})`,
    status: "warn",
    message: `${f.message} — subscription ${shortHexStr(f.externalVaultRidHex)} → ${f.externalMeshName}`,
    remediation: f.remediation,
    detail: {
      meshRidHex: f.meshRidHex,
      externalVaultRidHex: f.externalVaultRidHex,
      externalMeshRidHex: f.externalMeshRidHex,
      externalMeshName: f.externalMeshName,
      reason: f.reason,
    },
  };
}

function subscriptionCheckId(mesh: MeshRow, s: { externalVaultRid: Uint8Array }): string {
  return `mesh.subscriptions.validate:${mesh.name}:${uuid7BytesToHex(s.externalVaultRid)}`;
}

function subscriptionCheckIdFromHexes(meshName: string, externalVaultHex: string): string {
  return `mesh.subscriptions.validate:${meshName}:${externalVaultHex}`;
}
