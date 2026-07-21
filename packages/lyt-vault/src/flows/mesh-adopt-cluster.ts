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
import { dirname, join } from "node:path";

import { closeRegistry, getRegistryPath, openRegistry } from "../registry/client.js";
import { listFederationStates, upsertFederationState } from "../registry/federation-state.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { getVaultByExactName } from "../registry/repo.js";
import { assertSafeCloneName, getFederationRoot, vaultRepoName } from "../util/federation-paths.js";
import { getHandleFromIdentity } from "../util/identity.js";
import { resolveVaultPath } from "../util/paths.js";
import {
  hexToUuid7Bytes,
  newUuidv7Bytes,
  uuid7BytesToDashedString,
  uuid7BytesToHex,
} from "../util/uuid7.js";
import type { MeshGhClient } from "../util/gh-mesh.js";
import type { GhExecutor } from "../util/gh-discover.js";
import { observeActiveActor, type ActiveActorObservation } from "../op/active-actor-observation.js";
import {
  observePublicationPermission,
  type PublicationPermissionObserver,
} from "./federation/publication-permission.js";
import type { MeshPushKind } from "../yon/mesh-write.js";
import { cloneVaultFlow } from "./clone.js";
import { discoverFlow, UNCLUSTERED_MESH_NAME, type Cluster } from "./discover.js";
import { meshInitFlow, type MeshInitOptions } from "./mesh-init.js";
import { derivePlannedCreationRid, resolveCreationPlanV1 } from "./creation-plan.js";

// v1.C.3 — `lyt mesh adopt --cluster <name>`.
//
// Materializes a discovered orphan-mesh cluster per lyt-federation-design.md
// §11:501-529 + master-plan §v1.C.3:632-651:
// 1. Resolve the cluster (caller-supplied or via discoverFlow walk).
// 2. Refuse if the cluster's main vault is already registered locally
// (ClusterAlreadyRegisteredError → exit 2 per the ratified default).
// 3. Observe fresh attempt-bound actor/permission evidence for diagnostics,
// but never treat it (or cached discover evidence) as local-create authority.
// 4. Scaffold the missing main vault via meshInitFlow per the ratified default
// (v1.B.1 mesh-init primitive — composition over write-side machinery).
// 5. For each non-main cluster member, clone via cloneVaultFlow with
// `--to-mesh <cluster>` per the ratified default (registers + appends
// @MESH_HOME via the v1.B.3 path).
//
// Composition over primitives — no new write-side machinery. The cluster
// owner is the cluster's mesh_name per naming-convention §"The shape"
// (vault names are `{owner}/{leaf}` where {owner} == mesh_name). The push
// target on meshInitFlow uses `pushTo: owner, pushKind: 'handle'` per
// default (org detection deferred to v1.C.4 v1.E.*).
//
// Atomicity (brief intent vs implementation cleanest path):
// meshInitFlow opens + commits its own libSQL connection in a single
// transaction; cloneVaultFlow uses the caller-supplied db. We do NOT wrap
// both inside a single outer tx because meshInitFlow's signature predates
// the open-once seam (introduced v1.A.5 ) — folding it would require
// a separate refactor outside v1.C.3 scope. Each sub-step is atomic; if
// member clone N fails the main + members 1..N-1 stay in place,
// surfacing the partial-state as a structured error. The handler can
// re-run adopt for the remaining members (cloneVaultFlow is idempotent
// at the registry layer via rid-first convergence — the preserved rid
// resolves the already-registered member and short-circuits a re-INSERT;
// `name` is NOT a UNIQUE column post-migration-003).

export interface AdoptClusterCloneArgs {
  vaultName: string;
  cloneUrl: string;
  toMeshName: string;
  registryDb: Client;
}

export interface AdoptClusterCloneResult {
  vaultRidHex: string;
  vaultName: string;
}

// Injectable seam for cluster-member clones (default = cloneVaultFlow).
// Tests provide a fake that materialises the vault locally without git.
export type AdoptCloneFn = (args: AdoptClusterCloneArgs) => Promise<AdoptClusterCloneResult>;
export type AdoptActorObserver = (args: { attemptId: string }) => Promise<ActiveActorObservation>;

export interface MeshAdoptCreationEvidence {
  actor: ActiveActorObservation;
  permission: Awaited<ReturnType<PublicationPermissionObserver>> | null;
}

export async function observeMeshAdoptCreationEvidence(args: {
  attemptId: string;
  target: string;
  repository: string;
  actorObserver: AdoptActorObserver;
  permissionObserver: PublicationPermissionObserver;
}): Promise<MeshAdoptCreationEvidence> {
  const actor = await args.actorObserver({ attemptId: args.attemptId });
  const permission =
    actor.result === "verified"
      ? await args.permissionObserver({
          capability: "repository-create",
          target: args.target,
          repository: args.repository,
          actor: actor.actor,
          attemptId: args.attemptId,
          policyEpoch: 0,
        })
      : null;
  if (actor.attempt_id !== args.attemptId || permission?.attempt_id !== args.attemptId) {
    throw new Error("Mesh adoption evidence is not bound to the current attempt.");
  }
  return { actor, permission };
}

export interface AdoptClusterArgs {
  clusterName: string;
  // Override the cluster owner (defaults to clusterName per naming-convention).
  owner?: string | undefined;
  // Pre-resolved cluster (skips the internal discoverFlow walk). Useful
  // for the orchestration layer (Commit 3) which already has the cluster
  // from a parent discoverFlow result.
  cluster?: Cluster | undefined;
  // Open-once seam.
  registryDb?: Client | undefined;
  // Test seam for the discoverFlow walk + push-permission probe.
  ghExecutor?: GhExecutor | undefined;
  actorObserver?: AdoptActorObserver | undefined;
  permissionObserver?: PublicationPermissionObserver | undefined;
  /** Stable logical operation id supplied by resumable command adapters. */
  operationId?: string | undefined;
  // Forwarded to meshInitFlow for the main-vault scaffold.
  meshGhClient?: MeshGhClient | undefined;
  // Test seam for cluster member clones.
  cloneFn?: AdoptCloneFn | undefined;
  // pushKind for meshInitFlow (default 'handle' per the ratified default).
  pushKind?: MeshPushKind | undefined;
  // Skip push on the freshly-scaffolded main vault. Default false (push
  // by virtue of this). Tests pass true to keep meshInitFlow network-free
  // even with a fake gh client.
  noPush?: boolean | undefined;
}

export interface AdoptedMemberSummary {
  vaultName: string;
  vaultRidHex: string;
}

// B′ (Inc-2 cluster-adopt resilience) — a cluster member that did NOT land as
// an adopted vault, with the reason it was skipped. `membersRefused` carries
// members REFUSED at the security boundary (an unsafe/path-escaping name that
// the clone-name containment allowlist rejects — the hostile name never
// touches disk or the registry). `membersFailed` carries members whose clone
// FAILED transiently (network / git / registry) and can be retried. Both are
// SKIP-AND-CONTINUE outcomes: the adopt COMPLETES with the safe members
// instead of aborting the whole cluster mid-loop.
export interface AdoptSkippedMember {
  name: string;
  reason: string;
}

export interface AdoptClusterResult {
  clusterName: string;
  owner: string;
  mainVault: { name: string; ridHex: string; path: string };
  membersAdopted: AdoptedMemberSummary[];
  // B′ — members skipped (not aborted) so the caller/CLI can surface e.g.
  // "adopted 4 of 5 members; 1 refused (unsafe name): evil/../escape". A
  // skipped member is NEVER silently dropped — it lands in one of these two.
  membersRefused: AdoptSkippedMember[];
  membersFailed: AdoptSkippedMember[];
  pushed: boolean;
  durationMs: number;
}

export class AdoptClusterNotFoundError extends Error {
  readonly errorCode = "adopt-cluster-not-found";
  readonly clusterName: string;
  constructor(clusterName: string) {
    super(
      `lyt mesh adopt: cluster '${clusterName}' not found in the discover walk. ` +
        `Run 'lyt discover' to see available clusters.`,
    );
    this.name = "AdoptClusterNotFoundError";
    this.clusterName = clusterName;
  }
}

export class ClusterAlreadyRegisteredError extends Error {
  readonly errorCode = "cluster-already-registered";
  readonly clusterName: string;
  // B′ (no-stuck-state) — the cluster members that are NOT yet adopted locally
  // when the main vault IS already registered (the partial-adopt-after-a-
  // transient-member-failure case). Empty when the main is present and every
  // safe member is already adopted (a plain idempotent re-run).
  readonly missingMembers: string[];
  constructor(clusterName: string, missingMembers: string[] = []) {
    const base = `lyt mesh adopt: cluster '${clusterName}' is already registered locally; main vault present.`;
    // B′ — when members are still missing, name them + how to add each one so
    // the user is never left STUCK ("already registered", no path forward). A
    // clean auto-resume was deliberately NOT chosen: it would rewrite the
    // already-registered contract pinned by mesh-adopt-cluster unit tests; the
    // actionable-error keeps that contract while removing the dead end.
    const guidance =
      missingMembers.length > 0
        ? ` The main vault is in place, so re-running adopt cannot re-scaffold the cluster, ` +
          `but these members are NOT yet adopted locally: ${missingMembers.join(", ")}. ` +
          `Add each missing member directly with ` +
          `'lyt mesh subscribe --vault <mesh>/<vault> --from-mesh <your-mesh>' ` +
          `(e.g. 'lyt mesh subscribe --vault ${missingMembers[0]} --from-mesh ${clusterName}'). ` +
          `Then 'lyt mesh list' to confirm the cluster is complete.`
        : ` Use 'lyt mesh list' to inspect, or 'lyt mesh validate' to confirm integrity.`;
    super(base + guidance);
    this.name = "ClusterAlreadyRegisteredError";
    this.clusterName = clusterName;
    this.missingMembers = missingMembers;
  }
}

export class PushPermissionDeniedError extends Error {
  readonly errorCode = "push-permission-denied";
  readonly owner: string;
  readonly clusterName: string;
  constructor(owner: string, clusterName: string) {
    super(
      `lyt mesh adopt: user lacks push permission to ${owner}/main; cannot adopt cluster '${clusterName}'. ` +
        `Use 'lyt discover' interactive mode + choose [e]xternal to subscribe instead.`,
    );
    this.name = "PushPermissionDeniedError";
    this.owner = owner;
    this.clusterName = clusterName;
  }
}

// B′ — normalize any thrown value to a human-readable reason string for the
// skipped-member report (never leak `[object Object]` / undefined).
function skipReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// B′ — recognize a clone-name CONTAINMENT refusal (assertSafeCloneName's
// unsafe-name / path-escape error). The member loop pre-checks names at the
// boundary, but the clone seam (cloneVaultFlow) re-runs the same allowlist, so
// a refusal can also surface from inside the clone; this predicate re-classifies
// such an escape as `refused` (security) rather than `failed` (transient), so a
// hostile name is never mislabeled as a retryable failure.
//
// COUPLING (release review nit) — this regex is COUPLED to assertSafeCloneName's
// thrown-message wording in util/federation-paths.ts: all three of its throw
// sites contain the literal "Invalid clone name", and the path-escape site adds
// "slug-safe" + "escape the vaults root". If that message is ever reworded, this
// predicate must be updated in lockstep — otherwise a genuine containment
// refusal surfacing from inside the clone seam would be mis-classified as a
// transient failure (retryable) instead of a security refusal.
function isUnsafeNameRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /Invalid clone name|slug-safe|escape the vaults root/i.test(err.message);
}

// Release review fix #2 — recognize a GENUINELY-TRANSIENT (retryable) member-clone
// failure: a network / git / clone-seam error that a re-run of `lyt mesh adopt`
// could plausibly get past. This is an ALLOWLIST by design: only errors matching
// a known transient/clone shape are filed as `membersFailed` (and reported as
// "failed transiently — can be retried"). Anything NOT matching — a TypeError,
// an OOM, a dead/corrupt registry connection (LibsqlError), or any other
// unexpected/systemic fault — is deliberately EXCLUDED so the caller RE-THROWS
// (aborts loudly) rather than mislabeling a non-retryable bug as retryable and
// silently "succeeding" with a half-scaffolded cluster. A dead registry means
// every subsequent member fails too, so continuing is pointless and the "retry"
// advice would be actively wrong. Message-shape matching mirrors the messages
// cloneVaultFlow actually throws (flows/clone.ts: "git clone failed …",
// "Clone target already exists …") plus the common git/network transport phrases.
function isTransientCloneError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Programmer/systemic errors carry a distinctive constructor name — never
  // treat them as transient even if their message coincidentally matches below.
  const name = err.name;
  if (
    name === "TypeError" ||
    name === "RangeError" ||
    name === "ReferenceError" ||
    name === "SyntaxError" ||
    name === "EvalError" ||
    name === "URIError"
  ) {
    return false;
  }
  return /git clone failed|clone target already exists|could not resolve host|could not read from remote|remote end hung up|connection (?:refused|reset|timed out)|failed to connect|network is (?:unreachable|down)|early eof|rpc failed|the remote repository|repository not found|operation timed out/i.test(
    err.message,
  );
}

// B′ — list the cluster's non-main members that are NOT yet registered locally
// (used to make ClusterAlreadyRegisteredError actionable). Only SAFE-named
// members are surfaced: an unsafe name can never be adopted, so pointing the
// user at 'lyt mesh subscribe' for it would misdirect. Read-only.
//
// Release review fix — use getVaultByExactName (a literal `name = ?` probe), NOT
// getVaultByName (which delegates to resolveVault's SOFT leaf/alias/coordinate
// resolution). A genuinely-missing member whose leaf happens to resolve to some
// OTHER registered vault would be judged "present" under soft resolution and
// silently dropped from the guidance, leaving the actionable error incomplete.
// The exact probe reports a member as present ONLY when its canonical
// `{mesh}/{vault}` name is literally registered.
async function missingMemberNames(db: Client, cluster: Cluster): Promise<string[]> {
  const missing: string[] = [];
  for (const member of cluster.members) {
    if (member.isMain) continue;
    try {
      assertSafeCloneName(member.vaultName);
    } catch {
      continue; // an unsafe name is not an addable "missing member"
    }
    if ((await getVaultByExactName(db, member.vaultName)) === null) {
      missing.push(member.vaultName);
    }
  }
  return missing;
}

// Exported for integration tests that drive the REAL default clone fn (
// FIX-1 regression coverage) instead of a mock seam. Production callers still
// reach it via the `cloneFn` default below.
export const defaultAdoptCloneFn: AdoptCloneFn = async (args) => {
  const result = await cloneVaultFlow({
    url: args.cloneUrl,
    // (CRIT-2) — register under the caller's CANONICAL member name (the
    // one meshAdoptClusterFlow resolved from discover), never a URL-derived
    // guess. This is the ref the preserve-path identity check validates the
    // publisher's declared vault.yon name against, and it mirrors subscribe's
    // defaultCloneFn (which also passes name: args.vaultName). An honest
    // federated member's vault.yon declares this same canonical name.
    name: args.vaultName,
    toMesh: args.toMeshName,
    registryDb: args.registryDb,
    // adopt member clones KEEP the publisher rid (rid-first
    // convergence) and land clean-tree, same as subscribe-on-clone. Default
    // (re-mint) stays only on the standalone `lyt vault clone --to-mesh` path.
    preserveRid: true,
  });
  return {
    vaultRidHex: uuid7BytesToHex(result.rid),
    vaultName: result.name,
  };
};

export async function meshAdoptClusterFlow(args: AdoptClusterArgs): Promise<AdoptClusterResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  const discoveryOwner = args.owner ?? args.clusterName;
  const pushKind: MeshPushKind = args.pushKind ?? "handle";
  const cloneFn = args.cloneFn ?? defaultAdoptCloneFn;

  try {
    // 1. Resolve the cluster (caller-supplied or via internal discoverFlow).
    let cluster: Cluster | undefined = args.cluster;
    if (cluster === undefined) {
      const discover = await discoverFlow({
        owner: discoveryOwner,
        registryDb: db,
        ...(args.ghExecutor !== undefined ? { ghExecutor: args.ghExecutor } : {}),
      });
      cluster = discover.clusters.find((c) => c.meshName === args.clusterName);
    }
    if (cluster === undefined) {
      throw new AdoptClusterNotFoundError(args.clusterName);
    }
    if (cluster.isUnclustered || cluster.meshName === UNCLUSTERED_MESH_NAME) {
      throw new AdoptClusterNotFoundError(args.clusterName);
    }
    const owner = args.owner ?? cluster.owner;
    if (owner === null) {
      throw new Error(`Discovered cluster '${args.clusterName}' has no canonical GitHub owner.`);
    }

    // 2. Pre-check: cluster-already-registered (cluster flag + live DB check).
    // B′ (no-stuck-state) — the main vault being already registered is exactly
    // the state a partial adopt (a prior run that aborted / skipped members)
    // leaves behind. Surface an ACTIONABLE error naming the members still
    // missing locally + how to add each, so the retry has a path forward
    // instead of dead-ending. (See ClusterAlreadyRegisteredError for why a
    // clean auto-resume was not chosen.)
    if (cluster.mainVaultRegistered) {
      throw new ClusterAlreadyRegisteredError(
        args.clusterName,
        await missingMemberNames(db, cluster),
      );
    }
    const localMesh = await getMeshByName(db, args.clusterName);
    if (localMesh !== null && localMesh.mainVaultRid !== null) {
      throw new ClusterAlreadyRegisteredError(
        args.clusterName,
        await missingMemberNames(db, cluster),
      );
    }

    // 3. Observe current identity/capability for this attempt. Cached
    // discover-time pushPermitted is display evidence only and never gates
    // local adoption. Adoption's durable destination intent remains local.
    const attemptId = uuid7BytesToDashedString(newUuidv7Bytes());
    const operationId = args.operationId ?? attemptId;
    const targetOwner = owner.toLowerCase();
    const target = `github:${pushKind === "org" ? "org" : "user"}/${targetOwner}`;
    const evidence = await observeMeshAdoptCreationEvidence({
      attemptId,
      target,
      repository: `${targetOwner}/${vaultRepoName(`${args.clusterName}/main`)}`,
      actorObserver:
        args.actorObserver ??
        ((input) =>
          observeActiveActor({
            ...input,
            ...(args.ghExecutor === undefined
              ? {}
              : { runner: { run: (argv: readonly string[]) => args.ghExecutor!(argv) } }),
          })),
      permissionObserver:
        args.permissionObserver ??
        ((input) => observePublicationPermission(input, args.ghExecutor)),
    });
    const { actor, permission } = evidence;
    const destinationRequest = { kind: "local" } as const;

    const podIdentities = await listFederationStates(db);
    if (podIdentities.length > 1) {
      throw new Error("Mesh adoption requires exactly one local pod identity.");
    }
    const mainVaultName = `${args.clusterName}/main`;
    const mainVaultPath = resolveVaultPath(mainVaultName);
    const podHandle = podIdentities[0]?.handle ?? getHandleFromIdentity();
    const podRid =
      podIdentities[0]?.fedRidHex ?? derivePlannedCreationRid(operationId, `pod:${podHandle}`);
    const meshRid = derivePlannedCreationRid(operationId, `mesh:${args.clusterName}`);
    const vaultRid = derivePlannedCreationRid(operationId, `vault:${mainVaultName}`);
    const memscopeRid = derivePlannedCreationRid(operationId, `memscope:${mainVaultName}`);
    const planned = resolveCreationPlanV1({
      request: destinationRequest,
      subject: {
        kind: "mesh",
        repositoryName: vaultRepoName(mainVaultName),
      },
      actor,
      permission,
      intendedEffects: {
        operation_id: operationId,
        identity:
          podIdentities.length === 0
            ? { kind: "create", rid: podRid, handle: podHandle }
            : { kind: "existing", rid: podRid },
        mesh: { kind: "create", rid: meshRid, name: args.clusterName },
        primary_vault_rid: vaultRid,
        vaults: [
          {
            kind: "create",
            rid: vaultRid,
            memscope_rid: memscopeRid,
            name: mainVaultName,
            root: mainVaultPath,
          },
        ],
        local_writes: [
          {
            root: mainVaultPath,
            exact_paths: [
              join(mainVaultPath, ".lyt", "vault.yon"),
              join(mainVaultPath, ".lyt", "mesh.yon"),
            ],
            bounded_path_classes: ["vault-scaffold", "git-metadata"],
          },
          {
            root: dirname(getRegistryPath()),
            exact_paths: [getRegistryPath()],
            bounded_path_classes: ["registry"],
          },
          {
            root: getFederationRoot(),
            exact_paths: [],
            bounded_path_classes: ["destination-policy-ledger"],
          },
        ],
        registry_rows: [
          ...(podIdentities.length === 0
            ? [{ table: "federation_state" as const, key: podRid }]
            : []),
          { table: "meshes", key: meshRid },
          { table: "vaults", key: vaultRid },
          { table: "mesh_vaults", key: `${meshRid}:${vaultRid}` },
        ],
        topology_bindings: [{ mesh_rid: meshRid, vault_rid: vaultRid, role: "main" }],
        checkpoints: [
          { repository_root: mainVaultPath, exact_paths: [".lyt/mesh.yon", ".lyt/vault.yon"] },
        ],
        remote_effects: [],
      },
    });
    if (planned.kind === "refusal") throw new Error(planned.message);

    // Planning and all refusal gates above are read-only. Only now establish
    // the local pod identity required by mesh destination-policy creation.
    // Reuse an adopted identity when present; when absent, bind the canonical
    // ambient local identity. Never derive the pod identity from the cluster
    // owner and never create a second federation row.
    if (podIdentities.length === 0) {
      await upsertFederationState(db, { handle: podHandle, fedRidBytes: hexToUuid7Bytes(podRid) });
    }
    const meshInitOpts: MeshInitOptions = {
      name: args.clusterName,
      noPush: true,
      creation: {
        destinationRequest,
        creationPlan: planned.plan,
        attemptId,
      },
      db,
      ...(args.meshGhClient !== undefined ? { ghClient: args.meshGhClient } : {}),
    };
    const meshInit = await meshInitFlow(meshInitOpts);

    // 5. Clone non-main cluster members. mainAlreadyOnGh has been gated
    // out by the push-permission branch (the probe only fires when
    // main is NOT already on GH), so `member.isMain === true` here is
    // structurally impossible for a healthy v1.C.3 adopt path; the
    // `continue` is defensive.
    //
    // B′ (resilience) — the loop is NON-transactional by construction (each
    // member is its own clone). A single member that PATH-ESCAPES its name (or
    // fails transiently) must NOT abort the whole cluster and strand a partial
    // adopt. Each member is guarded: an unsafe name is REFUSED at the boundary
    // (recorded, never cloned — fail-closed, the hostile name never touches
    // disk/registry), a transient clone error is recorded as FAILED, and the
    // adopt COMPLETES with the safe members. Skipped members are surfaced in
    // membersRefused / membersFailed, never silently dropped.
    const membersAdopted: AdoptedMemberSummary[] = [];
    const membersRefused: AdoptSkippedMember[] = [];
    const membersFailed: AdoptSkippedMember[] = [];
    for (const member of cluster.members) {
      if (member.isMain) continue;

      // Security boundary — refuse an unsafe/path-escaping member name BEFORE
      // it can reach cloneVaultFlow / any path join or registry write.
      try {
        assertSafeCloneName(member.vaultName);
      } catch (err) {
        membersRefused.push({ name: member.vaultName, reason: skipReason(err) });
        continue;
      }

      // Safe name — attempt the clone. A defense-in-depth unsafe-name refusal
      // surfacing from inside the clone seam is re-classified as REFUSED (not
      // FAILED); a genuinely-transient network/git/clone-seam failure is recorded
      // as FAILED (retryable) and skipped. Release review fix #2 — an UNEXPECTED /
      // systemic error (a TypeError, OOM, a dead/corrupt registry connection)
      // matches NEITHER predicate: it is RE-THROWN so the adopt ABORTS LOUDLY
      // instead of silently "succeeding" with a half-scaffolded cluster and
      // mislabeling a non-retryable bug as a retryable transient failure.
      try {
        const cloneResult = await cloneFn({
          vaultName: member.vaultName,
          cloneUrl: member.repo.cloneUrl,
          toMeshName: args.clusterName,
          registryDb: db,
        });
        membersAdopted.push({
          vaultName: cloneResult.vaultName,
          vaultRidHex: cloneResult.vaultRidHex,
        });
      } catch (err) {
        if (isUnsafeNameRefusal(err)) {
          membersRefused.push({ name: member.vaultName, reason: skipReason(err) });
        } else if (isTransientCloneError(err)) {
          membersFailed.push({ name: member.vaultName, reason: skipReason(err) });
        } else {
          // Genuinely unexpected/systemic — do NOT swallow as retryable. Abort
          // loudly; the partial main + members 1..N-1 stay in place and the
          // structured error surfaces the fault (the finally block still closes
          // a flow-owned registry connection).
          throw err;
        }
      }
    }

    return {
      clusterName: args.clusterName,
      owner,
      mainVault: {
        name: meshInit.mainVault.name,
        ridHex: meshInit.mainVault.ridHex,
        path: meshInit.mainVault.path,
      },
      membersAdopted,
      membersRefused,
      membersFailed,
      pushed: meshInit.pushed,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
