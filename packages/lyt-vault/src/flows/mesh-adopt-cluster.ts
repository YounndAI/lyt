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

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { uuid7BytesToHex } from "../util/uuid7.js";
import type { MeshGhClient } from "../util/gh-mesh.js";
import { checkPushPermission, type GhExecutor } from "../util/gh-discover.js";
import type { MeshPushKind } from "../yon/mesh-write.js";
import { cloneVaultFlow } from "./clone.js";
import { discoverFlow, UNCLUSTERED_MESH_NAME, type Cluster } from "./discover.js";
import { meshInitFlow, type MeshInitOptions } from "./mesh-init.js";

// v1.C.3 — `lyt mesh adopt --cluster <name>`.
//
// Materializes a discovered orphan-mesh cluster per lyt-federation-design.md
// §11:501-529 + master-plan §v1.C.3:632-651:
// 1. Resolve the cluster (caller-supplied or via discoverFlow walk).
// 2. Refuse if the cluster's main vault is already registered locally
// (ClusterAlreadyRegisteredError → exit 2 per OD-13).
// 3. Refuse if the user lacks push permission to `{owner}/main`
// (PushPermissionDeniedError → exit 2). Falls back to a live probe
// when the cluster's pushPermitted flag is null (e.g. caller
// supplied a Cluster from a non-probing source).
// 4. Scaffold the missing main vault via meshInitFlow per OD-9 default
// (v1.B.1 mesh-init primitive — composition over write-side machinery).
// 5. For each non-main cluster member, clone via cloneVaultFlow with
// `--to-mesh <cluster>` per OD-7 default (registers + appends
// @MESH_HOME via the v1.B.3 path).
//
// Composition over primitives — no new write-side machinery. The cluster
// owner is the cluster's mesh_name per naming-convention §"The shape"
// (vault names are `{owner}/{leaf}` where {owner} == mesh_name). The push
// target on meshInitFlow uses `pushTo: owner, pushKind: 'handle'` per
// OD-9 default (org detection deferred to v1.C.4 / v1.E.*).
//
// Atomicity (OD-7 — brief intent vs implementation cleanest path):
// meshInitFlow opens + commits its own libSQL connection in a single
// transaction; cloneVaultFlow uses the caller-supplied db. We do NOT wrap
// both inside a single outer tx because meshInitFlow's signature predates
// the open-once seam (introduced v1.A.5 CR-B1) — folding it would require
// a separate refactor outside v1.C.3 scope. Each sub-step is atomic; if
// member clone N fails the main + members 1..N-1 stay in place,
// surfacing the partial-state as a structured error. The handler can
// re-run adopt for the remaining members (cloneVaultFlow is idempotent
// at the registry layer via UNIQUE name constraint).

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
  // Forwarded to meshInitFlow for the main-vault scaffold.
  meshGhClient?: MeshGhClient | undefined;
  // Test seam for cluster member clones.
  cloneFn?: AdoptCloneFn | undefined;
  // pushKind for meshInitFlow (default 'handle' per OD-9).
  pushKind?: MeshPushKind | undefined;
  // Skip push on the freshly-scaffolded main vault. Default false (push
  // by virtue of OD-9). Tests pass true to keep meshInitFlow network-free
  // even with a fake gh client.
  noPush?: boolean | undefined;
}

export interface AdoptedMemberSummary {
  vaultName: string;
  vaultRidHex: string;
}

export interface AdoptClusterResult {
  clusterName: string;
  owner: string;
  mainVault: { name: string; ridHex: string; path: string };
  membersAdopted: AdoptedMemberSummary[];
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
  constructor(clusterName: string) {
    super(
      `lyt mesh adopt: cluster '${clusterName}' is already registered locally; main vault present. ` +
        `Use 'lyt mesh list' to inspect, or 'lyt mesh validate' to confirm integrity.`,
    );
    this.name = "ClusterAlreadyRegisteredError";
    this.clusterName = clusterName;
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

const defaultAdoptCloneFn: AdoptCloneFn = async (args) => {
  const result = await cloneVaultFlow({
    url: args.cloneUrl,
    toMesh: args.toMeshName,
    registryDb: args.registryDb,
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
  const owner = args.owner ?? args.clusterName;
  const pushKind: MeshPushKind = args.pushKind ?? "handle";
  const cloneFn = args.cloneFn ?? defaultAdoptCloneFn;
  const noPush = args.noPush === true;

  try {
    // 1. Resolve the cluster (caller-supplied or via internal discoverFlow).
    let cluster: Cluster | undefined = args.cluster;
    if (cluster === undefined) {
      const discover = await discoverFlow({
        owner,
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

    // 2. Pre-check: cluster-already-registered (cluster flag + live DB check).
    if (cluster.mainVaultRegistered) {
      throw new ClusterAlreadyRegisteredError(args.clusterName);
    }
    const localMesh = await getMeshByName(db, args.clusterName);
    if (localMesh !== null && localMesh.mainVaultRid !== null) {
      throw new ClusterAlreadyRegisteredError(args.clusterName);
    }

    // 3. Pre-check: push-permission. cluster.pushPermitted may be null
    // (probe skipped at discover time); fall back to a live probe.
    let pushPermitted: boolean | null = cluster.pushPermitted;
    if (pushPermitted === null) {
      pushPermitted = await checkPushPermission({
        owner,
        repo: "main",
        ...(args.ghExecutor !== undefined ? { gh: args.ghExecutor } : {}),
      });
    }
    if (pushPermitted === false) {
      throw new PushPermissionDeniedError(owner, args.clusterName);
    }

    // 4. Scaffold the missing main vault via meshInitFlow.
    const meshInitOpts: MeshInitOptions = {
      name: args.clusterName,
      pushTo: owner,
      pushKind,
      noPush,
      ...(args.meshGhClient !== undefined ? { ghClient: args.meshGhClient } : {}),
    };
    const meshInit = await meshInitFlow(meshInitOpts);

    // 5. Clone non-main cluster members. mainAlreadyOnGh has been gated
    // out by the push-permission branch (the probe only fires when
    // main is NOT already on GH), so `member.isMain === true` here is
    // structurally impossible for a healthy v1.C.3 adopt path; the
    // `continue` is defensive.
    const membersAdopted: AdoptedMemberSummary[] = [];
    for (const member of cluster.members) {
      if (member.isMain) continue;
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
      pushed: meshInit.pushed,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
