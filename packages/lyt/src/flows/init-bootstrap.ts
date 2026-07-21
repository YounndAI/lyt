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

// v1.B.4 — `lyt init` bootstrap flow.
//
// Composes existing sub-flows from @younndai/lyt-vault (meshInitFlow,
// federationInitFlow) into an idempotent + re-runnable bootstrap with
// three branches selected by local-state probe + the --discover flag.
//
// Source: lyt-master-plan §v1.B.4:538-557 + lyt-federation-design.md
// §5:209-241 (probe order + branch table) + brief
// 2026-05-31-v1-b-4-lyt-init-bootstrap.md.
//
// Branch decision (per federation-design §5 + brief ):
// 1. mode === 'discover' (set by --discover flag) → DISCOVERY
// 2. meshes count == 0 && vaults count == 0 → FRESH
// 3. otherwise (registry has ≥1 mesh OR ≥1 vault) → RE-INIT
//
// Lives in the meta package (`packages/lyt/src/flows/`) — composing
// flows from lyt-vault here would create a logical inversion (lyt-vault
// would depend on its own composition). The meta package is the
// natural composer; this flow file is the FIRST member of packages/lyt's
// flows/ directory.
//
// Open-once `registryDb?` seam from line 1 per v1.A.5 CR-B1 (10th
// application across v1.A.5 → v1.D.* → v1.B.* lineage).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "@libsql/client";

import {
  adoptAndPrimeFlow,
  backfillFigmentCaches,
  closeRegistry,
  deriveCreationOperationIdV1,
  deriveProvisionalHandle,
  federationInitFlow,
  finalizeInitialCheckpoint,
  federationRepoName,
  getFederationRepoDir,
  getHandleFromIdentity,
  getMeshByRid,
  hexToUuid7Bytes,
  inspectRegistryTopologyPreflight,
  isProvisionalIdentity,
  isValidGhHandle,
  listMeshes,
  listFederationStates,
  listVaults,
  meshInitFlow,
  newUuidv7Bytes,
  observeActiveActor,
  openRegistry,
  plannedSingleVaultEffectsV1,
  parseVaultYon,
  readIdentityCache,
  realFederationGhClient,
  regeneratePodManifestFlow,
  resolveCreationPlanV1,
  withCreationRepositoryEffectsV1,
  resolveVaultPath,
  uuid7BytesToDashedString,
  vaultRepoName,
  writeProvisionalIdentity,
  type AdoptAndPrimeResult,
  type FederationGhClient,
  type FederationInitBranch,
  type GhExecutor,
  type MaterializePodResult,
  type MeshGhClient,
  type ActiveActorObservation,
  type CreationMutationEvidence,
  type CreationPlanV1,
  type DestinationRequest,
  type RecoverDrop,
  type RecoverPodResult,
  type VaultCloneFn,
} from "@younndai/lyt-vault";

import type { HealResult } from "./heal.js";

export type InitBootstrapBranch = "fresh" | "re-init" | "discovery" | "adopt";

export type IntegrityStatus = "ok" | "missing" | "unparseable" | "orphaned-home-mesh";

export interface IntegrityIssue {
  vaultName: string;
  status: IntegrityStatus;
  error?: string;
}

export type DiscoveredRepoKind = "lyt-prefix" | "lyt-public-topic";

export interface DiscoveredRepo {
  fullName: string;
  kind: DiscoveredRepoKind;
  alreadyInRegistry: boolean;
}

export interface DiscoveryProbeResult {
  // The probe returns ALL candidate repos visible to the authenticated
  // gh user. Filtering / dedup / registry cross-check is the bootstrap
  // flow's responsibility (so the probe stays narrow + injectable).
  repos: DiscoveredRepo[];
}

export interface DiscoveryProbe {
  // Probes the authenticated user's accessible repos via `gh api`.
  // Implementations may walk `/user/repos --paginate` then per-repo
  // topic queries. v1.B.4's default impl skips the per-repo
  // `.lyt/vault.yon` probe (deferred to v1.C.3) for fast happy-path
  // discovery.
  probe(handle: string): Promise<DiscoveryProbeResult>;
}

export interface InitBootstrapMeshAssignment {
  meshRidHex: string;
  meshName: string;
  meshAutoCreated: boolean;
  // v1.GP F7-followup — the scaffolded main vault's name + on-disk path,
  // surfaced so the command layer can render the WS2 pod card on `--auto`
  // without re-deriving the path. Populated by the FRESH branch.
  mainVaultName?: string;
  mainVaultPath?: string;
}

export interface InitBootstrapFederation {
  handle: string;
  fedRidHex: string;
  branch: FederationInitBranch;
  localPath: string;
  federationYonPath: string;
  remoteCreated: boolean;
  pushed: boolean;
  // the full `{handle}/lyt-pod` repo name, sourced from the
  // federation flow's chokepoint (federationRepoName) so the emit layer
  // never hardcodes the repo-name literal.
  remoteFullName: string;
}

// V-A-11 fix-pass — the ADOPT branch payload (mapped subset of the lyt-vault
// engine's AdoptAndPrimeResult). Populated when a fresh-state `lyt init --auto`
// (or headless first-init) found a remote `{handle}/lyt-pod` and routed to
// adoptAndPrimeFlow instead of scaffolding an empty fresh pod. `manifestSkipped`
// carries MF4 completeness honesty — the command layer classifies its failure
// reasons into the recovered-of-expected denominator + a loud partial-restore line.
export interface InitBootstrapAdopt {
  podBranch: FederationInitBranch;
  podHandle: string;
  podLocalPath: string;
  vaultsRecoveredFromManifest: number;
  vaultsAcquired: number;
  manifestSkipped: { vaultName: string; reason: string }[];
  // Classified clone-walk drops. Non-empty means reconstruction was
  // semantically incomplete even when the flow returned a structured result.
  manifestDrops?: RecoverDrop[];
  // Fail-closed recover-pod refusal. The kind distinguishes semantic invalidity
  // from failed ownership authentication; the reason carries its exact remedy.
  manifestRefused?: boolean;
  manifestRefusedKind?: RecoverPodResult["refusedKind"];
  manifestRefusedReason?: string;
  firstVaultCreated: boolean;
  primaryVaultPath: string | null;
  primaryMeshName: string | null;
  reconciledVaultPaths: string[];
}

export interface InitBootstrapResult {
  branch: InitBootstrapBranch;
  // FRESH branch — populated when the bootstrap composed a personal mesh
  // scaffold + federation forge.
  meshAssignment?: InitBootstrapMeshAssignment;
  federation?: InitBootstrapFederation;
  // RE-INIT branch — populated with one row per registered vault. An
  // empty array means all vaults probed cleanly.
  integrityIssues?: IntegrityIssue[];
  // DISCOVERY branch — populated with the filtered + cross-checked +
  // SORTED (Lock 0.3 deterministic) repo list.
  discoveredRepos?: DiscoveredRepo[];
  // ADOPT branch (V-A-11) — populated when a fresh-state --auto/headless init
  // routed to adoptAndPrimeFlow (a remote `{handle}/lyt-pod` existed) and cloned
  // the pod's content instead of scaffolding an empty fresh pod.
  adopt?: InitBootstrapAdopt;
  // ADOPT failure (V-A-11 / a review finding) — populated when adopt was attempted
  // (branch === "adopt") but the pod/vault clone threw. The flow NEVER throws on
  // adopt (resilience-core): it returns this structured reason so the command
  // layer renders an AI-actionable error + a clean non-zero exit instead of a raw
  // stack, and leaves the registry empty so a re-run re-probes + re-adopts.
  adoptError?: { reason: string };
  // W1.2 — populated when a heal runner was supplied AND the branch healed
  // (fresh + re-init only; discovery is read-only so never heals).
  heal?: HealResult;
  // W2.2 — Lane M FTS reconcile of on-disk vaults so a `lyt init` re-run
  // leaves search FRESH (fresh: the new vault; re-init: every healthy vault).
  reconciledVaultPaths?: string[];
  // Brief B (B.1) — populated when a materialize-publish runner was supplied AND
  // the fresh branch materialized. Reports
  // what was made publishable (per-vault git/commit/remote, pod commit). At init
  // this is LOCAL-only (push held); the honest card (B.3) reads it.
  publish?: MaterializePodResult;
  /** Exact fresh-creation plan plus observed local effects for Receipt V1. */
  creation?: {
    plan: CreationPlanV1;
    mutations: CreationMutationEvidence;
    podCheckpointCommitSha?: string;
  };
  durationMs: number;
}

export type InitBootstrapMode = "auto" | "custom" | "discover";

interface BootstrapPodIdentity {
  handle: string;
  rid: string;
}

interface PreparedFreshCreation {
  meshName: string;
  handle: string;
  provisionalHandle: string | null;
  attemptId: string;
  destinationRequest: DestinationRequest;
  planned: Extract<ReturnType<typeof resolveCreationPlanV1>, { kind: "plan" }>;
}

export interface InitBootstrapCustomOverrides {
  meshName?: string;
  pushTarget?: string;
  starterFigment?: boolean;
}

export interface InitBootstrapArgs {
  mode: InitBootstrapMode;
  meshGhClient?: MeshGhClient;
  federationGhClient?: FederationGhClient;
  // V-A-11 — injectable clone seam threaded to adoptAndPrimeFlow's pod.yon-driven
  // recovery so the ADOPT branch's partial-restore behaviour (MF4/SC8) is testable
  // hermetically (a fake that fails one vault clone). Undefined in production
  // (defaults to a real git clone inside the engine).
  vaultCloneFn?: VaultCloneFn;
  // Reuse adoptAndPrimeFlow's GitHub executor seam for manifest ownership
  // authentication. Undefined in production, where lyt-vault uses live `gh`.
  ghExecutor?: GhExecutor;
  // Open-once `registryDb?` seam: when supplied, the flow uses the
  // caller's already-open libSQL client and DOES NOT close it. v1.A.5
  // CR-B1 invariant.
  registryDb?: Client;
  nowIso?: string;
  // Injectable seam for DISCOVERY branch — the default impl (when not
  // injected) returns an empty probe (zero discovered repos). The
  // production `gh api /user/repos` impl ships in v1.C.3 when the
  // discover-as-network surface lands; v1.B.4 keeps discovery wired
  // structurally + relies on injection in tests.
  discoveryProbe?: DiscoveryProbe;
  // Override the authenticated handle (test seam + future BYOK).
  handle?: string;
  /** One bounded, fresh actor observation for the fresh creation attempt. */
  observeActor?: typeof observeActiveActor;
  customOverrides?: InitBootstrapCustomOverrides;
  // W1.2 heal runner. When supplied, the flow runs it on the fresh +
  // re-init branches (NOT discovery, which is read-only) so a single
  // `lyt init` re-aligns skills + agent manual + patterns. INJECTABLE so unit
  // tests stay hermetic (no real ~/.claude / ~/.codex / ~/.agents writes): the
  // CLI command wires the real `healPod()`; tests omit it (no heal runs). Heal
  // failure is swallowed (never-fail) — see runHealIfProvided.
  heal?: (() => Promise<HealResult>) | undefined;
  // Deprecated compatibility seam. Fresh `lyt init` no longer invokes a
  // materializer: remote attachment/publication belongs exclusively to scoped
  // `lyt sync --vault`, after an explicit Handler decision.
  materializePublish?: ((db: Client) => Promise<MaterializePodResult>) | undefined;
  // Re-init production seam: refresh the existing pod repository and recover
  // newly advertised vaults before integrity/index work. Tests omit it.
  refreshExistingPod?: ((db: Client) => Promise<void>) | undefined;
  // v1.GP F7-followup — phase-boundary hook for the command layer's
  // phase-spanning spinner. Invoked (and awaited) at each FRESH-branch phase
  // boundary so the command can re-label its persistent spinner + yield to
  // the event loop (`setImmediate`) so the render interval fires at the
  // boundary. No-op when not supplied (tests, --json, re-init/discovery).
  // The `op` mirrors util/spinner.ts SpinnerOp (string-typed here to avoid a
  // lyt-vault type import in the meta package's flow signature).
  onPhase?: (op: string, label: string) => void | Promise<void>;
}

// v1.G.13 Gap 1 — fresh-state probe exposed for the meta CLI's no-flag
// wizard auto-route. Reuses the SAME predicate that initBootstrapFlow's
// internal branch decision uses (line 158): meshes.length === 0 && vaults
// .length === 0 → fresh. Lifting it as a public helper avoids duplicating
// the detector in init.ts per project rule #9.
export async function probeFreshState(registryDb?: Client): Promise<boolean> {
  if (registryDb === undefined) {
    const topology = inspectRegistryTopologyPreflight();
    return topology.meshCount === 0 && topology.vaultCount === 0;
  }
  const meshes = await listMeshes(registryDb);
  const vaults = await listVaults(registryDb);
  return meshes.length === 0 && vaults.length === 0;
}

// MF1 (V-A-11) — shared PROVISIONAL-cache test (read-only, no side effects). True
// when the identity cache is provisional: this machine inited LOCAL-ONLY (gh
// absent/unauthed) before. This predicate unifies the `isProvisionalIdentity` CHECK
// across the three sites (adopt router, doFreshBranch, init.ts isLocalFirstContext)
// — but each site COMPOSES it differently, and that is INTENTIONAL (a review finding): the
// router gates on this ALONE (any provisional cache ⇒ never auto-adopt,
// handle-agnostic — the safer default), while doFreshBranch ALSO requires
// `cached.handle === handle` before going local-only. So the provisional TEST
// cannot drift; the surrounding local-first DECISION is deliberately per-site.
// Returns false on a null / non-provisional (gh-cli) cache.
export function resolveLocalFirst(cached: ReturnType<typeof readIdentityCache>): boolean {
  return cached !== null && isProvisionalIdentity(cached);
}

// V-A-11 / MF1 — decide whether a FRESH-state init should ADOPT a remote pod
// (clone its content) instead of scaffolding an empty fresh pod. Returns the
// handle to adopt under, or null to fall through to `fresh`.
//
// Resilience-core (MF1): the gh probe is GUARDED. `repoExists` returns false ONLY
// on HTTP 404 and THROWS on everything else (no-gh ENOENT, auth, network, 5xx —
// gh-federation.ts:289-294). Any throw degrades to null (→ fresh), so a transient
// gh failure NEVER aborts the common fresh init. A provisional local-first cache
// short-circuits BEFORE any probe (a returning local-first user is never gh-probed).
async function probeAdoptable(args: InitBootstrapArgs): Promise<string | null> {
  // Gate: a provisional identity cache ⇒ local-first returner ⇒ never probe.
  if (resolveLocalFirst(readIdentityCache())) return null;
  // Resolve the handle (explicit override → identity → null/gh-less ⇒ fresh).
  const handle = args.handle ?? safeIdentityResolve();
  if (handle === null) return null;
  // a review finding (release review fix-pass) — defense-in-depth: NEVER reach a `gh` spawn with
  // a handle that isn't a valid GitHub username. The handle can come from a
  // hand-editable identity cache / LYT_IDENTITY_OVERRIDE; repoExists interpolates it
  // into `gh api /repos/${handle}/lyt-pod`, so a `/`-bearing or metachar handle could
  // reshape the endpoint (or hit the Windows .cmd shell fallback). Mirror the
  // pre-spawn guard every sibling caller enforces (federationInitFlow,
  // recoverVaultsFromPodManifest, the engine's gh-walk). Invalid ⇒ not-adoptable ⇒ fresh.
  if (!isValidGhHandle(handle)) return null;
  // Probe the remote pod, GUARDED — reuse the SAME federationGhClient detection
  // federationInitFlow uses internally (so router + flow cannot disagree).
  const ghClient = args.federationGhClient ?? realFederationGhClient;
  try {
    const exists = await ghClient.repoExists(handle, federationRepoName());
    return exists ? handle : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `lyt init: pod-exists probe failed non-fatally — ${msg}. Proceeding with a fresh init.`,
    );
    return null;
  }
}

export async function initBootstrapFlow(args: InitBootstrapArgs): Promise<InitBootstrapResult> {
  const startedAtMs = nowMs(args.nowIso);

  const ownDb = args.registryDb === undefined;
  // Fresh creation is planned against a physically read-only snapshot.  In
  // particular, a missing registry must not be created or migrated merely to
  // decide what identities/effects a first `lyt init` will own.
  const readOnlyTopology = ownDb ? inspectRegistryTopologyPreflight() : null;
  let branch: InitBootstrapBranch | null = null;
  let adoptHandle: string | null = null;
  let preparedFresh: PreparedFreshCreation | null = null;
  if (readOnlyTopology !== null) {
    if (args.mode === "discover") {
      branch = "discovery";
    } else if (readOnlyTopology.meshCount === 0 && readOnlyTopology.vaultCount === 0) {
      adoptHandle = await probeAdoptable(args);
      branch = adoptHandle !== null ? "adopt" : "fresh";
      if (branch === "fresh") {
        preparedFresh = await prepareFreshCreation(args, readOnlyTopology.podIdentities);
      }
    } else {
      branch = "re-init";
    }
  }

  const db = args.registryDb ?? (await openRegistry());

  try {
    // Probe local state ONCE up front.
    const meshes = await listMeshes(db);
    const vaults = await listVaults(db);

    if (
      readOnlyTopology !== null &&
      (readOnlyTopology.meshCount !== meshes.length ||
        readOnlyTopology.vaultCount !== vaults.length)
    ) {
      throw new Error(
        "Bootstrap topology changed after its read-only creation plan; retry lyt init.",
      );
    }

    // Branch decision (federation-design §5 + brief; V-A-11 adds ADOPT).
    if (branch === null && args.mode === "discover") {
      branch = "discovery";
    } else if (branch === null && meshes.length === 0 && vaults.length === 0) {
      // V-A-11 — a FRESH registry prefers ADOPT when a remote `{handle}/lyt-pod`
      // exists (clone its content), else scaffolds a FRESH pod. probeAdoptable is
      // GUARDED (gh flake / no-gh / provisional-local-first → null → fresh), so it
      // never aborts the common fresh path (MF1, SC3/SC7).
      adoptHandle = await probeAdoptable(args);
      branch = adoptHandle !== null ? "adopt" : "fresh";
    } else if (branch === null) {
      branch = "re-init";
    }

    if (branch === "adopt") {
      // adoptHandle is non-null here (branch was set from it).
      const result = await doAdoptBranch(args, db, adoptHandle!);
      // a review finding — on adopt failure surface it cleanly: no heal/materialize, the
      // command layer renders the actionable error + sets a non-zero exit.
      if (result.adoptError !== undefined) {
        return finalize({ ...result, branch }, startedAtMs, args.nowIso);
      }
      // New machine cloning a pod still wants its skills + agent-manuals aligned,
      // so run heal (parity with fresh + the interactive wizard). The flow already
      // ran healPatterns (idempotent, version-gated) — the patterns subset double
      // is a near-noop. Do NOT materialize: adopt clones EXISTING remotes; a
      // materialize-publish would try to forge/commit remotes for already-remote
      // vaults (wrong for adopt + would touch the push surface).
      const heal = await runHealIfProvided(args);
      return finalize(
        {
          ...result,
          branch,
          ...(heal !== null ? { heal } : {}),
        },
        startedAtMs,
        args.nowIso,
      );
    }
    if (branch === "fresh") {
      if (preparedFresh === null) {
        const existingPodIdentities = (await listFederationStates(db)).map((row) => ({
          handle: row.handle,
          rid: row.fedRidHex,
        }));
        preparedFresh = await prepareFreshCreation(args, existingPodIdentities);
      }
      const result = await doFreshBranch(args, db, preparedFresh);
      const heal = await runHealIfProvided(args);
      // Fresh creation is local-only.  Even an injected legacy materializer
      // must not create/attach/push a remote from `lyt init`; scoped sync owns
      // the first outward mutation.
      return finalize(
        {
          ...result,
          branch,
          ...(heal !== null ? { heal } : {}),
        },
        startedAtMs,
        args.nowIso,
      );
    }
    if (branch === "re-init") {
      if (args.refreshExistingPod !== undefined) await args.refreshExistingPod(db);
      const result = await doReInitBranch(db);
      const heal = await runHealIfProvided(args);
      return finalize(
        {
          ...result,
          branch,
          ...(heal !== null ? { heal } : {}),
        },
        startedAtMs,
        args.nowIso,
      );
    }
    // DISCOVERY — read-only; never heals.
    const result = await doDiscoveryBranch(args, db, meshes);
    return finalize({ ...result, branch }, startedAtMs, args.nowIso);
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}

// W2.2 — Lane M FTS reconcile of on-disk vaults so a `lyt init` re-run leaves
// search FRESH. Operates on each vault's OWN libSQL db (under LYT_HOME), so it
// is hermetic + side-effect-local. Per-vault failure is swallowed (never-fail).
async function reconcileVaults(vaultPaths: readonly string[]): Promise<string[]> {
  const reconciled: string[] = [];
  for (const p of vaultPaths) {
    try {
      await backfillFigmentCaches(p);
      reconciled.push(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`lyt init: reconcile of ${p} failed non-fatally — ${msg}`);
    }
  }
  return reconciled;
}

// W1.2 — run the injected heal runner, swallowing any failure so heal can
// NEVER fail an init (never-fail). Returns null when no runner was
// supplied (the hermetic-test default) or when the heal threw.
async function runHealIfProvided(args: InitBootstrapArgs): Promise<HealResult | null> {
  if (args.heal === undefined) return null;
  try {
    return await args.heal();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`lyt init: heal step failed non-fatally — ${msg}`);
    return null;
  }
}

// V-A-11 — route a fresh-state init with a resolvable remote pod through the
// wizard's PROVEN engine (adoptAndPrimeFlow), which clones the pod + recovers its
// vaults from pod.yon. This is the fix for the empty-scaffold `--auto` bug: the
// fresh branch's doFreshBranch scaffolds personal/main BEFORE the federation forge
// and never recovers vault CONTENT; adoptAndPrimeFlow orders it correctly
// (adopt pod → clone vaults → scaffold only if 0 recovered).
async function doAdoptBranch(
  args: InitBootstrapArgs,
  db: Client,
  handle: string,
): Promise<Omit<InitBootstrapResult, "branch" | "durationMs">> {
  // MF2 — skipDiscover:true makes adopt MANIFEST-AUTHORITATIVE (pod.yon is the
  // catalog): deterministic, and it eliminates the gh-walk-reaches-the-real-account
  // hole (discoverFlow walks `gh api /user/repos`, which LYT_HOME does not sandbox).
  // noPush:true — adopt writes only local, un-pushed init commits (V-A-9: a
  // machine-id discriminator gates the PUSH, not the adopt). Reuse the SAME
  // federationGhClient the router probed with (router + flow cannot disagree).
  let adopt: AdoptAndPrimeResult;
  try {
    adopt = await adoptAndPrimeFlow({
      handle,
      registryDb: db,
      noPush: true,
      skipDiscover: true,
      ...(args.federationGhClient !== undefined
        ? { federationGhClient: args.federationGhClient }
        : {}),
      ...(args.meshGhClient !== undefined ? { meshGhClient: args.meshGhClient } : {}),
      ...(args.vaultCloneFn !== undefined ? { vaultCloneFn: args.vaultCloneFn } : {}),
      ...(args.ghExecutor !== undefined ? { ghExecutor: args.ghExecutor } : {}),
    });
  } catch (err) {
    // a review finding (release review) — the pod/vault clone threw (network drop, private-repo
    // credential miss with GIT_TERMINAL_PROMPT=0, gh/git failure). Do NOT crash and
    // do NOT silently fall through to an empty `fresh` scaffold (that would
    // re-introduce the exact V-A-11 empty-pod symptom). Return a structured,
    // AI-actionable failure; the common pod-clone throw leaves the registry empty
    // (re-runnable). The COMMAND LAYER owns all rendering — no console.error here
    // (Phase-D a review finding: a flow-layer log duplicated the message + leaked a non-JSON
    // line onto stderr under --json).
    const reason = err instanceof Error ? err.message : String(err);
    return { adoptError: { reason } };
  }

  return {
    adopt: {
      podBranch: adopt.podBranch,
      podHandle: adopt.podHandle,
      podLocalPath: adopt.podLocalPath,
      vaultsRecoveredFromManifest: adopt.vaultsRecoveredFromManifest,
      vaultsAcquired: adopt.vaultsAcquired,
      manifestSkipped: adopt.manifestSkipped,
      ...(adopt.manifestDrops !== undefined ? { manifestDrops: adopt.manifestDrops } : {}),
      // Thread the typed refusal and its source-generated remedy to the command.
      ...(adopt.manifestRefused === true ? { manifestRefused: true } : {}),
      ...(adopt.manifestRefusedKind !== undefined
        ? { manifestRefusedKind: adopt.manifestRefusedKind }
        : {}),
      ...(adopt.manifestRefusedReason !== undefined
        ? { manifestRefusedReason: adopt.manifestRefusedReason }
        : {}),
      firstVaultCreated: adopt.firstVaultCreated,
      primaryVaultPath: adopt.primaryVaultPath,
      primaryMeshName: adopt.primaryMeshName,
      reconciledVaultPaths: adopt.reconciledVaultPaths,
    },
    // Surface the reconcile at the top level too (parity with fresh/re-init —
    // the command layer reads reconciledVaultPaths for its re-index summary).
    reconciledVaultPaths: adopt.reconciledVaultPaths,
  };
}

/** Build the complete first-init plan without opening a writable registry. */
async function prepareFreshCreation(
  args: InitBootstrapArgs,
  existingPodIdentities: readonly BootstrapPodIdentity[],
): Promise<PreparedFreshCreation> {
  const meshName = args.customOverrides?.meshName ?? "personal";
  const attemptId = uuid7BytesToDashedString(newUuidv7Bytes());
  const cachedIdentity = readIdentityCache();
  const observedActor =
    args.handle === undefined && cachedIdentity === null
      ? await (args.observeActor ?? observeActiveActor)({ attemptId })
      : null;
  let handle = args.handle ?? cachedIdentity?.handle ?? observedActor?.actor ?? null;
  let localOnly = false;
  let provisionalHandle: string | null = null;
  if (handle === null) {
    handle = deriveProvisionalHandle();
    provisionalHandle = handle;
    localOnly = true;
  } else if (args.handle === undefined) {
    const cached = readIdentityCache();
    if (cached !== null && cached.handle === handle && resolveLocalFirst(cached)) {
      localOnly = true;
    }
  }

  if (existingPodIdentities.length > 1) {
    throw new Error("Fresh bootstrap requires exactly one local pod identity.");
  }
  if (existingPodIdentities.length === 1 && existingPodIdentities[0]!.handle !== handle) {
    throw new Error(
      `Fresh bootstrap identity conflict: local pod belongs to '${existingPodIdentities[0]!.handle}', not '${handle}'.`,
    );
  }

  const destinationRequest = bootstrapDestinationRequest(args, localOnly);
  const actor: ActiveActorObservation =
    destinationRequest.kind === "local"
      ? {
          attempt_id: attemptId,
          observed_at: new Date().toISOString(),
          result: "unknown",
          actor: null,
          evidence_class: "unavailable",
        }
      : (observedActor ?? (await (args.observeActor ?? observeActiveActor)({ attemptId })));
  const subject = { kind: "mesh" as const, repositoryName: vaultRepoName(`${meshName}/main`) };
  const resolved = resolveCreationPlanV1({
    request: destinationRequest,
    subject,
    actor,
    intendedEffects: withCreationRepositoryEffectsV1(
      plannedSingleVaultEffectsV1({
        operationId: deriveCreationOperationIdV1({
          request: destinationRequest,
          subject,
          scope: `${meshName}/main\0${resolveVaultPath(`${meshName}/main`)}`,
        }),
        pod:
          existingPodIdentities.length === 1
            ? { kind: "existing", rid: existingPodIdentities[0]!.rid }
            : { kind: "create", handle },
        mesh: { kind: "create", name: meshName },
        vaultName: `${meshName}/main`,
        vaultRoot: resolveVaultPath(`${meshName}/main`),
      }),
      existingPodIdentities.length === 1
        ? [
            {
              repositoryRoot: getFederationRepoDir(existingPodIdentities[0]!.handle),
              exactPaths: ["pod.yon"],
            },
          ]
        : [],
    ),
  });
  if (resolved.kind === "refusal") throw new Error(resolved.message);
  return { meshName, handle, provisionalHandle, attemptId, destinationRequest, planned: resolved };
}

async function doFreshBranch(
  args: InitBootstrapArgs,
  db: Client,
  prepared: PreparedFreshCreation,
): Promise<Omit<InitBootstrapResult, "branch" | "durationMs">> {
  const { meshName, handle, provisionalHandle, attemptId, destinationRequest, planned } = prepared;
  const onPhase = args.onPhase ?? (() => {});
  // The creation binding is already complete from the read-only preflight.
  // Only now may bootstrap establish the planned pod and mesh locally.
  // Apply begins only after the complete creation plan and identity conflict
  // check above. Materialize the canonical pod locally before mesh creation:
  // this creates one stable registry identity and local Git repo, but performs
  // no remote probe, create, or push.
  if (provisionalHandle !== null) writeProvisionalIdentity(provisionalHandle);
  await onPhase("create", `your pod repo (${handle}/lyt-pod)`);
  const fedResult = await federationInitFlow({
    handle,
    pushToRemote: false,
    createRemoteIfMissing: false,
    localOnly: true,
    checkpointMode: "deferred",
    ...(planned.plan.intended_effects.identity.kind === "create"
      ? { plannedFedRidBytes: hexToUuid7Bytes(planned.plan.intended_effects.identity.rid) }
      : {}),
    db,
    ...(args.federationGhClient !== undefined ? { ghClient: args.federationGhClient } : {}),
  });
  const federation: InitBootstrapFederation = {
    handle: fedResult.handle,
    fedRidHex: fedResult.fedRidHex,
    branch: fedResult.branch,
    localPath: fedResult.localPath,
    federationYonPath: fedResult.federationYonPath,
    remoteCreated: fedResult.remoteCreated,
    pushed: fedResult.pushed,
    remoteFullName: fedResult.remoteFullName,
  };
  await onPhase("git-init", "your personal mesh + main vault");
  const meshResult = await meshInitFlow({
    name: meshName,
    noPush: true,
    creation: {
      destinationRequest,
      creationPlan: planned.plan,
      attemptId,
    },
    // Open-once seam (A.4): reuse the bootstrap's registry connection so
    // mesh-init does not open a 2nd one (nested-open SQLITE_BUSY risk).
    db,
    checkpointMode: "deferred",
    ...(args.meshGhClient !== undefined ? { ghClient: args.meshGhClient } : {}),
  });

  // (Brief A) — regenerate the derived pod manifest from the now-populated
  // registry so `lyt init` (fresh) leaves a POPULATED pod.yon listing
  // personal/main (acceptance #1). Runs AFTER the federation forge wrote the
  // skeleton + federation_state row. Fresh creation is not complete unless the
  // derived manifest contains the one mesh + main vault created from the empty
  // preflight topology, so regeneration and this postcondition are fatal here.
  const manifestResult = await regeneratePodManifestFlow(db, {
    handle,
    ...(args.nowIso !== undefined ? { nowIso: args.nowIso } : {}),
  });
  if (manifestResult.skipped || manifestResult.meshCount !== 1 || manifestResult.vaultCount !== 1) {
    throw new Error(
      `Fresh bootstrap produced an incomplete pod manifest (${manifestResult.meshCount} meshes, ${manifestResult.vaultCount} vaults).`,
    );
  }

  // The pod manifest changes only after the mesh/vault topology exists. Its
  // one creation checkpoint must therefore run here, after regeneration, not
  // inside the earlier pod scaffold forge.
  const intendedPodCheckpoint = planned.plan.intended_effects.checkpoints.find(
    (checkpoint) => checkpoint.repository_root === fedResult.localPath,
  );
  if (intendedPodCheckpoint === undefined) {
    throw new Error("Fresh bootstrap plan is missing its exact pod checkpoint.");
  }
  const podCheckpointResult = finalizeInitialCheckpoint({
    vaultPath: fedResult.localPath,
    paths: [...intendedPodCheckpoint.exact_paths],
    expectedContentDigests: new Map(),
  });
  if (podCheckpointResult.status !== "committed") {
    throw new Error("Fresh bootstrap could not finalize its exact pod checkpoint.");
  }
  const podCheckpoint = assertPlannedPodCheckpointPaths(planned.plan, fedResult.localPath);
  const meshCheckpointResult = finalizeInitialCheckpoint(meshResult.checkpointContext);
  if (meshCheckpointResult.status !== "committed") {
    throw new Error("Fresh bootstrap could not finalize its exact mesh-main checkpoint.");
  }

  // W2.2 — index the freshly-scaffolded vault so it is search-fresh on first
  // use (mirrors the adopt path's reconcile; non-fatal).
  const reconciledVaultPaths = await reconcileVaults([meshResult.mainVault.path]);

  return {
    meshAssignment: {
      meshRidHex: meshResult.meshRidHex,
      meshName: meshResult.meshName,
      meshAutoCreated: true,
      mainVaultName: meshResult.mainVault.name,
      mainVaultPath: meshResult.mainVault.path,
    },
    ...(federation !== undefined ? { federation } : {}),
    creation: {
      plan: planned.plan,
      mutations: {
        registryRows:
          meshResult.mutations.registryRows +
          (planned.plan.intended_effects.identity.kind === "create" ? 1 : 0),
        topologyBindings: meshResult.mutations.topologyBindings,
        localDatabases: meshResult.mutations.localDatabases,
        filesystemWrites: meshResult.mutations.filesystemWrites + 1,
        destinationPolicyRecords: meshResult.mutations.destinationPolicyRecords,
        failureLogRecords: meshResult.mutations.failureLogRecords,
        checkpointCommits:
          meshResult.mutations.checkpointCommits +
          (podCheckpoint === null ? 0 : 1) +
          (meshCheckpointResult.status === "committed" ? 1 : 0),
        checkpointRepositories: [
          ...meshResult.mutations.checkpointRepositories.filter(
            (repository) => repository.repositoryRoot !== meshResult.mainVault.path,
          ),
          {
            repositoryRoot: meshResult.mainVault.path,
            paths: meshCheckpointResult.paths,
            commitSha: meshCheckpointResult.commitSha!,
            ...(meshCheckpointResult.beforeCommitSha === undefined
              ? {}
              : { beforeCommitSha: meshCheckpointResult.beforeCommitSha }),
            clean: true,
          },
          ...(podCheckpoint === null
            ? []
            : [
                {
                  repositoryRoot: fedResult.localPath,
                  paths: podCheckpoint.paths,
                  commitSha: podCheckpoint.commitSha,
                  clean: true,
                },
              ]),
        ],
        checkpointPaths: [
          ...meshResult.mutations.checkpointPaths,
          ...(podCheckpoint?.paths ?? []),
        ].sort(),
      },
      ...(podCheckpoint === null ? {} : { podCheckpointCommitSha: podCheckpoint.commitSha }),
    },
    reconciledVaultPaths,
  };
}

function assertPlannedPodCheckpointPaths(
  plan: CreationPlanV1,
  podRoot: string,
): { paths: string[]; commitSha: string } | null {
  const intended = plan.intended_effects.checkpoints.find(
    (checkpoint) => checkpoint.repository_root === podRoot,
  );
  if (intended === undefined) return null;
  const observed = intended.exact_paths.filter((path) => existsSync(join(podRoot, path))).sort();
  if (observed.length !== intended.exact_paths.length) {
    throw new Error("Fresh bootstrap pod files differ from the immutable creation plan.");
  }
  let commitSha: string;
  try {
    commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: podRoot,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    throw new Error("Fresh bootstrap pod checkpoint has no observed commit.");
  }
  if (commitSha.length === 0)
    throw new Error("Fresh bootstrap pod checkpoint has no observed SHA.");
  return { paths: observed.map((path) => `${podRoot}:${path}`), commitSha };
}

function bootstrapDestinationRequest(
  args: InitBootstrapArgs,
  localOnly: boolean,
): DestinationRequest {
  if (localOnly) return { kind: "local" };
  const customTarget = args.customOverrides?.pushTarget?.trim();
  if (args.mode !== "custom" || customTarget === undefined || customTarget.length === 0) {
    return { kind: "auto" };
  }
  if (customTarget.startsWith("github:user/") || customTarget.startsWith("github:org/")) {
    return { kind: "target", target: customTarget.toLowerCase() };
  }
  if (customTarget.startsWith("org:")) {
    return { kind: "target", target: `github:org/${customTarget.slice(4).toLowerCase()}` };
  }
  return { kind: "target", target: `github:user/${customTarget.toLowerCase()}` };
}

async function doReInitBranch(
  db: Client,
): Promise<Omit<InitBootstrapResult, "branch" | "durationMs">> {
  const vaults = await listVaults(db);
  const issues: IntegrityIssue[] = [];

  for (const vault of vaults) {
    const status = await probeVaultIntegrity(db, vault);
    issues.push(status);
  }

  // W2.2 — re-index every HEALTHY vault so a re-run leaves search fresh (the
  // spec's "existing structure on disk → re-sync + re-index"). Only vaults
  // that probed `ok` are reconciled; missing/unparseable are skipped (their
  // db isn't reliably readable). Non-fatal per vault.
  const okPaths = vaults
    .filter((v) => issues.find((i) => i.vaultName === v.name)?.status === "ok")
    .map((v) => v.path);
  const reconciledVaultPaths = await reconcileVaults(okPaths);

  return { integrityIssues: issues, reconciledVaultPaths };
}

interface ProbeableVault {
  name: string;
  path: string;
  homeMeshRid: Uint8Array | null;
}

async function probeVaultIntegrity(db: Client, vault: ProbeableVault): Promise<IntegrityIssue> {
  // (a) Disk presence.
  if (!existsSync(vault.path)) {
    return {
      vaultName: vault.name,
      status: "missing",
      error: `vault path does not exist: ${vault.path}`,
    };
  }
  // (b) vault.yon presence.
  const yonPath = `${vault.path}/.lyt/vault.yon`;
  if (!existsSync(yonPath)) {
    return {
      vaultName: vault.name,
      status: "missing",
      error: `vault.yon not found at ${yonPath}`,
    };
  }
  // (c) vault.yon parses.
  let parsed;
  try {
    parsed = parseVaultYon(readFileSync(yonPath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      vaultName: vault.name,
      status: "unparseable",
      error: msg,
    };
  }
  // (d) home_mesh_rid resolves (if set).
  if (vault.homeMeshRid !== null) {
    const meshRow = await getMeshByRid(db, vault.homeMeshRid);
    if (meshRow === null) {
      return {
        vaultName: vault.name,
        status: "orphaned-home-mesh",
        error: `home_mesh_rid does not resolve to a meshes row`,
      };
    }
  }
  // Re-bind the parsed reference so it isn't flagged unused.
  void parsed.rid;
  return { vaultName: vault.name, status: "ok" };
}

async function doDiscoveryBranch(
  args: InitBootstrapArgs,
  db: Client,
  meshes: Awaited<ReturnType<typeof listMeshes>>,
): Promise<Omit<InitBootstrapResult, "branch" | "durationMs">> {
  const handle = args.handle ?? safeIdentityResolve();
  if (handle === null) {
    // No identity → empty discovery (read-only flow stays well-defined).
    return { discoveredRepos: [] };
  }
  const probe = args.discoveryProbe ?? defaultDiscoveryProbe();
  const probed = await probe.probe(handle);

  // Filter: keep lyt-prefix OR lyt-public-topic kinds (default — the
  // .lyt/vault.yon per-repo probe is deferred to v1.C.3). Probe is
  // expected to tag each row with its source `kind`; the bootstrap
  // doesn't re-classify.
  const filtered = probed.repos.filter(
    (r) => r.kind === "lyt-prefix" || r.kind === "lyt-public-topic",
  );

  // Cross-check against the local registry. A repo is "already in
  // registry" when one of the registered meshes has a legacy origin hint that
  // matches `<handle>/<name>` (i.e. a known mesh-main repo) OR matches
  // the bare name (legacy lyt- prefix). We use a Set for O(1) lookup
  // even though discovery sets are small.
  // This is discovery de-duplication only. These compatibility hints never
  // authorize creation, retargeting, or publication.
  const knownLegacyOriginHints = new Set<string>();
  for (const m of meshes) {
    if (m.pushTarget !== null) knownLegacyOriginHints.add(m.pushTarget);
  }
  // Also cross-check the vault.git_url surface in case a vault was
  // adopted from a public repo that didn't go through `lyt mesh init`.
  // Inexpensive ORM walk; bounded by registered vault count.
  const knownVaultUrls = new Set<string>();
  const knownVaults = await listVaults(db);
  for (const v of knownVaults) {
    if (v.gitUrl !== null) {
      // Strip protocol + .git suffix for fuzzy match against
      // `<handle>/<repo>` slug shape (e.g. https://github.com/x/y.git →
      // x/y).
      const m = v.gitUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (m) knownVaultUrls.add(m[1]!);
    }
  }

  // Annotate alreadyInRegistry + Lock 0.3 deterministic sort.
  const annotated = filtered.map((r) => ({
    fullName: r.fullName,
    kind: r.kind,
    alreadyInRegistry:
      r.alreadyInRegistry ||
      knownLegacyOriginHints.has(r.fullName) ||
      knownVaultUrls.has(r.fullName),
  }));
  annotated.sort((a, b) => a.fullName.localeCompare(b.fullName));

  return { discoveredRepos: annotated };
}

// Default impl returns an empty probe — the production gh-api integration
// ships in v1.C.3 (per the ratified default; v1.B.4 keeps discovery wired
// structurally with the probe as an injectable seam used by tests + the
// future v1.C.3 prod impl). This default makes the no-injection happy
// path predictable: discovery returns an empty list rather than throwing.
function defaultDiscoveryProbe(): DiscoveryProbe {
  return {
    async probe(_handle: string): Promise<DiscoveryProbeResult> {
      return { repos: [] };
    },
  };
}

function safeIdentityResolve(): string | null {
  try {
    return getHandleFromIdentity();
  } catch {
    return null;
  }
}

function finalize(
  partial: Omit<InitBootstrapResult, "durationMs"> & {
    durationMs?: number;
  },
  startedAtMs: number,
  nowIso?: string,
): InitBootstrapResult {
  const elapsed = nowMs(nowIso) - startedAtMs;
  return {
    ...partial,
    durationMs: Math.max(0, elapsed),
  };
}

function nowMs(nowIso: string | undefined): number {
  if (nowIso !== undefined) return Date.parse(nowIso);
  return Date.now();
}
