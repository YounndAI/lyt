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
import { getVaultByName } from "../registry/repo.js";
import { getMeshByRid } from "../registry/meshes-repo.js";
import { listSubscriptionsForExternalVault } from "../registry/mesh-subscriptions-repo.js";
import { GhAccessProvider } from "../access/gh-access-provider.js";
import type { AccessEntry, AccessProvider } from "../access/access-provider.js";
import type { GhExecutor } from "../util/gh-discover.js";

// keystone Phase C — the `lyt vault access` READ-ONLY verb. Reads the LIVE
// access state of a vault straight off GitHub's repo-collaborator list (the
// sole SoT — NO local "access" mirror), then reconciles it against LYT's local
// subscription view so a handler can see drift between "who gh says has access"
// and "who LYT's mesh subscriptions reflect."
//
// READ-ONLY: there is NO confirmed-gate here (unlike share/unshare). Listing
// access never mutates anything.

// A LYT mesh that subscribes to this vault, surfaced for the reconcile.
// Fed-v2 D1c: the subscription cache row no longer carries the foreign mesh
// name (external_mesh_* dropped). The subscriber's identity is the SUBSCRIBING
// mesh (its rid + resolved name) — after reconstitution this is a reserved
// owner-bucket mesh (`subscriptions`/`shared`).
export interface SubscriberView {
  meshRidHex: string;
  subscribingMeshName: string;
}

// The reconcile between gh's live grants and LYT's local subscription view.
// Because mesh_subscriptions carries NO GitHub handle (it keys mesh→external
// vault, not handle→repo), the reconcile is presence/asymmetry-shaped, not a
// handle-by-handle diff:
//   - ghGrantCount: how many live collaborators gh reports.
//   - subscriptionCount: how many local meshes subscribe to this vault.
//   - ghOnly: true when gh reports grants but LYT records no local subscription
//     for the vault (access exists that LYT's federation view does not reflect).
//   - subscriptionsWithoutGhAccess: true when LYT records subscriptions but gh
//     reports ZERO collaborators (the vault's access went away under a
//     subscription LYT still holds).
export interface AccessDrift {
  ghGrantCount: number;
  subscriptionCount: number;
  ghOnly: boolean;
  subscriptionsWithoutGhAccess: boolean;
}

export interface VaultAccessArgs {
  vaultName: string;
}

export interface VaultAccessFlowOpts {
  // Injectable registry handle — tests thread one in. Defaults to a freshly
  // opened (and closed) registry, matching the other flows.
  db?: Client;
  // Injectable AccessProvider — tests inject a fake returning known grants /
  // canShare. Defaults to a GhAccessProvider built from `gh`.
  accessProvider?: AccessProvider;
  // Injectable gh executor used only when `accessProvider` is NOT supplied.
  gh?: GhExecutor;
  // When true, skip listing grants/subscriptions — just resolve `canShare`.
  // Wired from the CLI `--can-i-share` flag.
  canIShareOnly?: boolean;
}

export interface VaultAccessResult {
  vault: string;
  // The live gh collaborator grants. Empty when `canIShareOnly`.
  grants: AccessEntry[];
  // LYT's local subscription view for this vault. Empty when `canIShareOnly`.
  subscribers: SubscriberView[];
  // The reconcile. `null` when `canIShareOnly` (not computed).
  drift: AccessDrift | null;
  // Whether the session caller can share this vault (push/admin on the repo).
  canShare: boolean;
}

// Read the live access state of `vaultName` and reconcile it against LYT's
// local subscription view. READ-ONLY: no confirmed-gate.
export async function vaultAccessFlow(
  args: VaultAccessArgs,
  opts: VaultAccessFlowOpts = {},
): Promise<VaultAccessResult> {
  const { db, owns } = await resolveDb(opts.db);
  try {
    const row = await getVaultByName(db, args.vaultName);
    if (!row) {
      throw new Error(`No vault registered with name '${args.vaultName}'. Try 'lyt vault list'.`);
    }
    const provider = resolveProvider(db, opts);

    const canShare = await provider.canShare(row);

    if (opts.canIShareOnly === true) {
      return { vault: row.name, grants: [], subscribers: [], drift: null, canShare };
    }

    const grants = await provider.listAccess(row);
    const subRows = await listSubscriptionsForExternalVault(db, row.rid);
    const subscribers: SubscriberView[] = [];
    for (const s of subRows) {
      const subscribingMesh = await getMeshByRid(db, s.meshRid);
      subscribers.push({
        meshRidHex: s.meshRidHex,
        subscribingMeshName: subscribingMesh?.name ?? s.meshRidHex,
      });
    }

    const drift: AccessDrift = {
      ghGrantCount: grants.length,
      subscriptionCount: subscribers.length,
      ghOnly: grants.length > 0 && subscribers.length === 0,
      subscriptionsWithoutGhAccess: subscribers.length > 0 && grants.length === 0,
    };

    return { vault: row.name, grants, subscribers, drift, canShare };
  } finally {
    if (owns) await closeRegistry(db);
  }
}

async function resolveDb(injected?: Client): Promise<{ db: Client; owns: boolean }> {
  if (injected !== undefined) return { db: injected, owns: false };
  return { db: await openRegistry(), owns: true };
}

function resolveProvider(db: Client, opts: VaultAccessFlowOpts): AccessProvider {
  if (opts.accessProvider !== undefined) return opts.accessProvider;
  return new GhAccessProvider(db, opts.gh !== undefined ? { gh: opts.gh } : {});
}
