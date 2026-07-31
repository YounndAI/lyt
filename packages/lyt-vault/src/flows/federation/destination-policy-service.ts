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

import { listFederationStates } from "../../registry/federation-state.js";
import type { MeshRow } from "../../registry/meshes-repo.js";
import { getVaultByRid, listVaults, type VaultRow, type VaultSource } from "../../registry/repo.js";
import {
  MINIMUM_DESTINATION_POLICY_WRITER_VERSION,
  destinationPolicyKey,
  resolveEffectiveOwnedMeshDestination,
  type DestinationPolicyRecordV1,
  type DestinationPolicyState,
  type DestinationPolicyValue,
  type DestinationSubjectKind,
  type EffectiveOwnedDestination,
} from "../../registry/destination-policy.js";
import {
  clearOwnedMeshDestinationProjection,
  clearForeignVaultDestination,
  clearOwnedVaultDestinationProjection,
  projectOwnedMeshDestination,
  projectOwnedVaultDestination,
} from "../../registry/destination-policy-projection.js";
import {
  appendDestinationPolicyRecordUnderLock,
  foldDestinationPolicyWinners,
  getDestinationPolicyAttemptLockPath,
  getDestinationPolicyLockPath,
  readAllDestinationPolicyRecords,
  readVerifiedDestinationPolicyWinners,
} from "./destination-policy-ledger.js";
import {
  withDestinationPolicyLock,
  type DestinationPolicyLockLease,
} from "./destination-policy-lock.js";
import { uuid7BytesToHex } from "../../util/uuid7.js";
import { vaultRepoName } from "../../util/federation-paths.js";
import { isValidGhHandle } from "../../util/identity.js";

export interface DestinationPolicyContext {
  podRid: string | null;
  podIdentityStatus?: "resolved" | "missing" | "ambiguous";
  podRoot?: string;
  winners: ReadonlyMap<string, DestinationPolicyRecordV1>;
}

export interface DestinationPolicySubjectRef {
  subjectKind: DestinationSubjectKind;
  subjectRid: string;
}

export interface CanonicalVaultPublicationAuthority {
  destination: Extract<EffectiveOwnedDestination, { kind: "github" }> & {
    repositoryName: string;
  };
  policyEpoch: number;
  policySubject: DestinationPolicySubjectRef;
  /** Every subject whose mutation could change this vault's effective target. */
  guardedSubjects: readonly DestinationPolicySubjectRef[];
}

export type CanonicalVaultDestinationAssessment =
  | Readonly<{
      status: "resolved";
      destination: EffectiveOwnedDestination;
      source: "vault-policy" | "mesh-policy";
    }>
  | Readonly<{
      status: "refused";
      reason: "missing-policy" | "contradictory-policy" | "ambiguous-authority";
      policySource: string | null;
    }>;

export interface LoadDestinationPolicyContextOptions {
  podRid?: string;
  podRoot?: string;
}

export async function loadDestinationPolicyContext(
  db: Client,
  options: LoadDestinationPolicyContextOptions = {},
): Promise<DestinationPolicyContext> {
  let podRid = options.podRid ?? null;
  let podIdentityStatus: "resolved" | "missing" | "ambiguous" =
    options.podRid === undefined ? "missing" : "resolved";
  if (podRid === null) {
    const states = await listFederationStates(db);
    if (states.length === 1) {
      podRid = states[0]!.fedRidHex;
      podIdentityStatus = "resolved";
    } else if (states.length > 1) {
      podIdentityStatus = "ambiguous";
    }
  }
  const winners =
    podRid === null
      ? new Map<string, DestinationPolicyRecordV1>()
      : readVerifiedDestinationPolicyWinners(podRid, options.podRoot);
  return {
    podRid,
    podIdentityStatus,
    ...(options.podRoot === undefined ? {} : { podRoot: options.podRoot }),
    winners,
  };
}

/** Runtime publication readers use ledger winners before compatibility columns. */
export function resolveCanonicalOwnedVaultDestination(
  vault: VaultRow,
  mesh: MeshRow | null | undefined,
  context: DestinationPolicyContext,
): EffectiveOwnedDestination {
  const assessment = assessCanonicalOwnedVaultDestination(vault, mesh, context);
  return assessment.status === "resolved"
    ? assessment.destination
    : { kind: "unconfigured", reason: "missing-policy" };
}

/** Resolve the canonical coordinate plus the epoch/subjects that authorize it. */
export function resolveCanonicalOwnedVaultPublicationAuthority(
  vault: VaultRow,
  mesh: MeshRow | null | undefined,
  context: DestinationPolicyContext,
): CanonicalVaultPublicationAuthority | null {
  if (vault.source !== "own") return null;

  const assessment = assessCanonicalOwnedVaultDestination(vault, mesh, context);
  if (assessment.status !== "resolved" || assessment.source !== "vault-policy") return null;

  const vaultWinner = context.winners.get(destinationPolicyKey("vault", vault.ridHex));
  if (vaultWinner !== undefined) {
    if (vaultWinner.state !== "active") return null;
    const destination = effectiveRecord(vaultWinner);
    if (destination.kind !== "github" || destination.repositoryName === null) return null;
    return {
      destination: { ...destination, repositoryName: destination.repositoryName },
      policyEpoch: vaultWinner.policyEpoch ?? 0,
      policySubject: { subjectKind: "vault", subjectRid: vault.ridHex },
      guardedSubjects: [{ subjectKind: "vault", subjectRid: vault.ridHex }],
    };
  }
  // Publication requires a vault-specific canonical ledger winner. Registry
  // columns are a diagnostics/migration projection only and never authorize an
  // outward action when the ledger is missing or has rolled back.
  return null;
}

/**
 * Resolve repair/presentation authority without allowing a stale registry
 * projection or a poisoned vault override to outrank conservative home-mesh
 * owner evidence. A repair caller may supply a fresh live origin for its own
 * operational comparison, but that observed effect is never policy authority.
 */
export function assessCanonicalOwnedVaultDestination(
  vault: VaultRow,
  mesh: MeshRow | null | undefined,
  context: DestinationPolicyContext,
  _observedOriginUrl: string | null = null,
): CanonicalVaultDestinationAssessment {
  const podIdentityStatus =
    context.podIdentityStatus ?? (context.podRid === null ? "missing" : "resolved");
  if (podIdentityStatus === "ambiguous") {
    return Object.freeze({
      status: "refused",
      reason: "ambiguous-authority",
      policySource: null,
    });
  }
  if (vault.source !== "own") {
    return Object.freeze({ status: "refused", reason: "missing-policy", policySource: null });
  }

  const vaultWinner = context.winners.get(destinationPolicyKey("vault", vault.ridHex));
  const vaultDestination =
    vaultWinner?.state === "active" ? effectiveRecord(vaultWinner) : null;
  if (vaultDestination !== null && vaultDestination.kind === "unconfigured") {
    return Object.freeze({
      status: "refused",
      reason: "ambiguous-authority",
      policySource: vaultWinner?.source ?? null,
    });
  }

  const meshDestination = resolveCanonicalOwnedMeshDestination(mesh, context);
  const meshOwnerEvidence = resolveMeshOwnerEvidence(mesh, context);
  const repositoryName = vaultRepoName(vault.name);

  if (vaultDestination?.kind === "github") {
    if (mesh === null || mesh === undefined || meshOwnerEvidence === null) {
      return Object.freeze({
        status: "refused",
        reason: "ambiguous-authority",
        policySource: vaultDestination.source,
      });
    }
    if (vaultDestination.owner.toLowerCase() !== meshOwnerEvidence.toLowerCase()) {
      return Object.freeze({
        status: "refused",
        reason: "contradictory-policy",
        policySource: vaultDestination.source,
      });
    }
    return Object.freeze({
      status: "resolved",
      destination: vaultDestination,
      source: "vault-policy",
    });
  }
  if (vaultDestination?.kind === "local") {
    return Object.freeze({
      status: "resolved",
      destination: vaultDestination,
      source: "vault-policy",
    });
  }
  if (vaultWinner !== undefined) {
    return Object.freeze({
      status: "refused",
      reason: "missing-policy",
      policySource: vaultWinner.source,
    });
  }
  if (mesh === null || mesh === undefined || mesh.ownCreated !== true) {
    return Object.freeze({
      status: "refused",
      reason: "ambiguous-authority",
      policySource: null,
    });
  }
  if (meshDestination.kind === "github" || meshDestination.kind === "local") {
    return Object.freeze({
      status: "resolved",
      destination:
        meshDestination.kind === "github"
          ? { ...meshDestination, repositoryName }
          : meshDestination,
      source: "mesh-policy",
    });
  }
  return Object.freeze({
    status: "refused",
    reason: "missing-policy",
    policySource: null,
  });
}

export function resolveCanonicalOwnedMeshDestination(
  mesh: MeshRow | null | undefined,
  context: DestinationPolicyContext,
): EffectiveOwnedDestination {
  if (mesh?.ownCreated !== true) return { kind: "unconfigured", reason: "missing-policy" };
  const winner = context.winners.get(destinationPolicyKey("mesh", mesh.ridHex));
  if (winner !== undefined) {
    return winner.state === "active"
      ? effectiveRecord(winner)
      : { kind: "unconfigured", reason: "missing-policy" };
  }
  return resolveEffectiveOwnedMeshDestination(mesh);
}

/**
 * Compatibility mesh fields are conservative conflict evidence only. They may
 * veto a conflicting exact vault winner but never authorize publication or
 * promote an unowned mesh by themselves.
 */
function resolveMeshOwnerEvidence(
  mesh: MeshRow | null | undefined,
  context: DestinationPolicyContext,
): string | null {
  if (mesh === null || mesh === undefined) return null;
  const winner = context.winners.get(destinationPolicyKey("mesh", mesh.ridHex));
  if (winner?.state === "active") {
    const effective = effectiveRecord(winner);
    if (effective.kind === "github") return effective.owner;
  }
  const projectedOwner = mesh.destinationTarget;
  if (typeof projectedOwner === "string" && isValidGhHandle(projectedOwner)) return projectedOwner;
  return typeof mesh.pushTarget === "string" && isValidGhHandle(mesh.pushTarget)
    ? mesh.pushTarget
    : null;
}

export interface SetCanonicalDestinationPolicyArgs extends DestinationPolicyValue {
  subjectKind: DestinationSubjectKind;
  subjectRid: Uint8Array;
  state?: DestinationPolicyState;
  podRid?: string;
  podRoot?: string;
  writerVersion?: string;
  recordedAt?: string;
  policyEpoch?: number;
}

/** The production write order is append -> fold winner -> compatibility projection. */
export async function setCanonicalDestinationPolicy(
  db: Client,
  args: SetCanonicalDestinationPolicyArgs,
): Promise<DestinationPolicyRecordV1> {
  const subjectRidHex = uuid7BytesToHex(args.subjectRid);
  const legacyCallerRid = (
    args as SetCanonicalDestinationPolicyArgs & {
      subjectRidHex?: unknown;
    }
  ).subjectRidHex;
  if (legacyCallerRid !== undefined && legacyCallerRid !== subjectRidHex) {
    throw new Error("Destination-policy subject RID bytes do not match the caller RID string.");
  }
  const context = await loadDestinationPolicyContext(db, {
    ...(args.podRid === undefined ? {} : { podRid: args.podRid }),
    ...(args.podRoot === undefined ? {} : { podRoot: args.podRoot }),
  });
  if (context.podRid === null) {
    throw new Error("Destination-policy writes require one resolved local pod identity.");
  }
  return withDestinationPolicySubjectLocks(
    context.podRoot,
    [{ subjectKind: args.subjectKind, subjectRid: subjectRidHex }],
    async () =>
      withDestinationPolicyLock(getDestinationPolicyLockPath(context.podRoot), async () => {
        const current = foldDestinationPolicyWinners(
          readAllDestinationPolicyRecords(context.podRid!, context.podRoot),
        );
        const state = args.state ?? "active";
        const priorWinner = current.get(destinationPolicyKey(args.subjectKind, subjectRidHex));
        const policyEpoch =
          args.policyEpoch ??
          (priorWinner === undefined
            ? 0
            : samePolicyBinding(priorWinner, { ...args, state })
              ? (priorWinner.policyEpoch ?? 0)
              : (priorWinner.policyEpoch ?? 0) + 1);
        appendDestinationPolicyRecordUnderLock({
          podRid: context.podRid!,
          subjectKind: args.subjectKind,
          subjectRid: subjectRidHex,
          destinationKind: args.destinationKind,
          targetOwner: args.targetOwner,
          targetKind: args.targetKind,
          repositoryName: args.repositoryName ?? null,
          source: args.source,
          state,
          policyEpoch,
          writerVersion: args.writerVersion ?? MINIMUM_DESTINATION_POLICY_WRITER_VERSION,
          ...(args.recordedAt === undefined ? {} : { recordedAt: args.recordedAt }),
          ...(args.podRoot === undefined ? {} : { podRoot: args.podRoot }),
        });
        const winner = foldDestinationPolicyWinners(
          readAllDestinationPolicyRecords(context.podRid!, context.podRoot),
        ).get(destinationPolicyKey(args.subjectKind, subjectRidHex));
        if (winner === undefined) {
          throw new Error("Destination-policy append did not produce a fold winner.");
        }
        await projectDestinationWinner(db, args, winner);
        return winner;
      }),
  );
}

/**
 * Promote exact, owned GitHub projections into canonical vault snapshots.
 * This is migration/recovery input only: any existing winner (including a
 * tombstone) wins and is never resurrected from the compatibility database.
 */
export async function backfillCanonicalOwnedVaultPolicySnapshots(
  db: Client,
  options: LoadDestinationPolicyContextOptions = {},
): Promise<number> {
  const context = await loadDestinationPolicyContext(db, options);
  if (context.podRid === null) return 0;
  let written = 0;
  for (const vault of await listVaults(db)) {
    if (
      vault.source !== "own" ||
      vault.status !== "active" ||
      vault.destinationKind !== "github" ||
      (vault.destinationSource !== "mesh-inherited" &&
        vault.destinationSource !== "vault-override") ||
      vault.destinationTarget === null ||
      vault.destinationTargetKind === null ||
      vault.destinationRepositoryName === null ||
      context.winners.has(destinationPolicyKey("vault", vault.ridHex))
    ) {
      continue;
    }
    await setCanonicalDestinationPolicy(db, {
      podRid: context.podRid,
      ...(context.podRoot === undefined ? {} : { podRoot: context.podRoot }),
      subjectKind: "vault",
      subjectRid: vault.rid,
      destinationKind: "github",
      targetOwner: vault.destinationTarget,
      targetKind: vault.destinationTargetKind,
      repositoryName: vault.destinationRepositoryName,
      source: vault.destinationSource,
    });
    written += 1;
  }
  return written;
}

/** Retract a vault-specific policy before an acquisition-source boundary change. */
export async function tombstoneCanonicalVaultDestination(
  db: Client,
  subjectRid: Uint8Array,
): Promise<boolean> {
  const subjectRidHex = uuid7BytesToHex(subjectRid);
  const context = await loadDestinationPolicyContext(db);
  if (context.podRid === null) {
    throw new Error("Vault source transition requires one resolved local pod identity.");
  }
  const winner = context.winners.get(destinationPolicyKey("vault", subjectRidHex));
  if (winner?.state === "tombstoned") return false;

  await setCanonicalDestinationPolicy(db, {
    podRid: context.podRid,
    subjectKind: "vault",
    subjectRid,
    destinationKind: winner?.destinationKind ?? "local",
    targetOwner: winner?.targetOwner ?? null,
    targetKind: winner?.targetKind ?? null,
    repositoryName: winner?.repositoryName ?? null,
    source: winner?.source ?? "vault-override",
    state: "tombstoned",
    policyEpoch: (winner?.policyEpoch ?? 0) + 1,
  });
  return true;
}

/** Hold the policy lock across the epoch fence and registry source mutation. */
export async function transitionVaultSourceWithPolicyFence(
  db: Client,
  subjectRid: Uint8Array,
  source: VaultSource,
): Promise<void> {
  const subjectRidHex = uuid7BytesToHex(subjectRid);
  const context = await loadDestinationPolicyContext(db);
  if (context.podRid === null) {
    throw new Error("Vault source transition requires one resolved local pod identity.");
  }
  await withDestinationPolicySubjectLocks(
    context.podRoot,
    [{ subjectKind: "vault", subjectRid: subjectRidHex }],
    async () =>
      withDestinationPolicyLock(getDestinationPolicyLockPath(context.podRoot), async () => {
        const winners = foldDestinationPolicyWinners(
          readAllDestinationPolicyRecords(context.podRid!, context.podRoot),
        );
        const prior = winners.get(destinationPolicyKey("vault", subjectRidHex));
        const nextEpoch = (prior?.policyEpoch ?? 0) + 1;
        appendDestinationPolicyRecordUnderLock({
          podRid: context.podRid!,
          subjectKind: "vault",
          subjectRid: subjectRidHex,
          destinationKind: prior?.destinationKind ?? "local",
          targetOwner: prior?.targetOwner ?? null,
          targetKind: prior?.targetKind ?? null,
          repositoryName: prior?.repositoryName ?? null,
          source: prior?.source ?? "vault-override",
          state: "tombstoned",
          policyEpoch: nextEpoch,
          writerVersion: MINIMUM_DESTINATION_POLICY_WRITER_VERSION,
          ...(context.podRoot === undefined ? {} : { podRoot: context.podRoot }),
        });
        const winner = foldDestinationPolicyWinners(
          readAllDestinationPolicyRecords(context.podRid!, context.podRoot),
        ).get(destinationPolicyKey("vault", subjectRidHex));
        if (winner?.state !== "tombstoned" || winner.policyEpoch !== nextEpoch) {
          throw new Error("Vault source transition could not establish its policy epoch fence.");
        }
        const updated = await db.execute({
          sql: `UPDATE vaults SET source = ?, destination_kind = NULL,
              destination_source = NULL, destination_target = NULL,
              destination_target_kind = NULL, destination_repository_name = NULL WHERE rid = ?`,
          args: [source, subjectRid],
        });
        if (updated.rowsAffected !== 1) {
          throw new Error("Vault source transition requires an existing registry row.");
        }
      }),
  );
}

export function withDestinationPolicySubjectLocks<T>(
  podRoot: string | undefined,
  subjects: readonly DestinationPolicySubjectRef[],
  action: (lease: DestinationPolicySubjectLockLease) => T,
): T {
  const locks = [
    ...new Map(
      subjects.map((subject) => {
        const identity = `${subject.subjectKind}:${subject.subjectRid}`;
        return [
          getDestinationPolicyAttemptLockPath(subject.subjectKind, subject.subjectRid, podRoot),
          identity,
        ] as const;
      }),
    ).entries(),
  ].sort(([left], [right]) => left.localeCompare(right));
  const acquire = (index: number, held: readonly DestinationPolicyLockLease[]): T =>
    index >= locks.length
      ? action({ renew: () => held.forEach((lease) => lease.renew()) })
      : withDestinationPolicyLock(
          locks[index]![0],
          (lease) => acquire(index + 1, [...held, lease]),
          { subject: locks[index]![1] },
        );
  return acquire(0, []);
}

export interface DestinationPolicySubjectLockLease {
  /** Renew every held subject lock immediately before one bounded outward child. */
  renew(): void;
}

async function projectDestinationWinner(
  db: Client,
  args: SetCanonicalDestinationPolicyArgs,
  winner: DestinationPolicyRecordV1,
): Promise<void> {
  if (args.subjectKind === "mesh") {
    if (winner.state === "tombstoned") {
      await clearOwnedMeshDestinationProjection(db, args.subjectRid);
    } else {
      await projectOwnedMeshDestination(db, args.subjectRid, {
        destinationKind: winner.destinationKind,
        targetOwner: winner.targetOwner,
        targetKind: winner.targetKind,
        source: winner.source as
          | "explicit"
          | "authenticated-default"
          | "auto-fallback-local"
          | "legacy-derived",
      });
    }
    return;
  }
  if (winner.state === "tombstoned") {
    const vault = await getVaultByRid(db, args.subjectRid);
    if (vault === null)
      throw new Error("Clearing vault destination policy requires an existing vault.");
    if (vault.source === "own") await clearOwnedVaultDestinationProjection(db, args.subjectRid);
    else await clearForeignVaultDestination(db, args.subjectRid);
    return;
  }
  await projectOwnedVaultDestination(db, args.subjectRid, {
    destinationKind: winner.destinationKind,
    targetOwner: winner.targetOwner,
    targetKind: winner.targetKind,
    repositoryName: winner.repositoryName ?? null,
    source: winner.source as "mesh-inherited" | "vault-override" | "legacy-derived",
  });
}

function effectiveRecord(record: DestinationPolicyRecordV1): EffectiveOwnedDestination {
  if (record.source === "legacy-derived") {
    return { kind: "unconfigured", reason: "quarantined-policy" };
  }
  if (record.destinationKind === "local") return { kind: "local", source: record.source };
  if (
    record.targetOwner === null ||
    record.targetKind === null ||
    (record.subjectKind === "vault" && record.repositoryName == null)
  ) {
    return { kind: "unconfigured", reason: "quarantined-policy" };
  }
  return {
    kind: "github",
    owner: record.targetOwner,
    targetKind: record.targetKind,
    repositoryName: record.repositoryName ?? null,
    source: record.source,
  };
}

function samePolicyBinding(
  current: DestinationPolicyRecordV1,
  next: DestinationPolicyValue & { state?: DestinationPolicyState },
): boolean {
  return (
    current.destinationKind === next.destinationKind &&
    current.targetOwner === next.targetOwner &&
    current.targetKind === next.targetKind &&
    (current.repositoryName ?? null) === (next.repositoryName ?? null) &&
    current.source === next.source &&
    current.state === (next.state ?? "active")
  );
}
