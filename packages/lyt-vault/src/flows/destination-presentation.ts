/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  resolveEffectiveOwnedDestination,
  type EffectiveOwnedDestination,
} from "../registry/destination-policy.js";
import type { MeshRow } from "../registry/meshes-repo.js";
import type { VaultRow } from "../registry/repo.js";

export interface DestinationPresentation {
  kind: "local" | "github" | "unconfigured";
  target: { owner: string; kind: "user" | "org"; repository: string | null } | null;
  source: string | null;
  authority: "legacy-projection" | null;
  reason: "foreign" | "missing-policy" | "quarantined-policy" | null;
}

// Registry projections are the only policy input here. In particular, this helper
// never upgrades a legacy target into authority and never looks at a remote.
export function presentVaultDestination(vault: VaultRow, mesh?: MeshRow | null): DestinationPresentation {
  const effective = resolveEffectiveOwnedDestination(vault, mesh);
  return presentEffectiveDestination(effective, vault.destinationSource);
}

export function presentMeshDestination(mesh: MeshRow): DestinationPresentation {
  if (!mesh.ownCreated) {
    return { kind: "unconfigured", target: null, source: null, authority: null, reason: "foreign" };
  }
  if (mesh.destinationSource === "legacy-derived") {
    return {
      kind: "unconfigured",
      target: null,
      source: "legacy-derived",
      authority: "legacy-projection",
      reason: "quarantined-policy",
    };
  }
  if (mesh.destinationKind === "local") {
    return { kind: "local", target: null, source: mesh.destinationSource ?? null, authority: null, reason: null };
  }
  if (mesh.destinationKind === "github" && mesh.destinationTarget && mesh.destinationTargetKind) {
    return {
      kind: "github",
      target: { owner: mesh.destinationTarget, kind: mesh.destinationTargetKind, repository: null },
      source: mesh.destinationSource ?? null,
      authority: null,
      reason: null,
    };
  }
  return { kind: "unconfigured", target: null, source: mesh.destinationSource ?? null, authority: null, reason: "missing-policy" };
}

function presentEffectiveDestination(
  effective: EffectiveOwnedDestination,
  rawSource: string | null,
): DestinationPresentation {
  if (effective.kind === "github") {
    return {
      kind: "github",
      target: { owner: effective.owner, kind: effective.targetKind, repository: effective.repositoryName },
      source: effective.source,
      authority: null,
      reason: null,
    };
  }
  if (effective.kind === "local") {
    return { kind: "local", target: null, source: effective.source, authority: null, reason: null };
  }
  return {
    kind: "unconfigured",
    target: null,
    source: rawSource,
    authority: rawSource === "legacy-derived" ? "legacy-projection" : null,
    reason: effective.reason,
  };
}
