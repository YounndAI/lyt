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

import { Command } from "commander";
import { createInterface } from "node:readline/promises";

import {
  DiscoverGhUnavailableError,
  computeAutoDecisions,
  discoverFlow,
  orchestrateClusters,
  shouldOfferBatchFastPath,
  type Cluster,
  type ClusterDecision,
  type ClusterOutcome,
  type DiscoverResult,
} from "../flows/discover.js";
import { getHandleFromIdentity } from "../util/identity.js";
import { withSpinner } from "../util/spinner.js";

// v1.C.3 — `lyt discover` top-level CLI verb (meta-CLI level per the ratified default).
//
// Read-only walk of the user's GH-accessible repos; clusters discovered
// Lyt vaults by `@VAULT_HOME_MESH.mesh_name` and surfaces per-cluster
// registration + push-permission flags. Commit 1 ships the read-only
// surface; Commit 3 wires the per-cluster orchestration (adopt / external
// / skip prompt + batch fast-path).
//
// Lives at the meta-CLI top level — registered via this builder; the
// meta-CLI in `packages/lyt/src/cli.ts` calls `program.addCommand
// (buildDiscoverCommand())` per the ratified default (federation-design §6:249 lists
// `lyt discover` at the top level next to `lyt init`).
//
// Structured error contract (per the ratified default):
// exit 0 discover ran cleanly (regardless of cluster count)
// exit 1 gh-unavailable
// exit 3 non-TTY under --auto without resolvable defaults (Commit 3)

interface DiscoverCliOpts {
  owner?: string;
  auto?: boolean;
  json?: boolean;
}

export function buildDiscoverCommand(): Command {
  return new Command("discover")
    .description(
      "Read-only walk of GH-accessible repos; surfaces Lyt vaults clustered by @VAULT_HOME_MESH.mesh_name + per-cluster push-permission flags (includes orphan-mesh recovery). Under --auto, applies per-cluster default decisions (adopt-if-permitted, external-if-not, skip otherwise) and dispatches via orchestrateClusters.",
    )
    .option(
      "--owner <handle>",
      "Scope discovery to a specific GH handle (defaults to authenticated user)",
    )
    .option(
      "--auto",
      "Non-interactive: apply per-cluster default decisions (adopt-if-permitted / external-if-not / skip) without prompting",
    )
    .option("--json", "Emit deterministic JSON instead of human-readable output")
    .action(async (opts: DiscoverCliOpts) => {
      const json = opts.json === true;
      const auto = opts.auto === true;
      try {
        // V-DX-1 — liveness spinner over the read-only GH repo walk (the long
        // silent window). --json stays spinner-free; non-TTY prints
        // "Scouting…" once. The post-walk interactive prompt + orchestrate
        // (clone/adopt) run after this resolves — their own gh/git spinners
        // (gh-federation) fire sequentially, never nested.
        const discoverArgs = {
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        };
        const result = !json
          ? await withSpinner("GitHub", () => discoverFlow(discoverArgs), { op: "probe" })
          : await discoverFlow(discoverArgs);
        // Resolve primary mesh = {owner}/main per naming-convention.
        const owner = opts.owner ?? getHandleFromIdentity();
        const primaryMeshName = owner;

        // Branch 1 — --json + --auto: emit clusters + orchestration result.
        // Branch 2 — --json without --auto: emit clusters only (read-only).
        // Branch 3 — TTY + --auto (no --json): apply defaults, dispatch,
        // print summary.
        // Branch 4 — TTY interactive (no --auto, no --json): prompt
        // per-cluster (with batch fast-path at >5 actionable
        // clusters), dispatch, print summary.
        // Branch 5 — non-TTY + no --auto + no --json: refuse + exit 3.
        const isTty = process.stdin.isTTY === true;

        if (json && !auto) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(toJsonShape(result), null, 2));
          return;
        }

        if (auto) {
          const decisions = computeAutoDecisions(result.clusters);
          const orch = await orchestrateClusters({
            clusters: result.clusters,
            decisions,
            owner,
            primaryMeshName,
          });
          if (json) {
            // eslint-disable-next-line no-console
            console.log(
              JSON.stringify(
                {
                  ...toJsonShape(result),
                  orchestration: {
                    outcomes: orch.outcomes.map(outcomeToJson),
                    duration_ms: orch.durationMs,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }
          emitHuman(result);
          emitOutcomesHuman(orch.outcomes);
          return;
        }

        // No --auto, no --json. Interactive path.
        if (!isTty) {
          emitError(json, {
            error: "requires-tty-or-auto",
            message:
              "lyt discover: non-interactive shell detected. Pass --auto to apply per-cluster defaults, or --json to emit cluster data for caller-side decision dispatch.",
          });
          process.exitCode = 3;
          return;
        }

        emitHuman(result);
        const decisions = await collectDecisionsInteractive(result.clusters);
        if (decisions === null) {
          // user bailed
          // eslint-disable-next-line no-console
          console.log("Cancelled — no clusters dispatched.");
          return;
        }
        const orch = await orchestrateClusters({
          clusters: result.clusters,
          decisions,
          owner,
          primaryMeshName,
        });
        emitOutcomesHuman(orch.outcomes);
      } catch (err) {
        const status = mapErrorToExitCode(err);
        if (status !== null) {
          emitError(json, errorToJsonBody(err));
          process.exitCode = status;
          return;
        }
        throw err;
      }
    });
}

async function collectDecisionsInteractive(
  clusters: readonly Cluster[],
): Promise<Map<string, ClusterDecision> | null> {
  const decisions = new Map<string, ClusterDecision>();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (shouldOfferBatchFastPath(clusters)) {
      // eslint-disable-next-line no-console
      console.log(`\n${clusters.length} clusters detected (> 5). Batch fast-path:`);
      const ans = (
        await rl.question(
          "  [A]dopt all-where-permitted / [E]xternal all-others / [c]ustomize per cluster: ",
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "a") {
        for (const c of clusters) {
          if (c.isUnclustered || c.mainVaultRegistered || c.members.length === 0) {
            decisions.set(c.meshName, "skip");
          } else if (c.pushPermitted === true) {
            decisions.set(c.meshName, "adopt");
          } else {
            decisions.set(c.meshName, "skip");
          }
        }
        return decisions;
      }
      if (ans === "e") {
        for (const c of clusters) {
          if (c.isUnclustered || c.mainVaultRegistered || c.members.length === 0) {
            decisions.set(c.meshName, "skip");
          } else {
            decisions.set(c.meshName, "external");
          }
        }
        return decisions;
      }
      // fall through to per-cluster
    }
    for (const c of clusters) {
      if (c.isUnclustered || c.mainVaultRegistered || c.members.length === 0) {
        decisions.set(c.meshName, "skip");
        continue;
      }
      const adoptHint = c.pushPermitted === true ? "[a]dopt" : "[a]dopt (unauthorized)";
      const ans = (
        await rl.question(
          `\nCluster '${c.meshName}' (${c.members.length} vault${c.members.length === 1 ? "" : "s"}; push_permitted=${c.pushPermitted ?? "n/a"}): ${adoptHint} / [e]xternal / [s]kip [s]: `,
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "a") decisions.set(c.meshName, "adopt");
      else if (ans === "e") decisions.set(c.meshName, "external");
      else decisions.set(c.meshName, "skip");
    }
    return decisions;
  } finally {
    rl.close();
  }
}

function outcomeToJson(o: ClusterOutcome): Record<string, unknown> {
  return {
    cluster_name: o.clusterName,
    decision: o.decision,
    status: o.status,
    members_processed: o.membersProcessed,
    ...(o.message !== undefined ? { message: o.message } : {}),
  };
}

function emitOutcomesHuman(outcomes: readonly ClusterOutcome[]): void {
  if (outcomes.length === 0) return;
  // eslint-disable-next-line no-console
  console.log("\nOrchestration outcomes:");
  for (const o of outcomes) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${o.clusterName.padEnd(20)} ${o.decision.padEnd(10)} → ${o.status}${o.membersProcessed > 0 ? ` (${o.membersProcessed} member${o.membersProcessed === 1 ? "" : "s"})` : ""}${o.message !== undefined ? ` — ${o.message}` : ""}`,
    );
  }
}

interface DiscoverJsonShape {
  walk_owner: string;
  total_repos_walked: number;
  total_lyt_vaults_found: number;
  clusters: ClusterJsonShape[];
  duration_ms: number;
}

interface ClusterJsonShape {
  mesh_name: string;
  is_unclustered: boolean;
  owner: string | null;
  main_vault_registered: boolean;
  main_already_on_gh: boolean;
  push_permitted: boolean | null;
  member_count: number;
  members: {
    vault_name: string;
    vault_rid: string;
    is_main: boolean;
    repo: {
      owner: string;
      name: string;
      clone_url: string;
      ssh_url: string;
      is_private: boolean;
    };
  }[];
}

function toJsonShape(r: DiscoverResult): DiscoverJsonShape {
  return {
    walk_owner: r.walkOwner,
    total_repos_walked: r.totalReposWalked,
    total_lyt_vaults_found: r.totalLytVaultsFound,
    clusters: r.clusters.map(clusterToJson),
    duration_ms: r.durationMs,
  };
}

function clusterToJson(c: Cluster): ClusterJsonShape {
  return {
    mesh_name: c.meshName,
    is_unclustered: c.isUnclustered,
    owner: c.owner,
    main_vault_registered: c.mainVaultRegistered,
    main_already_on_gh: c.mainAlreadyOnGh,
    push_permitted: c.pushPermitted,
    member_count: c.members.length,
    members: c.members.map((m) => ({
      vault_name: m.vaultName,
      vault_rid: `vault:${m.vaultRidHex}`,
      is_main: m.isMain,
      repo: {
        owner: m.repo.owner,
        name: m.repo.name,
        clone_url: m.repo.cloneUrl,
        ssh_url: m.repo.sshUrl,
        is_private: m.repo.isPrivate,
      },
    })),
  };
}

function emitHuman(r: DiscoverResult): void {
  // eslint-disable-next-line no-console
  console.log(
    `Discovered ${r.totalLytVaultsFound} Lyt vault${r.totalLytVaultsFound === 1 ? "" : "s"} across ${r.clusters.length} cluster${r.clusters.length === 1 ? "" : "s"} (walked ${r.totalReposWalked} repos owned by ${r.walkOwner}).`,
  );
  if (r.clusters.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No Lyt vaults found on GitHub for this owner.");
    return;
  }
  for (const c of r.clusters) {
    // eslint-disable-next-line no-console
    console.log("");
    const tag = c.isUnclustered
      ? "[unclustered]"
      : `[${c.meshName}]${c.owner !== null ? ` owner=${c.owner}` : ""}`;
    // eslint-disable-next-line no-console
    console.log(`${tag} ${c.members.length} vault${c.members.length === 1 ? "" : "s"}`);
    for (const m of c.members) {
      const marker = m.isMain ? "★" : " ";
      // eslint-disable-next-line no-console
      console.log(`  ${marker} ${m.vaultName} (${m.repo.owner}/${m.repo.name})`);
    }
    if (!c.isUnclustered) {
      // eslint-disable-next-line no-console
      console.log(
        `  status: main_registered=${c.mainVaultRegistered} main_on_gh=${c.mainAlreadyOnGh} push_permitted=${c.pushPermitted ?? "n/a"}`,
      );
    }
  }
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof DiscoverGhUnavailableError) return 1;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof DiscoverGhUnavailableError) {
    return { error: err.errorCode, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt discover: ${String(body["message"] ?? body["error"])}`);
  }
}
