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

import type { Client } from "@libsql/client";

import {
  assessCanonicalOwnedVaultDestination,
  loadDestinationPolicyContext,
  type DestinationPolicyContext,
} from "../flows/federation/destination-policy-service.js";
import { listFederationStates } from "../registry/federation-state.js";
import { listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { listVaults, type VaultRow } from "../registry/repo.js";
import { isValidGhHandle } from "./identity.js";
import { ridsEqual } from "./uuid7.js";

// THE POD-OWNER FENCE SET — the GitHub owners this pod actually publishes to:
// every federation handle, every mesh push target, and every own vault's
// CANONICAL destination owner.
//
// Derived from POLICY ONLY, never from an observed remote, so a hijacked /
// stranger origin can never vote itself into the set. Any consumer that is
// about to act on an owner parsed out of a stored `git_url` (repair-vault-
// origin-owner's `git remote set-url`, vault-visibility's `gh repo edit
// --visibility`) must first prove the owner is in here — `source === 'own'` is
// the one registry field known to lie (a vault registered with `lyt vault join`
// fail-closes to `own` while being FOREIGN).
//
// SEE ALSO (the two fences that consume this): flows/repair-vault-origin-owner.ts
// (skip reason `origin-owner-unknown-to-pod`) and flows/vault-visibility.ts
// (refuses before any gh call). Keep the skip-reason vocabulary in sync.
export const UNKNOWN_POD_OWNER_REASON = "origin-owner-unknown-to-pod";

export interface KnownPodOwnersInput {
  // Already-loaded rows, so a caller that has them does not pay a second read.
  // NOTE: `ownVaults` MUST be the POD-WIDE own-vault set, never a scoped
  // selection — the owner set is a pod property, and a narrower input would
  // refuse a vault an unscoped run would accept.
  meshes?: readonly MeshRow[];
  ownVaults?: readonly VaultRow[];
  policyContext?: DestinationPolicyContext;
}

export async function collectKnownPodOwners(
  db: Client,
  loaded: KnownPodOwnersInput = {},
): Promise<Set<string>> {
  const meshes = loaded.meshes ?? (await listMeshes(db));
  const policyContext = loaded.policyContext ?? (await loadDestinationPolicyContext(db));
  const ownVaults =
    loaded.ownVaults ??
    (await listVaults(db)).filter((v) => v.source === "own" && v.status !== "tombstoned");

  const owners = new Set<string>();
  for (const state of await listFederationStates(db)) {
    // The pod's own account handle. A personal mesh often carries no explicit
    // push target, so its vaults' origins sit under the handle and nowhere else.
    if (isValidGhHandle(state.handle)) owners.add(state.handle.toLowerCase());
  }
  for (const mesh of meshes) {
    const target = mesh.pushTarget ?? "";
    if (target.length > 0 && isValidGhHandle(target)) owners.add(target.toLowerCase());
  }
  for (const vault of ownVaults) {
    const homeMesh =
      vault.homeMeshRid === null
        ? null
        : (meshes.find((m) => ridsEqual(m.rid, vault.homeMeshRid!)) ?? null);
    const canonical = assessCanonicalOwnedVaultDestination(vault, homeMesh, policyContext);
    if (canonical.status !== "refused" && canonical.destination.kind === "github") {
      const owner = canonical.destination.owner;
      if (isValidGhHandle(owner)) owners.add(owner.toLowerCase());
    }
  }
  return owners;
}
