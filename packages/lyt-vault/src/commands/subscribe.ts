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
  SubscribeMainVaultMissingError,
  SubscribeVaultNotFoundError,
  subscribeFlow,
  type SubscribeResult,
} from "../flows/subscribe.js";

// v1.C.2 — `lyt mesh subscribe --vault <name> --from-mesh <name> [--json]`.
//
// Fed-v2 D1c: records the subscription in this writer's append-only
// subscription ledger shard (the SoT) — mesh.yon is NOT written, and the
// `mesh_subscriptions` cache is reconstituted from the ledger by
// rebuildFederationCacheFlow, not inserted here. The referenced
// (subscribed) vault's home mesh is unaware per federation-design §3
// asymmetric awareness. Local libSQL index (lanes_cache + fts_cache) is
// refreshed after a successful write so the v1.D.3 cascade engine
// surfaces the subscribed vault under mesh-scoped uniform search.
//
// Structured error contract (per the ratified default):
// exit 0 subscription written OR subscription-already-present (idempotent)
// exit 1 vault-not-found / clone-failed for --vault
// exit 4 main-vault-missing (subscribing mesh's main vault not in registry)

interface SubscribeCliOpts {
  vault?: string;
  fromMesh?: string;
  json?: boolean;
}

export function buildMeshSubscribeSubcommand(): Command {
  return new Command("subscribe")
    .description(
      "Record a subscription to an external vault in this writer's append-only subscription ledger (asymmetric — referenced vault's home mesh untouched; mesh.yon is not written). Clones the subscribed vault locally on first subscribe + builds the local libSQL index so mesh-scoped search includes it.",
    )
    .requiredOption(
      "--vault <name>",
      "Subscribed vault — {mesh}/{vault} (e.g. younndai/pub-test) or the literal repo name {owner}/lyt-vault-<mesh>--<leaf>; both normalize to the vault name. If absent from the local registry, lyt clones it via cloneVaultFlow before writing the subscription",
    )
    .requiredOption(
      "--from-mesh <name>",
      "Subscribing mesh — its main vault must be registered locally (mesh.yon writes only land on main vaults per naming-convention)",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: SubscribeCliOpts) => {
      const json = opts.json === true;
      try {
        const result = await subscribeFlow({
          subscribedVaultName: opts.vault!,
          fromMeshName: opts.fromMesh!,
        });
        if (json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
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

function emitHuman(r: SubscribeResult): void {
  if (r.status === "subscription-already-present") {
    // eslint-disable-next-line no-console
    console.log(`Subscription already present in the ledger (no ledger write).`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Recorded subscription to ledger`);
  }
  // eslint-disable-next-line no-console
  console.log(`  subscribing mesh: ${r.subscribingMesh.name} (mesh:${r.subscribingMesh.ridHex})`);
  // eslint-disable-next-line no-console
  console.log(` subscribed vault: ${r.subscribedVault.name} (vault:${r.subscribedVault.ridHex})`);
  // eslint-disable-next-line no-console
  console.log(
    `  external mesh:    ${r.subscribedVault.homeMeshName} (mesh:${r.subscribedVault.homeMeshRidHex})`,
  );
  // eslint-disable-next-line no-console
  console.log(`  clone action:     ${r.cloneAction}`);
  // eslint-disable-next-line no-console
  console.log(
    `  index built:      lanes=${r.indexBuilt.lanesRan ? "ran" : "noop"}; fts=${r.indexBuilt.ftsRan ? "ran" : "noop"}`,
  );
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof SubscribeVaultNotFoundError) return 1;
  if (err instanceof SubscribeMainVaultMissingError) return 4;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof SubscribeVaultNotFoundError) {
    return { error: err.errorCode, vault_name: err.vaultName, message: err.message };
  }
  if (err instanceof SubscribeMainVaultMissingError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt mesh subscribe: ${String(body["message"] ?? body["error"])}`);
  }
}
