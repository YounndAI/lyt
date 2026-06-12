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
import { getHandleFromIdentity } from "../util/identity.js";
import {
  checkPushPermission,
  fetchVaultYonContent,
  walkUserRepos,
  type DiscoveredRepo,
  type GhExecutor,
} from "../util/gh-discover.js";
import type { MeshGhClient } from "../util/gh-mesh.js";
import { parseVaultYon, type ParsedVaultYon } from "../yon/parse.js";
import {
  AdoptClusterNotFoundError,
  ClusterAlreadyRegisteredError,
  PushPermissionDeniedError,
  meshAdoptClusterFlow,
  type AdoptCloneFn,
} from "./mesh-adopt-cluster.js";
import { subscribeFlow, type SubscribeCloneFn } from "./subscribe.js";

// v1.C.3 — `lyt discover` flow. Read-only walk of the user's GH-accessible
// repos; clusters discovered Lyt vaults by `@VAULT_HOME_MESH.mesh_name` per
// lyt-federation-design.md §11:501-529 orphan-mesh recovery + master-plan
// §v1.C.3:632-651.
//
// The flow has 4 phases:
// 1. Resolve the walk owner (--owner or `getHandleFromIdentity`).
// 2. Walk the owner's accessible repos via `gh api /user/repos --paginate`
// (lyt-vault-owned walker per OD-3 alt — cycle-free; lyt-mesh's
// walkGithub couldn't be reused because lyt-mesh depends on lyt-vault,
// not the other way round).
// 3. Per repo, fetch `.lyt/vault.yon` via the GH Contents API; skip 404s
// (not a Lyt vault); parse via `parseVaultYon` for the rest.
// 4. Cluster by `homeMesh.meshName`; derive per-cluster flags
// (`mainVaultRegistered`, `pushPermitted`, `mainAlreadyOnGh`); emit a
// deterministic `DiscoverResult`.
//
// Determinism contract (Lock 0.3):
// - Clusters sorted by `meshName` ASC.
// - Tie-break by member-count DESC (larger clusters first).
// - Tie-break by first-member-name ASC.
// - Within a cluster, members sorted by `vaultName` ASC.
// - The same GH state + same `gh` fixture → identical JSON bytes.
//
// Open-once seam (v1.A.5 CR-B1 vindicated 16×): callers may pass `registryDb`;
// the flow opens its own client only when omitted.
//
// Push-permission gating (federation-design §11:512): per cluster we probe
// `gh repo view {cluster-owner}/main --json viewerPermission` ONLY when the
// cluster could plausibly be adopted — i.e. it has a mesh name, its main
// vault is NOT already registered locally, and its main is NOT already on
// GH. Otherwise the probe is skipped (`pushPermitted: null`) to avoid
// wasted gh API budget for clusters that aren't candidates.

export interface DiscoverArgs {
  // Override the GH handle to scope the walk to. Defaults to the
  // authenticated user's handle.
  owner?: string | undefined;
  // Open-once seam.
  registryDb?: Client | undefined;
  // Test seam — injectable GhExecutor for fake-gh routing.
  ghExecutor?: GhExecutor | undefined;
}

export interface ClusterMemberRepo {
  owner: string;
  name: string;
  cloneUrl: string;
  sshUrl: string;
  isPrivate: boolean;
}

export interface ClusterMember {
  vaultName: string;
  vaultRidHex: string;
  isMain: boolean;
  repo: ClusterMemberRepo;
}

export interface Cluster {
  meshName: string;
  isUnclustered: boolean;
  owner: string | null;
  members: ClusterMember[];
  mainVaultRegistered: boolean;
  // True when one of the discovered members IS the cluster's main vault
  // (vaultName === `${meshName}/main`). When true, adopt is not the right
  // action — `lyt mesh join` is. Adopt is for MISSING mains.
  mainAlreadyOnGh: boolean;
  // null when the probe was skipped (unclustered / already-registered /
  // main-already-on-gh / probe failure).
  pushPermitted: boolean | null;
}

export interface DiscoverResult {
  walkOwner: string;
  totalReposWalked: number;
  totalLytVaultsFound: number;
  clusters: Cluster[];
  durationMs: number;
}

export class DiscoverGhUnavailableError extends Error {
  readonly errorCode = "gh-unavailable";
  constructor(reason: string) {
    super(
      `lyt discover: GitHub CLI unavailable or /user/repos failed: ${reason}. ` +
        `Install gh (https://cli.github.com) and run 'gh auth login', then retry.`,
    );
    this.name = "DiscoverGhUnavailableError";
  }
}

// Sentinel meshName for vaults missing @VAULT_HOME_MESH (pre-v1.A.3b
// vaults; cluster-design implicit-fallback per federation-design §11).
export const UNCLUSTERED_MESH_NAME = "__unclustered__";

interface DiscoveredVault {
  repo: DiscoveredRepo;
  vaultName: string;
  vaultRidHex: string;
  meshName: string | null;
}

export async function discoverFlow(opts: DiscoverArgs = {}): Promise<DiscoverResult> {
  const startedAt = Date.now();
  const callerSupplied = opts.registryDb !== undefined;
  const db = opts.registryDb ?? (await openRegistry());
  const owner = opts.owner ?? getHandleFromIdentity();

  try {
    // 1. Walk repos.
    let repos: DiscoveredRepo[];
    try {
      repos = await walkUserRepos({ owner, gh: opts.ghExecutor });
    } catch (err) {
      throw new DiscoverGhUnavailableError(err instanceof Error ? err.message : String(err));
    }

    // 2. Fetch + parse vault.yon per repo; collect candidates.
    const candidates: DiscoveredVault[] = [];
    for (const repo of repos) {
      let content: string | null;
      try {
        content = await fetchVaultYonContent({
          owner: repo.owner,
          repo: repo.name,
          gh: opts.ghExecutor,
        });
      } catch (err) {
        // Non-404 fetch error — skip the repo + log. Don't fail the whole
        // walk because one repo's Contents API hiccuped.
        // eslint-disable-next-line no-console
        console.error(
          `lyt discover: skipping ${repo.owner}/${repo.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      if (content === null) continue;
      let parsed: ParsedVaultYon;
      try {
        parsed = parseVaultYon(content);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `lyt discover: skipping ${repo.owner}/${repo.name} (vault.yon parse error): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      candidates.push({
        repo,
        vaultName: parsed.name,
        vaultRidHex: parsed.rid,
        meshName: parsed.homeMesh?.meshName ?? null,
      });
    }

    // 3. Cluster by meshName.
    const clusterMap = new Map<string, DiscoveredVault[]>();
    for (const c of candidates) {
      const key = c.meshName ?? UNCLUSTERED_MESH_NAME;
      const existing = clusterMap.get(key);
      if (existing === undefined) clusterMap.set(key, [c]);
      else existing.push(c);
    }

    // 4. Per cluster, derive flags.
    const clusters: Cluster[] = [];
    for (const [meshName, members] of clusterMap) {
      const isUnclustered = meshName === UNCLUSTERED_MESH_NAME;
      // Per lyt-naming-convention §"The shape", mesh_name IS the owner —
      // vault names are `{owner}/{leaf}` and the {owner} segment equals
      // mesh_name. Push-permission probe targets `{mesh_name}/main`
      // (federation-design §11:512 + brief §"Discovery flow" step 6).
      // The discovered repo's GH owner may differ from mesh_name in
      // unusual fork setups; v1.C.3 treats mesh_name as authoritative.
      const clusterOwner = isUnclustered ? null : meshName;

      const mainAlreadyOnGh = !isUnclustered
        ? members.some((m) => m.vaultName === `${meshName}/main`)
        : false;

      let mainVaultRegistered = false;
      if (!isUnclustered) {
        const meshRow = await getMeshByName(db, meshName);
        if (meshRow !== null && meshRow.mainVaultRid !== null) {
          mainVaultRegistered = true;
        }
      }

      let pushPermitted: boolean | null = null;
      if (!isUnclustered && !mainVaultRegistered && !mainAlreadyOnGh && clusterOwner !== null) {
        try {
          pushPermitted = await checkPushPermission({
            owner: clusterOwner,
            repo: "main",
            gh: opts.ghExecutor,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `lyt discover: push-permission probe failed for ${clusterOwner}/main: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          pushPermitted = false;
        }
      }

      const clusterMembers: ClusterMember[] = members
        .map((m) => ({
          vaultName: m.vaultName,
          vaultRidHex: m.vaultRidHex,
          isMain: !isUnclustered && m.vaultName === `${meshName}/main`,
          repo: {
            owner: m.repo.owner,
            name: m.repo.name,
            cloneUrl: m.repo.cloneUrl,
            sshUrl: m.repo.sshUrl,
            isPrivate: m.repo.isPrivate,
          },
        }))
        .sort((a, b) => a.vaultName.localeCompare(b.vaultName));

      clusters.push({
        meshName,
        isUnclustered,
        owner: clusterOwner,
        members: clusterMembers,
        mainVaultRegistered,
        mainAlreadyOnGh,
        pushPermitted,
      });
    }

    // 5. Deterministic ordering — meshName ASC; tie-break by member-count
    // DESC; tie-break by first-member-name ASC.
    clusters.sort((a, b) => {
      const an = a.meshName.localeCompare(b.meshName);
      if (an !== 0) return an;
      const cn = b.members.length - a.members.length;
      if (cn !== 0) return cn;
      return a.members[0]!.vaultName.localeCompare(b.members[0]!.vaultName);
    });

    return {
      walkOwner: owner,
      totalReposWalked: repos.length,
      totalLytVaultsFound: candidates.length,
      clusters,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

// =====================================================================
// v1.C.3 Commit 3 — orchestration layer (per-cluster decision dispatch)
// =====================================================================
//
// Pure helpers + a flow-level orchestrator that the `lyt discover` command
// calls after collecting per-cluster decisions (via TTY prompt or --auto
// defaults). Splitting the orchestration into the flow keeps it testable
// without TTY; the command layer is just the I/O adapter.
//
// Decisions map cluster.meshName → 'adopt' | 'external' | 'skip'.
// - 'adopt' → meshAdoptClusterFlow on the cluster
// - 'external' → per-member subscribeFlow into the user's primary mesh
// - 'skip' → no-op
//
// Outcomes wrap each cluster's terminal status — including failure-class
// mapping so the command layer can render a structured report.

export type ClusterDecision = "adopt" | "external" | "skip";

export type ClusterOutcomeStatus =
  | "adopted"
  | "external"
  | "skipped"
  | "unauthorized"
  | "already-registered"
  | "error";

export interface ClusterOutcome {
  clusterName: string;
  decision: ClusterDecision;
  status: ClusterOutcomeStatus;
  membersProcessed: number;
  message?: string;
}

export interface OrchestrateClustersArgs {
  clusters: readonly Cluster[];
  decisions: ReadonlyMap<string, ClusterDecision>;
  owner: string;
  // The user's primary mesh — receives @MESH_SUBSCRIPTION rows for any
  // cluster decided 'external'. Defaults to `${owner}/main`-style mesh
  // (matches naming-convention §"The shape").
  primaryMeshName: string;
  // Open-once seam.
  registryDb?: Client | undefined;
  // Test seams.
  ghExecutor?: GhExecutor | undefined;
  meshGhClient?: MeshGhClient | undefined;
  adoptCloneFn?: AdoptCloneFn | undefined;
  subscribeCloneFn?: SubscribeCloneFn | undefined;
  // Skip the push on the freshly-scaffolded main vault per adopt path.
  noPush?: boolean | undefined;
}

export interface OrchestrateClustersResult {
  outcomes: ClusterOutcome[];
  durationMs: number;
}

// Pure: derive default decisions for `--auto` mode (federation-design
// §11:512 — adopt-if-permitted, external-if-not, skip the unclustered
// bucket + already-registered clusters).
export function computeAutoDecisions(clusters: readonly Cluster[]): Map<string, ClusterDecision> {
  const decisions = new Map<string, ClusterDecision>();
  for (const c of clusters) {
    if (c.isUnclustered) {
      decisions.set(c.meshName, "skip");
      continue;
    }
    if (c.mainVaultRegistered) {
      decisions.set(c.meshName, "skip");
      continue;
    }
    if (c.mainAlreadyOnGh) {
      // Main exists on GH but not locally — `lyt mesh join` is the right
      // verb; auto-skip rather than guess.
      decisions.set(c.meshName, "skip");
      continue;
    }
    if (c.members.length === 0) {
      decisions.set(c.meshName, "skip");
      continue;
    }
    if (c.pushPermitted === true) {
      decisions.set(c.meshName, "adopt");
    } else {
      decisions.set(c.meshName, "external");
    }
  }
  return decisions;
}

// Pure: should the command layer surface the batch fast-path prompt?
// Triggered per master-plan §v1.C.3:644 + federation-design §11:513 at
// > 5 actionable clusters (unclustered + already-registered excluded
// from the count since they're auto-skip).
export function shouldOfferBatchFastPath(clusters: readonly Cluster[]): boolean {
  const actionable = clusters.filter(
    (c) => !c.isUnclustered && !c.mainVaultRegistered && c.members.length > 0,
  );
  return actionable.length > 5;
}

export async function orchestrateClusters(
  args: OrchestrateClustersArgs,
): Promise<OrchestrateClustersResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    const outcomes: ClusterOutcome[] = [];
    for (const cluster of args.clusters) {
      const decision = args.decisions.get(cluster.meshName) ?? "skip";
      outcomes.push(
        await dispatchDecision({
          cluster,
          decision,
          owner: args.owner,
          primaryMeshName: args.primaryMeshName,
          db,
          ...(args.ghExecutor !== undefined ? { ghExecutor: args.ghExecutor } : {}),
          ...(args.meshGhClient !== undefined ? { meshGhClient: args.meshGhClient } : {}),
          ...(args.adoptCloneFn !== undefined ? { adoptCloneFn: args.adoptCloneFn } : {}),
          ...(args.subscribeCloneFn !== undefined
            ? { subscribeCloneFn: args.subscribeCloneFn }
            : {}),
          noPush: args.noPush === true,
        }),
      );
    }
    return { outcomes, durationMs: Date.now() - startedAt };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

interface DispatchArgs {
  cluster: Cluster;
  decision: ClusterDecision;
  owner: string;
  primaryMeshName: string;
  db: Client;
  ghExecutor?: GhExecutor;
  meshGhClient?: MeshGhClient;
  adoptCloneFn?: AdoptCloneFn;
  subscribeCloneFn?: SubscribeCloneFn;
  noPush: boolean;
}

async function dispatchDecision(args: DispatchArgs): Promise<ClusterOutcome> {
  const { cluster, decision } = args;
  if (decision === "skip" || cluster.isUnclustered) {
    return {
      clusterName: cluster.meshName,
      decision,
      status: "skipped",
      membersProcessed: 0,
    };
  }
  if (decision === "adopt") {
    try {
      const result = await meshAdoptClusterFlow({
        clusterName: cluster.meshName,
        owner: args.owner,
        cluster,
        registryDb: args.db,
        ...(args.ghExecutor !== undefined ? { ghExecutor: args.ghExecutor } : {}),
        ...(args.meshGhClient !== undefined ? { meshGhClient: args.meshGhClient } : {}),
        ...(args.adoptCloneFn !== undefined ? { cloneFn: args.adoptCloneFn } : {}),
        noPush: args.noPush,
      });
      return {
        clusterName: cluster.meshName,
        decision,
        status: "adopted",
        membersProcessed: result.membersAdopted.length + 1, // +1 for main
      };
    } catch (err) {
      if (err instanceof ClusterAlreadyRegisteredError) {
        return {
          clusterName: cluster.meshName,
          decision,
          status: "already-registered",
          membersProcessed: 0,
          message: err.message,
        };
      }
      if (err instanceof PushPermissionDeniedError) {
        return {
          clusterName: cluster.meshName,
          decision,
          status: "unauthorized",
          membersProcessed: 0,
          message: err.message,
        };
      }
      if (err instanceof AdoptClusterNotFoundError) {
        return {
          clusterName: cluster.meshName,
          decision,
          status: "error",
          membersProcessed: 0,
          message: err.message,
        };
      }
      return {
        clusterName: cluster.meshName,
        decision,
        status: "error",
        membersProcessed: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // External: per-member subscribe into primaryMeshName.
  let processed = 0;
  let firstError: string | undefined;
  for (const member of cluster.members) {
    try {
      await subscribeFlow({
        subscribedVaultName: member.vaultName,
        fromMeshName: args.primaryMeshName,
        registryDb: args.db,
        ...(args.subscribeCloneFn !== undefined ? { cloneFn: args.subscribeCloneFn } : {}),
      });
      processed += 1;
    } catch (err) {
      if (firstError === undefined) {
        firstError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return {
    clusterName: cluster.meshName,
    decision,
    status: processed === cluster.members.length ? "external" : "error",
    membersProcessed: processed,
    ...(firstError !== undefined ? { message: firstError } : {}),
  };
}
