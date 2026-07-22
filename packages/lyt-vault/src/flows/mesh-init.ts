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

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { initVaultDbs } from "../registry/vault-db.js";
import { getMeshByName, updateMeshMainVault } from "../registry/meshes-repo.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { setVaultHomeMesh } from "../registry/repo.js";
import { initVault } from "../scaffold/init.js";
import { validateMeshName } from "../util/identity.js";
import { getFederationRepoDir, vaultRepoName } from "../util/federation-paths.js";
import { hexToUuid7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import { renderMeshYon } from "../yon/mesh-write.js";
import type { MeshPushKind } from "../yon/mesh-write.js";
import { registerVaultFromYon } from "./register.js";
import { indexScaffoldFtsOnCreate } from "./upsert-fts-cache.js";
import {
  resolveCreationPlanV1,
  type CreationPlanV1,
  type DestinationRequest,
} from "./creation-plan.js";
import {
  assertMeshInitWriteTarget,
  assertMeshYonWriteTarget,
  inspectMeshInitPreflight,
} from "./mesh-init-preflight.js";
import type { VaultCreationBinding } from "./vault-init-preflight.js";
import {
  createInitialCheckpointContext,
  finalizeInitialCheckpoint,
  recordInitialCheckpointPaths,
  type CheckpointGitRunner,
  type LocalCheckpointResult,
} from "../scaffold/local-checkpoint.js";
import { setCanonicalDestinationPolicy } from "./federation/destination-policy-service.js";
import { destinationPolicyKey } from "../registry/destination-policy.js";
import { getFederationRoot } from "../util/federation-paths.js";
import {
  foldDestinationPolicyWinners,
  readAllDestinationPolicyRecords,
} from "./federation/destination-policy-ledger.js";
import { regeneratePodManifestNonFatal } from "./federation/regenerate.js";
import { recordInitFailure } from "../util/failure-log.js";
import { federationInitFlow } from "./federation/init.js";
import { LEDGER_REGISTRY } from "../registry/ledger-registry.js";
import {
  CreationMutationJournal,
  asCreationMutationFailure,
  type CreationMutationEvidence,
} from "../op/creation-mutation-journal.js";

// v1.B.1 — `lyt mesh init <name>` flow.
//
// Source: Brief steps 1-2 + lyt-federation-design.md §3 (mesh.yon
// schema verbatim, lines 121-151) + lyt-master-plan.md §5 v1.B.1 + Brief
// @CONTINUATION §5 (mesh.yon initial-state shape).
//
// Order of operations (Brief step 2):
// (a) validate <name> as mesh-name slot (no `/`, slug-safe — validateMeshName)
// (b) resolve --parent <existing-mesh> → mesh's main_vault_rid as parentVaultRid
// for the new main vault (BLOB FK on vaults.parent_vault per v1.A.1b)
// (c) generate meshRid = newUuidv7Bytes()
// (d) scaffold the main vault via initVault({ name: '<name>/main', parentVaultRid, ... })
// (e) initialise per-vault libSQL + register vault row in `vaults`
// (f) write .lyt/mesh.yon (initial state: @MESH + @MESH_HOME for the main)
// (g) INSERT into meshes (with main_vault_rid pointing at the just-registered vault)
// (h) UPDATE vaults.home_mesh_rid for the main vault → meshRid
// (i) INSERT into mesh_vaults role='home' (composite PK + partial unique idx)
// (j) optionally push the main vault repo to the resolved GH target
//
// v1.B.1 keeps the cross-mesh edge unwritten — parent linkage is captured
// purely via `vaults.parent_vault` BLOB FK per v1.A.1b. @MESH_EDGE writer
// ships v1.C.1.

export interface MeshInitOptions {
  name: string;
  parent?: string | undefined;
  /** Exact request/plan/attempt binding consumed by the mutation seam. */
  creation: VaultCreationBinding;
  noGit?: boolean | undefined;
  commitInitial?: boolean | undefined;
  pushTo?: string | undefined;
  pushKind?: MeshPushKind | undefined;
  noPush?: boolean | undefined;
  /** Deprecated caller-closure compatibility only; mesh creation never uses it. */
  ghClient?: unknown;
  checkpointGitRunner?: CheckpointGitRunner | undefined;
  /** Parent creation may defer the mesh-main checkpoint until its final binding write. */
  checkpointMode?: "automatic" | "deferred" | undefined;
  // Test seam — override the registry path (vitest fixtures point at a
  // tempdir-scoped LYT_HOME via env, but flow signatures kept symmetric
  // with flows/init.ts for clarity).
  registryPath?: string | undefined;
  // Open-once registry seam (Brief A A.4 / a review finding): when a parent flow already
  // holds the registry open (initVaultFlow, adoptAndPrimeFlow, initBootstrap),
  // it threads its client here so mesh-init does NOT open a 2nd connection —
  // the nested-open that risked Windows SQLITE_BUSY. Caller owns close(); when
  // supplied, `registryPath` is ignored (the caller's client wins).
  db?: Client | undefined;
}

export interface MeshInitResult {
  meshRid: Uint8Array;
  meshRidHex: string;
  meshName: string;
  pushTarget: string | null;
  pushKind: MeshPushKind | null;
  pushed: false;
  creationPlan: CreationPlanV1;
  checkpoint: LocalCheckpointResult;
  checkpointContext: ReturnType<typeof createInitialCheckpointContext>;
  mutations: CreationMutationEvidence;
  mainVault: {
    rid: Uint8Array;
    ridHex: string;
    name: string;
    path: string;
  };
  parentVault: {
    rid: Uint8Array;
    ridHex: string;
    name: string;
  } | null;
}

export async function meshInitFlow(opts: MeshInitOptions): Promise<MeshInitResult> {
  validateMeshName(opts.name);
  if (opts.creation === undefined) {
    throw new Error("Mesh creation requires one exact, attempt-bound CreationBinding.");
  }
  const creationBinding = opts.creation;
  const { destinationRequest, creationPlan, attemptId } = creationBinding;
  if (destinationRequest.kind === "inherit") {
    throw new Error("Top-level mesh creation cannot inherit a destination policy.");
  }
  const expectedRepositoryName = vaultRepoName(`${opts.name}/main`);
  if (!validCreationPlan(creationPlan, destinationRequest, attemptId, expectedRepositoryName)) {
    throw new Error("Mesh creation plan does not match this local, not-published mesh creation.");
  }
  const podCheckpointBoundary = capturePodCheckpointBoundary(creationPlan, opts.noGit === true);
  const preflight = await inspectMeshInitPreflight({
    name: opts.name,
    parent: opts.parent,
    registryPath: opts.registryPath,
  });
  if (preflight.meshExists) throw new Error(`Mesh '${opts.name}' is already registered.`);
  if (opts.parent !== undefined && opts.parent.length > 0 && preflight.parentExists === false) {
    throw new Error(`--parent <mesh>: no mesh registered with name '${opts.parent}'.`);
  }

  // This is the final capability-level read-only revalidation immediately before
  // opening the migration-capable apply registry.
  const applyPreflight = await inspectMeshInitPreflight({
    name: opts.name,
    parent: opts.parent,
    registryPath: opts.registryPath,
  });
  assertMeshInitWriteTarget(applyPreflight, creationPlan);
  const mutationJournal = new CreationMutationJournal(creationBinding.attemptId);

  // Open-once seam (A.4 / a review finding): reuse the caller's registry when threaded;
  // otherwise open our own and close it in finally. `ownDb` flags ownership.
  const ownDb = opts.db === undefined;
  let db: Client | null = opts.db ?? null;
  let plannedPodRoot: string | null =
    applyPreflight.podIdentity.state === "present"
      ? applyPreflight.podIdentity.repositoryRoot
      : null;
  try {
    db ??= await openRegistry(
      opts.registryPath !== undefined ? { path: opts.registryPath } : undefined,
    );
    // A first mesh is also a first pod.  Its identity is not an incidental
    // side effect: consume the plan's exact create effect before mesh writes.
    if (applyPreflight.podIdentity.state === "missing") {
      const identity = creationPlan.intended_effects.identity;
      if (identity.kind !== "create") {
        throw new Error("Missing pod identity is not owned by this mesh creation plan.");
      }
      const pod = await federationInitFlow({
        handle: identity.handle,
        localOnly: true,
        pushToRemote: false,
        createRemoteIfMissing: false,
        checkpointMode: "deferred",
        plannedFedRidBytes: hexToUuid7Bytes(identity.rid),
        db,
      });
      if (pod.fedRidHex !== identity.rid) {
        throw new Error("Mesh creation pod apply observed an identity that differs from its plan.");
      }
      plannedPodRoot = pod.localPath;
    }
    const podRid =
      applyPreflight.podIdentity.state === "present"
        ? applyPreflight.podIdentity.rid
        : creationPlan.intended_effects.identity.rid;

    // (a) duplicate-name guard (meshes.name is UNIQUE — surface a clear error
    // instead of the raw SQLite UNIQUE violation).
    const existingMesh = await getMeshByName(db, opts.name);
    if (existingMesh !== null) {
      throw new Error(
        `Mesh '${opts.name}' is already registered (rid: ${existingMesh.ridHex}). ` +
          `Use a different mesh name or 'lyt mesh list' to inspect existing meshes.`,
      );
    }

    // (b) resolve --parent: the parent mesh's main vault becomes the
    // parent_vault FK for the new main vault.
    let parentLink: MeshInitResult["parentVault"] = null;
    let parentVaultRid: Uint8Array | undefined;
    if (opts.parent !== undefined && opts.parent.length > 0) {
      const parentMesh = await getMeshByName(db, opts.parent);
      if (parentMesh === null) {
        throw new Error(
          `--parent <mesh>: no mesh registered with name '${opts.parent}'. ` +
            `Use 'lyt mesh list' to see registered meshes.`,
        );
      }
      if (parentMesh.mainVaultRid === null) {
        throw new Error(
          `--parent <mesh>: mesh '${opts.parent}' has no main vault set (rid: ${parentMesh.ridHex}). ` +
            `This is a structural invariant violation — the parent mesh is malformed.`,
        );
      }
      parentVaultRid = parentMesh.mainVaultRid;
      parentLink = {
        rid: parentMesh.mainVaultRid,
        ridHex: parentMesh.mainVaultRidHex ?? uuid7BytesToHex(parentMesh.mainVaultRid),
        name: `${parentMesh.name}/main`,
      };
    }

    // (c) Apply only identities allocated by the immutable plan. Retrying the
    // same logical creation must observe these exact rows, never mint peers.
    const meshRid = hexToUuid7Bytes(creationPlan.intended_effects.mesh.rid);
    const meshRidHex = uuid7BytesToHex(meshRid);

    const pushPlan = destinationProjection(creationPlan);

    // v1.B.3 — INSERT the meshes row FIRST (with main_vault_rid NULL) so
    // that when registerVaultFromYon runs and reads the @VAULT_HOME_MESH
    // record from the scaffolded vault.yon, the FK on vaults.home_mesh_rid
    // resolves cleanly. (Pre-v1.B.3 ordering put mesh INSERT after vault
    // register, which worked because vault.yon carried NO @VAULT_HOME_MESH;
    // v1.B.3's @VAULT_HOME_MESH-at-scaffold means register-from-yon now
    // needs the meshes row in place.)
    const createdAt = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO meshes (rid, name, push_target, push_kind, main_vault_rid, created_at, own_created,
                                destination_kind, destination_source)
            VALUES (?, ?, NULL, NULL, NULL, ?, 1, NULL, NULL)`,
      args: [meshRid, opts.name, createdAt],
    });
    mutationJournal.record({ registryRows: 1 });

    // (d) scaffold the main vault via the existing initVault helper. The
    // vault gets name '<mesh>/main'; parent_vault FK threaded through bytes.
    // git is initialised; the initial commit is HELD so we can fold mesh.yon
    // into it (a single coherent "vault scaffolded" commit, not two).
    //
    // v1.B.3 — thread the home-mesh assignment through the scaffold so the
    // main vault's vault.yon carries a @VAULT_HOME_MESH record from first
    // write. Keeps vault.yon SoT in sync with mesh.yon SoT — a fresh clone
    // + rebuild-registry round-trip re-derives the binding correctly from
    // either file.
    const mainVaultName = `${opts.name}/main`;
    const scaffoldResult = initVault({
      name: mainVaultName,
      ...(parentVaultRid !== undefined ? { parentVaultRid } : {}),
      gitInit: opts.noGit !== true,
      checkpointMode: "deferred",
      plannedVaultRid: hexToUuid7Bytes(creationPlan.intended_effects.primary_vault_rid),
      plannedMemscopeRid: hexToUuid7Bytes(
        creationPlan.intended_effects.vaults.find(
          (vault) => vault.rid === creationPlan.intended_effects.primary_vault_rid,
        )!.memscope_rid,
      ),
      homeMesh: {
        meshRid,
        meshName: opts.name,
        assignedAt: createdAt,
      },
    });
    mutationJournal.record({
      filesystemWrites: scaffoldResult.checkpointContext.paths.length,
      checkpointPaths: scaffoldResult.checkpointContext.paths,
    });

    // (e) per-vault libSQL + registry row. register-from-yon reads the
    // @VAULT_HOME_MESH from vault.yon and sets vaults.home_mesh_rid → meshRid
    // (meshes row was inserted above, so the FK resolves).
    await initVaultDbs(scaffoldResult.vaultPath);
    mutationJournal.record({ localDatabases: 1 + LEDGER_REGISTRY.length });
    // B-4 / Decision-B (B2): index the auto-created `<mesh>/main` vault's scaffold
    // figments into FTS at create so doctor's index-fts-smoke does not false-warn
    // (exit 2) on it. Shared seam + rationale: indexScaffoldFtsOnCreate
    // (upsert-fts-cache.ts) — keep in sync with the flows/init.ts call site.
    await indexScaffoldFtsOnCreate(scaffoldResult.vaultPath);
    const registered = await registerVaultFromYon(db, {
      vaultPath: scaffoldResult.vaultPath,
    });
    if (
      registered.ridHex !== creationPlan.intended_effects.primary_vault_rid ||
      meshRidHex !== creationPlan.intended_effects.mesh.rid
    ) {
      throw new Error(
        "Mesh creation apply observed identities that differ from its immutable plan.",
      );
    }
    mutationJournal.record({ registryRows: 1 });

    const destinationKind = pushPlan.target === null ? "local" : "github";
    const targetKind = pushPlan.target === null ? null : pushPlan.kind === "org" ? "org" : "user";
    const meshSource =
      creationPlan.destination.policy_source === "authenticated-default"
        ? "authenticated-default"
        : creationPlan.destination.policy_source === "auto-fallback-local"
          ? "auto-fallback-local"
          : "explicit";
    await setCanonicalDestinationPolicy(db, {
      podRid,
      subjectKind: "mesh",
      subjectRid: meshRid,
      destinationKind,
      targetOwner: pushPlan.target,
      targetKind,
      repositoryName: null,
      source: meshSource,
    });
    mutationJournal.record({ destinationPolicyRecords: 1 });
    await setCanonicalDestinationPolicy(db, {
      podRid,
      subjectKind: "vault",
      subjectRid: registered.rid,
      destinationKind,
      targetOwner: pushPlan.target,
      targetKind,
      repositoryName: destinationKind === "github" ? expectedRepositoryName : null,
      source: "mesh-inherited",
    });
    mutationJournal.record({ destinationPolicyRecords: 1 });

    // (f) write the initial-state mesh.yon (single @MESH + single @MESH_HOME).
    const meshYon = renderMeshYon({
      mesh: {
        rid: meshRid,
        name: opts.name,
        ...(pushPlan.target !== null ? { pushTarget: pushPlan.target } : {}),
        ...(pushPlan.kind !== null ? { pushKind: pushPlan.kind } : {}),
        mainVaultRid: registered.rid,
        createdAt,
      },
      homeVaults: [
        {
          meshRid,
          vaultRid: registered.rid,
          vaultName: mainVaultName,
        },
      ],
    });
    const meshYonPath = join(scaffoldResult.vaultPath, ".lyt", "mesh.yon");
    mkdirSync(join(scaffoldResult.vaultPath, ".lyt"), { recursive: true });
    assertMeshYonWriteTarget(applyPreflight);
    writeFileSync(meshYonPath, meshYon, "utf8");
    recordInitialCheckpointPaths(scaffoldResult.checkpointContext, [".lyt/mesh.yon"]);
    mutationJournal.record({ filesystemWrites: 1, checkpointPaths: [".lyt/mesh.yon"] });
    assertPlannedCheckpointPaths(
      creationPlan,
      scaffoldResult.vaultPath,
      scaffoldResult.checkpointContext.paths,
    );

    // (g) UPDATE meshes.main_vault_rid → registered vault rid (was NULL
    // at insert time per v1.B.3 reordering).
    // (h) belt-and-braces UPDATE vaults.home_mesh_rid → meshRid (register-
    // from-yon already did this via @VAULT_HOME_MESH; idempotent).
    // (i) INSERT mesh_vaults role='home'.
    await updateMeshMainVault(db, meshRid, registered.rid);
    mutationJournal.record({ topologyBindings: 1 });
    await setVaultHomeMesh(db, registered.rid, meshRid);
    mutationJournal.record({ topologyBindings: 1 });
    await addVaultToMesh(db, meshRid, registered.rid, "home");
    mutationJournal.record({ registryRows: 1, topologyBindings: 1 });
    await assertPlannedRegistryAndTopology(
      db,
      creationPlan,
      destinationRequest,
      podRid,
      meshRid,
      registered.rid,
    );

    // `pod.yon` is a derived view consumed by the pod. Regenerate it only
    // after every registry/topology mutation has landed and before the final
    // exact-path checkpoint/receipt is computed. The lifecycle helper is
    // deliberately non-fatal and performs no remote action.
    await regeneratePodManifestNonFatal(db);
    mutationJournal.record({ filesystemWrites: 1 });
    if (plannedPodRoot !== null && opts.checkpointMode !== "deferred" && opts.noGit !== true) {
      const podCheckpoint = finalizePlannedPodCheckpoint(
        creationPlan,
        plannedPodRoot,
        podCheckpointBoundary,
        opts.checkpointGitRunner,
      );
      mutationJournal.record({
        checkpointPaths: podCheckpoint.paths,
        checkpointCommits: podCheckpoint.status === "committed" ? 1 : 0,
        checkpointRepositories: [
          {
            repositoryRoot: plannedPodRoot,
            paths: podCheckpoint.paths,
            ...(podCheckpoint.commitSha === undefined
              ? {}
              : { commitSha: podCheckpoint.commitSha }),
            ...(podCheckpoint.beforeCommitSha === undefined
              ? {}
              : { beforeCommitSha: podCheckpoint.beforeCommitSha }),
            clean: podCheckpoint.status === "committed" || podCheckpoint.status === "skipped",
          },
        ],
      });
    }

    const checkpoint =
      opts.noGit === true || opts.checkpointMode === "deferred"
        ? scaffoldResult.checkpoint
        : finalizeInitialCheckpoint(scaffoldResult.checkpointContext, opts.checkpointGitRunner);
    if (checkpoint.status === "committed") {
      mutationJournal.record({ checkpointCommits: 1 });
    }
    if (opts.noGit !== true) {
      mutationJournal.record({
        checkpointRepositories: [
          {
            repositoryRoot: scaffoldResult.vaultPath,
            paths: checkpoint.paths,
            ...(checkpoint.commitSha === undefined ? {} : { commitSha: checkpoint.commitSha }),
            ...(checkpoint.beforeCommitSha === undefined
              ? {}
              : { beforeCommitSha: checkpoint.beforeCommitSha }),
            clean: checkpoint.status === "committed" || checkpoint.status === "skipped",
          },
        ],
      });
    }

    return {
      meshRid,
      meshRidHex,
      meshName: opts.name,
      pushTarget: pushPlan.target,
      pushKind: pushPlan.kind,
      pushed: false,
      creationPlan,
      checkpoint,
      checkpointContext: scaffoldResult.checkpointContext,
      mutations: mutationJournal.snapshot(),
      mainVault: {
        rid: registered.rid,
        ridHex: registered.ridHex,
        name: registered.name,
        path: registered.path,
      },
      parentVault: parentLink,
    };
  } catch (error) {
    const failureLogged = recordInitFailure({
      site: "first-vault-create",
      step: "flow:meshInitFlow",
      summary: "Mesh creation stopped after its local apply phase began.",
      context: { mesh: opts.name },
    });
    if (failureLogged) mutationJournal.record({ failureLogRecords: 1, filesystemWrites: 1 });
    throw asCreationMutationFailure(error, mutationJournal, {
      code: "mesh-init-apply-failed",
      summary: "Mesh creation stopped after its local apply phase began.",
      nextAction: {
        code: "inspect-local-creation",
        summary: "Run lyt repair --dry-run, inspect the local mesh state, then retry creation.",
      },
    });
  } finally {
    if (ownDb && db !== null) await closeRegistry(db);
  }
}

interface ResolvedPush {
  target: string | null;
  kind: MeshPushKind | null;
}

function destinationProjection(plan: CreationPlanV1): ResolvedPush {
  if (plan.destination.kind === "local") return { target: null, kind: null };
  const [, kind, target] = /^github:(user|org)\/([^/]+)$/.exec(plan.destination.target)!;
  return { target: target!, kind: kind === "org" ? "org" : "handle" };
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
    throw new Error("Mesh creation checkpoint paths differ from its immutable plan.");
  }
}

function finalizePlannedPodCheckpoint(
  plan: CreationPlanV1,
  podRoot: string,
  boundary: PodCheckpointBoundary,
  runGit: CheckpointGitRunner | undefined,
): LocalCheckpointResult {
  const intended = plan.intended_effects.checkpoints.find(
    (checkpoint) =>
      checkpoint.repository_root === podRoot && checkpoint.exact_paths.includes("pod.yon"),
  );
  if (intended === undefined) {
    throw new Error("Mesh creation plan is missing its exact pod checkpoint.");
  }
  const binding = bindOperationPodCheckpoint(intended.exact_paths, boundary);
  const checkpoint = finalizeInitialCheckpoint(
    createInitialCheckpointContext(podRoot, binding.paths, binding.contentDigests),
    runGit,
  );
  if (checkpoint.status !== "committed") {
    throw new Error("Mesh creation could not finalize its exact pod checkpoint.");
  }
  return checkpoint;
}

interface PodCheckpointBoundary {
  podRoot: string;
  preexistingPaths: ReadonlySet<string>;
  contentDigests: ReadonlyMap<string, string>;
}

function capturePodCheckpointBoundary(plan: CreationPlanV1, noGit: boolean): PodCheckpointBoundary {
  const identity = plan.intended_effects.identity;
  const podRoot =
    identity.kind === "create"
      ? getFederationRepoDir(identity.handle)
      : plan.intended_effects.checkpoints.find((checkpoint) =>
          checkpoint.exact_paths.includes("pod.yon"),
        )?.repository_root;
  if (podRoot === undefined) throw new Error("Mesh creation plan is missing its pod repository.");
  const intended = plan.intended_effects.checkpoints.find(
    (checkpoint) => checkpoint.repository_root === podRoot,
  );
  if (intended === undefined) throw new Error("Mesh creation plan is missing its pod effects.");
  const contentDigests = new Map<string, string>();
  for (const path of intended.exact_paths) {
    if (existsSync(join(podRoot, path))) {
      contentDigests.set(path, fileDigest(join(podRoot, path)));
    }
  }
  if (!existsSync(podRoot)) {
    return { podRoot, preexistingPaths: new Set(), contentDigests };
  }
  if (noGit) {
    return {
      podRoot,
      preexistingPaths: new Set(contentDigests.keys()),
      contentDigests,
    };
  }
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: podRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: podRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (dirty.length !== 0) {
    if (identity.kind !== "create") {
      throw new Error("Mesh creation refuses a dirty pod repository before mutation.");
    }
    const allowed = new Set(intended.exact_paths);
    for (const entry of dirty.split("\0").filter((value) => value.length > 0)) {
      const status = entry.slice(0, 2);
      const path = entry.slice(3).replaceAll("\\", "/");
      if (entry.length < 4 || status !== "??" || !allowed.has(path)) {
        throw new Error("Mesh creation refuses unplanned dirt in a fresh pod repository.");
      }
    }
  }
  const freshDeferredPod = identity.kind === "create";
  return {
    podRoot,
    // A fresh federation forge owns its exact plan-bound untracked files. They
    // are not pre-existing collisions and remain part of the later checkpoint.
    preexistingPaths: freshDeferredPod
      ? new Set()
      : new Set(
          output
            .split("\0")
            .filter((path) => path.length > 0)
            .map((path) => path.replaceAll("\\", "/")),
        ),
    contentDigests: freshDeferredPod ? new Map() : contentDigests,
  };
}

function bindOperationPodCheckpoint(
  requiredPaths: readonly string[],
  boundary: PodCheckpointBoundary,
): { paths: string[]; contentDigests: ReadonlyMap<string, string> } {
  const allowed = new Set(requiredPaths);
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: boundary.podRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const paths: string[] = [];
  for (const entry of output.split("\0").filter((value) => value.length > 0)) {
    const status = entry.slice(0, 2);
    if (entry.length < 4 || (status !== "??" && status !== " M")) {
      throw new Error("Mesh creation pod checkpoint observed staged, renamed, or deleted state.");
    }
    const path = entry.slice(3).replaceAll("\\", "/");
    if (!allowed.has(path) || (boundary.preexistingPaths.has(path) && status === "??")) {
      throw new Error(`Mesh creation pod checkpoint observed an unjournaled path: ${path}`);
    }
    paths.push(path);
  }
  if (!requiredPaths.every((path) => paths.includes(path))) {
    throw new Error("Mesh creation pod checkpoint is missing a required Lyt-authored path.");
  }
  const contentDigests = new Map<string, string>();
  for (const path of requiredPaths) {
    const digest = fileDigest(join(boundary.podRoot, path));
    const before = boundary.contentDigests.get(path);
    if (before === digest && (path === "pod.yon" || path.startsWith("ledger/"))) {
      throw new Error(`Mesh creation pod effect did not change its declared path: ${path}`);
    }
    contentDigests.set(path, digest);
  }
  return { paths: [...new Set(paths)].sort(), contentDigests };
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function assertPlannedRegistryAndTopology(
  db: Client,
  plan: CreationPlanV1,
  request: DestinationRequest,
  podRid: string,
  meshRid: Uint8Array,
  vaultRid: Uint8Array,
): Promise<void> {
  for (const row of plan.intended_effects.registry_rows) {
    const present =
      row.table === "meshes"
        ? await db.execute({
            sql: "SELECT 1 FROM meshes WHERE lower(hex(rid)) = ?",
            args: [row.key],
          })
        : row.table === "vaults"
          ? await db.execute({
              sql: "SELECT 1 FROM vaults WHERE lower(hex(rid)) = ?",
              args: [row.key],
            })
          : row.table === "mesh_vaults"
            ? await db.execute({
                sql: "SELECT 1 FROM mesh_vaults WHERE mesh_rid = ? AND vault_rid = ?",
                args: [meshRid, vaultRid],
              })
            : await db.execute({
                sql: "SELECT 1 FROM federation_state WHERE lower(hex(fed_rid)) = ?",
                args: [row.key],
              });
    if (present.rows.length !== 1) {
      throw new Error(
        `Mesh creation did not realize planned registry row ${row.table}:${row.key}.`,
      );
    }
  }
  for (const binding of plan.intended_effects.topology_bindings) {
    if (
      binding.mesh_rid !== plan.intended_effects.mesh.rid ||
      binding.vault_rid !== plan.intended_effects.primary_vault_rid
    ) {
      throw new Error("Mesh creation plan contains an unsupported topology binding.");
    }
    const present = await db.execute({
      sql: "SELECT 1 FROM mesh_vaults WHERE mesh_rid = ? AND vault_rid = ?",
      args: [meshRid, vaultRid],
    });
    if (present.rows.length !== 1) {
      throw new Error("Mesh creation did not realize its planned topology binding.");
    }
  }
  const winner = foldDestinationPolicyWinners(
    readAllDestinationPolicyRecords(podRid, getFederationRoot()),
  ).get(destinationPolicyKey("mesh", plan.intended_effects.mesh.rid));
  const expectedSource =
    plan.destination.policy_source === "authenticated-default"
      ? "authenticated-default"
      : plan.destination.policy_source === "auto-fallback-local"
        ? "auto-fallback-local"
        : "explicit";
  if (
    winner === undefined ||
    winner.state !== "active" ||
    winner.source !== expectedSource ||
    request.kind === "inherit"
  ) {
    throw new Error("Mesh creation destination-policy apply differs from its immutable plan.");
  }
  const target = destinationProjection(plan);
  if (
    (target.target === null &&
      (winner.destinationKind !== "local" ||
        winner.targetOwner !== null ||
        winner.targetKind !== null)) ||
    (target.target !== null &&
      (winner.destinationKind !== "github" ||
        winner.targetOwner !== target.target ||
        winner.targetKind !== (target.kind === "org" ? "org" : "user")))
  ) {
    throw new Error("Mesh creation destination target differs from its immutable plan.");
  }
}

function validCreationPlan(
  plan: CreationPlanV1,
  request: DestinationRequest,
  attemptId: string,
  repositoryName: string,
): boolean {
  if (
    attemptId.length === 0 ||
    plan.attempt.attempt_id !== attemptId ||
    plan.attempt.active_actor.attempt_id !== attemptId ||
    (plan.attempt.permission_observation !== null &&
      plan.attempt.permission_observation.attempt_id !== attemptId)
  ) {
    return false;
  }
  const resolved = resolveCreationPlanV1({
    request,
    subject: { kind: "mesh", repositoryName },
    actor: plan.attempt.active_actor,
    intendedEffects: plan.intended_effects,
    permission: plan.attempt.permission_observation,
  });
  return resolved.kind === "plan" && isDeepStrictEqual(resolved.plan, plan);
}
