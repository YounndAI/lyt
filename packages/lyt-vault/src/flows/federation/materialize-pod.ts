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

import { listFederationStates, readFederationState } from "../../registry/federation-state.js";
import { listVaults } from "../../registry/repo.js";
import { getFederationRepoDir } from "../../util/federation-paths.js";
import type { FederationGhClient } from "../../util/gh-federation.js";
import {
  commitPodRepo,
  materializeVaultPublishable,
  type GitRunner,
  type MaterializeVaultResult,
} from "./vault-publish.js";

// Brief B (B.1) — materialize the WHOLE pod toward a publishable state. The
// init/adopt path calls this LOCAL-ONLY (push + createRemote held); the
// consented sync engine (B.2, in lyt-mesh) reuses the same per-vault +
// pod-commit atoms with push=true via the outbox. Idempotent + non-fatal: a
// missing pod (no federation_state) is a skip, never an error — same posture as
// the lifecycle regen hook (regeneratePodManifestNonFatal). Handle resolution is
// registry-driven (federation_state), matching the regen hook, so it makes no
// gh call on the common path.

export interface MaterializePodOptions {
  handle?: string | undefined;
  // Outward gh-create. B.1 = false (held); B.2 = true. Default false.
  createRemoteIfMissing?: boolean | undefined;
  // Outward push. B.1 = false (held); B.2 = true. Default false.
  push?: boolean | undefined;
  // D34 (OD-LOCALFIRST) — wire vault `origin` remotes. Default true. A no-gh
  // LOCAL init passes false so the provisional handle never reaches a remote
  // URL (connect re-materializes with the real handle + setRemote=true).
  setRemote?: boolean | undefined;
  ghClient?: FederationGhClient | undefined;
  runGit?: GitRunner | undefined;
}

export interface MaterializePodResult {
  skipped: boolean;
  reason?: string;
  handle?: string;
  vaults: MaterializeVaultResult[];
  podCommitted: boolean;
  podPushed: boolean;
  warnings: string[];
}

export async function materializePodLocal(
  db: Client,
  opts: MaterializePodOptions = {},
): Promise<MaterializePodResult> {
  const empty: MaterializePodResult = {
    skipped: true,
    vaults: [],
    podCommitted: false,
    podPushed: false,
    warnings: [],
  };

  let handle = opts.handle;
  if (handle === undefined || handle.length === 0) {
    const states = await listFederationStates(db);
    // 0 → no pod forged yet (skip). >1 → ambiguous multi-handle (deferred per
    // the single-pod assumption); skip rather than guess.
    if (states.length !== 1) return { ...empty, reason: "no-single-pod" };
    handle = states[0]!.handle;
  }
  const state = await readFederationState(db, handle);
  if (state === null) return { ...empty, reason: "no-federation-state" };

  const vaults = (await listVaults(db)).filter((v) => v.status !== "tombstoned");
  const vaultResults: MaterializeVaultResult[] = [];
  for (const v of vaults) {
    const r = await materializeVaultPublishable(v, {
      handle,
      createRemoteIfMissing: opts.createRemoteIfMissing ?? false,
      push: opts.push ?? false,
      setRemote: opts.setRemote ?? true,
      ...(opts.ghClient !== undefined ? { ghClient: opts.ghClient } : {}),
      ...(opts.runGit !== undefined ? { runGit: opts.runGit } : {}),
    });
    vaultResults.push(r);
  }

  // Commit the regenerated pod.yon + identity.yon (a review finding). Caller is expected to
  // have regen'd pod.yon already (the lifecycle regen hook runs before this);
  // the commit captures it so the staged pod is clean-committed, not dirty.
  const podDir = getFederationRepoDir(handle);
  const podCommit = await commitPodRepo(podDir, "chore(lyt): publish pod manifest", {
    push: opts.push ?? false,
    ...(opts.runGit !== undefined ? { runGit: opts.runGit } : {}),
  });

  return {
    skipped: false,
    handle,
    vaults: vaultResults,
    podCommitted: podCommit.committed,
    podPushed: podCommit.pushed,
    warnings: [...podCommit.warnings, ...vaultResults.flatMap((r) => r.warnings)],
  };
}
