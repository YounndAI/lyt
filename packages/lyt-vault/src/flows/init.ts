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

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

import type { Client } from "@libsql/client";

import { assertVaultRegistered, type CommitVerdict } from "../registry/assert-committed.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { readFederationState } from "../registry/federation-state.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByExactName, setVaultHomeMesh } from "../registry/repo.js";
import { appendMeshHomeToFile } from "../registry/vault-home-mesh-helpers.js";
import { initVaultDbs } from "../registry/vault-db.js";
import { LEDGER_REGISTRY } from "../registry/ledger-registry.js";
import {
  initVault,
  plannedObsidianScaffoldPaths,
  type InitOptions,
  type InitResult,
} from "../scaffold/init.js";
import {
  createInitialCheckpointContext,
  finalizeInitialCheckpoint,
  recordInitialCheckpointPaths,
  type LocalCheckpointResult,
} from "../scaffold/local-checkpoint.js";
import { getFederationRepoDir } from "../util/federation-paths.js";
import { recordInitFailure } from "../util/failure-log.js";
import { getHandleFromIdentity } from "../util/identity.js";
import { hexToUuid7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import { getWriterId } from "../util/writer-id.js";
import { VOICE } from "../voice.js";
import { federationInitFlow } from "./federation/init.js";
import { regeneratePodManifestNonFatal } from "./federation/regenerate.js";
import { meshInitFlow } from "./mesh-init.js";
import type { FederationGhClient, FederationRepoVisibility } from "../util/gh-federation.js";
import type { MeshGhClient } from "../util/gh-mesh.js";
import { registerVaultFromYon } from "./register.js";
import { indexScaffoldFtsOnCreate } from "./upsert-fts-cache.js";
import { setCanonicalDestinationPolicy } from "./federation/destination-policy-service.js";
import { parseCanonicalDestinationTarget } from "../registry/destination-policy.js";
import { destinationPolicyKey } from "../registry/destination-policy.js";
import { getFederationRoot } from "../util/federation-paths.js";
import {
  foldDestinationPolicyWinners,
  readAllDestinationPolicyRecords,
} from "./federation/destination-policy-ledger.js";
import {
  asCreationMutationFailure,
  CreationMutationJournal,
  type CreationMutationEvidence,
} from "../op/creation-mutation-journal.js";
import type { CreationPlanV1, DestinationRequest } from "./creation-plan.js";
import {
  assertVaultCreationBinding,
  assertVaultInitWriteTarget,
  inspectVaultInitPreflight,
  type VaultCreationBinding,
} from "./vault-init-preflight.js";

export interface InitFlowResult extends InitResult {
  registered: boolean;
  // 0.9.4 (3d / §4) — read-back verdict. `verified` when the post-register
  // re-read confirms the vault row exists by rid; `unverified` otherwise. The
  // CLI appends `unverifiedNote` to the success line on an unverified outcome
  // instead of printing an unconditional "Initialized".
  committed: CommitVerdict;
  unverifiedNote: string | null;
  // v1.A.0 federation self-heal branch — populated when initVaultFlow
  // detected ZERO federation_state row AND ZERO local cache AND the just-
  // registered vault put the count at ≥1. `null` when the branch did not
  // fire (cached state, opt-out, or self-heal was skipped via options).
  federationSelfHealed: {
    handle: string;
    fedRidHex: string;
    branch: "fresh" | "adopted";
    visibility: FederationRepoVisibility;
    statusVoiceEmitted: string;
  } | null;
  // v1.B.3 — populated when the init flow auto-normalized a bare name to
  // `personal/<name>` (or `<mesh>/<name>` for already-namespaced input
  // that resolved to an existing mesh). Carries the home-mesh assignment
  // that landed in vault.yon + mesh.yon. `null` when init was called via
  // direct mesh-init flow (which builds its own mesh.yon) or when
  // selfHeal.mesh.enabled was false and no mesh assignment was possible.
  meshAssignment: {
    meshRidHex: string;
    meshName: string;
    autoNormalizedFrom: string | null;
    meshAutoCreated: boolean;
    statusVoiceEmitted: string;
    pushTarget: string | null;
    pushKind: string | null;
    ownCreated: boolean;
  } | null;
  /** Phase B local-only creation evidence; command adapters own Receipt V1. */
  creation: {
    plan: CreationPlanV1;
    checkpoints: LocalCheckpointResult[];
    mutations: CreationMutationEvidence;
  } | null;
}

// v1.A.1 fold (DO NOT SKIP #12) — InitFlowOptions refactored from four
// federation-specific top-level knobs to a nested sub-options bag. The
// `selfHeal.federation` shape captures everything v1.A.0 needs; the
// `selfHeal.mesh` placeholder declares the shape v1.B.1 will fill once
// `lyt mesh init` exists. Mesh self-heal IS the v1.B.1 contract — declared
// here so InitFlowOptions doesn't reshape twice.

export interface FederationSelfHealOptions {
  // Opt-IN gate: when true (or absent + treated as true at the CLI layer),
  // post-vault-registration probes federation_state + materialises the
  // {handle}/lyt-pod repo if missing. Default `false` at the API
  // level so existing block-A tests stay network-free. CLI explicitly opts
  // in via `commands/init.ts`.
  enabled?: boolean | undefined;
  // Injectable seam for tests + future BYOK consumers.
  ghClient?: FederationGhClient | undefined;
  // Lets tests force the handle without depending on `gh api /user`.
  handle?: string | undefined;
  // Controls whether the self-heal init pushes to remote. Default false on
  // self-heal — handler hasn't explicitly asked for federation publication.
  pushOnSelfHeal?: boolean | undefined;
}

// v1.B.3 populates the MeshSelfHealOptions shape (was an intentionally
// empty placeholder in v1.A.1; v1.B.1 retro flagged it for v1.B.3 wiring).
//
// Auto-personal mesh creation: when `lyt vault init <bare>` runs and the
// `personal` mesh isn't registered, the init flow invokes `meshInitFlow`
// in-process to scaffold it locally before scaffolding the new vault. The
// resulting mesh is then the new vault's home mesh, and vault.yon +
// mesh.yon get @VAULT_HOME_MESH + @MESH_HOME records describing the
// binding.
//
// Default at the API surface: `enabled: false` (preserves test-friendly
// network-free init for the block-A test suite). The CLI layer
// (commands/init.ts) opts in via `enabled: true`.
export interface MeshSelfHealOptions {
  // Master opt-in. When undefined or false, init never reshapes the name
  // and never auto-creates a mesh — the call behaves like v1.A.1's
  // mesh-unaware init (vault.yon emits no @VAULT_HOME_MESH).
  enabled?: boolean | undefined;
  // Override the auto-created mesh name for a BARE init (defaults to
  // `'personal'`). For a `<mesh>/<leaf>` init the mesh slot is the user's
  // chosen name. Tests pass a deterministic name; production defaults to
  // `personal` per naming-convention.md §Bare-name normalization.
  meshName?: string | undefined;
  // Push the just-created mesh to remote on auto-create. Default false —
  // auto-create is a local self-heal; the handler explicitly opts in (via
  // `lyt vault init <mesh>/<leaf> --push-to <handle>`) when they want a
  // remote sharing mesh.
  pushOnSelfHeal?: boolean | undefined;
  // 0.9.4 (3c) — explicit push target for an auto-created mesh (a GitHub
  // handle/org). When set, the auto-created mesh is a SHARING mesh pointed at
  // this owner; without it, the new mesh is local-only (matches the personal
  // default). Threaded into the nested meshInitFlow.
  pushTo?: string | undefined;
  // Injectable seam for tests + future BYOK consumers. Forwarded into the
  // nested `meshInitFlow` call when auto-creation fires. Mirrors the
  // federation self-heal shape.
  ghClient?: MeshGhClient | undefined;
  /** Exact mesh plan used only when this vault operation creates the mesh. */
  creation?: VaultCreationBinding | undefined;
}

export interface InitFlowOptions extends InitOptions {
  /** Exact, attempt-bound request/plan consumed by this mutation. */
  creation: VaultCreationBinding;
  selfHeal?: {
    federation?: FederationSelfHealOptions;
    mesh?: MeshSelfHealOptions;
  };
}

// v1.A.1 fold (DO NOT SKIP #15) — pure decision: should the federation
// self-heal branch fire on this invocation? Extracted from
// `maybeSelfHealFederation` so the four-case decision matrix is
// independently unit-testable (no SQL, no filesystem, no network):
//
// 1. opts.selfHeal.federation.enabled !== true → false
// 2. handle cannot be resolved → false
// 3. federation_state row exists → false
// 4. local ~/lyt/pod/ directory exists → false (flat pod dir)
//
// Otherwise → returns the resolved handle so the caller can act.
//
// The `registryProbe` callback returns the federation_state row (or null).
// Tests pass a fake; production passes a closure over an already-open db.
export interface ShouldSelfHealProbe {
  readFederationStateForHandle(handle: string): Promise<unknown | null>;
  localFederationDirExists(handle: string): boolean;
}

export async function shouldSelfHealFederation(
  opts: InitFlowOptions,
  probe: ShouldSelfHealProbe,
): Promise<{ handle: string } | null> {
  const fed = opts.selfHeal?.federation;
  if (fed?.enabled !== true) return null;

  let handle = fed.handle;
  if (handle === undefined || handle.length === 0) {
    try {
      handle = getHandleFromIdentity();
    } catch {
      return null;
    }
  }
  if (!handle || handle.length === 0) return null;

  const existing = await probe.readFederationStateForHandle(handle);
  if (existing !== null) return null;
  if (probe.localFederationDirExists(handle)) return null;

  return { handle };
}

// v1.B.3 — structured error raised when `lyt vault init <owner>/<name>`
// names a mesh that isn't registered AND mesh auto-creation is gated to
// `personal` only.
//
// 0.9.4 (3c) — RETAINED for back-compat (still exported so existing
// callers/tests resolve), but NO LONGER THROWN on a missing mesh: create-if-
// missing now auto-creates ANY named mesh, uniformly (the `personal`-only
// special-case is dropped). The class survives only for the defensive
// "auto-created mesh didn't land / main vault unresolvable" arms.
export class HomeMeshNotFoundError extends Error {
  readonly errorCode = "home-mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt vault init: home mesh '${meshName}' could not be resolved after auto-create (defensive).`,
    );
    this.name = "HomeMeshNotFoundError";
    this.meshName = meshName;
  }
}

// 0.9.4 (3c) — `vault init {mesh}/{vault}` STOPS + NOTIFIES when the
// vault already exists (idempotent-by-refusal: never silently re-scaffold over
// a live vault). The mesh is still created-if-missing; only an existing VAULT
// is the stop condition.
export class VaultAlreadyExistsError extends Error {
  readonly errorCode = "vault-already-exists";
  readonly vaultName: string;
  constructor(vaultName: string) {
    super(
      `lyt vault init: vault '${vaultName}' already exists. ` +
        `Nothing to do — use 'lyt vault list' to inspect it, or 'lyt vault rename'/'lyt vault move' to change it.`,
    );
    this.name = "VaultAlreadyExistsError";
    this.vaultName = vaultName;
  }
}

export async function initVaultFlow(opts: InitFlowOptions): Promise<InitFlowResult> {
  if (opts.creation === undefined) {
    throw new Error("Vault creation requires one exact, attempt-bound CreationBinding.");
  }
  const creationBinding = opts.creation;
  let creationPreflight = inspectVaultInitPreflight({
    name: opts.name,
    ...(opts.path === undefined ? {} : { path: opts.path }),
    meshEnabled: opts.selfHeal?.mesh?.enabled === true,
    ...(opts.selfHeal?.mesh?.meshName === undefined
      ? {}
      : { defaultMeshName: opts.selfHeal.mesh.meshName }),
  });
  assertVaultCreationBinding(creationPreflight, creationBinding);
  // Re-read and revalidate immediately before the first migration-capable
  // registry open. The preflight itself is capability-level read-only.
  creationPreflight = inspectVaultInitPreflight({
    name: opts.name,
    ...(opts.path === undefined ? {} : { path: opts.path }),
    meshEnabled: opts.selfHeal?.mesh?.enabled === true,
    ...(opts.selfHeal?.mesh?.meshName === undefined
      ? {}
      : { defaultMeshName: opts.selfHeal.mesh.meshName }),
  });
  assertVaultCreationBinding(creationPreflight, creationBinding);
  assertVaultInitWriteTarget(creationPreflight, creationBinding);
  const freshPodBoundary = captureFreshPodMutationBoundary(creationBinding.creationPlan);

  // v1.A.1b: open the registry ONCE up-front (v1.A.1a fold #4 extended) so
  // we can (a) resolve --parent <name> → parentVaultRid bytes before the
  // scaffold writes vault.yon, (b) register the just-scaffolded vault, and
  // (c) thread the same db into the federation self-heal probe. Saves the
  // duplicate-open the v1.A.0 code did pre-fold-#4.
  let db: Client | null = null;
  let federationSelfHealed: InitFlowResult["federationSelfHealed"] = null;
  let meshAssignment: InitFlowResult["meshAssignment"] = null;
  let creation: InitFlowResult["creation"] = null;
  const mutationJournal = new CreationMutationJournal(creationBinding.attemptId);
  try {
    db = await openRegistry();
    const writerId =
      creationBinding.creationPlan.intended_effects.identity.kind === "create"
        ? getWriterId()
        : null;
    // Materialize the planned first-pod identity before any vault or mesh
    // scaffold.  This keeps all nested creation paths on the same real pod
    // rather than letting one of them manufacture a second identity.
    if (creationPreflight.podIdentity.state === "missing") {
      const identity = creationBinding.creationPlan.intended_effects.identity;
      if (identity.kind !== "create") {
        throw new Error("First-vault creation is missing its planned pod identity effect.");
      }
      const pod = await federationInitFlow({
        handle: identity.handle,
        visibility: "private",
        pushToRemote: false,
        createRemoteIfMissing: false,
        localOnly: true,
        checkpointMode: "deferred",
        plannedFedRidBytes: hexToUuid7Bytes(identity.rid),
        db,
      });
      if (pod.fedRidHex !== identity.rid) {
        throw new Error(
          "Vault creation pod apply observed an identity that differs from its plan.",
        );
      }
      if (pod.branch === "cached") {
        throw new Error(
          "Vault creation pod apply received branch=cached despite a missing planned identity.",
        );
      }
      federationSelfHealed = {
        handle: pod.handle,
        fedRidHex: pod.fedRidHex,
        branch: pod.branch,
        visibility: pod.visibility,
        statusVoiceEmitted: VOICE.forgingFromDetectedState,
      };
      mutationJournal.record({ registryRows: 1 });
    }

    // v1.B.3 — name normalization + mesh self-heal probe. Runs BEFORE the
    // scaffold so vault.yon gets a @VAULT_HOME_MESH block on first write
    // (no post-scaffold re-render). The decision tree:
    //
    // 1. mesh self-heal disabled OR opts.name already contains '/' AND
    // no mesh self-heal context → don't normalize; vault stays
    // mesh-unaffiliated (v1.A.1 behavior).
    // 2. bare name + self-heal enabled → normalize to `<meshName>/<bare>`
    // where meshName defaults to 'personal'; ensure the mesh exists
    // (auto-create if absent); emit transparent VOICE message.
    // 3. `<owner>/<name>` form + self-heal enabled → require the
    // `<owner>` mesh to already exist; throw HomeMeshNotFoundError
    // otherwise (per Plan-D1: don't silently auto-create non-personal
    // meshes).
    const meshSelfHealAssignment = await maybeAssignHomeMesh(opts, db);
    if (meshSelfHealAssignment?.meshMutations !== undefined) {
      mutationJournal.record(meshSelfHealAssignment.meshMutations);
    }

    const effectiveName = meshSelfHealAssignment?.normalizedName ?? opts.name;
    const homeMeshScaffoldArg = meshSelfHealAssignment?.scaffoldHomeMesh;

    // 0.9.4 (3c) — STOP + NOTIFY if the vault already exists. Probe by
    // the EXACT normalized name (not the leaf-resolving chokepoint — we want a
    // literal "is THIS vault present?" check). The mesh has already been
    // created-if-missing above; only an existing VAULT is the stop condition.
    if (await getVaultByExactName(db, effectiveName)) {
      throw new VaultAlreadyExistsError(effectiveName);
    }

    // Resolve --parent <name> into the FK-compatible Uint8Array bytes that
    // scaffold/init writes into vault.yon's @VAULT parent_vault field. Any
    // explicit parentVaultRid passed by the caller (tests + future
    // programmatic consumers) wins over the name lookup.
    let parentVaultRid = opts.parentVaultRid;
    if (parentVaultRid === undefined && opts.parent !== undefined && opts.parent.length > 0) {
      const parentRow = await getVaultByName(db, opts.parent);
      if (parentRow === null) {
        throw new Error(
          `--parent <name>: no vault registered with name '${opts.parent}'. ` +
            `Use 'lyt vault list' to see registered vaults.`,
        );
      }
      parentVaultRid = parentRow.rid;
    }
    const scaffoldOpts: InitOptions = {
      ...opts,
      name: effectiveName,
      ...(parentVaultRid !== undefined ? { parentVaultRid } : {}),
      ...(homeMeshScaffoldArg !== undefined ? { homeMesh: homeMeshScaffoldArg } : {}),
      plannedVaultRid: hexToUuid7Bytes(
        creationBinding.creationPlan.intended_effects.primary_vault_rid,
      ),
      plannedMemscopeRid: hexToUuid7Bytes(
        creationBinding.creationPlan.intended_effects.vaults.find(
          (vault) => vault.rid === creationBinding.creationPlan.intended_effects.primary_vault_rid,
        )!.memscope_rid,
      ),
      checkpointMode: "deferred" as const,
    };

    const result = initVault(scaffoldOpts);
    const editorLocalWritePaths = plannedObsidianScaffoldPaths(result.template);
    mutationJournal.record({
      filesystemWrites: result.checkpointContext.paths.length + editorLocalWritePaths.length,
      checkpointPaths: result.checkpointContext.paths,
    });
    assertPlannedCheckpointPaths(
      creationBinding.creationPlan,
      result.vaultPath,
      result.checkpointContext.paths,
    );
    // Per-vault libSQL initialised on creation so the 6 schemas are queryable
    // on first read, not lazily on first write. Block-A Commit 4 invariant.
    await initVaultDbs(result.vaultPath);
    mutationJournal.record({ localDatabases: 1 + LEDGER_REGISTRY.length });

    // B-4 / Decision-B (B2): index the scaffold figments into FTS at create so a
    // freshly-init'd vault has FTS == on-disk-indexable and doctor's
    // index-fts-smoke canary does not false-warn (exit 2) on it. Shared seam +
    // full rationale: indexScaffoldFtsOnCreate (upsert-fts-cache.ts).
    await indexScaffoldFtsOnCreate(result.vaultPath);

    const registered = await registerVaultFromYon(db, { vaultPath: result.vaultPath });
    mutationJournal.record({ registryRows: 1 });
    if (
      uuid7BytesToHex(result.vaultRid) !==
        creationBinding.creationPlan.intended_effects.primary_vault_rid ||
      registered.ridHex !== creationBinding.creationPlan.intended_effects.primary_vault_rid
    ) {
      throw new Error(
        "Vault creation apply observed an identity that differs from its immutable plan.",
      );
    }

    // v1.B.3 — when a home-mesh assignment landed in vault.yon, complete
    // the registry-side binding: set vaults.home_mesh_rid (register.ts
    // already does this via the parsed @VAULT_HOME_MESH; setVaultHomeMesh
    // is a belt-and-braces no-op then), INSERT mesh_vaults role='home',
    // and append the @MESH_HOME row to the home mesh's main vault's
    // mesh.yon.
    if (meshSelfHealAssignment !== null) {
      await setVaultHomeMesh(db, registered.rid, meshSelfHealAssignment.meshRid);
      mutationJournal.record({ topologyBindings: 1 });
      await addVaultToMesh(db, meshSelfHealAssignment.meshRid, registered.rid, "home");
      mutationJournal.record({ registryRows: 1, topologyBindings: 1 });
      appendMeshHomeToFile({
        mainVaultPath: meshSelfHealAssignment.mainVaultPath,
        meshRid: meshSelfHealAssignment.meshRid,
        vaultRid: registered.rid,
        vaultName: effectiveName,
      });
      mutationJournal.record({ filesystemWrites: 1, checkpointPaths: [".lyt/mesh.yon"] });
      meshAssignment = {
        meshRidHex: meshSelfHealAssignment.meshRidHex,
        meshName: meshSelfHealAssignment.meshName,
        autoNormalizedFrom: meshSelfHealAssignment.autoNormalizedFrom,
        meshAutoCreated: meshSelfHealAssignment.meshAutoCreated,
        statusVoiceEmitted: meshSelfHealAssignment.statusVoiceEmitted,
        pushTarget: meshSelfHealAssignment.pushTarget,
        pushKind: meshSelfHealAssignment.pushKind,
        ownCreated: meshSelfHealAssignment.ownCreated,
      };
    }

    if (creationPreflight.podIdentity.state !== "missing") {
      federationSelfHealed = await maybeSelfHealFederation(opts, db);
    }
    const policyPodRid =
      creationPreflight.podRid ??
      federationSelfHealed?.fedRidHex ??
      creationBinding.creationPlan.intended_effects.identity.rid;
    if (policyPodRid === null) {
      throw new Error("Vault creation lost its initialized pod identity before policy apply.");
    }
    await applyVaultCreationPolicy(
      db,
      policyPodRid,
      registered.rid,
      creationBinding.creationPlan,
      creationBinding.destinationRequest,
    );
    mutationJournal.record({ destinationPolicyRecords: 1 });
    await assertPlannedVaultApply(
      db,
      creationBinding.creationPlan,
      policyPodRid,
      creationBinding.destinationRequest,
    );

    // (Brief A) — regenerate the derived pod manifest from the now-populated
    // registry so `pod.yon` reflects this just-registered vault. Runs LAST, after
    // the vault + mesh + federation_state rows have landed. Non-fatal + skipped
    // when the pod isn't initialised (no federation_state yet). Reuses the open
    // registry (open-once).
    await regeneratePodManifestNonFatal(
      db,
      federationSelfHealed !== null ? { handle: federationSelfHealed.handle } : {},
    );
    mutationJournal.record({ filesystemWrites: 1 });

    const podCheckpoint = finalizePlannedPodCheckpoint(
      creationBinding.creationPlan,
      creationPreflight.podIdentity.state === "present"
        ? creationPreflight.podIdentity.repositoryRoot
        : creationBinding.creationPlan.intended_effects.identity.kind === "create"
          ? getFederationRepoDir(creationBinding.creationPlan.intended_effects.identity.handle)
          : null,
      freshPodBoundary,
      writerId,
      opts.checkpointGitRunner,
    );

    // Read-back guard on top of registration. Re-read the row by rid and
    // assert the vault is actually present before claiming success — closes
    // the "reported success without effect" class for the init surface.
    const committed = await assertVaultRegistered(db, registered.rid);

    const checkpoints: LocalCheckpointResult[] = [];
    const checkpointRepositories: Array<{
      repositoryRoot: string;
      checkpoint: LocalCheckpointResult;
    }> = [];
    const vaultCheckpoint =
      opts.checkpointMode !== "deferred" &&
      result.gitInitialized &&
      result.checkpoint.status === "deferred"
        ? finalizeInitialCheckpoint(result.checkpointContext, opts.checkpointGitRunner)
        : result.checkpoint;
    checkpoints.push(vaultCheckpoint);
    checkpointRepositories.push({ repositoryRoot: result.vaultPath, checkpoint: vaultCheckpoint });
    if (podCheckpoint !== null) {
      checkpoints.push(podCheckpoint);
      const podRoot =
        creationPreflight.podIdentity.state === "present"
          ? creationPreflight.podIdentity.repositoryRoot
          : getFederationRepoDir(
              (
                creationBinding.creationPlan.intended_effects.identity as {
                  kind: "create";
                  handle: string;
                }
              ).handle,
            );
      checkpointRepositories.push({ repositoryRoot: podRoot, checkpoint: podCheckpoint });
    }
    if (
      result.gitInitialized &&
      meshSelfHealAssignment !== null &&
      meshSelfHealAssignment.mainVaultPath !== result.vaultPath
    ) {
      const meshContext = meshSelfHealAssignment.mainVaultCheckpointContext;
      if (meshContext !== undefined) {
        // The auto-created mesh deferred its own checkpoint specifically so
        // this final mesh-home binding joins the original scaffold journal.
        recordInitialCheckpointPaths(meshContext, [".lyt/mesh.yon"]);
      }
      const meshCheckpoint = finalizeInitialCheckpoint(
        meshContext ??
          createInitialCheckpointContext(meshSelfHealAssignment.mainVaultPath, [".lyt/mesh.yon"]),
        opts.checkpointGitRunner,
      );
      checkpoints.push(meshCheckpoint);
      checkpointRepositories.push({
        repositoryRoot: meshSelfHealAssignment.mainVaultPath,
        checkpoint: meshCheckpoint,
      });
    }
    const checkpointPaths = checkpoints.flatMap((checkpoint) => checkpoint.paths);
    for (const checkpoint of checkpoints) {
      if (checkpoint.status === "committed") mutationJournal.record({ checkpointCommits: 1 });
    }
    mutationJournal.record({
      checkpointRepositories: checkpointRepositories.map(({ repositoryRoot, checkpoint }) => ({
        repositoryRoot,
        paths: checkpoint.paths,
        ...(checkpoint.commitSha === undefined ? {} : { commitSha: checkpoint.commitSha }),
        ...(checkpoint.beforeCommitSha === undefined
          ? {}
          : { beforeCommitSha: checkpoint.beforeCommitSha }),
        clean: checkpoint.status === "committed" || checkpoint.status === "skipped",
      })),
    });
    creation = {
      plan: creationBinding.creationPlan,
      checkpoints,
      mutations: {
        ...mutationJournal.snapshot(),
        checkpointPaths: [
          ...new Set([...mutationJournal.snapshot().checkpointPaths, ...checkpointPaths]),
        ].sort(),
      },
    };
    const returnedResult = {
      ...result,
      checkpoint: vaultCheckpoint,
      initialCommitMade: vaultCheckpoint.status === "committed",
    };

    return {
      ...returnedResult,
      registered: true,
      federationSelfHealed,
      meshAssignment,
      creation,
      committed: committed.verdict,
      unverifiedNote: committed.unverifiedNote,
    };
  } catch (error) {
    const failureLogged = recordInitFailure({
      site: "first-vault-create",
      step: "flow:initVaultFlow",
      summary: "Vault creation stopped after its local apply phase began.",
      context: { name: opts.name },
    });
    if (failureLogged) mutationJournal.record({ failureLogRecords: 1, filesystemWrites: 1 });
    throw asCreationMutationFailure(error, mutationJournal, {
      code: "vault-init-apply-failed",
      summary: "Vault creation stopped after its local apply phase began.",
      retryable: false,
      nextAction: {
        code: "inspect-local-creation",
        summary:
          `Run lyt repair --dry-run. If '${opts.name}' exists with the wrong destination, ` +
          `use lyt vault destination '${opts.name}' --target github:user|org/<owner>, then ` +
          `lyt sync --vault '${opts.name}'. Do not delete or recreate the vault.`,
      },
    });
  } finally {
    if (db !== null) await closeRegistry(db);
  }
}

async function assertPlannedVaultApply(
  db: Client,
  plan: CreationPlanV1,
  podRid: string,
  request: DestinationRequest,
): Promise<void> {
  for (const row of plan.intended_effects.registry_rows) {
    const present =
      row.table === "federation_state"
        ? await db.execute({
            sql: "SELECT 1 FROM federation_state WHERE lower(hex(fed_rid)) = ?",
            args: [row.key],
          })
        : row.table === "meshes"
          ? await db.execute({
              sql: "SELECT 1 FROM meshes WHERE lower(hex(rid)) = ?",
              args: [row.key],
            })
          : row.table === "vaults"
            ? await db.execute({
                sql: "SELECT 1 FROM vaults WHERE lower(hex(rid)) = ?",
                args: [row.key],
              })
            : (() => {
                const [meshRid, vaultRid] = row.key.split(":");
                return db.execute({
                  sql: "SELECT 1 FROM mesh_vaults WHERE lower(hex(mesh_rid)) = ? AND lower(hex(vault_rid)) = ?",
                  args: [meshRid ?? "", vaultRid ?? ""],
                });
              })();
    if ((await present).rows.length !== 1) {
      throw new Error(
        `Vault creation did not realize planned registry row ${row.table}:${row.key}.`,
      );
    }
  }
  for (const binding of plan.intended_effects.topology_bindings) {
    const present = await db.execute({
      sql: "SELECT 1 FROM mesh_vaults WHERE lower(hex(mesh_rid)) = ? AND lower(hex(vault_rid)) = ? AND role = 'home'",
      args: [binding.mesh_rid, binding.vault_rid],
    });
    if (present.rows.length !== 1) {
      throw new Error("Vault creation did not realize a planned topology binding.");
    }
  }
  const winner = foldDestinationPolicyWinners(
    readAllDestinationPolicyRecords(podRid, getFederationRoot()),
  ).get(destinationPolicyKey("vault", plan.intended_effects.primary_vault_rid));
  const expectedSource = request.kind === "inherit" ? "mesh-inherited" : "vault-override";
  if (winner === undefined || winner.state !== "active" || winner.source !== expectedSource) {
    throw new Error("Vault creation destination-policy apply differs from its immutable plan.");
  }
  if (plan.destination.kind === "local") {
    if (
      winner.destinationKind !== "local" ||
      winner.targetOwner !== null ||
      winner.targetKind !== null
    ) {
      throw new Error("Vault creation local destination-policy apply differs from its plan.");
    }
  } else {
    const target = parseCanonicalDestinationTarget(plan.destination.target);
    if (
      target === null ||
      winner.destinationKind !== "github" ||
      winner.targetOwner !== target.targetOwner ||
      winner.targetKind !== target.targetKind ||
      winner.repositoryName !== plan.subject.repositoryName
    ) {
      throw new Error("Vault creation GitHub destination-policy apply differs from its plan.");
    }
  }
}

function assertPlannedCheckpointPaths(
  plan: CreationPlanV1,
  repositoryRoot: string,
  observedPaths: readonly string[],
): void {
  const intended = plan.intended_effects.checkpoints.find(
    (checkpoint) => checkpoint.repository_root === repositoryRoot,
  );
  if (
    intended === undefined ||
    !isDeepStrictEqual([...intended.exact_paths].sort(), [...observedPaths].sort())
  ) {
    throw new Error("Vault creation checkpoint paths differ from its immutable plan.");
  }
}

function finalizePlannedPodCheckpoint(
  plan: CreationPlanV1,
  podRoot: string | null,
  freshBoundary: FreshPodMutationBoundary | null,
  writerId: string | null,
  runGit: Parameters<typeof finalizeInitialCheckpoint>[1] | undefined,
): LocalCheckpointResult | null {
  if (podRoot === null) return null;
  const intended = plan.intended_effects.checkpoints.find(
    (checkpoint) => checkpoint.repository_root === podRoot,
  );
  if (intended === undefined) {
    throw new Error("First-vault creation plan is missing its exact pod checkpoint.");
  }
  const paths =
    plan.intended_effects.identity.kind === "create"
      ? freshPodMutationPaths(plan, podRoot, intended.exact_paths, freshBoundary, writerId)
      : [...intended.exact_paths];
  const checkpoint = finalizeInitialCheckpoint(
    createInitialCheckpointContext(podRoot, paths),
    runGit,
  );
  if (checkpoint.status !== "committed") {
    throw new Error("First-vault creation could not finalize its exact pod checkpoint.");
  }
  return checkpoint;
}

interface FreshPodMutationBoundary {
  podRoot: string;
  preexistingPaths: ReadonlySet<string>;
}

function captureFreshPodMutationBoundary(plan: CreationPlanV1): FreshPodMutationBoundary | null {
  if (plan.intended_effects.identity.kind !== "create") return null;
  const podRoot = getFederationRepoDir(plan.intended_effects.identity.handle);
  const checkpoint = plan.intended_effects.checkpoints.find(
    (entry) => entry.repository_root === podRoot,
  );
  if (checkpoint === undefined) {
    throw new Error("First-vault creation plan is missing its exact pod checkpoint.");
  }
  if (!existsSync(podRoot)) return { podRoot, preexistingPaths: new Set() };
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: podRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return {
    podRoot,
    preexistingPaths: new Set(
      output
        .split("\0")
        .filter((path) => path.length > 0)
        .map((path) => path.replaceAll("\\", "/")),
    ),
  };
}

function freshPodMutationPaths(
  plan: CreationPlanV1,
  podRoot: string,
  requiredPaths: readonly string[],
  boundary: FreshPodMutationBoundary | null,
  writerId: string | null,
): string[] {
  if (boundary === null || boundary.podRoot !== podRoot || writerId === null) {
    throw new Error("Fresh pod checkpoint is missing its operation-local mutation boundary.");
  }
  const ledgerKinds = [
    ...(plan.intended_effects.vaults.length > 0 ? ["destination-policy", "vaults"] : []),
    ...(plan.intended_effects.topology_bindings.length > 0 ? ["meshes"] : []),
  ];
  const expectedLedgerPaths = ledgerKinds.map((kind) => `ledger/${kind}/${writerId}.yon`);
  const allowedPaths = new Set([...requiredPaths, ".gitignore", ...expectedLedgerPaths]);
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: podRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.length < 4 || entry.slice(0, 2) !== "??" || entry[2] !== " ") {
      throw new Error("Fresh pod checkpoint observed staged, renamed, or modified state.");
    }
    const path = entry.slice(3).replaceAll("\\", "/");
    if (!allowedPaths.has(path) || boundary.preexistingPaths.has(path)) {
      throw new Error(`Fresh pod checkpoint observed an unjournaled path: ${path}`);
    }
    paths.push(path);
  }
  if (
    !requiredPaths.every((path) => paths.includes(path)) ||
    !expectedLedgerPaths.every((path) => paths.includes(path)) ||
    !paths.includes("pod.yon")
  ) {
    const missing = [...requiredPaths, ...expectedLedgerPaths, "pod.yon"].filter(
      (path, index, all) => all.indexOf(path) === index && !paths.includes(path),
    );
    throw new Error(
      `Fresh pod checkpoint is missing required Lyt-authored path(s): ${missing.join(", ")}.`,
    );
  }
  return [...new Set(paths)].sort();
}

interface ResolvedHomeMeshAssignment {
  meshRid: Uint8Array;
  meshRidHex: string;
  meshName: string;
  mainVaultPath: string;
  mainVaultCheckpointContext?: ReturnType<typeof createInitialCheckpointContext>;
  normalizedName: string;
  autoNormalizedFrom: string | null;
  meshAutoCreated: boolean;
  statusVoiceEmitted: string;
  pushTarget: string | null;
  pushKind: string | null;
  ownCreated: boolean;
  /** Exact child mutation journal when this invocation created the mesh. */
  meshMutations?: CreationMutationEvidence;
  scaffoldHomeMesh: {
    meshRid: Uint8Array;
    meshName: string;
  };
}

async function maybeAssignHomeMesh(
  opts: InitFlowOptions,
  db: Client,
): Promise<ResolvedHomeMeshAssignment | null> {
  const meshSelfHeal = opts.selfHeal?.mesh;
  if (meshSelfHeal?.enabled !== true) return null;

  const autoMeshName = meshSelfHeal.meshName ?? "personal";
  const slashIdx = opts.name.indexOf("/");

  let resolvedMeshName: string;
  let resolvedVaultLeaf: string;
  let autoNormalizedFrom: string | null;

  if (slashIdx === -1) {
    // Bare name → normalize to `<autoMeshName>/<bare>`.
    resolvedMeshName = autoMeshName;
    resolvedVaultLeaf = opts.name;
    autoNormalizedFrom = opts.name;
  } else {
    // Already-namespaced `<mesh>/<leaf>`. Don't normalize; the mesh slot
    // is the user's chosen name.
    resolvedMeshName = opts.name.slice(0, slashIdx);
    resolvedVaultLeaf = opts.name.slice(slashIdx + 1);
    autoNormalizedFrom = null;
  }
  if (resolvedMeshName.length === 0 || resolvedVaultLeaf.length === 0) {
    return null;
  }

  const normalizedName = `${resolvedMeshName}/${resolvedVaultLeaf}`;

  // 0.9.4 (3c) — CREATE-IF-MISSING, uniform across every mesh name.
  // The old `personal`-only gate (and the HomeMeshNotFoundError refusal for any
  // other namespace) is dropped: `vault init company/x` auto-creates `company`
  // if absent, exactly as a bare init auto-creates `personal`. Push semantics
  // are explicit — a `--push-to <handle>` makes the new mesh a SHARING mesh;
  // without it the mesh is local-only (the prior personal default).
  let meshRow = await getMeshByName(db, resolvedMeshName);
  let meshAutoCreated = false;
  let mainVaultCheckpointContext: ReturnType<typeof createInitialCheckpointContext> | undefined;
  let meshMutations: CreationMutationEvidence | undefined;

  if (meshRow === null) {
    const pushTo = meshSelfHeal.pushTo;
    const meshCreation = meshSelfHeal.creation;
    if (meshCreation === undefined) {
      throw new Error("Auto-created home mesh requires its own exact creation request and plan.");
    }
    const meshResult = await meshInitFlow({
      name: resolvedMeshName,
      // Creation never owns an online effect, regardless of legacy flags.
      noPush: true,
      ...(pushTo !== undefined && pushTo.length > 0 ? { pushTo } : {}),
      // Open-once seam (A.4): thread the open registry so mesh-init reuses it
      // instead of opening a 2nd connection (nested-open SQLITE_BUSY risk).
      db,
      ...(meshSelfHeal.ghClient !== undefined ? { ghClient: meshSelfHeal.ghClient } : {}),
      creation: meshCreation,
      noGit: opts.gitInit === false,
      commitInitial: opts.commitInitial,
      checkpointMode: "deferred",
    });
    meshRow = await getMeshByName(db, resolvedMeshName);
    if (meshRow === null) {
      // meshInitFlow guarantees a row; this branch is defensive.
      throw new Error(
        `lyt vault init: auto-created mesh '${resolvedMeshName}' did not land in the registry (rid: ${meshResult.meshRidHex}).`,
      );
    }
    meshAutoCreated = true;
    mainVaultCheckpointContext = meshResult.checkpointContext;
    meshMutations = meshResult.mutations;
    // Preserve the exact mesh-init scaffold journal; the parent adds its
    // `@MESH_HOME` mutation and commits this repository once below.
  }

  // Resolve the home mesh's main vault path so we can append @MESH_HOME
  // post-scaffold.
  let mainVaultPath: string | null = null;
  if (meshRow.mainVaultRid !== null) {
    const mainVault = await getVaultByExactName(db, `${meshRow.name}/main`);
    if (mainVault !== null) mainVaultPath = mainVault.path;
  }
  if (mainVaultPath === null) {
    // Can't append @MESH_HOME without the main vault path. Surface as a
    // structured error rather than silently dropping the binding.
    throw new HomeMeshNotFoundError(resolvedMeshName);
  }

  const statusVoiceEmitted = meshAutoCreated
    ? `Auto-created mesh '${resolvedMeshName}' (local; --no-push). Vault '${normalizedName}' assigned to it.`
    : `Vault '${normalizedName}' assigned to mesh '${resolvedMeshName}'.`;

  return {
    meshRid: meshRow.rid,
    meshRidHex: meshRow.ridHex,
    meshName: meshRow.name,
    mainVaultPath,
    ...(mainVaultCheckpointContext === undefined ? {} : { mainVaultCheckpointContext }),
    normalizedName,
    autoNormalizedFrom,
    meshAutoCreated,
    statusVoiceEmitted,
    pushTarget: meshRow.pushTarget,
    pushKind: meshRow.pushKind,
    ownCreated: meshRow.ownCreated,
    ...(meshMutations === undefined ? {} : { meshMutations }),
    scaffoldHomeMesh: {
      meshRid: meshRow.rid,
      meshName: meshRow.name,
    },
  };
}

async function applyVaultCreationPolicy(
  db: Client,
  podRid: string,
  vaultRid: Uint8Array,
  plan: CreationPlanV1,
  request: DestinationRequest,
): Promise<void> {
  // Provenance follows the Handler's request, never the incidental fact that
  // this operation also had to create its home mesh. An explicit target/local
  // request remains a vault override; only `inherit` snapshots mesh policy.
  const source = request.kind === "inherit" ? "mesh-inherited" : "vault-override";
  if (plan.destination.kind === "local") {
    await setCanonicalDestinationPolicy(db, {
      podRid,
      subjectKind: "vault",
      subjectRid: vaultRid,
      destinationKind: "local",
      targetOwner: null,
      targetKind: null,
      repositoryName: null,
      source,
    });
    return;
  }
  const target = parseCanonicalDestinationTarget(plan.destination.target);
  if (target === null)
    throw new Error("Vault creation plan contains an invalid canonical GitHub target.");
  await setCanonicalDestinationPolicy(db, {
    podRid,
    subjectKind: "vault",
    subjectRid: vaultRid,
    destinationKind: "github",
    targetOwner: target.targetOwner,
    targetKind: target.targetKind,
    repositoryName: plan.subject.repositoryName,
    source,
  });
}

// Self-heal action: takes the predicate's verdict, runs the federation
// init, returns the result for the command layer to surface.
//
// By contract non-fatal: vault creation always succeeds first. The outer
// try/catch covers every step — handle resolution, SQL, gh round-trip —
// and converts failures to a console.error + `null` return.
async function maybeSelfHealFederation(
  opts: InitFlowOptions,
  db: Client,
): Promise<InitFlowResult["federationSelfHealed"]> {
  try {
    const decision = await shouldSelfHealFederation(opts, {
      readFederationStateForHandle: async (handle) => readFederationState(db, handle),
      localFederationDirExists: (handle) => existsSync(getFederationRepoDir(handle)),
    });
    if (decision === null) return null;

    const fed = opts.selfHeal?.federation ?? {};
    const voice = VOICE.forgingFromDetectedState;
    const r = await federationInitFlow({
      handle: decision.handle,
      visibility: "private",
      pushToRemote: false,
      // `vault init` is local-only. The explicit scoped `lyt sync --vault`
      // is the first operation authorized to create a remote or publish data.
      createRemoteIfMissing: false,
      localOnly: true,
      // Thread the open registry through (fold #4).
      db,
      ...(fed.ghClient !== undefined ? { ghClient: fed.ghClient } : {}),
    });
    if (r.branch === "cached") {
      throw new Error(
        "federation self-heal received branch=cached despite no-state guard — invariant violated; revisit shouldSelfHealFederation.",
      );
    }
    return {
      handle: r.handle,
      fedRidHex: r.fedRidHex,
      branch: r.branch,
      visibility: r.visibility,
      statusVoiceEmitted: voice,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordInitFailure({
      site: "federation-init",
      step: "init:maybeSelfHealFederation",
      summary: `federation self-heal failed: ${msg}`,
      context: { vault: opts.name },
    });
    // eslint-disable-next-line no-console
    console.error(`federation self-heal skipped — ${msg}`);
    return null;
  }
}
