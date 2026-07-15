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

import { resolveConfig } from "../util/config.js";
import { getFederationRoot, vaultRepoName } from "../util/federation-paths.js";
import {
  foldFedVaults,
  listFedVaultShards,
  observedMaxHlcFromFedVaultRecords,
  readAllFedVaultRecords,
} from "./federation-vault-ledger-read.js";
import { appendFedVaultActive } from "./federation-vault-ledger-write.js";

// Inc-2 R1 (PROPER FIX) — author-on-mutation for the @FED_VAULT manifest ledger.
//
// A vault rename / move mutates the registry-owned VALUE fields (name /
// home_mesh_rid) but, before this, authored NO ledger event — so the change only
// reached the manifest via the reconcile path (regenerate.reconcileVaultsIntoLedger),
// whose origin-writer guard DROPS a non-head machine's diff. Net effect: a
// machine whose vault_rid's current ledger head is a FOREIGN writer could NEVER
// author a rename/move — a silent lost-update / permanent starvation.
//
// This authors a FRESH `active` @FED_VAULT record on THIS writer's shard at the
// mutation point, seeded ABOVE everything observed across all synced shards (the
// receive rule, via appendFedVaultActive's default stampNext path). A concurrent
// rename/move now competes in proper LWW: the causally-later mutation wins, the
// loser is superseded (not starved). This is a SEPARATE direct-append path — it
// does NOT go through the reconcile, so the origin-writer guard (still needed for
// non-rename registry value drift on the reconcile path) does not block it. The
// two compose: author-on-mutation makes the newer rename win; the guard still
// prevents a stale reconcile from re-authoring an older value (no flip-flop).
export interface AuthorFedVaultMutationArgs {
  // The subject vault's UUIDv7 (hex) — the @FED_VAULT register key.
  vaultRidHex: string;
  // The NEW converged VALUE fields after the mutation.
  vaultName: string;
  homeMeshRidHex: string | null;
  // Test seam — override the pod root (defaults to getFederationRoot()).
  podRoot?: string;
}

// Author a fresh `active` @FED_VAULT for a just-applied vault mutation. Gated on
// the federation ledger being IN USE (≥1 shard) — a non-federated single vault
// has no manifest to converge, so a bare rename authors nothing (no regression,
// no stray ledger files). Best-effort by contract: the caller wraps it non-fatal
// so a manifest-authoring hiccup never fails the registry-canonical mutation
// (convergence self-heals on the next sync).
export function authorFedVaultMutation(args: AuthorFedVaultMutationArgs): void {
  const podRoot = args.podRoot ?? getFederationRoot();
  // No federation ledger yet → nothing to converge into (non-federated vault).
  if (listFedVaultShards(podRoot).length === 0) return;

  const records = readAllFedVaultRecords(podRoot);
  // Receive rule input — seed the new stamp above every hlc observed across all
  // synced shards so a lagging-clock machine's causally-later mutation still wins.
  const observedMaxHlc = observedMaxHlcFromFedVaultRecords(records);
  // Carry the converged `visibility` VALUE from the current live winner (a rename
  // / move does not change visibility); default only when the rid has no live
  // ledger record yet. Mirrors the reconcile's changed-existing arm.
  const live = foldFedVaults(records).find((v) => v.vaultRid === args.vaultRidHex);
  const visibility = live?.visibility ?? resolveConfig().defaultRepoVisibility;

  appendFedVaultActive({
    vaultRid: args.vaultRidHex,
    vaultName: args.vaultName,
    homeMeshRidHex: args.homeMeshRidHex,
    repo: vaultRepoName(args.vaultName),
    visibility,
    // R1 (FIX 2) — constant `active` presence marker; reachability is machine-local.
    status: "active",
    observedMaxHlc,
    ...(args.podRoot !== undefined ? { podRoot: args.podRoot } : {}),
  });
}
