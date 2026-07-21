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
import { readFileSync } from "node:fs";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { getMeshByRid } from "../../registry/meshes-repo.js";
import { getVaultByRid } from "../../registry/repo.js";
import {
  assertFreshVerifiedPermission,
  parseGithubPublicationTarget,
  type PublicationCapability,
} from "../../util/permission-observation.js";
import {
  normalizeGithubPublicationCoordinate,
  type GithubPublicationCoordinate,
} from "../../util/publication-coordinate.js";
import { resolveRemoteUrl } from "../../util/remote-url.js";
import { federationRepoName } from "../../util/federation-paths.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import {
  getDestinationPolicyLockPath,
  getPublicationAttemptLockPath,
  readVerifiedDestinationPolicyWinnersUnderLock,
} from "./destination-policy-ledger.js";
import { withDestinationPolicyLock } from "./destination-policy-lock.js";
import {
  resolveCanonicalOwnedVaultPublicationAuthority,
  withDestinationPolicySubjectLocks,
  type CanonicalVaultPublicationAuthority,
  type DestinationPolicyContext,
} from "./destination-policy-service.js";
import {
  observePublicationPermission,
  type PublicationPermissionObserver,
} from "./publication-permission.js";

export interface FreshPublicationPermissionArgs<T> {
  capability: PublicationCapability;
  target: string;
  repository: string;
  actor: string;
  attemptId: string;
  policyEpoch: number;
  permissionObserver?: PublicationPermissionObserver;
  publicationSubject?: { identity: string; podRoot?: string };
  action: (context: CanonicalVaultPublicationAttemptContext) => Promise<T>;
}

/** Probe, bind, and consume one permission observation for one exact action. */
export async function withFreshPublicationPermission<T>(
  args: FreshPublicationPermissionArgs<T>,
): Promise<T> {
  const observedAt = new Date().toISOString();
  const observation = await (args.permissionObserver ?? observePublicationPermission)({
    capability: args.capability,
    target: args.target,
    repository: args.repository,
    actor: args.actor,
    attemptId: args.attemptId,
    policyEpoch: args.policyEpoch,
    observedAt,
  });
  assertFreshVerifiedPermission(observation, {
    capability: args.capability,
    target: args.target,
    repository: args.repository,
    actor: args.actor,
    attemptId: args.attemptId,
    policyEpoch: args.policyEpoch,
    observedAt,
  });
  if (args.publicationSubject === undefined) {
    return args.action({ runOutwardChild: (child) => child() });
  }
  const subject = args.publicationSubject;
  return withDestinationPolicyLock(
    getPublicationAttemptLockPath(subject.identity, subject.podRoot),
    (lease) =>
      args.action({
        runOutwardChild: async (child) => {
          lease.renew();
          return child();
        },
      }),
    { subject: subject.identity },
  );
}

export interface CanonicalVaultPublicationAttemptContext {
  /** Renew all subject leases, then invoke exactly one bounded outward child. */
  runOutwardChild<U>(child: () => Promise<U>): Promise<U>;
}

export interface CanonicalPodPublicationAuthority {
  podRid: string;
  handle: string;
  destination: GithubPublicationCoordinate;
}

export function resolveCanonicalPodPublicationAuthority(
  handle: string,
  podRid: string,
): CanonicalPodPublicationAuthority {
  const destination = normalizeGithubPublicationCoordinate(
    resolveRemoteUrl(handle, federationRepoName()),
  );
  if (destination === null) {
    throw new Error("Pod publication requires one canonical GitHub coordinate.");
  }
  return { podRid, handle, destination };
}

export interface CanonicalPodPublicationAttemptArgs<T> {
  authority: CanonicalPodPublicationAuthority;
  podYonPath: string;
  podRoot: string;
  actor: string;
  attemptId: string;
  permissionObserver?: PublicationPermissionObserver;
  action: (context: CanonicalVaultPublicationAttemptContext) => Promise<T>;
}

/** Re-probe permission and re-read the exact pod identity before one push. */
export async function withCanonicalPodPublicationAttempt<T>(
  args: CanonicalPodPublicationAttemptArgs<T>,
): Promise<T> {
  const { authority } = args;
  return withFreshPublicationPermission({
    capability: "repository-push",
    target: `github:user/${authority.destination.owner}`,
    repository: `${authority.destination.owner}/${authority.destination.repositoryName}`,
    actor: args.actor,
    attemptId: args.attemptId,
    policyEpoch: 0,
    ...(args.permissionObserver === undefined
      ? {}
      : { permissionObserver: args.permissionObserver }),
    publicationSubject: { identity: `pod:${authority.podRid}`, podRoot: args.podRoot },
    action: async (context) => {
      const manifest = parseFederationYon(readFileSync(args.podYonPath, "utf8"));
      const current = resolveCanonicalPodPublicationAuthority(
        manifest.federation.handle,
        manifest.federation.fedRidHex,
      );
      if (
        current.podRid !== authority.podRid ||
        current.handle.toLowerCase() !== authority.handle.toLowerCase() ||
        current.destination.coordinate !== authority.destination.coordinate
      ) {
        throw new Error("Publication refused: canonical pod destination changed before push.");
      }
      return args.action(context);
    },
  });
}

export interface CanonicalVaultPublicationAttemptArgs<T> extends Omit<
  FreshPublicationPermissionArgs<T>,
  "policyEpoch" | "action"
> {
  db?: Client;
  vaultRid: Uint8Array;
  podRid: string;
  podRoot?: string;
  authority: CanonicalVaultPublicationAuthority;
  /** RID-addressed repository mapping captured with the authority snapshot. */
  expectedRepository: string;
  action: (context: CanonicalVaultPublicationAttemptContext) => Promise<T>;
}

/**
 * Permission is probed outside every lock. Scoped subject locks then remain
 * held through the outward action, while the global policy lock is held only
 * for the immediate canonical coordinate/epoch revalidation. A successful
 * revocation therefore cannot overtake an already-authorized network action.
 */
export async function withCanonicalVaultPublicationAttempt<T>(
  args: CanonicalVaultPublicationAttemptArgs<T>,
): Promise<T> {
  const observedAt = new Date().toISOString();
  const observer = args.permissionObserver ?? observePublicationPermission;
  const observation = await observer({
    capability: args.capability,
    target: args.target,
    repository: args.repository,
    actor: args.actor,
    attemptId: args.attemptId,
    policyEpoch: args.authority.policyEpoch,
    observedAt,
  });
  assertFreshVerifiedPermission(observation, {
    capability: args.capability,
    target: args.target,
    repository: args.repository,
    actor: args.actor,
    attemptId: args.attemptId,
    policyEpoch: args.authority.policyEpoch,
    observedAt,
  });

  const ownDb = args.db === undefined;
  const db = args.db ?? (await openRegistry());
  try {
    return await withDestinationPolicySubjectLocks(
      args.podRoot,
      args.authority.guardedSubjects,
      async (subjectLease) => {
        await withDestinationPolicyLock(getDestinationPolicyLockPath(args.podRoot), async () => {
          const vault = await getVaultByRid(db, args.vaultRid);
          if (vault === null) throw authorityChanged();
          const mesh =
            vault.homeMeshRid === null ? null : await getMeshByRid(db, vault.homeMeshRid);
          const context: DestinationPolicyContext = {
            podRid: args.podRid,
            ...(args.podRoot === undefined ? {} : { podRoot: args.podRoot }),
            winners: readVerifiedDestinationPolicyWinnersUnderLock(args.podRid, args.podRoot),
          };
          const current = resolveCanonicalOwnedVaultPublicationAuthority(vault, mesh, context);
          if (
            !sameAuthority(
              current,
              args.authority,
              args.target,
              args.repository,
              args.expectedRepository,
            )
          ) {
            throw authorityChanged();
          }
        });
        return args.action({
          runOutwardChild: async (child) => {
            // Synchronous renewal is intentionally adjacent to child creation:
            // a timer heartbeat can be starved by a synchronous 120s child.
            subjectLease.renew();
            return child();
          },
        });
      },
    );
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}

function sameAuthority(
  current: CanonicalVaultPublicationAuthority | null,
  expected: CanonicalVaultPublicationAuthority,
  target: string,
  repository: string,
  expectedRepository: string,
): boolean {
  if (current === null || current.policyEpoch !== expected.policyEpoch) return false;
  if (
    current.policySubject.subjectKind !== expected.policySubject.subjectKind ||
    current.policySubject.subjectRid !== expected.policySubject.subjectRid ||
    current.destination.owner.toLowerCase() !== expected.destination.owner.toLowerCase() ||
    current.destination.targetKind !== expected.destination.targetKind ||
    current.destination.repositoryName.toLowerCase() !==
      expected.destination.repositoryName.toLowerCase()
  ) {
    return false;
  }
  const parsedTarget = parseGithubPublicationTarget(target);
  const repositoryParts = repository.split("/");
  const expectedRepositoryParts = expectedRepository.split("/");
  if (
    repositoryParts.length !== 2 ||
    expectedRepositoryParts.length !== 2 ||
    repositoryParts.some((part) => part.length === 0) ||
    expectedRepositoryParts.some((part) => part.length === 0) ||
    repository.toLowerCase() !== expectedRepository.toLowerCase()
  ) {
    return false;
  }
  const [owner, repositoryName] = repositoryParts;
  return (
    parsedTarget?.kind === current.destination.targetKind &&
    parsedTarget.owner === current.destination.owner.toLowerCase() &&
    owner?.toLowerCase() === current.destination.owner.toLowerCase() &&
    repositoryName?.toLowerCase() === current.destination.repositoryName.toLowerCase()
  );
}

function authorityChanged(): Error {
  return new Error(
    "Publication refused: canonical destination policy changed before the outward action.",
  );
}
