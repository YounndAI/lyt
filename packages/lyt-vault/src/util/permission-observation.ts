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

import { isValidGhHandle } from "./identity.js";

export type PublicationCapability = "repository-create" | "repository-push";
export type PermissionObservationResult = "verified" | "denied" | "unknown";
export type GithubPublicationTargetKind = "user" | "org";

export interface CanonicalGithubPublicationTarget {
  kind: GithubPublicationTargetKind;
  owner: string;
  value: `github:${GithubPublicationTargetKind}/${string}`;
}

export type PermissionEvidence =
  | { kind: "personal-self-target"; actorConfirmed: boolean }
  | {
      kind: "organization-create";
      effectiveMembership: "verified" | "unknown";
      creationPolicy: "verified" | "unknown";
      administrator: "verified" | "unknown";
    }
  | { kind: "repository-push"; canPush: boolean }
  | { kind: "confirmed-denial" }
  | { kind: "unavailable"; reason: "404-or-invisible" | "offline" | "timeout" | "rate-limit" }
  | { kind: "ambiguous" };

export type PermissionEvidenceClass =
  | "personal-self-target"
  | "organization-membership-and-create-policy"
  | "organization-administrator"
  | "repository-push"
  | "confirmed-denial"
  | "404-or-invisible"
  | "offline"
  | "timeout"
  | "rate-limit"
  | "ambiguous";

/**
 * Ephemeral evidence for one capability probe. It is deliberately not a
 * destination-policy record and must never be used as cache authority.
 */
export interface PermissionObservation {
  capability: PublicationCapability;
  target: CanonicalGithubPublicationTarget["value"];
  repository: string;
  actor: string | null;
  attempt_id: string;
  /** Canonical destination-policy epoch observed for this exact attempt. */
  policy_epoch: number;
  result: PermissionObservationResult;
  observed_at: string;
  evidence_class: PermissionEvidenceClass;
}

export interface BuildPermissionObservationInput {
  capability: PublicationCapability;
  target: string;
  repository: string;
  actor: string | null | undefined;
  attemptId: string;
  policyEpoch: number;
  observedAt: string;
  evidence: PermissionEvidence;
}

/** Parse the sole canonical target syntax accepted by publication policy. */
export function parseGithubPublicationTarget(
  target: string,
): CanonicalGithubPublicationTarget | null {
  const match = /^github:(user|org)\/([^/]+)$/i.exec(target.trim());
  if (match === null) return null;
  const kind = match[1]!.toLowerCase() as GithubPublicationTargetKind;
  const owner = match[2]!.toLowerCase();
  if (!isValidGhHandle(owner)) return null;
  return { kind, owner, value: `github:${kind}/${owner}` };
}

/**
 * Build one attempt-bound, structured observation from explicit probe facts.
 * This is pure: callers supply the fresh actor and timestamp, and no cached
 * observation can confer permission through this function.
 */
export function buildPermissionObservation(
  input: BuildPermissionObservationInput,
): PermissionObservation {
  const target = parseGithubPublicationTarget(input.target);
  if (target === null) {
    throw new Error("Permission observation requires a canonical GitHub user or org target.");
  }

  const actor = canonicalActor(input.actor);
  const repository = canonicalRepository(input.repository);
  if (repository === null) {
    throw new Error("Permission observation requires an exact repository coordinate.");
  }
  if (input.attemptId.trim().length === 0) {
    throw new Error("Permission observation requires a non-empty attempt id.");
  }
  if (!Number.isSafeInteger(input.policyEpoch) || input.policyEpoch < 0) {
    throw new Error("Permission observation requires a non-negative policy epoch.");
  }
  const classified = classifyPermissionEvidence({
    capability: input.capability,
    target,
    actor,
    evidence: input.evidence,
  });
  return {
    capability: input.capability,
    target: target.value,
    repository,
    actor,
    attempt_id: input.attemptId,
    policy_epoch: input.policyEpoch,
    result: classified.result,
    observed_at: input.observedAt,
    evidence_class: classified.evidenceClass,
  };
}

export interface RequiredPermissionObservation {
  capability: PublicationCapability;
  target: string;
  repository: string;
  actor: string;
  attemptId: string;
  policyEpoch: number;
  observedAt: string;
  maxAgeMs?: number;
}

/**
 * Refuse cached, cross-target, cross-actor, or inconclusive observations.
 * Callers bind one observation to one outward attempt and validate it
 * immediately before the corresponding create/push operation.
 */
export function assertFreshVerifiedPermission(
  observation: PermissionObservation | null | undefined,
  required: RequiredPermissionObservation,
): void {
  const target = parseGithubPublicationTarget(required.target);
  const repository = canonicalRepository(required.repository);
  const actor = canonicalActor(required.actor);
  const observedMs =
    observation === undefined || observation === null
      ? Number.NaN
      : Date.parse(observation.observed_at);
  const requiredMs = Date.parse(required.observedAt);
  const maxAgeMs = required.maxAgeMs ?? 60_000;
  // Epoch is the ownership-boundary fence and is deliberately compared before
  // HLC/time freshness or coordinate fields. An older epoch can never regain
  // authority merely because its observation is newer.
  const epochMatches =
    observation !== undefined &&
    observation !== null &&
    Number.isSafeInteger(required.policyEpoch) &&
    required.policyEpoch >= 0 &&
    observation.policy_epoch === required.policyEpoch;
  const matches =
    epochMatches &&
    observation !== undefined &&
    observation !== null &&
    target !== null &&
    repository !== null &&
    actor !== null &&
    observation.result === "verified" &&
    observation.capability === required.capability &&
    observation.target === target.value &&
    observation.repository.toLowerCase() === repository.toLowerCase() &&
    observation.actor === actor &&
    observation.attempt_id === required.attemptId &&
    Number.isFinite(observedMs) &&
    Number.isFinite(requiredMs) &&
    observedMs <= requiredMs &&
    requiredMs - observedMs <= maxAgeMs;
  if (!matches) {
    throw new Error(
      `Publication refused: ${required.capability} permission is not freshly verified for ${required.repository}.`,
    );
  }
}

export function classifyPermissionEvidence(input: {
  capability: PublicationCapability;
  target: CanonicalGithubPublicationTarget;
  actor: string | null;
  evidence: PermissionEvidence;
}): { result: PermissionObservationResult; evidenceClass: PermissionEvidenceClass } {
  const { capability, target, actor, evidence } = input;

  if (evidence.kind === "confirmed-denial") {
    return { result: "denied", evidenceClass: "confirmed-denial" };
  }
  if (evidence.kind === "unavailable") {
    return { result: "unknown", evidenceClass: evidence.reason };
  }
  if (evidence.kind === "ambiguous") {
    return { result: "unknown", evidenceClass: "ambiguous" };
  }
  if (evidence.kind === "personal-self-target") {
    const selfTarget =
      capability === "repository-create" &&
      target.kind === "user" &&
      actor !== null &&
      actor === target.owner &&
      evidence.actorConfirmed;
    return {
      result: selfTarget ? "verified" : "unknown",
      evidenceClass: "personal-self-target",
    };
  }
  if (evidence.kind === "organization-create") {
    const membershipAndAuthority =
      capability === "repository-create" &&
      target.kind === "org" &&
      evidence.effectiveMembership === "verified" &&
      (evidence.creationPolicy === "verified" || evidence.administrator === "verified");
    return {
      result: membershipAndAuthority ? "verified" : "unknown",
      evidenceClass:
        evidence.administrator === "verified"
          ? "organization-administrator"
          : "organization-membership-and-create-policy",
    };
  }

  return {
    result: capability === "repository-push" && evidence.canPush ? "verified" : "unknown",
    evidenceClass: "repository-push",
  };
}

/** A cached observation is display-only; it is never an authorization input. */
export function formatLastObservedPermission(observation: PermissionObservation): string {
  return `last observed ${observation.observed_at}: ${observation.result} (${observation.evidence_class})`;
}

function canonicalActor(actor: string | null | undefined): string | null {
  if (typeof actor !== "string") return null;
  const normalized = actor.trim().toLowerCase();
  return isValidGhHandle(normalized) ? normalized : null;
}

function canonicalRepository(repository: string): string | null {
  const match = /^([^/]+)\/([^/]+)$/.exec(repository.trim());
  if (match === null || !isValidGhHandle(match[1]!) || !isValidRepositoryName(match[2]!)) {
    return null;
  }
  return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
}

function isValidRepositoryName(value: string): boolean {
  return value.length > 0 && value.length <= 100 && /^[A-Za-z0-9_.-]+$/.test(value);
}
