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

import {
  AdoptClusterNotFoundError,
  ClusterAlreadyRegisteredError,
  PushPermissionDeniedError,
  meshAdoptClusterFlow,
  type AdoptClusterResult,
} from "../flows/mesh-adopt-cluster.js";
import { DiscoverGhUnavailableError } from "../flows/discover.js";

// v1.C.3 — `lyt mesh adopt --cluster <name> [--owner <handle>] [--json]`.
//
// Materialises a discovered orphan-mesh cluster: scaffolds the missing
// main vault via meshInitFlow, clones each non-main member via
// cloneVaultFlow --to-mesh, and writes the @MESH_HOME rows into the
// freshly-created mesh.yon (via cloneVaultFlow's appendMeshHomeToFile
// path).
//
// Structured error contract (per OD-13):
// exit 0 cluster adopted
// exit 1 gh-unavailable / vault-yon-fetch-failed / adopt-cluster-not-found
// exit 2 push-permission-denied OR cluster-already-registered

interface MeshAdoptCliOpts {
  cluster?: string;
  owner?: string;
  json?: boolean;
  // commander writes `push: false` for `--no-push`.
  push?: boolean;
}

export function buildMeshAdoptSubcommand(): Command {
  return new Command("adopt")
    .description(
      "v1.C.3: adopt an orphan-mesh cluster — scaffold the missing main vault locally + register each cluster member as a @MESH_HOME (federation-design §11:501-529 orphan-mesh recovery + master-plan §v1.C.3).",
    )
    .requiredOption(
      "--cluster <name>",
      "Cluster name (= @VAULT_HOME_MESH.mesh_name from discovered vaults)",
    )
    .option(
      "--owner <handle>",
      "Override the cluster owner (defaults to cluster name per naming-convention §The shape)",
    )
    .option(
      "--no-push",
      "Skip the initial git push on the freshly-scaffolded main vault (local commits only)",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: MeshAdoptCliOpts) => {
      const json = opts.json === true;
      const noPush = opts.push === false;
      try {
        const result = await meshAdoptClusterFlow({
          clusterName: opts.cluster!,
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
          noPush,
        });
        if (json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(toJsonShape(result), null, 2));
          return;
        }
        emitHuman(result);
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

function toJsonShape(r: AdoptClusterResult): Record<string, unknown> {
  return {
    cluster_name: r.clusterName,
    owner: r.owner,
    main_vault: {
      name: r.mainVault.name,
      rid: `vault:${r.mainVault.ridHex}`,
      rid_hex: r.mainVault.ridHex,
      path: r.mainVault.path,
    },
    members_adopted: r.membersAdopted.map((m) => ({
      vault_name: m.vaultName,
      vault_rid: `vault:${m.vaultRidHex}`,
      vault_rid_hex: m.vaultRidHex,
    })),
    pushed: r.pushed,
    duration_ms: r.durationMs,
  };
}

function emitHuman(r: AdoptClusterResult): void {
  // eslint-disable-next-line no-console
  console.log(`Adopted cluster '${r.clusterName}' (owner=${r.owner})`);
  // eslint-disable-next-line no-console
  console.log(`  main vault: ${r.mainVault.name} (vault:${r.mainVault.ridHex})`);
  // eslint-disable-next-line no-console
  console.log(`  path:       ${r.mainVault.path}`);
  // eslint-disable-next-line no-console
  console.log(
    `  members:    ${r.membersAdopted.length} adopted${r.pushed ? " · main pushed" : " · main NOT pushed"}`,
  );
  for (const m of r.membersAdopted) {
    // eslint-disable-next-line no-console
    console.log(`    - ${m.vaultName} (vault:${m.vaultRidHex})`);
  }
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof DiscoverGhUnavailableError) return 1;
  if (err instanceof AdoptClusterNotFoundError) return 1;
  if (err instanceof PushPermissionDeniedError) return 2;
  if (err instanceof ClusterAlreadyRegisteredError) return 2;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof DiscoverGhUnavailableError) {
    return { error: err.errorCode, message: err.message };
  }
  if (err instanceof AdoptClusterNotFoundError) {
    return { error: err.errorCode, cluster_name: err.clusterName, message: err.message };
  }
  if (err instanceof PushPermissionDeniedError) {
    return {
      error: err.errorCode,
      owner: err.owner,
      cluster_name: err.clusterName,
      message: err.message,
    };
  }
  if (err instanceof ClusterAlreadyRegisteredError) {
    return { error: err.errorCode, cluster_name: err.clusterName, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt mesh adopt: ${String(body["message"] ?? body["error"])}`);
  }
}
