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
import { getMeshByName, listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import type { CheckResult } from "./doctor.js";
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

// v1.C.2 — sibling-shape per the ratified default. A MeshSubscriptionFinding
// described a broken @MESH_SUBSCRIPTION row in a subscribing mesh's mesh.yon.
//
// Fed-v2 Layer-1 (Phase D1c): subscription validation is RETIRED. mesh.yon is
// no longer the subscription SoT (no-legacy, design §5) — subscriptions
// live in the per-writer ledger reconstituted into mesh_subscriptions by
// `rebuildFederationCacheFlow`, so there is no mesh.yon-vs-cache subscription
// drift to validate. The type + the `subscriptionFindings` / `subscriptionsValidated`
// result fields are RETAINED (now always empty / 0) for JSON-shape stability of
// existing consumers and because `repair.ts` still imports the type for its
// (now-dormant) reason union. The `external_mesh_*` finding fields are dropped
// in lockstep with the cache column-drop.
export interface MeshSubscriptionFinding {
  // The mesh that recorded the subscription (the subscriber).
  meshName: string;
  meshRidHex: string;
  externalVaultRidHex: string;
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
    // Fed-v2 D1c: subscription validation retired (mesh.yon no longer the
    // subscription SoT). subscriptionFindings stays empty + subscriptionsValidated
    // stays 0 for JSON-shape stability.
    const subscriptionsValidated = 0;

    for (const mesh of targets) {
      const meshEdgeChecks = await validateOneMesh(db, mesh, fileFindings);
      for (const c of meshEdgeChecks.checks) checks.push(c);
      edgesValidated += meshEdgeChecks.edgesSeen;
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

  // Slice 2a — the @MESH_EDGE edge-validation block was DELETED. mesh.yon no
  // longer carries edges (the per-writer mesh-edge ledger is the SoT,
  // reconstituted into the mesh_edges cache by rebuildFederationCacheFlow), so
  // there is no mesh.yon-row resolution check and no mesh.yon-vs-cache edge-drift
  // check to run. We still PARSE mesh.yon (the parse-error → MeshFileFinding path
  // is retained — it's a file-level integrity check, not an edge check). On a
  // clean parse we emit a `pass` row and `edgesSeen: 0`. (`findings` stays empty,
  // mirroring the D1c `subscriptionFindings` retirement.) A later slice may add
  // ledger-edge validation; per the build-stop addendum this is a DELETE, not a
  // re-point.
  try {
    parseMeshYon(readFileSync(meshYonPath, "utf8"));
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

  return {
    checks: [
      {
        id: `mesh.edges.validate:${mesh.name}`,
        group: "mesh-validate",
        label: `mesh.yon (${mesh.name})`,
        status: "pass",
        message: `mesh '${mesh.name}' mesh.yon parses; edge validation is ledger-owned (no mesh.yon edge SoT)`,
      },
    ],
    edgesSeen: 0,
  };
}

