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

import { existsSync } from "node:fs";

import type { Client } from "@libsql/client";

import { assertVaultRegistered, type CommitVerdict } from "../registry/assert-committed.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { readFederationState } from "../registry/federation-state.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByExactName, setVaultHomeMesh } from "../registry/repo.js";
import { appendMeshHomeToFile } from "../registry/vault-home-mesh-helpers.js";
import { initVaultDbs } from "../registry/vault-db.js";
import { initVault, type InitOptions, type InitResult } from "../scaffold/init.js";
import { getFederationRepoDir } from "../util/federation-paths.js";
import { recordInitFailure } from "../util/failure-log.js";
import { getHandleFromIdentity } from "../util/identity.js";
import { VOICE } from "../voice.js";
import { federationInitFlow } from "./federation/init.js";
import { regeneratePodManifestNonFatal } from "./federation/regenerate.js";
import { meshInitFlow } from "./mesh-init.js";
import type { FederationGhClient, FederationRepoVisibility } from "../util/gh-federation.js";
import type { MeshGhClient } from "../util/gh-mesh.js";
import { registerVaultFromYon } from "./register.js";

export interface InitFlowResult extends InitResult {
  registered: boolean;
  // 0.9.4 (3d / §4) — read-back verdict. `verified` when the post-register
  // re-read confirms the vault row exists by rid; `unverified` otherwise. The
  // CLI appends `unverifiedNote` to the success line on an unverified outcome
  // instead of printing an unconditional "Initialized".
  committed: CommitVerdict;
  unverifiedNote: string | null;
  // v1.A.0 federation self-heal branch — populated when initVaultFlow
  // detected ZERO federation_state row AND ZERO local cache AND the just-
  // registered vault put the count at ≥1. `null` when the branch did not
  // fire (cached state, opt-out, or self-heal was skipped via options).
  federationSelfHealed: {
    handle: string;
    fedRidHex: string;
    branch: "fresh" | "adopted";
    visibility: FederationRepoVisibility;
    statusVoiceEmitted: string;
  } | null;
  // v1.B.3 — populated when the init flow auto-normalized a bare name to
  // `personal/<name>` (or `<mesh>/<name>` for already-namespaced input
  // that resolved to an existing mesh). Carries the home-mesh assignment
  // that landed in vault.yon + mesh.yon. `null` when init was called via
  // direct mesh-init flow (which builds its own mesh.yon) or when
  // selfHeal.mesh.enabled was false and no mesh assignment was possible.
  meshAssignment: {
    meshRidHex: string;
    meshName: string;
    autoNormalizedFrom: string | null;
    meshAutoCreated: boolean;
    statusVoiceEmitted: string;
  } | null;
}

// v1.A.1 fold (DO NOT SKIP #12) — InitFlowOptions refactored from four
// federation-specific top-level knobs to a nested sub-options bag. The
// `selfHeal.federation` shape captures everything v1.A.0 needs; the
// `selfHeal.mesh` placeholder declares the shape v1.B.1 will fill once
// `lyt mesh init` exists. Mesh self-heal IS the v1.B.1 contract — declared
// here so InitFlowOptions doesn't reshape twice.

export interface FederationSelfHealOptions {
  // Opt-IN gate: when true (or absent + treated as true at the CLI layer),
  // post-vault-registration probes federation_state + materialises the
  // {handle}/lyt-pod repo if missing. Default `false` at the API
  // level so existing block-A tests stay network-free. CLI explicitly opts
  // in via `commands/init.ts`.
  enabled?: boolean | undefined;
  // Injectable seam for tests + future BYOK consumers.
  ghClient?: FederationGhClient | undefined;
  // Lets tests force the handle without depending on `gh api /user`.
  handle?: string | undefined;
  // Controls whether the self-heal init pushes to remote. Default false on
  // self-heal — handler hasn't explicitly asked for federation publication.
  pushOnSelfHeal?: boolean | undefined;
}

// v1.B.3 populates the MeshSelfHealOptions shape (was an intentionally
// empty placeholder in v1.A.1; v1.B.1 retro flagged it for v1.B.3 wiring).
//
// Auto-personal mesh creation: when `lyt vault init <bare>` runs and the
// `personal` mesh isn't registered, the init flow invokes `meshInitFlow`
// in-process to scaffold it locally before scaffolding the new vault. The
// resulting mesh is then the new vault's home mesh, and vault.yon +
// mesh.yon get @VAULT_HOME_MESH + @MESH_HOME records describing the
// binding.
//
// Default at the API surface: `enabled: false` (preserves test-friendly
// network-free init for the block-A test suite). The CLI layer
// (commands/init.ts) opts in via `enabled: true`.
export interface MeshSelfHealOptions {
  // Master opt-in. When undefined or false, init never reshapes the name
  // and never auto-creates a mesh — the call behaves like v1.A.1's
  // mesh-unaware init (vault.yon emits no @VAULT_HOME_MESH).
  enabled?: boolean | undefined;
  // Override the auto-created mesh name for a BARE init (defaults to
  // `'personal'`). For a `<mesh>/<leaf>` init the mesh slot is the user's
  // chosen name. Tests pass a deterministic name; production defaults to
  // `personal` per naming-convention.md §Bare-name normalization.
  meshName?: string | undefined;
  // Push the just-created mesh to remote on auto-create. Default false —
  // auto-create is a local self-heal; the handler explicitly opts in (via
  // `lyt vault init <mesh>/<leaf> --push-to <handle>`) when they want a
  // remote sharing mesh.
  pushOnSelfHeal?: boolean | undefined;
  // 0.9.4 (3c) — explicit push target for an auto-created mesh (a GitHub
  // handle/org). When set, the auto-created mesh is a SHARING mesh pointed at
  // this owner; without it, the new mesh is local-only (matches the personal
  // default). Threaded into the nested meshInitFlow.
  pushTo?: string | undefined;
  // Injectable seam for tests + future BYOK consumers. Forwarded into the
  // nested `meshInitFlow` call when auto-creation fires. Mirrors the
  // federation self-heal shape.
  ghClient?: MeshGhClient | undefined;
}

export interface InitFlowOptions extends InitOptions {
  selfHeal?: {
    federation?: FederationSelfHealOptions;
    mesh?: MeshSelfHealOptions;
  };
}

// v1.A.1 fold (DO NOT SKIP #15) — pure decision: should the federation
// self-heal branch fire on this invocation? Extracted from
// `maybeSelfHealFederation` so the four-case decision matrix is
// independently unit-testable (no SQL, no filesystem, no network):
//
// 1. opts.selfHeal.federation.enabled !== true → false
// 2. handle cannot be resolved → false
// 3. federation_state row exists → false
// 4. local ~/lyt/pod/ directory exists → false (flat pod dir)
//
// Otherwise → returns the resolved handle so the caller can act.
//
// The `registryProbe` callback returns the federation_state row (or null).
// Tests pass a fake; production passes a closure over an already-open db.
export interface ShouldSelfHealProbe {
  readFederationStateForHandle(handle: string): Promise<unknown | null>;
  localFederationDirExists(handle: string): boolean;
}

export async function shouldSelfHealFederation(
  opts: InitFlowOptions,
  probe: ShouldSelfHealProbe,
): Promise<{ handle: string } | null> {
  const fed = opts.selfHeal?.federation;
  if (fed?.enabled !== true) return null;

  let handle = fed.handle;
  if (handle === undefined || handle.length === 0) {
    try {
      handle = getHandleFromIdentity();
    } catch {
      return null;
    }
  }
  if (!handle || handle.length === 0) return null;

  const existing = await probe.readFederationStateForHandle(handle);
  if (existing !== null) return null;
  if (probe.localFederationDirExists(handle)) return null;

  return { handle };
}

// v1.B.3 — structured error raised when `lyt vault init <owner>/<name>`
// names a mesh that isn't registered AND mesh auto-creation is gated to
// `personal` only.
//
// 0.9.4 (3c) — RETAINED for back-compat (still exported so existing
// callers/tests resolve), but NO LONGER THROWN on a missing mesh: create-if-
// missing now auto-creates ANY named mesh, uniformly (the `personal`-only
// special-case is dropped). The class survives only for the defensive
// "auto-created mesh didn't land / main vault unresolvable" arms.
export class HomeMeshNotFoundError extends Error {
  readonly errorCode = "home-mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt vault init: home mesh '${meshName}' could not be resolved after auto-create (defensive).`,
    );
    this.name = "HomeMeshNotFoundError";
    this.meshName = meshName;
  }
}

// 0.9.4 (3c) — `vault init {mesh}/{vault}` STOPS + NOTIFIES when the
// vault already exists (idempotent-by-refusal: never silently re-scaffold over
// a live vault). The mesh is still created-if-missing; only an existing VAULT
// is the stop condition.
export class VaultAlreadyExistsError extends Error {
  readonly errorCode = "vault-already-exists";
  readonly vaultName: string;
  constructor(vaultName: string) {
    super(
      `lyt vault init: vault '${vaultName}' already exists. ` +
        `Nothing to do — use 'lyt vault list' to inspect it, or 'lyt vault rename'/'lyt vault move' to change it.`,
    );
    this.name = "VaultAlreadyExistsError";
    this.vaultName = vaultName;
  }
}

export async function initVaultFlow(opts: InitFlowOptions): Promise<InitFlowResult> {
  // v1.A.1b: open the registry ONCE up-front (v1.A.1a fold #4 extended) so
  // we can (a) resolve --parent <name> → parentVaultRid bytes before the
  // scaffold writes vault.yon, (b) register the just-scaffolded vault, and
  // (c) thread the same db into the federation self-heal probe. Saves the
  // duplicate-open the v1.A.0 code did pre-fold-#4.
  const db = await openRegistry();
  let federationSelfHealed: InitFlowResult["federationSelfHealed"] = null;
  let meshAssignment: InitFlowResult["meshAssignment"] = null;
  try {
    // v1.B.3 — name normalization + mesh self-heal probe. Runs BEFORE the
    // scaffold so vault.yon gets a @VAULT_HOME_MESH block on first write
    // (no post-scaffold re-render). The decision tree:
    //
    // 1. mesh self-heal disabled OR opts.name already contains '/' AND
    // no mesh self-heal context → don't normalize; vault stays
    // mesh-unaffiliated (v1.A.1 behavior).
    // 2. bare name + self-heal enabled → normalize to `<meshName>/<bare>`
    // where meshName defaults to 'personal'; ensure the mesh exists
    // (auto-create if absent); emit transparent VOICE message.
    // 3. `<owner>/<name>` form + self-heal enabled → require the
    // `<owner>` mesh to already exist; throw HomeMeshNotFoundError
    // otherwise (per Plan-D1: don't silently auto-create non-personal
    // meshes).
    const meshSelfHealAssignment = await maybeAssignHomeMesh(opts, db);

    const effectiveName = meshSelfHealAssignment?.normalizedName ?? opts.name;
    const homeMeshScaffoldArg = meshSelfHealAssignment?.scaffoldHomeMesh;

    // 0.9.4 (3c) — STOP + NOTIFY if the vault already exists. Probe by
    // the EXACT normalized name (not the leaf-resolving chokepoint — we want a
    // literal "is THIS vault present?" check). The mesh has already been
    // created-if-missing above; only an existing VAULT is the stop condition.
    if (await getVaultByExactName(db, effectiveName)) {
      throw new VaultAlreadyExistsError(effectiveName);
    }

    // Resolve --parent <name> into the FK-compatible Uint8Array bytes that
    // scaffold/init writes into vault.yon's @VAULT parent_vault field. Any
    // explicit parentVaultRid passed by the caller (tests + future
    // programmatic consumers) wins over the name lookup.
    let parentVaultRid = opts.parentVaultRid;
    if (parentVaultRid === undefined && opts.parent !== undefined && opts.parent.length > 0) {
      const parentRow = await getVaultByName(db, opts.parent);
      if (parentRow === null) {
        throw new Error(
          `--parent <name>: no vault registered with name '${opts.parent}'. ` +
            `Use 'lyt vault list' to see registered vaults.`,
        );
      }
      parentVaultRid = parentRow.rid;
    }
    const scaffoldOpts: InitOptions = {
      ...opts,
      name: effectiveName,
      ...(parentVaultRid !== undefined ? { parentVaultRid } : {}),
      ...(homeMeshScaffoldArg !== undefined ? { homeMesh: homeMeshScaffoldArg } : {}),
    };

    const result = initVault(scaffoldOpts);
    // Per-vault libSQL initialised on creation so the 6 schemas are queryable
    // on first read, not lazily on first write. Block-A Commit 4 invariant.
    await initVaultDbs(result.vaultPath);

    const registered = await registerVaultFromYon(db, { vaultPath: result.vaultPath });

    // v1.B.3 — when a home-mesh assignment landed in vault.yon, complete
    // the registry-side binding: set vaults.home_mesh_rid (register.ts
    // already does this via the parsed @VAULT_HOME_MESH; setVaultHomeMesh
    // is a belt-and-braces no-op then), INSERT mesh_vaults role='home',
    // and append the @MESH_HOME row to the home mesh's main vault's
    // mesh.yon.
    if (meshSelfHealAssignment !== null) {
      await setVaultHomeMesh(db, registered.rid, meshSelfHealAssignment.meshRid);
      await addVaultToMesh(db, meshSelfHealAssignment.meshRid, registered.rid, "home");
      appendMeshHomeToFile({
        mainVaultPath: meshSelfHealAssignment.mainVaultPath,
        meshRid: meshSelfHealAssignment.meshRid,
        vaultRid: registered.rid,
        vaultName: effectiveName,
      });
      meshAssignment = {
        meshRidHex: meshSelfHealAssignment.meshRidHex,
        meshName: meshSelfHealAssignment.meshName,
        autoNormalizedFrom: meshSelfHealAssignment.autoNormalizedFrom,
        meshAutoCreated: meshSelfHealAssignment.meshAutoCreated,
        statusVoiceEmitted: meshSelfHealAssignment.statusVoiceEmitted,
      };
    }

    federationSelfHealed = await maybeSelfHealFederation(opts, db);

    // (Brief A) — regenerate the derived pod manifest from the now-populated
    // registry so `pod.yon` reflects this just-registered vault. Runs LAST, after
    // the vault + mesh + federation_state rows have landed. Non-fatal + skipped
    // when the pod isn't initialised (no federation_state yet). Reuses the open
    // registry (open-once).
    await regeneratePodManifestNonFatal(
      db,
      federationSelfHealed !== null ? { handle: federationSelfHealed.handle } : {},
    );

    // Read-back guard on top of registration. Re-read the row by rid and
    // assert the vault is actually present before claiming success — closes
    // the "reported success without effect" class for the init surface.
    const committed = await assertVaultRegistered(db, registered.rid);

    return {
      ...result,
      registered: true,
      federationSelfHealed,
      meshAssignment,
      committed: committed.verdict,
      unverifiedNote: committed.unverifiedNote,
    };
  } finally {
    await closeRegistry(db);
  }
}

interface ResolvedHomeMeshAssignment {
  meshRid: Uint8Array;
  meshRidHex: string;
  meshName: string;
  mainVaultPath: string;
  normalizedName: string;
  autoNormalizedFrom: string | null;
  meshAutoCreated: boolean;
  statusVoiceEmitted: string;
  scaffoldHomeMesh: {
    meshRid: Uint8Array;
    meshName: string;
  };
}

async function maybeAssignHomeMesh(
  opts: InitFlowOptions,
  db: Client,
): Promise<ResolvedHomeMeshAssignment | null> {
  const meshSelfHeal = opts.selfHeal?.mesh;
  if (meshSelfHeal?.enabled !== true) return null;

  const autoMeshName = meshSelfHeal.meshName ?? "personal";
  const slashIdx = opts.name.indexOf("/");

  let resolvedMeshName: string;
  let resolvedVaultLeaf: string;
  let autoNormalizedFrom: string | null;

  if (slashIdx === -1) {
    // Bare name → normalize to `<autoMeshName>/<bare>`.
    resolvedMeshName = autoMeshName;
    resolvedVaultLeaf = opts.name;
    autoNormalizedFrom = opts.name;
  } else {
    // Already-namespaced `<mesh>/<leaf>`. Don't normalize; the mesh slot
    // is the user's chosen name.
    resolvedMeshName = opts.name.slice(0, slashIdx);
    resolvedVaultLeaf = opts.name.slice(slashIdx + 1);
    autoNormalizedFrom = null;
  }
  if (resolvedMeshName.length === 0 || resolvedVaultLeaf.length === 0) {
    return null;
  }

  const normalizedName = `${resolvedMeshName}/${resolvedVaultLeaf}`;

  // 0.9.4 (3c) — CREATE-IF-MISSING, uniform across every mesh name.
  // The old `personal`-only gate (and the HomeMeshNotFoundError refusal for any
  // other namespace) is dropped: `vault init company/x` auto-creates `company`
  // if absent, exactly as a bare init auto-creates `personal`. Push semantics
  // are explicit — a `--push-to <handle>` makes the new mesh a SHARING mesh;
  // without it the mesh is local-only (the prior personal default).
  let meshRow = await getMeshByName(db, resolvedMeshName);
  let meshAutoCreated = false;

  if (meshRow === null) {
    const pushTo = meshSelfHeal.pushTo;
    const wantsPush =
      (pushTo !== undefined && pushTo.length > 0) || meshSelfHeal.pushOnSelfHeal === true;
    const meshResult = await meshInitFlow({
      name: resolvedMeshName,
      noPush: !wantsPush,
      ...(pushTo !== undefined && pushTo.length > 0 ? { pushTo } : {}),
      // Open-once seam (A.4): thread the open registry so mesh-init reuses it
      // instead of opening a 2nd connection (nested-open SQLITE_BUSY risk).
      db,
      ...(meshSelfHeal.ghClient !== undefined ? { ghClient: meshSelfHeal.ghClient } : {}),
    });
    meshRow = await getMeshByName(db, resolvedMeshName);
    if (meshRow === null) {
      // meshInitFlow guarantees a row; this branch is defensive.
      throw new Error(
        `lyt vault init: auto-created mesh '${resolvedMeshName}' did not land in the registry (rid: ${meshResult.meshRidHex}).`,
      );
    }
    meshAutoCreated = true;
  }

  // Resolve the home mesh's main vault path so we can append @MESH_HOME
  // post-scaffold.
  let mainVaultPath: string | null = null;
  if (meshRow.mainVaultRid !== null) {
    const mainVault = await getVaultByExactName(db, `${meshRow.name}/main`);
    if (mainVault !== null) mainVaultPath = mainVault.path;
  }
  if (mainVaultPath === null) {
    // Can't append @MESH_HOME without the main vault path. Surface as a
    // structured error rather than silently dropping the binding.
    throw new HomeMeshNotFoundError(resolvedMeshName);
  }

  const statusVoiceEmitted = meshAutoCreated
    ? `Auto-created mesh '${resolvedMeshName}' (local; --no-push). Vault '${normalizedName}' assigned to it.`
    : `Vault '${normalizedName}' assigned to mesh '${resolvedMeshName}'.`;

  return {
    meshRid: meshRow.rid,
    meshRidHex: meshRow.ridHex,
    meshName: meshRow.name,
    mainVaultPath,
    normalizedName,
    autoNormalizedFrom,
    meshAutoCreated,
    statusVoiceEmitted,
    scaffoldHomeMesh: {
      meshRid: meshRow.rid,
      meshName: meshRow.name,
    },
  };
}

// Self-heal action: takes the predicate's verdict, runs the federation
// init, returns the result for the command layer to surface.
//
// By contract non-fatal: vault creation always succeeds first. The outer
// try/catch covers every step — handle resolution, SQL, gh round-trip —
// and converts failures to a console.error + `null` return.
async function maybeSelfHealFederation(
  opts: InitFlowOptions,
  db: Client,
): Promise<InitFlowResult["federationSelfHealed"]> {
  try {
    const decision = await shouldSelfHealFederation(opts, {
      readFederationStateForHandle: async (handle) => readFederationState(db, handle),
      localFederationDirExists: (handle) => existsSync(getFederationRepoDir(handle)),
    });
    if (decision === null) return null;

    const fed = opts.selfHeal?.federation ?? {};
    const voice = VOICE.forgingFromDetectedState;
    const r = await federationInitFlow({
      handle: decision.handle,
      visibility: "private",
      pushToRemote: fed.pushOnSelfHeal ?? false,
      // Thread the open registry through (fold #4).
      db,
      ...(fed.ghClient !== undefined ? { ghClient: fed.ghClient } : {}),
    });
    if (r.branch === "cached") {
      throw new Error(
        "federation self-heal received branch=cached despite no-state guard — invariant violated; revisit shouldSelfHealFederation.",
      );
    }
    return {
      handle: r.handle,
      fedRidHex: r.fedRidHex,
      branch: r.branch,
      visibility: r.visibility,
      statusVoiceEmitted: voice,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordInitFailure({
      site: "federation-init",
      step: "init:maybeSelfHealFederation",
      summary: `federation self-heal failed: ${msg}`,
      context: { vault: opts.name },
    });
    // eslint-disable-next-line no-console
    console.error(`federation self-heal skipped — ${msg}`);
    return null;
  }
}
