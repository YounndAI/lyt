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

// 0.12.1 identity-safety (design §1 two-phase init step 3 + §6.1 S3/G2) — the
// SEMANTIC half of the two-phase-init "do all the checks" gate. `parseFederationYon`
// (federation-read.ts) only proves the manifest is PARSEABLE; this proves it is
// COHERENT. It is a PURE function over the already-parsed FederationDoc (no I/O,
// no gh call) so recover-pod / init can run it AFTER the parse and BEFORE it acts
// on any mesh or clones any vault — fail-closed-EARLY (a corrupt/suspicious pod
// stops the flow before any vault is touched).
//
// The networked ownership oracle (gh-accessibility of each push_target) is the
// explicitly-DEFERRED 0.12.2 gh-oracle lane — this file is the cheap
// manifest-INTERNAL check only.

import { isValidGhHandle } from "../util/identity.js";
import type { FederationDoc } from "./federation-write.js";

export type ManifestIssueCode =
  // S3 — semantic coherence
  | "duplicate-mesh-rid"
  | "duplicate-vault-rid"
  | "empty-required-field"
  | "dangling-home-mesh"
  // G2 — own-mesh push_target internal plausibility (defense-in-depth)
  | "implausible-push-target";

export interface ManifestSemanticIssue {
  code: ManifestIssueCode;
  detail: string;
}

// Validate the parsed pod manifest SEMANTICALLY. Returns the (possibly empty)
// list of coherence issues; an EMPTY list means the manifest is coherent and the
// reconstruction may proceed. A NON-empty list is a fail-closed signal: the
// caller MUST refuse to reconstruct (no mesh insert, no vault clone) and surface
// the issues.
//
// NOTE on role: `parseFederationYon` already coerces `role` to the known set
// {own, join}, failing CLOSED to `join` on any other value (M2, federation-read.ts:161),
// so a "role ∈ known set" check here would be structurally dead — the doc's typed
// `role` can only be `own|join`. The M2 default IS that check, upstream.
export function validatePodManifestSemantics(doc: FederationDoc): ManifestSemanticIssue[] {
  const issues: ManifestSemanticIssue[] = [];

  // --- meshes: rid uniqueness + required fields + G2 push_target plausibility ---
  // Also build the set of mesh rids PRESENT in the manifest so the vault loop can
  // prove every non-orphan vault homes into a mesh block that actually exists.
  const meshRidSet = new Set<string>();
  for (const m of doc.meshes) {
    if (m.meshRidHex.length === 0) {
      issues.push({
        code: "empty-required-field",
        detail: `mesh ${JSON.stringify(m.meshName)} has an empty mesh rid`,
      });
    } else {
      if (meshRidSet.has(m.meshRidHex)) {
        issues.push({
          code: "duplicate-mesh-rid",
          detail: `mesh rid mesh:${m.meshRidHex} appears more than once (a register fold emits ≤1 record per rid — a duplicate signals corruption/tamper)`,
        });
      }
      meshRidSet.add(m.meshRidHex);
    }

    if (m.meshName.length === 0) {
      issues.push({
        code: "empty-required-field",
        detail: `mesh mesh:${m.meshRidHex} has an empty mesh_name`,
      });
    }

    // G2 — own-mesh push_target INTERNAL plausibility. A non-empty push_target on
    // an OWN mesh is the ownership authority that feeds deriveVaultRepoOwner → the
    // clone owner for the user's OWN org vaults (design §0: owner is
    // manifest-derivable). A tampered own-pod mesh block whose push_target points
    // at an attacker-controlled org would clone foreign content into a trusted
    // `vaults/{mesh}` bucket as role=own (design §6.1 G2). This is the cheap
    // INTERNAL check — the push_target must be a valid GitHub owner-handle SHAPE;
    // the full networked gh-accessibility oracle is the DEFERRED 0.12.2 lane.
    // An EMPTY push_target is a legit LOCAL-ONLY (--no-push) own mesh — owner
    // resolution falls back to the federation handle — so it is allowed.
    if (m.role === "own" && m.pushTarget.length > 0 && !isValidGhHandle(m.pushTarget)) {
      issues.push({
        code: "implausible-push-target",
        detail:
          `own mesh ${JSON.stringify(m.meshName)} declares push_target ` +
          `${JSON.stringify(m.pushTarget)}, which is not a valid GitHub owner handle — ` +
          `refusing (a tampered own-mesh push_target could clone foreign content into a ` +
          `trusted bucket as role=own)`,
      });
    }
  }

  // --- vaults: rid uniqueness + required fields + home-mesh resolvability ---
  const vaultRidSet = new Set<string>();
  for (const v of doc.vaults) {
    if (v.vaultRidHex.length === 0) {
      issues.push({
        code: "empty-required-field",
        detail: `vault ${JSON.stringify(v.vaultName)} has an empty vault rid`,
      });
    } else {
      if (vaultRidSet.has(v.vaultRidHex)) {
        issues.push({
          code: "duplicate-vault-rid",
          detail: `vault rid vault:${v.vaultRidHex} appears more than once (a register fold emits ≤1 record per rid — a duplicate signals corruption/tamper)`,
        });
      }
      vaultRidSet.add(v.vaultRidHex);
    }

    if (v.vaultName.length === 0) {
      issues.push({
        code: "empty-required-field",
        detail: `vault vault:${v.vaultRidHex} has an empty vault_name`,
      });
    }
    if (v.repo.length === 0) {
      issues.push({
        code: "empty-required-field",
        detail: `vault ${JSON.stringify(v.vaultName)} has an empty repo`,
      });
    }

    // S3 — a NON-orphan vault must reference a mesh block PRESENT in this manifest.
    // A vault whose home_mesh_rid points at a mesh absent from the manifest is the
    // canonical incoherent-manifest shape (design §6.1 S3): the reconstruction
    // could not home it, and proceeding would clone a vault under the fallback
    // handle with no valid mesh binding. An orphan (homeMeshRidHex === null, the
    // `home_mesh_rid=mesh:none` sentinel) is legit and skipped.
    if (v.homeMeshRidHex !== null && !meshRidSet.has(v.homeMeshRidHex)) {
      issues.push({
        code: "dangling-home-mesh",
        detail:
          `vault ${JSON.stringify(v.vaultName)} references home mesh ` +
          `mesh:${v.homeMeshRidHex}, which is absent from the manifest`,
      });
    }
  }

  return issues;
}
