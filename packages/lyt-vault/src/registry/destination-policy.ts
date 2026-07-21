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

import { isValidGhHandle } from "../util/identity.js";
import type { Hlc } from "../util/hlc.js";
import { parseGithubPublicationTarget } from "../util/permission-observation.js";
import { isValidGithubRepositoryName } from "../util/publication-coordinate.js";
import { canonicalizeCoordinate, gitUrlToCoordinate } from "./vault-addressing.js";

export {
  comparePublicationCoordinates,
  type PublicationCoordinateComparison,
} from "../util/publication-coordinate.js";

export const DESTINATION_POLICY_SCHEMA_MAJOR = 2 as const;
export const LEGACY_DESTINATION_POLICY_SCHEMA_MAJOR = 1 as const;
export const MINIMUM_DESTINATION_POLICY_WRITER_VERSION = "0.20.0";

export type DestinationSubjectKind = "mesh" | "vault";
export type DestinationKind = "local" | "github";
export type DestinationTargetKind = "user" | "org";
export type MeshDestinationSource =
  | "explicit"
  | "authenticated-default"
  | "auto-fallback-local"
  | "legacy-derived";
export type VaultDestinationSource = "mesh-inherited" | "vault-override" | "legacy-derived";
export type DestinationSource = MeshDestinationSource | VaultDestinationSource;
export type DestinationPolicyState = "active" | "tombstoned";

export interface DestinationPolicyValue {
  destinationKind: DestinationKind;
  targetOwner: string | null;
  targetKind: DestinationTargetKind | null;
  repositoryName?: string | null;
  source: DestinationSource;
}

export interface DestinationPolicyRecordV1 extends DestinationPolicyValue {
  schemaMajor:
    | typeof LEGACY_DESTINATION_POLICY_SCHEMA_MAJOR
    | typeof DESTINATION_POLICY_SCHEMA_MAJOR;
  podRid: string;
  subjectKind: DestinationSubjectKind;
  subjectRid: string;
  state: DestinationPolicyState;
  /** Monotonic ownership-boundary fence; compared before HLC. */
  policyEpoch?: number;
  writerVersion: string;
  writerId: string;
  hlc: Hlc;
  seq: number;
  recordedAt: string;
}

export interface ResolvedDestinationPolicy {
  value: DestinationPolicyValue | null;
  authority: "policy-ledger" | "legacy-projection" | null;
}

export type EffectiveOwnedDestination =
  | {
      kind: "github";
      owner: string;
      targetKind: DestinationTargetKind;
      repositoryName: string | null;
      source: MeshDestinationSource | VaultDestinationSource;
    }
  | { kind: "local"; source: MeshDestinationSource | VaultDestinationSource }
  | { kind: "unconfigured"; reason: "foreign" | "missing-policy" | "quarantined-policy" };

export interface OwnedDestinationVaultView {
  source: "own" | "shared" | "subscribed";
  destinationKind: DestinationKind | null;
  destinationSource: VaultDestinationSource | null;
  destinationTarget: string | null;
  destinationTargetKind: DestinationTargetKind | null;
  destinationRepositoryName?: string | null;
}

export interface OwnedDestinationMeshView {
  ownCreated: boolean;
  destinationKind?: DestinationKind | null;
  destinationSource?: MeshDestinationSource | null;
  destinationTarget?: string | null;
  destinationTargetKind?: DestinationTargetKind | null;
}

export class DestinationPolicyValidationError extends Error {
  readonly errorCode = "invalid-destination-policy";
}

export class UnsupportedDestinationPolicySchemaError extends Error {
  readonly errorCode = "unsupported-destination-policy-schema";
}

export class DestinationPolicyWriterUpgradeRequiredError extends Error {
  readonly errorCode = "destination-policy-writer-upgrade-required";
  constructor(readonly actualVersion: string) {
    super(
      `Destination-policy writes require Lyt ${MINIMUM_DESTINATION_POLICY_WRITER_VERSION} or newer; ` +
        `this writer reports ${actualVersion}. Upgrade Lyt before changing publication intent.`,
    );
  }
}

export function destinationPolicyKey(
  subjectKind: DestinationSubjectKind,
  subjectRid: string,
): string {
  return `${subjectKind}\x00${subjectRid}`;
}

// Mixed-version dual-read rule. The mere presence of a versioned policy winner
// suppresses the legacy compatibility projection, including an explicit
// tombstone. Legacy is consulted only when this subject has never acquired a
// policy-ledger winner.
export function resolveDestinationPolicy(
  winner: DestinationPolicyRecordV1 | null,
  legacyProjection: DestinationPolicyValue | null,
): ResolvedDestinationPolicy {
  if (winner !== null) {
    return {
      value:
        winner.state === "active"
          ? {
              destinationKind: winner.destinationKind,
              targetOwner: winner.targetOwner,
              targetKind: winner.targetKind,
              repositoryName: winner.repositoryName ?? null,
              source: winner.source,
            }
          : null,
      authority: "policy-ledger",
    };
  }
  return legacyProjection === null
    ? { value: null, authority: null }
    : { value: legacyProjection, authority: "legacy-projection" };
}

/**
 * Resolve the only destination value publication callers may treat as durable
 * intent. Portable YON and legacy push fields are deliberately absent from the
 * input shape, so they cannot accidentally become publication authority.
 */
export function resolveEffectiveOwnedDestination(
  vault: OwnedDestinationVaultView,
  mesh: OwnedDestinationMeshView | null | undefined,
): EffectiveOwnedDestination {
  if (vault.source !== "own") return { kind: "unconfigured", reason: "foreign" };

  // Migration evidence is quarantine, never publication authority—even when
  // its compatibility columns happen to form a syntactically valid target.
  if (vault.destinationSource === "legacy-derived") {
    return { kind: "unconfigured", reason: "quarantined-policy" };
  }

  const vaultPolicy = resolveEffectiveValue(
    vault.destinationKind,
    vault.destinationSource,
    vault.destinationTarget,
    vault.destinationTargetKind,
    vault.destinationRepositoryName ?? null,
  );
  if (vaultPolicy !== null) return vaultPolicy;

  return resolveEffectiveOwnedMeshDestination(mesh);
}

export function resolveEffectiveOwnedMeshDestination(
  mesh: OwnedDestinationMeshView | null | undefined,
): EffectiveOwnedDestination {
  if (mesh?.ownCreated !== true) return { kind: "unconfigured", reason: "missing-policy" };
  if (mesh.destinationSource === "legacy-derived") {
    return { kind: "unconfigured", reason: "quarantined-policy" };
  }
  const meshPolicy = resolveEffectiveValue(
    mesh.destinationKind ?? null,
    mesh.destinationSource ?? null,
    mesh.destinationTarget ?? null,
    mesh.destinationTargetKind ?? null,
    null,
  );
  if (meshPolicy !== null) return meshPolicy;
  return { kind: "unconfigured", reason: "missing-policy" };
}

function resolveEffectiveValue(
  kind: DestinationKind | null,
  source: MeshDestinationSource | VaultDestinationSource | null,
  owner: string | null,
  targetKind: DestinationTargetKind | null,
  repositoryName: string | null,
): Extract<EffectiveOwnedDestination, { kind: "github" | "local" }> | null {
  if (source === null || kind === null) return null;
  if (kind === "local") {
    return owner === null && targetKind === null && repositoryName === null
      ? { kind: "local", source }
      : null;
  }
  return owner !== null && targetKind !== null && isValidGhHandle(owner)
    ? { kind: "github", owner, targetKind, repositoryName, source }
    : null;
}

export function assertSupportedDestinationPolicyWriter(version: string): void {
  if (compareSemver(version, MINIMUM_DESTINATION_POLICY_WRITER_VERSION) < 0) {
    throw new DestinationPolicyWriterUpgradeRequiredError(version);
  }
}

export function validateDestinationPolicyValue(
  subjectKind: DestinationSubjectKind,
  value: DestinationPolicyValue,
): void {
  const meshSources: readonly DestinationSource[] = [
    "explicit",
    "authenticated-default",
    "auto-fallback-local",
    "legacy-derived",
  ];
  const vaultSources: readonly DestinationSource[] = [
    "mesh-inherited",
    "vault-override",
    "legacy-derived",
  ];
  const allowed = subjectKind === "mesh" ? meshSources : vaultSources;
  if (!allowed.includes(value.source)) {
    throw new DestinationPolicyValidationError(
      `${subjectKind} destination policy cannot use source ${JSON.stringify(value.source)}.`,
    );
  }
  if (value.destinationKind === "local") {
    if (
      value.targetOwner !== null ||
      value.targetKind !== null ||
      (value.repositoryName ?? null) !== null
    ) {
      throw new DestinationPolicyValidationError(
        "A local destination must not carry a GitHub owner or target kind.",
      );
    }
    return;
  }
  if (
    value.targetOwner === null ||
    value.targetKind === null ||
    !isValidGhHandle(value.targetOwner)
  ) {
    throw new DestinationPolicyValidationError(
      "A GitHub destination requires a valid canonical user/org owner.",
    );
  }
  const repositoryName = value.repositoryName ?? null;
  if (subjectKind === "mesh" && repositoryName !== null) {
    throw new DestinationPolicyValidationError(
      "A mesh destination may store an owner default but not a vault repository name.",
    );
  }
  if (
    subjectKind === "vault" &&
    (repositoryName === null || !isValidGithubRepositoryName(repositoryName))
  ) {
    throw new DestinationPolicyValidationError(
      "A GitHub vault destination requires an exact valid repository name.",
    );
  }
}

export function parseCanonicalDestinationTarget(
  raw: string,
): { destinationKind: "github"; targetKind: DestinationTargetKind; targetOwner: string } | null {
  const target = parseGithubPublicationTarget(raw);
  return target === null
    ? null
    : {
        destinationKind: "github",
        targetKind: target.kind,
        targetOwner: target.owner,
      };
}

export function publicationCoordinateOwner(raw: string): string | null {
  const canonical = toCanonicalCoordinate(raw);
  if (canonical === null) return null;
  const bare = canonical.replace(/^lyt:vault:/, "");
  const parts = bare.split("/");
  return parts.length >= 3 && parts[1] ? parts[1] : null;
}

function toCanonicalCoordinate(raw: string): string | null {
  const fromUrl = gitUrlToCoordinate(raw);
  const candidate = fromUrl ?? raw;
  const canonical = canonicalizeCoordinate(candidate);
  return canonical.startsWith("lyt:vault:") ? canonical : null;
}

function compareSemver(a: string, b: string): number {
  const aa = parseSemver(a);
  const bb = parseSemver(b);
  if (aa === null || bb === null) return -1;
  for (let i = 0; i < 3; i += 1) {
    if (aa[i] !== bb[i]) return aa[i]! < bb[i]! ? -1 : 1;
  }
  return 0;
}

function parseSemver(raw: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  if (match === null) return null;
  const out = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return out.every((n) => Number.isSafeInteger(n) && n >= 0) ? out : null;
}
