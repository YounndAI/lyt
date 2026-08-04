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
import { existsSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listVaults } from "../registry/repo.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { isValidGhHandle } from "../util/identity.js";
import type { FederationGhClient } from "../util/gh-federation.js";
import type { GhExecutor } from "../util/gh-discover.js";
import type { MeshGhClient } from "../util/gh-mesh.js";
import { federationInitFlow, type FederationInitBranch } from "./federation/init.js";
import { regeneratePodManifestNonFatal } from "./federation/regenerate.js";
import {
  recoverVaultsFromPodManifest,
  type RecoverDrop,
  type RecoverPodResult,
  type VaultCloneFn,
} from "./federation/recover-pod.js";
import {
  computeAutoDecisions,
  discoverFlow,
  orchestrateClusters,
  type ClusterDecision,
  type ClusterOutcome,
} from "./discover.js";
import type { AdoptCloneFn } from "./mesh-adopt-cluster.js";
import type { SubscribeCloneFn } from "./subscribe.js";
import { meshInitFlow } from "./mesh-init.js";
import { rebuildVaultFlow } from "./rebuild-vault.js";
import { reflectInboundIndex } from "./reflect-index.js";
import { reconcileMeshLinks } from "./mesh-link-reconcile.js";
import { healPatterns } from "../util/pattern-paths.js";
import { getFederationRepoDir, vaultRepoName } from "../util/federation-paths.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import {
  deriveCreationOperationIdV1,
  plannedSingleVaultEffectsV1,
  resolveCreationPlanV1,
  withCreationRepositoryEffectsV1,
} from "./creation-plan.js";
import { resolveVaultPath } from "../util/paths.js";
import { createLocalCheckpoint } from "../scaffold/local-checkpoint.js";
import { getMachineId } from "../util/writer-id.js";

// W2.1 / W2.2 (2026-06-03) — adopt-and-prime. The "never-fail, adopt instead
// of halt" flow that replaces the wizard P7 halt (DF-2) + the spec decision
// tree (2026-06-03-init-redesign-self-healing-adopt-flow.md §"Desired init
// decision tree" steps 2-4). It composes EXISTING lyt-vault primitives — the
// spec's finding was "adopt-and-prime ≈ wiring these in", not new build:
//
// 2. Pod — federationInitFlow: remote {handle}/lyt-pod exists → CLONE
// (branch "adopted"); absent → CREATE (branch "fresh"). Either
// way the pod ends up cloned/forged + registered locally.
// 3. Vaults — discoverFlow (gh-walk for the user's lyt-* repos) +
// orchestrateClusters auto-adopting the user's OWN
// (push-permitted) clusters. 'external' subscriptions are
// deferred to an explicit `lyt mesh subscribe` (no primary mesh
// exists yet to subscribe into on a fresh adopt). Pod + NO
// vaults acquired → scaffold the first vault + mesh
// (personal/main).
// 4. Re-index — Lane M backfillFigmentCaches on every touched vault so an
// adopt leaves search FRESH, not stale (W2.2).
//
// NEVER-FAIL: the gh-walk acquisition + the per-vault reconcile are each
// wrapped so an offline / gh-down / single-vault failure degrades to a
// surfaced note rather than aborting the adopt. A complete `~/lyt` is the
// invariant on every branch — no partial state, no halt.
//
// pod.yon now LISTS the local registry's meshes + vaults (derived), but it
// reflects what's ALREADY registered locally — not the remote repos to acquire.
// Acquisition therefore still goes through the gh-walk (discoverFlow); the
// end-of-flow regen below then refreshes pod.yon from the post-acquisition
// registry.

export interface AdoptAndPrimeArgs {
  // Pod owner handle. Defaults to the identity-resolved handle inside
  // federationInitFlow when omitted.
  handle?: string | undefined;
  // Open-once registry seam.
  registryDb?: Client | undefined;
  // Injectable seams (real CLI uses defaults; tests pass fakes).
  federationGhClient?: FederationGhClient | undefined;
  ghExecutor?: GhExecutor | undefined;
  meshGhClient?: MeshGhClient | undefined;
  adoptCloneFn?: AdoptCloneFn | undefined;
  subscribeCloneFn?: SubscribeCloneFn | undefined;
  // Skip the gh-walk vault acquisition (offline / no-gh path). Pod adopt +
  // personal/main fallback + reconcile still run.
  skipDiscover?: boolean | undefined;
  // Brief B (B.5 / a review finding) — injectable clone seam for the pod.yon-driven
  // recovery (tests pass a fake that drops a vault.yon). Default git-clones each
  // @FED_VAULT repo.
  vaultCloneFn?: VaultCloneFn | undefined;
  // Skip the Lane M FTS reconcile of touched vaults (perf / test seam).
  skipReconcile?: boolean | undefined;
  // Hold the push on the scaffolded first vault (default true — handler
  // controls the push; the wizard always passes noPush).
  noPush?: boolean | undefined;
}

export interface AdoptAndPrimeResult {
  podBranch: FederationInitBranch;
  podLocalPath: string;
  podHandle: string;
  // Number of vault members acquired from gh via discover/orchestrate.
  vaultsAcquired: number;
  // Brief B (B.5 / a review finding) — vaults recovered from the cloned pod.yon manifest
  // (the authoritative acquisition on an adopted pod; 0 on a fresh pod).
  vaultsRecoveredFromManifest: number;
  // V-A-11 fix-pass (MF4) — completeness honesty for the --auto adopt path: the
  // raw skipped[] (with reasons) so the command layer can classify real clone
  // FAILURES (vs benign tombstoned/already-registered skips) and surface a partial
  // restore LOUDLY rather than as a swallowed console.error. [] on a fresh pod
  // (recovery never runs). The honest "expected" denominator is recovered + the
  // failure-reason skips — computed at the command layer, not a raw manifest total.
  manifestSkipped: { vaultName: string; reason: string }[];
  // G1 (0.12.1) — vaults the reconstruction clone-walk DROPPED (classified:
  // owner-misresolved vs repo-moved). Non-empty ⇒ the reconstruction is
  // INCOMPLETE; the command/wizard layer surfaces it loudly + exits nonzero
  // (reconstructionExitCode). Optional: absent on a fresh pod / non-adopt paths.
  manifestDrops?: RecoverDrop[];
  // Fail-closed refusal from recover-pod. The kind distinguishes manifest
  // incoherence from failed ownership authentication; the reason already
  // carries the correct remedy for callers to relay verbatim.
  manifestRefused?: boolean;
  manifestRefusedKind?: RecoverPodResult["refusedKind"];
  manifestRefusedReason?: string;
  clusterOutcomes: ClusterOutcome[];
  // True when no vaults were acquirable and personal/main was scaffolded.
  firstVaultCreated: boolean;
  // The primary vault selected for downstream onboarding.
  primaryVaultPath: string | null;
  primaryMeshName: string | null;
  // Paths the Lane M reconcile freshened.
  reconciledVaultPaths: string[];
}

export async function adoptAndPrimeFlow(
  args: AdoptAndPrimeArgs = {},
): Promise<AdoptAndPrimeResult> {
  const ownDb = args.registryDb === undefined;
  const db = args.registryDb ?? (await openRegistry());
  const noPush = args.noPush ?? true;

  try {
    // POD-level pattern resolution on the ADOPT path. mesh-init heals patterns
    // on the FRESH path, but adopt clones an existing pod and — when pod.yon
    // recovers the user's vaults — never calls meshInitFlow, so a lost-laptop
    // adopt landed with an EMPTY ~/lyt/patterns/ (the recurring HANDOFF-006 bug,
    // re-seen 2026-06-05). healPatterns is the version-gated, additive-safe
    // resolver: add missing, replace pristine-older (with backup), leave forks.
    // Idempotent + pod-scoped, so firing it here is safe and makes patterns
    // present + current after BOTH fresh and adopt inits.
    healPatterns();

    // 2. Adopt-or-forge the pod repo (no halt on existing pod — the DF-2 fix).
    const fed = await federationInitFlow({
      ...(args.handle !== undefined ? { handle: args.handle } : {}),
      pushToRemote: false,
      createRemoteIfMissing: false,
      db,
      ...(args.federationGhClient !== undefined ? { ghClient: args.federationGhClient } : {}),
    });
    const handle = fed.handle;

    // 3a-manifest (Brief B / a review finding) — when the pod was ADOPTED (cloned from a
    // published pod), recover the rest of the pod FROM pod.yon: clone each
    // @FED_VAULT repo + register it (rid preserved), meshes first. This is the
    // authoritative acquisition (the user's own manifest); the gh-walk below is
    // a supplementary discovery for repos pod.yon may omit. Non-fatal: a
    // recovery failure degrades to the gh-walk. Skipped on a FRESH pod (its
    // pod.yon is an empty skeleton — nothing to recover).
    let vaultsRecoveredFromManifest = 0;
    // MF4 — raw skipped[] threaded up for recovered-of-expected honesty (the
    // command layer classifies failure-reason skips → loud partial-restore line).
    let manifestSkipped: { vaultName: string; reason: string }[] = [];
    // G1 — classified clone-walk DROPS threaded up for the nonzero-exit surface.
    let manifestDrops: RecoverDrop[] = [];
    // Fail-closed refusal signal from recover-pod.
    let manifestRefused = false;
    let manifestRefusedKind: RecoverPodResult["refusedKind"];
    let manifestRefusedReason: string | undefined;
    if (fed.branch === "adopted") {
      try {
        const recovered = await recoverVaultsFromPodManifest({
          handle,
          registryDb: db,
          ...(args.vaultCloneFn !== undefined ? { cloneFn: args.vaultCloneFn } : {}),
          ...(args.ghExecutor !== undefined ? { ghExecutor: args.ghExecutor } : {}),
        });
        vaultsRecoveredFromManifest = recovered.vaultsRecovered.length;
        manifestSkipped = recovered.skipped;
        manifestDrops = recovered.drops;
        manifestRefused = recovered.refused === true;
        manifestRefusedKind = recovered.refusedKind;
        manifestRefusedReason = recovered.refusedReason;
        for (const w of recovered.warnings) {
          // eslint-disable-next-line no-console
          console.error(`lyt adopt: pod.yon recovery — ${w}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`lyt adopt: pod.yon-driven recovery failed non-fatally — ${msg}`);
      }
    }

    // Any recover-pod refusal is fail-closed before discovery/scaffold. The
    // source-generated reason differentiates manifest repair from GitHub
    // authentication/permission, so do not reinterpret it here.
    if (manifestRefused) {
      // eslint-disable-next-line no-console
      console.error(
        `lyt adopt: reconstruction REFUSED — stopping before vault discovery/scaffold. ` +
          `${manifestRefusedReason ?? ""}`.trimEnd(),
      );
      return {
        podBranch: fed.branch,
        podLocalPath: fed.localPath,
        podHandle: handle,
        vaultsAcquired: 0,
        vaultsRecoveredFromManifest,
        manifestSkipped,
        manifestDrops,
        manifestRefused: true,
        ...(manifestRefusedKind !== undefined ? { manifestRefusedKind } : {}),
        ...(manifestRefusedReason !== undefined ? { manifestRefusedReason } : {}),
        clusterOutcomes: [],
        firstVaultCreated: false,
        primaryVaultPath: null,
        primaryMeshName: null,
        reconciledVaultPaths: [],
      };
    }

    // 3b. Acquire the user's OWN vaults from gh (discover → auto-adopt only).
    // Supplements the pod.yon recovery (idempotent — already-registered vaults
    // are skipped). The gh-walk catches repos pod.yon omits + first-time adopts.
    const clusterOutcomes: ClusterOutcome[] = [];
    // R3 release review fix-pass — defense-in-depth: NEVER walk gh with a handle
    // that isn't a valid GitHub username. A poisoned `identity.yon` from a
    // cloned pod (W2.3 recovery) could seed a metachar-bearing handle; the
    // spawn layer is hardened, but mirror the wizard probe's pre-spawn guard
    // here too. A malformed handle → skip acquisition (the pod is adopted).
    if (args.skipDiscover !== true && !isValidGhHandle(handle)) {
      // eslint-disable-next-line no-console
      console.error(
        `lyt adopt: skipping gh vault-discovery — handle ${JSON.stringify(handle)} is not a valid GitHub username.`,
      );
    } else if (args.skipDiscover !== true) {
      try {
        const discovered = await discoverFlow({
          owner: handle,
          registryDb: db,
          ...(args.ghExecutor !== undefined ? { ghExecutor: args.ghExecutor } : {}),
        });
        // Only AUTO-ADOPT push-permitted (own) clusters during init; defer
        // 'external' subscriptions to an explicit `lyt mesh subscribe`.
        const auto = computeAutoDecisions(discovered.clusters);
        const adoptOnly = new Map<string, ClusterDecision>(
          [...auto].filter(([, d]) => d === "adopt"),
        );
        if (adoptOnly.size > 0) {
          const orch = await orchestrateClusters({
            clusters: discovered.clusters,
            decisions: adoptOnly,
            owner: handle,
            primaryMeshName: "personal",
            registryDb: db,
            noPush,
            ...(args.ghExecutor !== undefined ? { ghExecutor: args.ghExecutor } : {}),
            ...(args.meshGhClient !== undefined ? { meshGhClient: args.meshGhClient } : {}),
            ...(args.adoptCloneFn !== undefined ? { adoptCloneFn: args.adoptCloneFn } : {}),
            ...(args.subscribeCloneFn !== undefined
              ? { subscribeCloneFn: args.subscribeCloneFn }
              : {}),
          });
          clusterOutcomes.push(...orch.outcomes);
        }
      } catch (err) {
        // Non-fatal (offline / gh down) — never-fail. The pod is adopted; the
        // user can run `lyt discover` later to acquire vaults.
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`lyt adopt: vault discovery failed non-fatally — ${msg}`);
      }
    }

    // 3b. Pod + NO vaults acquired → scaffold the first vault + mesh.
    let firstVaultCreated = false;
    let primaryVaultPath: string | null = null;
    let primaryMeshName: string | null = null;
    const afterAcquire = await listVaults(db);
    if (afterAcquire.length === 0) {
      // R1 release review fix-pass (introduced-Critical): a torn prior init can
      // commit an orphan `personal` mesh row (insertMesh auto-commits BEFORE
      // the vault is registered). meshInitFlow's duplicate-name guard would
      // THROW on that, halting a re-run — violating "an interrupted init
      // self-heals on re-run". Guard: only scaffold when no `personal` mesh
      // exists, and wrap the scaffold so any failure is non-fatal (never-fail).
      // A pre-existing torn mesh is LEFT for `lyt doctor`/repair — init still
      // completes without halting (the demo phase tolerates a null vault path).
      const existingPersonal = await getMeshByName(db, "personal");
      if (existingPersonal === null) {
        try {
          const creation = await localMeshCreation(db, "personal");
          const mesh = await meshInitFlow({
            name: "personal",
            noPush,
            creation: {
              destinationRequest: creation.request,
              creationPlan: creation.plan,
              attemptId: creation.attemptId,
            },
            // Open-once seam (A.4): reuse the adopt flow's registry connection.
            db,
            ...(args.meshGhClient !== undefined ? { ghClient: args.meshGhClient } : {}),
          });
          firstVaultCreated = true;
          primaryVaultPath = mesh.mainVault.path;
          primaryMeshName = "personal";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`lyt adopt: personal/main scaffold failed non-fatally — ${msg}`);
          primaryMeshName = "personal";
        }
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `lyt adopt: a 'personal' mesh already exists but has no acquirable vault ` +
            `(likely a torn prior init). Leaving it for repair — run 'lyt doctor'. ` +
            `Init completes without halting.`,
        );
        primaryMeshName = "personal";
      }
    } else {
      const sorted = [...afterAcquire].sort((a, b) => a.name.localeCompare(b.name));
      primaryVaultPath = sorted[0]!.path;
      primaryMeshName = sorted[0]!.name.split("/")[0] ?? null;
    }

    // V-B-4 fix-pass (2026-06-09) — derive the MESH-SIDE links inline. The
    // acquisition above set each recovered vault's vault-side `home_mesh_rid`
    // (registerVaultFromYon) but NOT the mesh_vaults `home` rows / `mesh.main_vault`
    // that writability + `mesh info` + `mesh list` read from — so a fresh adopt
    // landed `writable: unknown` (push blocked) + dead mesh-info. reconcileMeshLinks
    // is the shared, idempotent reconciler (see flows/mesh-link-reconcile.ts); it
    // runs BEFORE the pod.yon regen below so the regenerated manifest reflects the
    // healed main_vault. Non-fatal (never-fail posture): a reconcile failure
    // degrades to a surfaced note, never aborts the adopt.
    try {
      const reconciled = await reconcileMeshLinks(db);
      for (const r of reconciled) {
        if (r.error !== undefined) {
          // eslint-disable-next-line no-console
          console.error(
            `lyt adopt: mesh-link reconcile of ${r.meshName} failed non-fatally ` +
              `(other meshes still healed) — ${r.error}. Run 'lyt repair' to inspect.`,
          );
        } else if (r.homeRowsAdded.length > 0 || r.mainVaultSet !== null) {
          // eslint-disable-next-line no-console
          console.error(
            `lyt adopt: mesh-link reconcile — ${r.meshName}: ` +
              `+${r.homeRowsAdded.length} home row(s)` +
              `${r.mainVaultSet !== null ? `, main_vault=${r.mainVaultSet}` : ""}.`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`lyt adopt: mesh-link reconcile failed non-fatally — ${msg}`);
    }

    // 4. Re-index received vaults by reflecting their committed YON + markdown
    // into machine-local caches. Re-clustering here rewrites tracked lanes.yon /
    // arcs.yon and dirties a freshly cloned vault. Only a locally scaffolded
    // fallback vault needs a full rebuild because it has no received index SoT.
    const reconciledVaultPaths: string[] = [];
    if (args.skipReconcile !== true) {
      const finalVaults = await listVaults(db);
      for (const v of finalVaults) {
        if (v.status === "tombstoned") continue;
        try {
          if (firstVaultCreated && v.path === primaryVaultPath) {
            await rebuildVaultFlow({ vault: v.name, registryDb: db });
          } else {
            await reflectInboundIndex(v.name, v.path);
          }
          reconciledVaultPaths.push(v.path);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`lyt adopt: reconcile of ${v.name} failed non-fatally — ${msg}`);
        }
      }
    }

    const vaultsAcquired =
      vaultsRecoveredFromManifest +
      clusterOutcomes
        .filter((o) => o.status === "adopted" || o.status === "external")
        .reduce((n, o) => n + o.membersProcessed, 0);

    // (Brief A) — regenerate the derived pod manifest from the now-populated
    // registry so the adopt leaves a POPULATED pod.yon (federationInitFlow at
    // step 2 wrote only the skeleton, BEFORE vaults were acquired/scaffolded —
    // the root cause of the empty-manifest dogfood symptom). Non-fatal; reuses
    // the open registry.
    // A cloned pod is already the recovery source of truth. Do not rewrite its
    // manifest or materialize migration ledgers during absorption; an explicit
    // later sync owns any publication-facing regeneration.
    if (fed.branch !== "adopted") {
      await regeneratePodManifestNonFatal(db, { handle });
    } else {
      const paths = [`ledger/machines/${getMachineId()}.yon`];
      if (existsSync(join(fed.localPath, "identity.yon"))) paths.push("identity.yon");
      const checkpoint = createLocalCheckpoint(fed.localPath, paths);
      if (checkpoint.status !== "committed") {
        throw new Error(
          `lyt adopt: could not checkpoint the local machine registration (${checkpoint.status}).`,
        );
      }
    }

    return {
      podBranch: fed.branch,
      podLocalPath: fed.localPath,
      podHandle: handle,
      vaultsAcquired,
      vaultsRecoveredFromManifest,
      manifestSkipped,
      manifestDrops,
      clusterOutcomes,
      firstVaultCreated,
      primaryVaultPath,
      primaryMeshName,
      reconciledVaultPaths,
    };
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}

async function localMeshCreation(db: Client, meshName: string) {
  const attemptId = uuid7BytesToDashedString(newUuidv7Bytes());
  const request = { kind: "local" } as const;
  const podRows = await db.execute(
    "SELECT handle, lower(hex(fed_rid)) AS rid FROM federation_state ORDER BY handle LIMIT 2",
  );
  if (podRows.rows.length !== 1) {
    throw new Error("Adopt mesh creation requires exactly one real local pod identity.");
  }
  const handle = String(podRows.rows[0]!["handle"]);
  const subject = { kind: "mesh" as const, repositoryName: vaultRepoName(`${meshName}/main`) };
  const operationId = deriveCreationOperationIdV1({
    request,
    subject,
    scope: `adopt:${meshName}/main\0${resolveVaultPath(`${meshName}/main`)}`,
  });
  const resolved = resolveCreationPlanV1({
    request,
    subject,
    actor: {
      attempt_id: attemptId,
      observed_at: new Date().toISOString(),
      result: "unknown",
      actor: null,
      evidence_class: "unavailable",
    },
    intendedEffects: withCreationRepositoryEffectsV1(
      plannedSingleVaultEffectsV1({
        operationId,
        pod: { kind: "existing", rid: String(podRows.rows[0]!["rid"]) },
        mesh: { kind: "create", name: meshName },
        vaultName: `${meshName}/main`,
        vaultRoot: resolveVaultPath(`${meshName}/main`),
      }),
      [{ repositoryRoot: getFederationRepoDir(handle), exactPaths: ["pod.yon"] }],
    ),
  });
  if (resolved.kind === "refusal") throw new Error(resolved.message);
  return { request, plan: resolved.plan, attemptId };
}
