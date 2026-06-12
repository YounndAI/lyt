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
// Branch decision (per federation-design §5 + brief OD-7):
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

import { existsSync, readFileSync } from "node:fs";

import type { Client } from "@libsql/client";

import {
  adoptAndPrimeFlow,
  backfillFigmentCaches,
  closeRegistry,
  deriveProvisionalHandle,
  federationInitFlow,
  federationRepoName,
  getHandleFromIdentity,
  getMeshByRid,
  isProvisionalIdentity,
  isValidGhHandle,
  listMeshes,
  listVaults,
  meshInitFlow,
  openRegistry,
  parseVaultYon,
  readIdentityCache,
  realFederationGhClient,
  regeneratePodManifestNonFatal,
  writeProvisionalIdentity,
  type AdoptAndPrimeResult,
  type FederationGhClient,
  type FederationInitBranch,
  type MaterializePodResult,
  type MeshGhClient,
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
  // D26: the full `{handle}/lyt-pod` repo name, sourced from the
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
  // the branch materialized (fresh + re-init; discovery is read-only). Reports
  // what was made publishable (per-vault git/commit/remote, pod commit). At init
  // this is LOCAL-only (push held); the honest card (B.3) reads it.
  publish?: MaterializePodResult;
  durationMs: number;
}

export type InitBootstrapMode = "auto" | "custom" | "discover";

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
  customOverrides?: InitBootstrapCustomOverrides;
  // W1.2 / OD-4 — heal runner. When supplied, the flow runs it on the fresh +
  // re-init branches (NOT discovery, which is read-only) so a single
  // `lyt init` re-aligns skills + agent manual + patterns. INJECTABLE so unit
  // tests stay hermetic (no real ~/.claude / ~/.codex / ~/.agents writes): the
  // CLI command wires the real `healPod()`; tests omit it (no heal runs). Heal
  // failure is swallowed (never-fail) — see runHealIfProvided.
  heal?: (() => Promise<HealResult>) | undefined;
  // Brief B (B.1) — materialize-publish runner. When supplied, the flow runs it
  // on the fresh + re-init branches (NOT discovery) AFTER the pod.yon regen, so a
  // single `lyt init` leaves each vault with git + an initial commit + a remote
  // URL, and the pod.yon committed (push HELD — outward gh-create + push are the
  // consented sync engine's job, B.2). INJECTABLE so unit tests stay hermetic
  // (no real git subprocesses on temp vault dirs): the CLI command wires the
  // real `(db) => materializePodLocal(db, { push: false })`; tests omit it.
  // Receives the bootstrap's open db (open-once seam). Failure is swallowed
  // (never-fail) — see runMaterializeIfProvided.
  materializePublish?: ((db: Client) => Promise<MaterializePodResult>) | undefined;
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
  const ownDb = registryDb === undefined;
  const db = registryDb ?? (await openRegistry());
  try {
    const meshes = await listMeshes(db);
    const vaults = await listVaults(db);
    return meshes.length === 0 && vaults.length === 0;
  } finally {
    if (ownDb) await closeRegistry(db);
  }
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
  const db = args.registryDb ?? (await openRegistry());

  try {
    // Probe local state ONCE up front.
    const meshes = await listMeshes(db);
    const vaults = await listVaults(db);

    // Branch decision (federation-design §5 + brief OD-7; V-A-11 adds ADOPT).
    let branch: InitBootstrapBranch;
    let adoptHandle: string | null = null;
    if (args.mode === "discover") {
      branch = "discovery";
    } else if (meshes.length === 0 && vaults.length === 0) {
      // V-A-11 — a FRESH registry prefers ADOPT when a remote `{handle}/lyt-pod`
      // exists (clone its content), else scaffolds a FRESH pod. probeAdoptable is
      // GUARDED (gh flake / no-gh / provisional-local-first → null → fresh), so it
      // never aborts the common fresh path (MF1, SC3/SC7).
      adoptHandle = await probeAdoptable(args);
      branch = adoptHandle !== null ? "adopt" : "fresh";
    } else {
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
      const result = await doFreshBranch(args, db);
      const heal = await runHealIfProvided(args);
      const publish = await runMaterializeIfProvided(args, db);
      return finalize(
        {
          ...result,
          branch,
          ...(heal !== null ? { heal } : {}),
          ...(publish !== null ? { publish } : {}),
        },
        startedAtMs,
        args.nowIso,
      );
    }
    if (branch === "re-init") {
      const result = await doReInitBranch(args, db);
      const heal = await runHealIfProvided(args);
      const publish = await runMaterializeIfProvided(args, db);
      return finalize(
        {
          ...result,
          branch,
          ...(heal !== null ? { heal } : {}),
          ...(publish !== null ? { publish } : {}),
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
// NEVER fail an init (D30 never-fail). Returns null when no runner was
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

// Brief B (B.1) — run the injected materialize-publish runner, swallowing any
// failure so it can NEVER fail an init (never-fail posture, same as heal/regen).
// Returns null when no runner was supplied (hermetic-test default) or it threw.
// Runs AFTER the pod.yon regen so the pod commit captures the populated manifest.
async function runMaterializeIfProvided(
  args: InitBootstrapArgs,
  db: Client,
): Promise<MaterializePodResult | null> {
  if (args.materializePublish === undefined) return null;
  try {
    return await args.materializePublish(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`lyt init: materialize-publish step failed non-fatally — ${msg}`);
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

async function doFreshBranch(
  args: InitBootstrapArgs,
  db: Client,
): Promise<Omit<InitBootstrapResult, "branch" | "durationMs">> {
  const meshName = args.customOverrides?.meshName ?? "personal";
  const onPhase = args.onPhase ?? (() => {});

  // V-A-1 (Phase E) — establish identity BEFORE the scaffold. meshInitFlow +
  // the vault scaffold call getIdentity() / getHandleFromIdentity(), which
  // HARD-THROW gh-less ("Identity refresh failed: GitHub CLI is not
  // authenticated"). The provisional minting used to run AFTER meshInitFlow, so
  // gh-less `lyt init --auto` threw MID-SCAFFOLD and left a partial pod
  // (registry.db + patterns/ + a half-built vaults/ with no personal/main —
  // the very state that then errored `no vault named 'personal/main'`).
  // Resolving — or minting a PROVISIONAL local identity — FIRST means the
  // scaffold's getIdentity() resolves from the just-written cache and the
  // gh-less `--auto` degrades to a LOCAL pod, exactly like the interactive
  // wizard (the brief's reference), instead of half-failing.
  //
  // D34 (OD-LOCALFIRST): no gh handle resolves → mint a provisional identity
  // (default OS username) + forge LOCAL-ONLY (no gh probe, no remote). `lyt
  // sync` reconciles to the real gh handle at connect. A provisional cache for
  // THIS handle → stay local-only too (don't gh-probe).
  let handle = args.handle ?? safeIdentityResolve();
  let localOnly = false;
  if (handle === null) {
    handle = deriveProvisionalHandle();
    writeProvisionalIdentity(handle);
    localOnly = true;
  } else if (args.handle === undefined) {
    // MF1 — provisional-cache → local-first via the shared resolveLocalFirst
    // predicate. The handle-match guard stays: only treat as local-only when the
    // provisional cache is THIS handle.
    const cached = readIdentityCache();
    if (cached !== null && cached.handle === handle && resolveLocalFirst(cached)) {
      localOnly = true;
    }
  }

  // (a) Scaffold the personal mesh (which scaffolds personal/main as the
  // mesh's main vault per meshInitFlow). `noPush: true` per OD-3 default;
  // the handler explicitly publishes later via `lyt sync` (D31 Brief B). The
  // identity established above lets the scaffold's getIdentity() resolve
  // locally gh-less (V-A-1).
  await onPhase("git-init", "your personal mesh + main vault");
  const meshResult = await meshInitFlow({
    name: meshName,
    noPush: true,
    // Open-once seam (A.4): reuse the bootstrap's registry connection so
    // mesh-init does not open a 2nd one (nested-open SQLITE_BUSY risk).
    db,
    ...(args.meshGhClient !== undefined ? { ghClient: args.meshGhClient } : {}),
  });

  // (b) Forge the federation repo locally. `pushToRemote: false` per OD-3
  // default. The federation init's own three-branch state-machine handles the
  // case where the remote repo already exists on GH (Branch B adopted) — we
  // don't second-guess it here. localOnly (resolved above) forges the pod
  // without any gh probe/remote.
  let federation: InitBootstrapFederation | undefined;
  if (handle !== null) {
    // Forging phase: federationInitFlow runs a sync prelude (registry probe,
    // git init, pod.yon write) THEN its own per-op gh spinner for the
    // `gh repo create` spawn. Re-label the spanning spinner to "Forging…"
    // here so the sync prelude is covered too (it was the silent gap F7
    // wrapped only the spawn — leaving the prelude dark).
    await onPhase("create", `your pod repo (${handle}/lyt-pod)`);
    try {
      const fedResult = await federationInitFlow({
        handle,
        pushToRemote: false,
        localOnly,
        db,
        ...(args.federationGhClient !== undefined ? { ghClient: args.federationGhClient } : {}),
      });
      federation = {
        handle: fedResult.handle,
        fedRidHex: fedResult.fedRidHex,
        branch: fedResult.branch,
        localPath: fedResult.localPath,
        federationYonPath: fedResult.federationYonPath,
        remoteCreated: fedResult.remoteCreated,
        pushed: fedResult.pushed,
        remoteFullName: fedResult.remoteFullName,
      };
    } catch (err) {
      // Federation init failure is NON-FATAL per OD-3 default — the
      // personal mesh + personal/main vault are already on disk; the
      // handler can re-invoke `lyt init` (which lands in re-init branch)
      // or run `lyt federation init` directly to recover. Emit the
      // failure as a console.error so the handler sees it without
      // forcing the whole bootstrap to fail.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`lyt init (fresh): federation init failed non-fatally — ${msg}`);
    }
  }

  // D31 (Brief A) — regenerate the derived pod manifest from the now-populated
  // registry so `lyt init` (fresh) leaves a POPULATED pod.yon listing
  // personal/main (acceptance #1). Runs AFTER the federation forge wrote the
  // skeleton + federation_state row. Non-fatal; reuses the open db.
  if (handle !== null) {
    await regeneratePodManifestNonFatal(db, {
      handle,
      ...(args.nowIso !== undefined ? { nowIso: args.nowIso } : {}),
    });
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
    reconciledVaultPaths,
  };
}

async function doReInitBranch(
  args: InitBootstrapArgs,
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

  // D31 (Brief A) — re-init against an existing pod regenerates pod.yon so it
  // reflects the ACTUAL registered vaults (acceptance #2). Non-fatal; skipped
  // if the pod has no federation_state yet.
  await regeneratePodManifestNonFatal(db, args.nowIso !== undefined ? { nowIso: args.nowIso } : {});

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

  // Filter: keep lyt-prefix OR lyt-public-topic kinds (OD-5 default — the
  // .lyt/vault.yon per-repo probe is deferred to v1.C.3). Probe is
  // expected to tag each row with its source `kind`; the bootstrap
  // doesn't re-classify.
  const filtered = probed.repos.filter(
    (r) => r.kind === "lyt-prefix" || r.kind === "lyt-public-topic",
  );

  // Cross-check against the local registry. A repo is "already in
  // registry" when one of the registered meshes has `push_target` that
  // matches `<handle>/<name>` (i.e. a known mesh-main repo) OR matches
  // the bare name (legacy lyt- prefix). We use a Set for O(1) lookup
  // even though discovery sets are small.
  const knownPushTargets = new Set<string>();
  for (const m of meshes) {
    if (m.pushTarget !== null) knownPushTargets.add(m.pushTarget);
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
      r.alreadyInRegistry || knownPushTargets.has(r.fullName) || knownVaultUrls.has(r.fullName),
  }));
  annotated.sort((a, b) => a.fullName.localeCompare(b.fullName));

  return { discoveredRepos: annotated };
}

// Default impl returns an empty probe — the production gh-api integration
// ships in v1.C.3 (per OD-5 default; v1.B.4 keeps discovery wired
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
