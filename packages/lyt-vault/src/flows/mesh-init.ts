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

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { regeneratePodManifestNonFatal } from "./federation/regenerate.js";
import { initVaultDbs } from "../registry/vault-db.js";
import { getMeshByName, insertMesh, updateMeshMainVault } from "../registry/meshes-repo.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { setVaultHomeMesh } from "../registry/repo.js";
import { initVault } from "../scaffold/init.js";
import { getHandleFromIdentity, validateMeshName } from "../util/identity.js";
import { healPatterns } from "../util/pattern-paths.js";
import { resolveRemoteUrl } from "../util/remote-url.js";
import { newUuidv7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import { renderMeshYon } from "../yon/mesh-write.js";
import type { MeshPushKind } from "../yon/mesh-write.js";
import type { MeshGhClient } from "../util/gh-mesh.js";
import { realMeshGhClient } from "../util/gh-mesh.js";
import { registerVaultFromYon } from "./register.js";
import { indexScaffoldFtsOnCreate } from "./upsert-fts-cache.js";

// v1.B.1 — `lyt mesh init <name>` flow.
//
// Source: Brief steps 1-2 + lyt-federation-design.md §3 (mesh.yon
// schema verbatim, lines 121-151) + lyt-master-plan.md §5 v1.B.1 + Brief
// @CONTINUATION §5 (mesh.yon initial-state shape).
//
// Order of operations (Brief step 2):
// (a) validate <name> as mesh-name slot (no `/`, slug-safe — validateMeshName)
// (b) resolve --parent <existing-mesh> → mesh's main_vault_rid as parentVaultRid
// for the new main vault (BLOB FK on vaults.parent_vault per v1.A.1b)
// (c) generate meshRid = newUuidv7Bytes()
// (d) scaffold the main vault via initVault({ name: '<name>/main', parentVaultRid, ... })
// (e) initialise per-vault libSQL + register vault row in `vaults`
// (f) write .lyt/mesh.yon (initial state: @MESH + @MESH_HOME for the main)
// (g) INSERT into meshes (with main_vault_rid pointing at the just-registered vault)
// (h) UPDATE vaults.home_mesh_rid for the main vault → meshRid
// (i) INSERT into mesh_vaults role='home' (composite PK + partial unique idx)
// (j) optionally push the main vault repo to the resolved GH target
//
// v1.B.1 keeps the cross-mesh edge unwritten — parent linkage is captured
// purely via `vaults.parent_vault` BLOB FK per v1.A.1b. @MESH_EDGE writer
// ships v1.C.1.

export interface MeshInitOptions {
  name: string;
  parent?: string | undefined;
  pushTo?: string | undefined;
  pushKind?: MeshPushKind | undefined;
  noPush?: boolean | undefined;
  // Test seam — pass FakeMeshGhClient to record calls without hitting the
  // real `gh`/`git` shellouts. Mirrors the FederationGhClient pattern from
  // v1.A.0.
  ghClient?: MeshGhClient | undefined;
  // Test seam — override the registry path (vitest fixtures point at a
  // tempdir-scoped LYT_HOME via env, but flow signatures kept symmetric
  // with flows/init.ts for clarity).
  registryPath?: string | undefined;
  // Open-once registry seam (Brief A A.4 / a review finding): when a parent flow already
  // holds the registry open (initVaultFlow, adoptAndPrimeFlow, initBootstrap),
  // it threads its client here so mesh-init does NOT open a 2nd connection —
  // the nested-open that risked Windows SQLITE_BUSY. Caller owns close(); when
  // supplied, `registryPath` is ignored (the caller's client wins).
  db?: Client | undefined;
}

export interface MeshInitResult {
  meshRid: Uint8Array;
  meshRidHex: string;
  meshName: string;
  pushTarget: string | null;
  pushKind: MeshPushKind | null;
  pushed: boolean;
  mainVault: {
    rid: Uint8Array;
    ridHex: string;
    name: string;
    path: string;
  };
  parentVault: {
    rid: Uint8Array;
    ridHex: string;
    name: string;
  } | null;
}

export async function meshInitFlow(opts: MeshInitOptions): Promise<MeshInitResult> {
  validateMeshName(opts.name);

  // POD-level pattern resolution. mesh-init is the single sub-flow
  // BOTH fresh-pod entry points converge on (wizard P8
  // phase6_createPersonalMesh AND `lyt init --auto/--custom` doFreshBranch),
  // and it's where the pod's `~/lyt/` tree is first materialised — so it is
  // the right single call site to resolve patterns into `~/lyt/patterns/`.
  // healPatterns (the version-gated resolver) supersedes the additive-only
  // copyBundledPatterns: add missing, replace pristine-older (with backup),
  // leave handler forks untouched — so the fresh/wizard path stays current with
  // bundled updates, not just non-empty. Idempotent + pod-scoped. Fixes
  // HANDOFF-006 (empty ~/lyt/patterns/) + the 2026-06-05 "updated patterns"
  // requirement.
  healPatterns();

  // Open-once seam (A.4 / a review finding): reuse the caller's registry when threaded;
  // otherwise open our own and close it in finally. `ownDb` flags ownership.
  const ownDb = opts.db === undefined;
  const db =
    opts.db ??
    (await openRegistry(opts.registryPath !== undefined ? { path: opts.registryPath } : undefined));
  try {
    // (a) duplicate-name guard (meshes.name is UNIQUE — surface a clear error
    // instead of the raw SQLite UNIQUE violation).
    const existingMesh = await getMeshByName(db, opts.name);
    if (existingMesh !== null) {
      throw new Error(
        `Mesh '${opts.name}' is already registered (rid: ${existingMesh.ridHex}). ` +
          `Use a different mesh name or 'lyt mesh list' to inspect existing meshes.`,
      );
    }

    // (b) resolve --parent: the parent mesh's main vault becomes the
    // parent_vault FK for the new main vault.
    let parentLink: MeshInitResult["parentVault"] = null;
    let parentVaultRid: Uint8Array | undefined;
    if (opts.parent !== undefined && opts.parent.length > 0) {
      const parentMesh = await getMeshByName(db, opts.parent);
      if (parentMesh === null) {
        throw new Error(
          `--parent <mesh>: no mesh registered with name '${opts.parent}'. ` +
            `Use 'lyt mesh list' to see registered meshes.`,
        );
      }
      if (parentMesh.mainVaultRid === null) {
        throw new Error(
          `--parent <mesh>: mesh '${opts.parent}' has no main vault set (rid: ${parentMesh.ridHex}). ` +
            `This is a structural invariant violation — the parent mesh is malformed.`,
        );
      }
      parentVaultRid = parentMesh.mainVaultRid;
      parentLink = {
        rid: parentMesh.mainVaultRid,
        ridHex: parentMesh.mainVaultRidHex ?? uuid7BytesToHex(parentMesh.mainVaultRid),
        name: `${parentMesh.name}/main`,
      };
    }

    // (c) generate the mesh rid.
    const meshRid = newUuidv7Bytes();
    const meshRidHex = uuid7BytesToHex(meshRid);

    // Resolve the push target. --no-push + no --push-to → omit from mesh.yon;
    // --push-to <target> always recorded; bare default → user's GH handle.
    const pushPlan = resolvePushPlan(opts);

    // v1.B.3 — INSERT the meshes row FIRST (with main_vault_rid NULL) so
    // that when registerVaultFromYon runs and reads the @VAULT_HOME_MESH
    // record from the scaffolded vault.yon, the FK on vaults.home_mesh_rid
    // resolves cleanly. (Pre-v1.B.3 ordering put mesh INSERT after vault
    // register, which worked because vault.yon carried NO @VAULT_HOME_MESH;
    // v1.B.3's @VAULT_HOME_MESH-at-scaffold means register-from-yon now
    // needs the meshes row in place.)
    const createdAt = new Date().toISOString();
    await insertMesh(db, {
      rid: meshRid,
      name: opts.name,
      pushTarget: pushPlan.target,
      pushKind: pushPlan.kind,
      mainVaultRid: null,
      createdAt,
    });

    // (d) scaffold the main vault via the existing initVault helper. The
    // vault gets name '<mesh>/main'; parent_vault FK threaded through bytes.
    // git is initialised; the initial commit is HELD so we can fold mesh.yon
    // into it (a single coherent "vault scaffolded" commit, not two).
    //
    // v1.B.3 — thread the home-mesh assignment through the scaffold so the
    // main vault's vault.yon carries a @VAULT_HOME_MESH record from first
    // write. Keeps vault.yon SoT in sync with mesh.yon SoT — a fresh clone
    // + rebuild-registry round-trip re-derives the binding correctly from
    // either file.
    const mainVaultName = `${opts.name}/main`;
    const scaffoldResult = initVault({
      name: mainVaultName,
      ...(parentVaultRid !== undefined ? { parentVaultRid } : {}),
      gitInit: true,
      commitInitial: false,
      homeMesh: {
        meshRid,
        meshName: opts.name,
        assignedAt: createdAt,
      },
    });

    // (e) per-vault libSQL + registry row. register-from-yon reads the
    // @VAULT_HOME_MESH from vault.yon and sets vaults.home_mesh_rid → meshRid
    // (meshes row was inserted above, so the FK resolves).
    await initVaultDbs(scaffoldResult.vaultPath);
    // B-4 / Decision-B (B2): index the auto-created `<mesh>/main` vault's scaffold
    // figments into FTS at create so doctor's index-fts-smoke does not false-warn
    // (exit 2) on it. Shared seam + rationale: indexScaffoldFtsOnCreate
    // (upsert-fts-cache.ts) — keep in sync with the flows/init.ts call site.
    await indexScaffoldFtsOnCreate(scaffoldResult.vaultPath);
    const registered = await registerVaultFromYon(db, {
      vaultPath: scaffoldResult.vaultPath,
    });

    // (f) write the initial-state mesh.yon (single @MESH + single @MESH_HOME).
    const meshYon = renderMeshYon({
      mesh: {
        rid: meshRid,
        name: opts.name,
        ...(pushPlan.target !== null ? { pushTarget: pushPlan.target } : {}),
        ...(pushPlan.kind !== null ? { pushKind: pushPlan.kind } : {}),
        mainVaultRid: registered.rid,
        createdAt,
      },
      homeVaults: [
        {
          meshRid,
          vaultRid: registered.rid,
          vaultName: mainVaultName,
        },
      ],
    });
    const meshYonPath = join(scaffoldResult.vaultPath, ".lyt", "mesh.yon");
    mkdirSync(join(scaffoldResult.vaultPath, ".lyt"), { recursive: true });
    writeFileSync(meshYonPath, meshYon, "utf8");

    // (g) UPDATE meshes.main_vault_rid → registered vault rid (was NULL
    // at insert time per v1.B.3 reordering).
    // (h) belt-and-braces UPDATE vaults.home_mesh_rid → meshRid (register-
    // from-yon already did this via @VAULT_HOME_MESH; idempotent).
    // (i) INSERT mesh_vaults role='home'.
    await updateMeshMainVault(db, meshRid, registered.rid);
    await setVaultHomeMesh(db, registered.rid, meshRid);
    await addVaultToMesh(db, meshRid, registered.rid, "home");

    // (j) push to the resolved GH target if not opted out. The initial
    // commit is created here (we held it back during scaffold) so mesh.yon
    // ships as part of the first commit, not a follow-up. v1.B.1 keeps the
    // commit logic inline (vs. extending scaffold's runInitialCommit) so
    // the mesh-init-specific paths stay scoped to this flow.
    let pushed = false;
    if (opts.noPush !== true && pushPlan.target !== null) {
      const ghClient = opts.ghClient ?? realMeshGhClient;
      pushed = await commitAndPushMain(scaffoldResult.vaultPath, pushPlan.target, ghClient);
    }

    // (Brief A) — when mesh-init is the STANDALONE entry (`lyt mesh init`,
    // ownDb), regenerate the derived pod manifest so a new mesh+vault shows up
    // in pod.yon. When a parent flow threaded its db (init/adopt), SKIP — the
    // parent regenerates once at the end of its own lifecycle (avoids redundant
    // regens mid-flow). Non-fatal + skipped when the pod isn't initialised.
    if (ownDb) {
      await regeneratePodManifestNonFatal(db);
    }

    return {
      meshRid,
      meshRidHex,
      meshName: opts.name,
      pushTarget: pushPlan.target,
      pushKind: pushPlan.kind,
      pushed,
      mainVault: {
        rid: registered.rid,
        ridHex: registered.ridHex,
        name: registered.name,
        path: registered.path,
      },
      parentVault: parentLink,
    };
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}

interface ResolvedPush {
  target: string | null;
  kind: MeshPushKind | null;
}

function resolvePushPlan(opts: MeshInitOptions): ResolvedPush {
  // Explicit --push-to wins.
  if (opts.pushTo !== undefined && opts.pushTo.length > 0) {
    return {
      target: opts.pushTo,
      kind: opts.pushKind ?? "handle",
    };
  }
  // --no-push without --push-to → omit push fields from mesh.yon. No identity
  // lookup, so the four-mesh test walkthrough works without `gh` configured.
  if (opts.noPush === true) {
    return { target: null, kind: null };
  }
  // Default: resolve the user's GH handle. Throws if identity not resolvable.
  // Callers (CLI command layer) surface the error verbatim.
  const handle = getHandleFromIdentity();
  return { target: handle, kind: "handle" };
}

const isWindows = process.platform === "win32";

async function commitAndPushMain(
  vaultPath: string,
  pushTarget: string,
  ghClient: MeshGhClient,
): Promise<boolean> {
  if (!existsSync(join(vaultPath, ".git"))) {
    // No .git → scaffold's gitInit was skipped or failed. Nothing to push.
    return false;
  }
  try {
    execFileSync("git", ["add", "."], {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "pipe"],
      shell: isWindows,
    });
    execFileSync("git", ["commit", "-m", "chore: lyt mesh init scaffold"], {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "pipe"],
      shell: isWindows,
    });
    // Pin local-repo identity if global git config is missing — matches
    // gh-federation.ts initLocalFromFresh guard.
    execFileSync("git", ["config", "user.name", pushTarget], {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "pipe"],
      shell: isWindows,
    });
    execFileSync("git", ["config", "user.email", `${pushTarget}@users.noreply.github.com`], {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "pipe"],
      shell: isWindows,
    });
    execFileSync("git", ["remote", "add", "origin", resolveRemoteUrl(pushTarget, "main")], {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "pipe"],
      shell: isWindows,
    });
    await ghClient.pushRepo(vaultPath);
    return true;
  } catch {
    // Push failures are non-fatal — local mesh state is already correct.
    // The handler can recover via `git push` directly or `lyt mesh fsck`
    // (ships v1.C.4). Mirrors federation init's non-fatal posture.
    return false;
  }
}
