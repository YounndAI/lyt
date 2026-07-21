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

import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, relative } from "node:path";

import type { ActiveActorObservation } from "../op/active-actor-observation.js";
import type { DestinationPolicyValue } from "../registry/destination-policy.js";
import {
  parseGithubPublicationTarget,
  type CanonicalGithubPublicationTarget,
  type PermissionObservation,
  type PermissionObservationResult,
} from "../util/permission-observation.js";
import { isValidGithubRepositoryName } from "../util/publication-coordinate.js";
import { getFederationRepoDir } from "../util/federation-paths.js";
import { plannedInitialLocalWritePaths, plannedInitialScaffoldPaths } from "../scaffold/init.js";
import { getWriterId } from "../util/writer-id.js";

export type DestinationRequest =
  | { kind: "auto" }
  | { kind: "local" }
  | { kind: "target"; target: string }
  | { kind: "inherit"; meshRid: string };

export interface CreationSubjectFacts {
  kind: "mesh" | "vault";
  /** Exact GitHub repository name; destination owner is resolved separately. */
  repositoryName: string;
}

export type PlannedPodIdentityEffectV1 =
  { kind: "existing"; rid: string } | { kind: "create"; rid: string; handle: string };

/** A vault can be created without a mesh when mesh self-heal is disabled. */
export type PlannedMeshEffectV1 =
  | { kind: "existing"; rid: string; name: string }
  | { kind: "create"; rid: string; name: string }
  /** No mesh RID or name is promised; both fields remain for consumer compatibility. */
  | { kind: "none"; rid: ""; name: "" };

export interface CreationIntendedEffectsV1 {
  /** Stable across retries of one logical creation operation. */
  operation_id: string;
  identity: PlannedPodIdentityEffectV1;
  mesh: PlannedMeshEffectV1;
  primary_vault_rid: string;
  vaults: readonly {
    kind: "create";
    rid: string;
    /** A vault scaffold owns both identities; retry must not mint either one. */
    memscope_rid: string;
    name: string;
    root: string;
  }[];
  local_writes: readonly {
    root: string;
    exact_paths: readonly string[];
    bounded_path_classes: readonly (
      | "vault-scaffold"
      | "registry"
      | "destination-policy-ledger"
      | "federation-manifest-ledger"
      | "git-metadata"
    )[];
  }[];
  registry_rows: readonly {
    table: "federation_state" | "meshes" | "vaults" | "mesh_vaults";
    key: string;
  }[];
  topology_bindings: readonly {
    mesh_rid: string;
    vault_rid: string;
    role: "main" | "member";
  }[];
  checkpoints: readonly {
    repository_root: string;
    exact_paths: readonly string[];
  }[];
  /** Creation is unconditionally local-only. This tuple must stay empty. */
  remote_effects: readonly [];
}

export function plannedMeshPodEffectPathsV1(includePodScaffold: boolean): string[] {
  const writerId = getWriterId();
  return [
    ...(includePodScaffold ? [".gitignore", "README.md", "identity.yon"] : []),
    "pod.yon",
    `ledger/destination-policy/${writerId}.yon`,
    `ledger/meshes/${writerId}.yon`,
    `ledger/machines/${writerId}.yon`,
    `ledger/vaults/${writerId}.yon`,
  ].sort();
}

/**
 * A parent creation operation may materialize a mesh main vault before its
 * requested vault.  Keep that child operation inspectable in the terminal
 * plan instead of letting the command receipt invent an aggregate afterwards.
 * The child is structural evidence only: its effects remain part of the
 * parent's `intended_effects` and its replay key is never re-hashed.
 */
export interface CreationPlanChildV1 {
  operation_id: string;
  request: DestinationRequest;
  subject: CreationSubjectFacts;
  logical_replay_key: string;
  intended_effects: CreationIntendedEffectsV1;
}

/**
 * Construct the smallest valid, local-only effect declaration for a single
 * Lyt-created vault.  Programmatic creation callers use this instead of
 * inventing a destination-only plan.  Callers which know more exact paths or
 * registry effects may extend the returned value before resolution.
 */
export function plannedSingleVaultEffectsV1(args: {
  /**
   * The caller supplies a logical operation id, never an invocation attempt
   * id.  Keeping this explicit makes an accidental attempt-id fallback
   * reviewable at every producer.
   */
  operationId: string;
  pod?: { kind: "existing"; rid: string } | { kind: "create"; handle: string };
  /** @deprecated Production callers must pass `pod`; retained for old consumers. */
  podRid?: string;
  /** Omit only for a mesh-free vault plan when mesh self-heal is disabled. */
  mesh?: { kind: "existing" | "create"; name: string; rid?: string };
  vaultName: string;
  vaultRoot: string;
  template?: "empty" | "obsidian-default" | undefined;
  starterFigment?: boolean | undefined;
}): CreationIntendedEffectsV1 {
  const operationId = args.operationId.replaceAll("-", "").toLowerCase();
  const pod =
    args.pod ??
    (args.podRid === undefined ? undefined : ({ kind: "existing", rid: args.podRid } as const));
  if (pod === undefined) {
    throw new Error("Creation effects require an explicit existing or create pod identity effect.");
  }
  const mesh =
    args.mesh === undefined
      ? ({ kind: "none", rid: "", name: "" } as const)
      : args.mesh.kind === "create"
        ? {
            kind: "create" as const,
            rid: derivePlannedCreationRid(operationId, `mesh:${args.mesh.name}`),
            name: args.mesh.name,
          }
        : {
            kind: "existing" as const,
            rid: args.mesh.rid ?? derivePlannedCreationRid(operationId, `mesh:${args.mesh.name}`),
            name: args.mesh.name,
          };
  const vaultRid = derivePlannedCreationRid(operationId, `vault:${args.vaultName}`);
  const memscopeRid = derivePlannedCreationRid(operationId, `memscope:${args.vaultName}`);
  const checkpointPaths = plannedInitialScaffoldPaths({
    name: args.vaultName,
    ...(args.template === undefined ? {} : { template: args.template }),
    ...(args.starterFigment === undefined ? {} : { starterFigment: args.starterFigment }),
  });
  const localWritePaths = plannedInitialLocalWritePaths({
    name: args.vaultName,
    ...(args.template === undefined ? {} : { template: args.template }),
    ...(args.starterFigment === undefined ? {} : { starterFigment: args.starterFigment }),
  });
  if (mesh.kind === "create" && args.vaultName === `${mesh.name}/main`) {
    checkpointPaths.push(".lyt/mesh.yon");
    localWritePaths.push(".lyt/mesh.yon");
  }
  const localWrites: Array<CreationIntendedEffectsV1["local_writes"][number]> = [
    {
      root: args.vaultRoot,
      exact_paths: localWritePaths.map((path) => join(args.vaultRoot, path)),
      bounded_path_classes: ["vault-scaffold", "git-metadata"] as const,
    },
  ];
  const checkpoints: Array<CreationIntendedEffectsV1["checkpoints"][number]> = [
    { repository_root: args.vaultRoot, exact_paths: checkpointPaths },
  ];
  const registryRows: CreationIntendedEffectsV1["registry_rows"] = [
    { table: "vaults", key: vaultRid },
    ...(mesh.kind === "none"
      ? []
      : [{ table: "mesh_vaults" as const, key: `${mesh.rid}:${vaultRid}` }]),
    ...(mesh.kind === "create" ? [{ table: "meshes" as const, key: mesh.rid }] : []),
    ...(pod.kind === "create"
      ? [
          {
            table: "federation_state" as const,
            key: derivePlannedCreationRid(operationId, `pod:${pod.handle}`),
          },
        ]
      : []),
  ];
  if (pod.kind === "create") {
    const podRoot = getFederationRepoDir(pod.handle);
    const podPaths = plannedMeshPodEffectPathsV1(true);
    localWrites.push({
      root: podRoot,
      exact_paths: podPaths.map((path) => join(podRoot, path)),
      bounded_path_classes: [
        "vault-scaffold",
        "destination-policy-ledger",
        "federation-manifest-ledger",
        "git-metadata",
      ],
    });
    checkpoints.push({ repository_root: podRoot, exact_paths: podPaths });
  }
  return {
    operation_id: operationId,
    identity:
      pod.kind === "existing"
        ? { kind: "existing", rid: pod.rid }
        : {
            kind: "create",
            rid: derivePlannedCreationRid(operationId, `pod:${pod.handle}`),
            handle: pod.handle,
          },
    mesh,
    primary_vault_rid: vaultRid,
    vaults: [
      {
        kind: "create",
        rid: vaultRid,
        memscope_rid: memscopeRid,
        name: args.vaultName,
        root: args.vaultRoot,
      },
    ],
    local_writes: localWrites,
    registry_rows: registryRows,
    topology_bindings:
      mesh.kind === "none"
        ? []
        : [
            {
              mesh_rid: mesh.rid,
              vault_rid: vaultRid,
              role: args.vaultName === `${mesh.name}/main` ? "main" : "member",
            },
          ],
    checkpoints,
    remote_effects: [],
  };
}

/**
 * Join a requested vault's effects with a preplanned auto-created mesh child.
 * This is intentionally strict: every child must share one logical operation
 * and pod/mesh identity, so an aggregate receipt cannot accidentally hide a
 * second creation attempt.
 */
export function mergeCreationIntendedEffectsV1(args: {
  primary: CreationIntendedEffectsV1;
  children: readonly CreationIntendedEffectsV1[];
}): CreationIntendedEffectsV1 {
  const all = [args.primary, ...args.children];
  const operationId = args.primary.operation_id;
  if (all.some((effect) => effect.operation_id !== operationId)) {
    throw new Error("Aggregate creation effects must share one logical operation id.");
  }
  const identity = args.primary.identity;
  const mesh = args.primary.mesh;
  if (mesh.kind === "none") {
    throw new Error("Aggregate creation effects require a planned mesh identity.");
  }
  for (const effect of args.children) {
    if (
      effect.mesh.kind === "none" ||
      !isDeepIdentity(identity, effect.identity) ||
      !isDeepMesh(mesh, effect.mesh)
    ) {
      throw new Error("Aggregate creation effects must share one pod and mesh identity.");
    }
  }
  return {
    operation_id: operationId,
    identity,
    mesh,
    primary_vault_rid: args.primary.primary_vault_rid,
    vaults: uniqueBy(
      all.flatMap((effect) => effect.vaults),
      (value) => value.rid,
    ),
    local_writes: mergeLocalWrites(all.flatMap((effect) => effect.local_writes)),
    registry_rows: uniqueBy(
      all.flatMap((effect) => effect.registry_rows),
      (value) => `${value.table}:${value.key}`,
    ),
    topology_bindings: uniqueBy(
      all.flatMap((effect) => effect.topology_bindings),
      (value) => `${value.mesh_rid}:${value.vault_rid}:${value.role}`,
    ),
    checkpoints: mergeCheckpoints(all.flatMap((effect) => effect.checkpoints)),
    remote_effects: [],
  };
}

export function creationPlanChildV1(plan: CreationPlanV1): CreationPlanChildV1 {
  return {
    operation_id: plan.intended_effects.operation_id,
    request: plan.request,
    subject: plan.subject,
    logical_replay_key: plan.logical_replay_key,
    intended_effects: plan.intended_effects,
  };
}

/**
 * Add exact, already-existing repositories which one creation operation will
 * update after its primary scaffold.  The aggregate plan therefore owns the
 * final pod manifest and an existing mesh main's topology file before apply.
 */
export function withCreationRepositoryEffectsV1(
  effects: CreationIntendedEffectsV1,
  repositories: readonly {
    repositoryRoot: string;
    exactPaths: readonly string[];
    boundedPathClasses?: CreationIntendedEffectsV1["local_writes"][number]["bounded_path_classes"];
  }[],
): CreationIntendedEffectsV1 {
  const localWrites = [...effects.local_writes];
  const checkpoints = [...effects.checkpoints];
  for (const repository of repositories) {
    const root = canonicalAbsolute(repository.repositoryRoot);
    const checkpointPaths = sortedUnique(
      repository.exactPaths.map(canonicalRelativeCheckpointPath),
    );
    if (checkpointPaths.length === 0) continue;
    localWrites.push({
      root,
      exact_paths: checkpointPaths.map((path) => join(root, path)),
      bounded_path_classes: repository.boundedPathClasses ?? ["vault-scaffold", "git-metadata"],
    });
    checkpoints.push({ repository_root: root, exact_paths: checkpointPaths });
  }
  return {
    ...effects,
    local_writes: mergeLocalWrites(localWrites),
    checkpoints: mergeCheckpoints(checkpoints),
  };
}

function mergeLocalWrites(
  values: readonly CreationIntendedEffectsV1["local_writes"][number][],
): CreationIntendedEffectsV1["local_writes"][number][] {
  const byRoot = new Map<string, CreationIntendedEffectsV1["local_writes"][number]>();
  for (const value of values) {
    const previous = byRoot.get(value.root);
    byRoot.set(value.root, {
      root: value.root,
      exact_paths: sortedUnique([...(previous?.exact_paths ?? []), ...value.exact_paths]),
      bounded_path_classes: sortedUnique([
        ...(previous?.bounded_path_classes ?? []),
        ...value.bounded_path_classes,
      ]),
    });
  }
  return [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
}

function mergeCheckpoints(
  values: readonly CreationIntendedEffectsV1["checkpoints"][number][],
): CreationIntendedEffectsV1["checkpoints"][number][] {
  const byRoot = new Map<string, CreationIntendedEffectsV1["checkpoints"][number]>();
  for (const value of values) {
    const previous = byRoot.get(value.repository_root);
    byRoot.set(value.repository_root, {
      repository_root: value.repository_root,
      exact_paths: sortedUnique([...(previous?.exact_paths ?? []), ...value.exact_paths]),
    });
  }
  return [...byRoot.values()].sort((a, b) => a.repository_root.localeCompare(b.repository_root));
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(key(value), value);
  return [...result.values()];
}

function isDeepIdentity(a: PlannedPodIdentityEffectV1, b: PlannedPodIdentityEffectV1): boolean {
  if (a.kind !== b.kind || a.rid !== b.rid) return false;
  return a.kind !== "create" || (b.kind === "create" && a.handle === b.handle);
}

function isDeepMesh(
  a: CreationIntendedEffectsV1["mesh"],
  b: CreationIntendedEffectsV1["mesh"],
): boolean {
  return a.kind === b.kind && a.rid === b.rid && a.name === b.name;
}

export interface ResolveCreationPlanV1Input {
  request: DestinationRequest;
  subject: CreationSubjectFacts;
  actor: ActiveActorObservation;
  intendedEffects: CreationIntendedEffectsV1;
  inherited?: { meshRid: string; policy: DestinationPolicyValue } | null;
  permission?: PermissionObservation | null;
  /** Child plans already prepared for this one logical creation operation. */
  children?: readonly CreationPlanChildV1[];
}

/**
 * Stable UUIDv7-shaped logical operation identity.  It deliberately derives
 * from normalized intent, never from an invocation attempt, clock, or random
 * UUID.  The attempt id remains fresh evidence on CreationPlanV1.attempt.
 */
export function deriveCreationOperationIdV1(input: {
  request: DestinationRequest;
  subject: CreationSubjectFacts;
  scope: string;
}): string {
  const repositoryName = canonicalRepositoryName(input.subject.repositoryName);
  if (repositoryName === null || input.scope.trim().length === 0) {
    throw new Error("Logical creation identity requires canonical subject and non-empty scope.");
  }
  const digest = createHash("sha256")
    .update(
      stableJson({
        version: 1,
        request: input.request,
        subject: { ...input.subject, repositoryName },
        scope: input.scope,
      }),
    )
    .digest("hex");
  const variant = (8 + (Number.parseInt(digest[15]!, 16) & 3)).toString(16);
  return `${digest.slice(0, 12)}7${digest.slice(12, 15)}${variant}${digest.slice(16, 31)}`;
}

export type CreationPlanDestinationSource =
  | "mesh-explicit"
  | "vault-override"
  | "mesh-inherited"
  | "authenticated-default"
  | "auto-unavailable";

export type CreationPlanPolicySource =
  | "explicit"
  | "vault-override"
  | "mesh-inherited"
  | "authenticated-default"
  | "auto-fallback-local";

export type CreationPlanV1 = {
  version: 1;
  /** Exact normalized request this immutable plan resolves. */
  request: DestinationRequest;
  subject: CreationSubjectFacts;
  intended_effects: CreationIntendedEffectsV1;
  /** Immutable child operation evidence for aggregate mesh+vault creation. */
  children: readonly CreationPlanChildV1[];
  /** Opaque digest of logical intent/effects; deliberately excludes attempt evidence. */
  logical_replay_key: string;
  /** Receipt-safe evidence retained for the plan's exact attempt. */
  attempt: {
    attempt_id: string;
    active_actor: ActiveActorObservation;
    permission_observation: PermissionObservation | null;
    permission_result: PermissionObservationResult | null;
  };
  destination:
    | {
        kind: "local";
        source: Exclude<CreationPlanDestinationSource, "authenticated-default">;
        policy_source: CreationPlanPolicySource;
        inherited_mesh_rid?: string;
      }
    | {
        kind: "github";
        target: CanonicalGithubPublicationTarget["value"];
        source: Exclude<CreationPlanDestinationSource, "auto-unavailable">;
        policy_source: Exclude<CreationPlanPolicySource, null>;
        inherited_mesh_rid?: string;
        permission: PermissionObservationResult;
      };
  publication: "not-published";
  online_action: "none";
  recommendation: "run-scoped-sync" | "configure-github-target" | null;
};

export type ResolveCreationPlanV1Result =
  | { kind: "plan"; plan: CreationPlanV1 }
  | { kind: "refusal"; code: string; message: string; next_action: string };

/**
 * Pure, zero-mutation destination resolution. It consumes only attempt-bound
 * observations and provided policy/subject facts; callers apply the returned
 * plan later and must revalidate critical facts immediately before writing.
 */
export function resolveCreationPlanV1(
  input: ResolveCreationPlanV1Input,
): ResolveCreationPlanV1Result {
  const repositoryName = canonicalRepositoryName(input.subject.repositoryName);
  if (repositoryName === null) {
    return refusal(
      "invalid-repository-name",
      "Creation planning requires an exact GitHub repository name.",
    );
  }
  const subject = { ...input.subject, repositoryName };
  const effects = normalizeIntendedEffects(input.intendedEffects, subject);
  if (effects.kind === "refusal") return effects;
  const children = normalizePlanChildren(input.children ?? [], effects.value.operation_id);
  if (children.kind === "refusal") return children;
  if (
    !children.value.every((child) =>
      childEffectsAreContained(effects.value, child.intended_effects),
    )
  ) {
    return refusal(
      "invalid-aggregate-creation-plan",
      "Every child request, identity, row, file, binding, and checkpoint must be contained in the parent plan.",
    );
  }

  if (input.request.kind === "local") {
    return localPlan(
      subject,
      effects.value,
      children.value,
      input.request,
      input.actor,
      input.permission ?? null,
      subject.kind === "mesh" ? "mesh-explicit" : "vault-override",
      explicitPolicySource(subject),
      null,
    );
  }
  if (input.request.kind === "auto") {
    return input.actor.result === "verified"
      ? githubPlan(
          subject,
          effects.value,
          children.value,
          input.request,
          input.actor,
          `github:user/${input.actor.actor}`,
          "authenticated-default",
          "authenticated-default",
          matchingPermission(
            parseGithubPublicationTarget(`github:user/${input.actor.actor}`)!,
            subject.repositoryName,
            input.actor,
            input.permission,
          ),
        )
      : localPlan(
          subject,
          effects.value,
          children.value,
          input.request,
          input.actor,
          null,
          "auto-unavailable",
          "auto-fallback-local",
          "configure-github-target",
        );
  }
  if (input.request.kind === "target") {
    const target = parseGithubPublicationTarget(input.request.target);
    if (target === null) {
      return refusal(
        "invalid-target",
        "Explicit targets must be github:user/<owner> or github:org/<owner>.",
      );
    }
    const normalizedRequest: DestinationRequest = { kind: "target", target: target.value };
    const permission = matchingPermission(
      target,
      subject.repositoryName,
      input.actor,
      input.permission,
    );
    return githubPlan(
      subject,
      effects.value,
      children.value,
      normalizedRequest,
      input.actor,
      target.value,
      subject.kind === "mesh" ? "mesh-explicit" : "vault-override",
      explicitPolicySource(subject),
      permission,
    );
  }
  return resolveInheritedPlan(
    subject,
    effects.value,
    children.value,
    input.request,
    input.actor,
    input.request.meshRid,
    input.inherited,
    input.permission,
  );
}

function childEffectsAreContained(
  parent: CreationIntendedEffectsV1,
  child: CreationIntendedEffectsV1,
): boolean {
  const includes = <T>(
    parentValues: readonly T[],
    childValues: readonly T[],
    key: (value: T) => string,
  ): boolean => {
    const keys = new Set(parentValues.map(key));
    return childValues.every((value) => keys.has(key(value)));
  };
  return (
    isDeepIdentity(parent.identity, child.identity) &&
    isDeepMesh(parent.mesh, child.mesh) &&
    includes(parent.vaults, child.vaults, (value) => stableJson(value)) &&
    child.local_writes.every((entry) => {
      const parentEntry = parent.local_writes.find((candidate) => candidate.root === entry.root);
      return (
        parentEntry !== undefined &&
        entry.exact_paths.every((path) => parentEntry.exact_paths.includes(path)) &&
        entry.bounded_path_classes.every((kind) => parentEntry.bounded_path_classes.includes(kind))
      );
    }) &&
    includes(parent.registry_rows, child.registry_rows, (value) => `${value.table}:${value.key}`) &&
    includes(
      parent.topology_bindings,
      child.topology_bindings,
      (value) => `${value.mesh_rid}:${value.vault_rid}:${value.role}`,
    ) &&
    child.checkpoints.every((entry) => {
      const parentEntry = parent.checkpoints.find(
        (candidate) => candidate.repository_root === entry.repository_root,
      );
      return (
        parentEntry !== undefined &&
        entry.exact_paths.every((path) => parentEntry.exact_paths.includes(path))
      );
    })
  );
}

function resolveInheritedPlan(
  subject: CreationSubjectFacts,
  effects: CreationIntendedEffectsV1,
  children: readonly CreationPlanChildV1[],
  request: Extract<DestinationRequest, { kind: "inherit" }>,
  actor: ActiveActorObservation,
  requestedMeshRid: string,
  inherited: { meshRid: string; policy: DestinationPolicyValue } | null | undefined,
  permission: PermissionObservation | null | undefined,
): ResolveCreationPlanV1Result {
  if (!isValidMeshRid(requestedMeshRid)) {
    return refusal(
      "invalid-inherited-mesh-rid",
      "Inherited creation requires a canonical lowercase UUIDv7 mesh RID hex.",
    );
  }
  if (inherited === null || inherited === undefined || inherited.meshRid !== requestedMeshRid) {
    return refusal(
      "missing-inherited-destination",
      "No inherited destination policy is available for this creation.",
    );
  }
  const { policy } = inherited;
  if (!isValidMeshRid(inherited.meshRid)) {
    return refusal(
      "invalid-inherited-mesh-rid",
      "Inherited creation requires a canonical lowercase UUIDv7 mesh RID hex.",
    );
  }
  if (policy.source !== "explicit" && policy.source !== "authenticated-default") {
    return refusal(
      "invalid-inherited-destination",
      "Inherited policy must be an active mesh policy source.",
    );
  }
  if (policy.destinationKind === "local") {
    return policy.targetOwner === null && policy.targetKind === null
      ? localPlan(
          subject,
          effects,
          children,
          request,
          actor,
          null,
          "mesh-inherited",
          "mesh-inherited",
          null,
          requestedMeshRid,
        )
      : refusal(
          "invalid-inherited-destination",
          "Inherited local policy contains a GitHub target.",
        );
  }
  if (policy.targetOwner === null || policy.targetKind === null) {
    return refusal(
      "invalid-inherited-destination",
      "Inherited GitHub policy lacks a canonical target.",
    );
  }
  const target = parseGithubPublicationTarget(`github:${policy.targetKind}/${policy.targetOwner}`);
  if (target === null) {
    return refusal(
      "invalid-inherited-destination",
      "Inherited GitHub policy has an invalid target.",
    );
  }
  const result = matchingPermission(target, subject.repositoryName, actor, permission);
  return githubPlan(
    subject,
    effects,
    children,
    request,
    actor,
    target.value,
    "mesh-inherited",
    "mesh-inherited",
    result,
    requestedMeshRid,
  );
}

function localPlan(
  subject: CreationSubjectFacts,
  effects: CreationIntendedEffectsV1,
  children: readonly CreationPlanChildV1[],
  request: DestinationRequest,
  actor: ActiveActorObservation,
  permission: PermissionObservation | null,
  source: Extract<CreationPlanV1["destination"], { kind: "local" }>["source"],
  policySource: CreationPlanPolicySource,
  recommendation: CreationPlanV1["recommendation"],
  inheritedMeshRid?: string,
): ResolveCreationPlanV1Result {
  return {
    kind: "plan",
    plan: deepFreeze({
      version: 1,
      request,
      subject,
      intended_effects: effects,
      children,
      logical_replay_key: logicalReplayKey(request, subject, effects),
      attempt: attemptEvidence(actor, permission, permission?.result ?? null),
      destination: {
        kind: "local",
        source,
        policy_source: policySource,
        ...(inheritedMeshRid === undefined ? {} : { inherited_mesh_rid: inheritedMeshRid }),
      },
      publication: "not-published",
      online_action: "none",
      recommendation,
    }),
  };
}

function githubPlan(
  subject: CreationSubjectFacts,
  effects: CreationIntendedEffectsV1,
  children: readonly CreationPlanChildV1[],
  request: DestinationRequest,
  actor: ActiveActorObservation,
  target: CanonicalGithubPublicationTarget["value"],
  source: Extract<CreationPlanV1["destination"], { kind: "github" }>["source"],
  policySource: Exclude<CreationPlanPolicySource, null>,
  permission: { observation: PermissionObservation | null; result: PermissionObservationResult },
  inheritedMeshRid?: string,
): ResolveCreationPlanV1Result {
  return {
    kind: "plan",
    plan: deepFreeze({
      version: 1,
      request,
      subject,
      intended_effects: effects,
      children,
      logical_replay_key: logicalReplayKey(request, subject, effects),
      attempt: attemptEvidence(actor, permission.observation, permission.result),
      destination: {
        kind: "github",
        target,
        source,
        policy_source: policySource,
        permission: permission.result,
        ...(inheritedMeshRid === undefined ? {} : { inherited_mesh_rid: inheritedMeshRid }),
      },
      publication: "not-published",
      online_action: "none",
      recommendation: "run-scoped-sync",
    }),
  };
}

function matchingPermission(
  target: CanonicalGithubPublicationTarget,
  repositoryName: string,
  actor: ActiveActorObservation,
  observation: PermissionObservation | null | undefined,
): { observation: PermissionObservation | null; result: PermissionObservationResult } {
  const repository = `${target.owner}/${repositoryName}`;
  const actorObservedMs = Date.parse(actor.observed_at);
  const permissionObservedMs =
    observation === null || observation === undefined
      ? Number.NaN
      : Date.parse(observation.observed_at);
  if (
    observation === null ||
    observation === undefined ||
    observation.capability !== "repository-create" ||
    observation.target !== target.value ||
    observation.repository !== repository ||
    observation.attempt_id !== actor.attempt_id ||
    !Number.isFinite(actorObservedMs) ||
    !Number.isFinite(permissionObservedMs) ||
    permissionObservedMs < actorObservedMs ||
    (actor.result === "verified" && observation.actor !== actor.actor)
  ) {
    return { observation: null, result: "unknown" };
  }
  return { observation, result: observation.result };
}

function attemptEvidence(
  actor: ActiveActorObservation,
  permission: PermissionObservation | null,
  permissionResult: PermissionObservationResult | null,
): CreationPlanV1["attempt"] {
  return {
    attempt_id: actor.attempt_id,
    active_actor: actor,
    permission_observation: permission,
    permission_result: permissionResult,
  };
}

function explicitPolicySource(subject: CreationSubjectFacts): "explicit" | "vault-override" {
  return subject.kind === "mesh" ? "explicit" : "vault-override";
}

function isValidMeshRid(value: string): boolean {
  // Phase A registry identity is uuid7BytesToHex: exactly 32 lowercase hex
  // digits, not a display UUID with hyphens.
  return /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(value);
}

function canonicalRepositoryName(value: string): string | null {
  return value === value.trim() && isValidGithubRepositoryName(value) ? value : null;
}

function refusal(
  code: string,
  message: string,
): Extract<ResolveCreationPlanV1Result, { kind: "refusal" }> {
  return {
    kind: "refusal",
    code,
    message,
    next_action: "Correct the destination facts and retry before mutation.",
  };
}

/** Stable UUIDv7-shaped RID allocation owned by the logical operation, not an invocation. */
export function derivePlannedCreationRid(operationId: string, label: string): string {
  const operationHex = operationId.replaceAll("-", "").toLowerCase();
  if (!isValidMeshRid(operationHex) || label.trim().length === 0) {
    throw new Error("Planned creation RIDs require a UUIDv7 operation id and non-empty label.");
  }
  const entropy = createHash("sha256").update(`${operationHex}\0${label}`).digest("hex");
  const variant = (8 + (Number.parseInt(entropy[3]!, 16) & 3)).toString(16);
  return `${operationHex.slice(0, 12)}7${entropy.slice(0, 3)}${variant}${entropy.slice(3, 18)}`;
}

function normalizeIntendedEffects(
  value: CreationIntendedEffectsV1,
  subject: CreationSubjectFacts,
):
  | { kind: "effects"; value: CreationIntendedEffectsV1 }
  | Extract<ResolveCreationPlanV1Result, { kind: "refusal" }> {
  try {
    const operationHex = value.operation_id.replaceAll("-", "").toLowerCase();
    if (!isValidMeshRid(operationHex)) throw new Error("operation_id must be UUIDv7");
    for (const rid of [
      value.identity.rid,
      ...(value.mesh.kind === "none" ? [] : [value.mesh.rid]),
      value.primary_vault_rid,
      ...value.vaults.flatMap((vault) => [vault.rid, vault.memscope_rid]),
    ]) {
      if (!isValidMeshRid(rid)) throw new Error("planned identities must be lowercase UUIDv7 hex");
    }
    if (
      value.identity.kind === "create" &&
      (value.identity.handle.trim().length === 0 ||
        value.identity.rid !==
          derivePlannedCreationRid(operationHex, `pod:${value.identity.handle}`))
    ) {
      throw new Error(
        "planned pod identity must be deterministically owned by operation_id and handle",
      );
    }
    if (
      value.mesh.kind === "create" &&
      value.mesh.rid !== derivePlannedCreationRid(operationHex, `mesh:${value.mesh.name}`)
    ) {
      throw new Error(
        "planned mesh RID must be deterministically owned by operation_id and mesh name",
      );
    }
    if (value.vaults.length === 0)
      throw new Error("creation must plan at least one vault create effect");
    for (const vault of value.vaults) {
      if (vault.rid !== derivePlannedCreationRid(operationHex, `vault:${vault.name}`)) {
        throw new Error(
          "planned vault RID must be deterministically owned by operation_id and vault name",
        );
      }
      if (vault.memscope_rid !== derivePlannedCreationRid(operationHex, `memscope:${vault.name}`)) {
        throw new Error(
          "planned memscope RID must be deterministically owned by operation_id and vault name",
        );
      }
      if (!isAbsolute(vault.root)) throw new Error("vault root must be absolute");
    }
    if (!value.vaults.some((vault) => vault.rid === value.primary_vault_rid)) {
      throw new Error("primary_vault_rid must name one planned vault effect");
    }
    if (value.mesh.kind === "none") {
      if (value.mesh.rid !== "" || value.mesh.name !== "") {
        throw new Error("mesh-free creation effects may not promise a mesh identity");
      }
      if (value.topology_bindings.length !== 0) {
        throw new Error("mesh-free creation effects may not promise topology bindings");
      }
      if (
        value.registry_rows.some((row) => row.table === "meshes" || row.table === "mesh_vaults")
      ) {
        throw new Error("mesh-free creation effects may not promise mesh registry rows");
      }
    }
    if (subject.kind === "mesh" && value.mesh.kind !== "create") {
      throw new Error("mesh creation must plan a mesh create effect");
    }
    if (value.remote_effects.length !== 0) throw new Error("creation remote effects must be empty");
    if (value.mesh.kind !== "none") {
      for (const vault of value.vaults) {
        if (
          !value.topology_bindings.some(
            (binding) => binding.mesh_rid === value.mesh.rid && binding.vault_rid === vault.rid,
          )
        ) {
          throw new Error("creation must plan every mesh/vault topology binding");
        }
      }
    }
    if (
      subject.kind === "mesh" &&
      !value.topology_bindings.some(
        (binding) =>
          binding.mesh_rid === value.mesh.rid &&
          binding.vault_rid === value.primary_vault_rid &&
          binding.role === "main",
      )
    ) {
      throw new Error("mesh creation primary vault must be its main topology binding");
    }
    if (
      value.mesh.kind === "create" &&
      !value.vaults.some(
        (vault) =>
          vault.name === `${value.mesh.name}/main` &&
          value.topology_bindings.some(
            (binding) => binding.vault_rid === vault.rid && binding.role === "main",
          ),
      )
    ) {
      throw new Error("new mesh effects must include its canonical main vault binding");
    }
    const localWrites = value.local_writes.map((entry) => {
      const root = canonicalAbsolute(entry.root);
      const exactPaths = sortedUnique(entry.exact_paths.map(canonicalAbsolute));
      for (const path of exactPaths) assertContained(root, path);
      return {
        root,
        exact_paths: exactPaths,
        bounded_path_classes: sortedUnique(entry.bounded_path_classes),
      };
    });
    const checkpoints = value.checkpoints.map((entry) => ({
      repository_root: canonicalAbsolute(entry.repository_root),
      exact_paths: sortedUnique(entry.exact_paths.map(canonicalRelativeCheckpointPath)),
    }));
    const normalized: CreationIntendedEffectsV1 = {
      operation_id: operationHex,
      identity: { ...value.identity },
      mesh: { ...value.mesh },
      primary_vault_rid: value.primary_vault_rid,
      vaults: value.vaults
        .map((vault) => ({ ...vault, root: canonicalAbsolute(vault.root) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      local_writes: [...localWrites].sort((a, b) => a.root.localeCompare(b.root)),
      registry_rows: [...value.registry_rows]
        .map((row) => ({ ...row }))
        .sort((a, b) => `${a.table}:${a.key}`.localeCompare(`${b.table}:${b.key}`)),
      topology_bindings: [...value.topology_bindings]
        .map((binding) => ({ ...binding }))
        .sort((a, b) =>
          `${a.mesh_rid}:${a.vault_rid}:${a.role}`.localeCompare(
            `${b.mesh_rid}:${b.vault_rid}:${b.role}`,
          ),
        ),
      checkpoints: [...checkpoints].sort((a, b) =>
        a.repository_root.localeCompare(b.repository_root),
      ),
      remote_effects: [],
    };
    return { kind: "effects", value: normalized };
  } catch (error) {
    return refusal(
      "invalid-intended-effects",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizePlanChildren(
  value: readonly CreationPlanChildV1[],
  operationId: string,
):
  | { kind: "children"; value: readonly CreationPlanChildV1[] }
  | Extract<ResolveCreationPlanV1Result, { kind: "refusal" }> {
  try {
    const seen = new Set<string>();
    const normalized: CreationPlanChildV1[] = [];
    for (const child of value) {
      if (
        child.operation_id !== operationId ||
        child.intended_effects.operation_id !== operationId
      ) {
        throw new Error("child plan must share the parent logical operation id");
      }
      if (!/^sha256:[a-f0-9]{64}$/i.test(child.logical_replay_key)) {
        throw new Error("child plan must carry its exact SHA-256 logical replay key");
      }
      if (child.intended_effects.remote_effects.length !== 0) {
        throw new Error("aggregate child plans may not contain remote effects");
      }
      const normalizedEffects = normalizeIntendedEffects(child.intended_effects, child.subject);
      if (normalizedEffects.kind === "refusal") {
        throw new Error(normalizedEffects.message);
      }
      const expectedKey = logicalReplayKey(child.request, child.subject, normalizedEffects.value);
      if (expectedKey !== child.logical_replay_key.toLowerCase()) {
        return refusal(
          "child-replay-mismatch",
          "Child replay key does not bind its normalized request, subject, and effects.",
        );
      }
      const key = `${child.operation_id}:${child.logical_replay_key}`;
      if (seen.has(key)) throw new Error("aggregate creation plan repeats a child plan");
      seen.add(key);
      normalized.push(
        deepFreeze({
          operation_id: child.operation_id,
          request: child.request,
          subject: child.subject,
          logical_replay_key: child.logical_replay_key.toLowerCase(),
          intended_effects: normalizedEffects.value,
        }),
      );
    }
    return { kind: "children", value: normalized };
  } catch (error) {
    return refusal(
      "invalid-aggregate-creation-plan",
      error instanceof Error ? error.message : "Creation plan child evidence is invalid.",
    );
  }
}

function logicalReplayKey(
  request: DestinationRequest,
  subject: CreationSubjectFacts,
  effects: CreationIntendedEffectsV1,
): string {
  const canonical = stableJson({ version: 1, request, subject, intended_effects: effects });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalAbsolute(value: string): string {
  if (!isAbsolute(value)) throw new Error(`planned path must be absolute: ${value}`);
  return normalize(value);
}

function canonicalRelativeCheckpointPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`checkpoint path must be a contained repository-relative path: ${value}`);
  }
  return normalized;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`planned path escapes its write root: ${candidate}`);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
