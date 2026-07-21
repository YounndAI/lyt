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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "@libsql/client";

import {
  getMeshByRid,
  insertMesh,
  type MeshRow,
  updateMeshOwnership,
} from "../../registry/meshes-repo.js";
import { getVaultByRid } from "../../registry/repo.js";
import { initVaultDbs } from "../../registry/vault-db.js";
import {
  federationRepoFullName,
  getFederationRepoDir,
  vaultRepoName,
} from "../../util/federation-paths.js";
import {
  destinationPolicyKey,
  type DestinationPolicyRecordV1,
} from "../../registry/destination-policy.js";
import {
  clearOwnedMeshDestinationProjection,
  clearOwnedVaultDestinationProjection,
  prepareOwnedMeshDestinationProjection,
  projectOwnedMeshDestination,
  projectOwnedVaultDestination,
  type MeshDestinationProjection,
  type VaultDestinationProjection,
} from "../../registry/destination-policy-projection.js";
import {
  foldDestinationPolicyWinners,
  readAllDestinationPolicyRecords,
} from "./destination-policy-ledger.js";
import { setCanonicalDestinationPolicy } from "./destination-policy-service.js";
import { getDefaultGhExecutor, type GhExecutor } from "../../util/gh-discover.js";
import { realFederationGhClient } from "../../util/gh-federation.js";
import { isValidGhHandle, validateMeshName, validateVaultName } from "../../util/identity.js";
import { getDefaultVaultsRoot, resolveVaultPath } from "../../util/paths.js";
import { assertNoSymlinkOnWritePath } from "../../util/write-path-guard.js";
import { hexToUuid7Bytes, uuid7BytesToHex } from "../../util/uuid7.js";
import { validatePodManifestSemantics } from "../../yon/federation-manifest-validate.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import { parseVaultYon } from "../../yon/parse.js";
import type { FedMeshRecord, FedMeshRole } from "../../yon/federation-write.js";
import { registerVaultFromYon } from "../register.js";

// Brief B (B.5 — folds a review finding). Pod.yon-driven RECOVERY/acquisition.
//
// On a clean machine, `lyt init` clones the published pod ({handle}/lyt-pod);
// THIS reads the cloned pod.yon and rebuilds the rest: clone each @FED_VAULT's
// repo (by its stored `repo` name) into the resolved vault path, registering it
// with its ORIGINAL rid (registerVaultFromYon preserves identity). Meshes are
// recovered from @FED_MESH first so each vault's home-mesh FK is valid.
//
// This is a review finding's "full vault-acquisition adopt — acquire from pod.yon, not just
// the gh-walk": pod.yon is the user's OWN authoritative manifest of their vaults
// (the gh-walk is a discovery heuristic that also catches repos pod.yon omits).
// Idempotent + non-fatal per item: an already-registered vault is skipped; a
// single clone failure degrades to a recorded skip, never aborts recovery.

export type VaultCloneFn = (args: {
  handle: string;
  repo: string;
  targetPath: string;
}) => Promise<void>;

export interface RecoverPodArgs {
  handle: string;
  // The adopt flow's already-open registry (open-once seam — no nested open).
  registryDb: Client;
  // Defaults to getFederationRepoDir(handle) (the cloned pod dir).
  podDir?: string | undefined;
  // Injectable clone seam (tests pass a fake that drops a vault.yon).
  cloneFn?: VaultCloneFn | undefined;
  // Existing GitHub executor seam, threaded through adopt/bootstrap so tests of
  // the consumed package never escape to the live `gh` binary. Runtime defaults
  // to the real executor below.
  ghExecutor?: GhExecutor | undefined;
}

// G1 (0.12.1 completeness) — a vault DROPPED during the clone-walk is a
// first-class terminal signal, not a silent `warnings`/`skipped` bury. Each drop
// is CLASSIFIED (no gh call) so the reconstruction can distinguish a code bug
// from state drift:
//  - "owner-misresolved": the vault is homed in an ORG mesh but we cloned it
//    under an owner OTHER than that mesh's push_target — the exact Finding-#1
//    failure shape (org vault cloned under the personal handle → 404). A BUG.
//  - "repo-moved-or-deleted": we resolved the owner correctly (personal vault,
//    or an org vault cloned under its own org) but the repo still didn't
//    materialize — the repo genuinely moved/renamed/was deleted on GitHub. STATE.
export type RecoverDropClassification = "owner-misresolved" | "repo-moved-or-deleted";

export interface RecoverDrop {
  vaultName: string;
  repo: string;
  owner: string;
  classification: RecoverDropClassification;
  reason: string;
}

export interface RecoverPodResult {
  meshesRecovered: number;
  vaultsRecovered: { vaultName: string; repo: string; path: string }[];
  skipped: { vaultName: string; reason: string }[];
  warnings: string[];
  // G1 — vaults the clone-walk could not acquire (a subset of `skipped`, but
  // loud + classified). Non-empty ⇒ the reconstruction is INCOMPLETE and must
  // report a nonzero exit (see reconstructionExitCode).
  drops: RecoverDrop[];
  // A distinguishable fail-closed refusal. Semantic incoherence and an
  // unauthenticated ownership claim both stop before the discovery/clone walk;
  // a legitimately-empty coherent pod does not set this and remains exit 0.
  refused?: boolean;
  refusedKind?: "syntax-validation" | "semantic-validation" | "ownership-authentication";
  // Complete, actionable text rendered at the authority boundary. Callers must
  // relay this instead of guessing whether the remedy is manifest repair or
  // GitHub authentication/organization permission.
  refusedReason?: string;
}

// G1 — the exit code a reconstruction command must surface. 0 when every vault
// materialized; nonzero when any dropped (12 when a drop looks like a
// mis-resolved owner / bug, 11 when it looks like pure state drift). Pure so the
// command layer and tests both consume the SAME rule.
export function reconstructionExitCode(result: {
  drops: readonly RecoverDrop[];
  refused?: boolean;
}): number {
  // FIX A (A2-R3 MAJOR-1) — a SEMANTIC REFUSAL is a distinct fail-closed exit (13),
  // independent of `drops.length`. A refusal returns BEFORE the clone-walk, so
  // `drops` is empty; keying on it alone would (wrongly) map a refusal to exit 0.
  if (result.refused === true) return 13;
  if (result.drops.length === 0) return 0;
  return result.drops.some((d) => d.classification === "owner-misresolved") ? 12 : 11;
}

function classifyRecoverDrop(
  manifestRole: FedMeshRole | undefined,
  homeMesh: MeshRow | null,
  owner: string,
): RecoverDropClassification {
  if (
    // R1-m1 fix-pass — gate on the MANIFEST `role`, not just push shape. A
    // BY-DESIGN joined-org fallback (role=join, correctly cloned under the
    // handle) that then 404s is STATE drift, not a bug — only an OWN mesh
    // (role=="own") whose org vault failed to route to its own push_target is
    // the Finding-#1 mis-resolution BUG.
    manifestRole === "own" &&
    homeMesh !== null &&
    homeMesh.pushKind === "org" &&
    homeMesh.pushTarget !== null &&
    homeMesh.pushTarget.length > 0 &&
    owner !== homeMesh.pushTarget
  ) {
    return "owner-misresolved";
  }
  return "repo-moved-or-deleted";
}

const defaultVaultCloneFn: VaultCloneFn = async ({ handle, repo, targetPath }) => {
  // cloneExisting git-clones {handle}/{repo} into targetPath + pins a local git
  // identity (fresh-machine guard). Reused from the pod-repo gh client — the op
  // is generic (handle, repoName, localDir).
  await realFederationGhClient.cloneExisting(handle, repo, targetPath);
};

const ORG_CREATE_AUTHORITY_QUERY =
  "query($login:String!){organization(login:$login){viewerCanCreateRepositories}}";

function renderRecoveryRefusal(
  kind: NonNullable<RecoverPodResult["refusedKind"]>,
  detail: string,
  remedy: string,
): string {
  const subject =
    kind === "syntax-validation"
      ? "pod.yon failed syntax validation"
      : kind === "semantic-validation"
        ? "pod.yon failed semantic validation"
        : "pod.yon ownership authentication failed";
  return `${subject}: ${detail}. ${remedy}`;
}

async function verifyRecoveredOwnMeshClaims(
  meshes: readonly FedMeshRecord[],
  gh: GhExecutor,
): Promise<{ issues: string[]; normalizedPushKinds: Map<string, "handle" | "org"> }> {
  const claims = meshes.filter((mesh) => mesh.role === "own" && mesh.pushTarget.length > 0);
  if (claims.length === 0) return { issues: [], normalizedPushKinds: new Map() };

  const issues: string[] = [];
  const normalizedPushKinds = new Map<string, "handle" | "org">();
  let authenticatedActor: string | null = null;
  const orgAuthority = new Map<string, boolean>();

  const canCreateInOrg = async (target: string): Promise<boolean> => {
    const key = target.toLowerCase();
    let canCreate = orgAuthority.get(key);
    if (canCreate !== undefined) return canCreate;
    const raw = await gh([
      "api",
      "graphql",
      "-f",
      `query=${ORG_CREATE_AUTHORITY_QUERY}`,
      "-F",
      `login=${target}`,
      "--jq",
      ".data.organization.viewerCanCreateRepositories",
    ]);
    canCreate = raw.trim().toLowerCase() === "true";
    orgAuthority.set(key, canCreate);
    return canCreate;
  };

  for (const mesh of claims) {
    try {
      if (mesh.pushKind === "handle") {
        authenticatedActor ??= (await gh(["api", "/user", "--jq", ".login"])).trim();
        if (
          authenticatedActor.length === 0 ||
          authenticatedActor.toLowerCase() !== mesh.pushTarget.toLowerCase()
        ) {
          // Historical pod manifests could record an organization target as
          // `push_kind=handle`. Authenticate that target as an organization
          // before refusing, then normalize the recovered registry row so the
          // next manifest regeneration repairs the stale classification.
          if (await canCreateInOrg(mesh.pushTarget)) {
            normalizedPushKinds.set(mesh.meshRidHex, "org");
            continue;
          }
          issues.push(
            `own mesh ${JSON.stringify(mesh.meshName)} targets owner ` +
              `${JSON.stringify(mesh.pushTarget)}, but it matches neither the authenticated ` +
              `GitHub actor ${JSON.stringify(authenticatedActor || "unknown")} nor an ` +
              `organization where that actor may create repositories`,
          );
        }
        continue;
      }

      const canCreate = await canCreateInOrg(mesh.pushTarget);
      if (!canCreate) {
        issues.push(
          `own mesh ${JSON.stringify(mesh.meshName)} targets organization ` +
            `${JSON.stringify(mesh.pushTarget)}, but GitHub did not confirm that the ` +
            `authenticated actor may create repositories there`,
        );
      }
    } catch (err) {
      issues.push(
        `own mesh ${JSON.stringify(mesh.meshName)} ownership could not be authenticated ` +
          `for ${JSON.stringify(mesh.pushTarget)}: ${errMsg(err)}`,
      );
    }
  }

  return { issues, normalizedPushKinds };
}

export async function recoverVaultsFromPodManifest(
  args: RecoverPodArgs,
): Promise<RecoverPodResult> {
  const db = args.registryDb;
  const cloneFn = args.cloneFn ?? defaultVaultCloneFn;
  const podDir = args.podDir ?? getFederationRepoDir(args.handle);
  const warnings: string[] = [];
  const vaultsRecovered: RecoverPodResult["vaultsRecovered"] = [];
  const skipped: RecoverPodResult["skipped"] = [];
  const drops: RecoverDrop[] = [];

  // release review / a review finding — the handle is resolved from the CLONED pod's
  // identity.yon (resolvePodIdentity precedence) and reaches `git clone
  // https://github.com/<handle>/...`. Refuse to clone with a handle that isn't a
  // valid GitHub username (poisoned-identity guard) BEFORE any git spawn.
  if (!isValidGhHandle(args.handle)) {
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
      drops,
      warnings: [
        `pod identity.yon handle ${JSON.stringify(args.handle)} is not a valid GitHub username — refusing to clone`,
      ],
    };
  }

  const podYonPath = join(podDir, "pod.yon");
  if (!existsSync(podYonPath)) {
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
      drops,
      warnings: ["no pod.yon at cloned pod dir"],
    };
  }

  let doc;
  try {
    doc = parseFederationYon(readFileSync(podYonPath, "utf8"));
  } catch (err) {
    const detail = errMsg(err);
    const remedy =
      `Inspect/repair the pod.yon in ${federationRepoFullName(args.handle)} (or re-clone ` +
      `the pod), then re-run 'lyt init'.`;
    const refusedReason = renderRecoveryRefusal("syntax-validation", detail, remedy);
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
      drops,
      refused: true,
      refusedKind: "syntax-validation",
      refusedReason,
      warnings: [
        `pod.yon failed syntax validation — refusing before any clone: ${detail}. ${remedy}`,
      ],
    };
  }

  // S3 + G2 (0.12.1 identity-safety, two-phase-init step-3 SEMANTIC gate) —
  // validate the parsed manifest for COHERENCE (not just parseability) BEFORE
  // walking any mesh or cloning any vault. Fail-closed-EARLY (design §1 / §6.1
  // S3+G2): a parseable-but-incoherent pod.yon (a vault homing into a mesh absent
  // from the manifest, a duplicate rid, an empty required field, or an OWN mesh
  // whose push_target is not a plausible GitHub owner handle) STOPS the
  // reconstruction with an actionable error before any vault is touched — no
  // silent clone-under-the-fallback-handle.
  const semanticIssues = validatePodManifestSemantics(doc);
  if (semanticIssues.length > 0) {
    const detail = semanticIssues.map((i) => `[${i.code}] ${i.detail}`).join("; ");
    // FIX E (A2-R3 MINOR-4) — an ACTIONABLE remedy on the refusal, so the operator
    // knows the next step (not just that it refused).
    const remedy =
      `Inspect/repair the pod.yon in ${federationRepoFullName(args.handle)} (or re-clone ` +
      `the pod), then re-run 'lyt init'.`;
    const refusedReason = renderRecoveryRefusal("semantic-validation", detail, remedy);
    // eslint-disable-next-line no-console
    console.error(
      `lyt reconstruction REFUSED — pod.yon parsed but is semantically incoherent ` +
        `(${semanticIssues.length} issue(s)); no vault was cloned: ${refusedReason}`,
    );
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
      drops,
      // Distinguishable semantic refusal; ownership authentication below uses
      // the same exit category with a different typed kind and remedy.
      refused: true,
      refusedKind: "semantic-validation",
      refusedReason,
      warnings: [
        `pod.yon failed semantic validation (${semanticIssues.length} issue(s)) — refusing ` +
          `to reconstruct before any clone: ${detail}. ${remedy}`,
      ],
    };
  }

  // `role=own` is a manifest claim, not authenticated authority. `ownCreated`
  // selects repository owners for publish and repair operations, so persisting
  // it from an unverified claim can redirect repo creation, pushes, or origin
  // rewrites. Authenticate every non-local ownership claim before the first
  // mesh insert or vault clone. Personal targets must match the live GitHub
  // actor; organization targets must explicitly allow that actor to create
  // repositories. False or indeterminate proof refuses the whole recovery so
  // no partially-authorized registry state can be consumed later.
  const ownership = await verifyRecoveredOwnMeshClaims(
    doc.meshes,
    args.ghExecutor ?? getDefaultGhExecutor(),
  );
  if (ownership.issues.length > 0) {
    const detail = ownership.issues.join("; ");
    const remedy =
      `Authenticate GitHub with the account that owns these targets (and has repository-create ` +
      `authority for each organization), then re-run 'lyt init'.`;
    const refusedReason = renderRecoveryRefusal("ownership-authentication", detail, remedy);
    // eslint-disable-next-line no-console
    console.error(
      `lyt reconstruction REFUSED — pod.yon ownership claims could not be authenticated; ` +
        `no mesh or vault was recovered: ${refusedReason}`,
    );
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
      drops,
      refused: true,
      refusedKind: "ownership-authentication",
      refusedReason,
      warnings: [
        `pod.yon ownership authentication failed — refusing before any mesh insert or vault ` +
          `clone: ${detail}. ${remedy}`,
      ],
    };
  }

  const recoveredMeshes = doc.meshes.map((mesh) => ({
    ...mesh,
    pushKind: ownership.normalizedPushKinds.get(mesh.meshRidHex) ?? mesh.pushKind,
  }));
  let policyWinners: Map<string, DestinationPolicyRecordV1>;
  try {
    policyWinners = foldDestinationPolicyWinners(
      readAllDestinationPolicyRecords(doc.federation.fedRidHex, podDir),
    );
  } catch (err) {
    const refusedReason = renderRecoveryRefusal(
      "semantic-validation",
      `destination-policy ledger is invalid: ${errMsg(err)}`,
      "Restore the pod policy ledger before retrying recovery",
    );
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
      drops,
      refused: true,
      refusedKind: "semantic-validation",
      refusedReason,
      warnings: [refusedReason],
    };
  }

  // R1-m1 fix-pass — index the MANIFEST mesh records by rid so the vault loop
  // can classify a drop against the manifest's declared `role` (not just the
  // registry row's push shape).
  const manifestMeshByRidHex = new Map<string, FedMeshRecord>();
  for (const m of recoveredMeshes) manifestMeshByRidHex.set(m.meshRidHex, m);

  // 1. Recover meshes first (so vault home-mesh FK is satisfiable). Idempotent.
  let meshesRecovered = 0;
  for (const m of recoveredMeshes) {
    try {
      // fed-v2 Layer-2 P1 (recover-pod meshName) — the pod.yon is FOREIGN input
      // (a cloned manifest, possibly hostile). Validate the declared mesh name
      // through the SAME user-facing validator the create/move/init sinks use
      // (validateMeshName → assertMeshNameNotReserved + slug-safe + Windows-
      // reserved), BEFORE insertMesh. A reserved name (`subscriptions`, `shared`,
      // `agents`, `published`) or a non-slug name must NOT land in the registry
      // verbatim — it would collide with or shadow the system's own federation
      // buckets. Mirror clone.ts:283. Refuse this mesh (recorded as a warning),
      // never abort the whole recovery.
      try {
        validateMeshName(m.meshName);
      } catch (validationErr) {
        warnings.push(
          `mesh ${JSON.stringify(m.meshName)} refused (invalid or reserved mesh name): ${errMsg(validationErr)}`,
        );
        continue;
      }
      const rid = hexToUuid7Bytes(m.meshRidHex);
      const existingMesh = await getMeshByRid(db, rid);
      const policyWinner = policyWinners.get(destinationPolicyKey("mesh", m.meshRidHex)) ?? null;
      if (existingMesh === null) {
        await insertMesh(db, {
          rid,
          name: m.meshName,
          pushTarget: policyWinner === null ? m.pushTarget : null,
          pushKind: policyWinner === null ? m.pushKind : null,
          createdAt: m.addedAt,
          // #1 (SC2) — RESTORE ownership from the manifest's `role`. Omitting
          // ownCreated fail-closed to false, which reconstructed every OWN mesh
          // as `join` and (via deriveVaultRepoOwner) refused the org push_target,
          // clone-404ing every org vault. The manifest's `role` IS the
          // ownership claim. M2 keeps parsing fail-CLOSED: only an explicit
          // `role=="own"` can reach this assignment. The authenticated preflight
          // above is the authority boundary: it proves the live actor matches a
          // personal target or may create repositories in the target org before
          // any mesh is inserted. Therefore this restore never promotes the
          // unauthenticated manifest claim by itself.
          ownCreated: m.role === "own",
        });
        if (m.role === "own" && policyWinner !== null) {
          await prepareOwnedMeshDestinationProjection(db, rid);
          if (policyWinner.state === "active") {
            await projectOwnedMeshDestination(db, rid, meshProjectionFromPolicy(policyWinner));
          } else {
            await clearOwnedMeshDestinationProjection(db, rid);
          }
        }
        meshesRecovered += 1;
      } else if (m.role === "own") {
        // Recovery is idempotent over partial/legacy local state. The ownership
        // preflight above authenticated this exact target before any mutation,
        // so converge an existing row to the verified manifest authority too.
        if (policyWinner === null) {
          // Legacy absence cannot clear a projection already known to come from
          // explicit 0.20 policy. Only legacy/unconfigured rows may be seeded
          // from the authenticated compatibility manifest.
          if (
            existingMesh.destinationSource !== "explicit" &&
            existingMesh.destinationSource !== "authenticated-default"
          ) {
            await updateMeshOwnership(db, rid, {
              pushTarget: m.pushTarget,
              pushKind: m.pushKind,
              ownCreated: true,
            });
          }
        } else {
          await prepareOwnedMeshDestinationProjection(db, rid);
          if (policyWinner.state === "active") {
            await projectOwnedMeshDestination(db, rid, meshProjectionFromPolicy(policyWinner));
          } else {
            await clearOwnedMeshDestinationProjection(db, rid);
          }
        }
      }
    } catch (err) {
      warnings.push(`mesh ${m.meshName}: ${errMsg(err)}`);
    }
  }

  // 2. Recover vaults from @FED_VAULT — clone the repo + register (rid preserved).
  // Inc-2 Phase 0 : pod.yon is the derived view of the ledger fold, which
  // EXCLUDES tombstoned (retracted) vaults — so a retracted vault never appears
  // in `doc.vaults`. The old `status === "tombstoned"` skip is therefore dead
  // (status is reachability-only now) and was removed.
  for (const v of doc.vaults) {
    const repo = v.repo.length > 0 ? v.repo : vaultRepoName(v.vaultName);
    const manifestHomeMeshRidHex = v.homeMeshRidHex;
    // #2 — resolve the clone source from the manifest's legacy origin hint.
    // not the pod-owner handle. An ORG-mesh vault lives under the org handle; the
    // old `cloneFn({ handle: args.handle, ... })` cloned it under the personal
    // handle → 404. deriveVaultRepoOwner reuses the SAME trust gate the publish
    // rail uses (org push_target ONLY when the mesh is own-created — a joined
    // mesh's untrusted push_target falls back to the federation handle, closing
    // the origin-hijack; SC2-neg). Read the RESTORED registry mesh row (its
    // push_target was already handle-validated at insertMesh) so an orphan or a
    // refused/reserved mesh safely falls back too.
    let homeMesh: MeshRow | null = null;
    let owner = args.handle;
    // The vault's home-mesh role as DECLARED in the manifest (undefined for an
    // orphan / absent mesh block) — drives the drop classifier (R1-m1).
    const manifestMesh =
      manifestHomeMeshRidHex !== null
        ? manifestMeshByRidHex.get(manifestHomeMeshRidHex)
        : undefined;
    const manifestRole = manifestMesh?.role;
    try {
      if (v.homeMeshRidHex !== null) {
        homeMesh = await getMeshByRid(db, hexToUuid7Bytes(v.homeMeshRidHex));
      }
      // The cloned pod manifest is the reconstruction source of truth for the
      // READ coordinate. Historical pod.yon files legitimately carry
      // `role=join` + `push_kind=handle` for meshes owned through another
      // account/org, while still preserving their correct push_target (for
      // example Marlink-Technologies and YounndAI). `role` continues to gate
      // write authority/ownCreated. A current foreign `role=join` + `push_kind=org`
      // remains untrusted and falls back to the pod owner.
      owner =
        manifestMesh !== undefined &&
        isValidGhHandle(manifestMesh.pushTarget) &&
        (manifestMesh.role === "own" || manifestMesh.pushKind === "handle")
          ? manifestMesh.pushTarget
          : args.handle;
    } catch {
      owner = args.handle;
    }
    // Defense-in-depth (mirror the top-level handle guard): a derived owner that
    // isn't a valid GitHub username must never reach the clone spawn.
    if (!isValidGhHandle(owner)) owner = args.handle;
    try {
      validateVaultName(v.vaultName);
      // Idempotency probe is rid-keyed, NOT name-keyed. The vault `rid`
      // (UUIDv7 identity) is stable across rename/move; the name in pod.yon can
      // diverge from the registry (a local rename, or a colliding name across
      // meshes). A name-keyed probe (`getVaultByName`) routes through the
      // leaf/alias resolver and would either miss an already-recovered vault
      // under a changed name (→ re-clone + re-register, a duplicate-identity
      // clobber) or resolve a bare leaf to a DIFFERENT vault. Match on identity.
      const ridBytes = hexToUuid7Bytes(v.vaultRidHex);
      const vaultPolicyWinner =
        policyWinners.get(destinationPolicyKey("vault", v.vaultRidHex)) ?? null;
      const existingVault = await getVaultByRid(db, ridBytes);
      if (existingVault !== null) {
        if (existingVault.source === "own") {
          await applyRecoveredOwnedVaultPolicy(
            db,
            ridBytes,
            existingVault,
            homeMesh,
            vaultPolicyWinner,
            doc.federation.fedRidHex,
            podDir,
          );
        }
        skipped.push({ vaultName: v.vaultName, reason: "already-registered" });
        continue;
      }
      const targetPath = resolveVaultPath(v.vaultName);
      // Guard the target leaf and every parent before even probing for an
      // existing vault.yon: a leaf junction can make that read, DB init, and
      // registration operate on an external tree without ever cloning.
      assertNoSymlinkOnWritePath(getDefaultVaultsRoot(), targetPath);
      const vaultYonPath = join(targetPath, ".lyt", "vault.yon");
      if (!existsSync(vaultYonPath)) {
        await cloneFn({ handle: owner, repo, targetPath });
      }
      // A clone can introduce links below the target root after the first
      // guard. Re-check the exact metadata and index paths before read/write.
      assertNoSymlinkOnWritePath(targetPath, vaultYonPath);
      assertNoSymlinkOnWritePath(targetPath, join(targetPath, ".lyt", "indexes"));
      if (!existsSync(vaultYonPath)) {
        const reason = "clone produced no .lyt/vault.yon";
        skipped.push({ vaultName: v.vaultName, reason });
        // G1 — a clone that produced nothing is a DROP, not a silent skip.
        drops.push({
          vaultName: v.vaultName,
          repo,
          owner,
          classification: classifyRecoverDrop(manifestRole, homeMesh, owner),
          reason,
        });
        continue;
      }
      const clonedVault = parseVaultYon(readFileSync(vaultYonPath, "utf8"));
      if (clonedVault.name !== v.vaultName) {
        throw new Error(
          `cloned vault identity mismatch: pod.yon names '${v.vaultName}', ` +
            `but .lyt/vault.yon names '${clonedVault.name}'`,
        );
      }
      const clonedHomeMeshRid = clonedVault.homeMesh?.meshRid;
      if (
        manifestHomeMeshRidHex === null ||
        manifestMesh === undefined ||
        clonedHomeMeshRid === undefined ||
        uuid7BytesToHex(hexToUuid7Bytes(clonedHomeMeshRid)) !== manifestHomeMeshRidHex ||
        clonedVault.homeMesh?.meshName !== manifestMesh.meshName
      ) {
        throw new Error(
          `cloned vault home-mesh mismatch for '${v.vaultName}': ` +
            `pod.yon requires mesh '${manifestMesh?.meshName ?? manifestHomeMeshRidHex ?? "<missing>"}'`,
        );
      }
      // A just-cloned vault has no .lyt/indexes/*.db (gitignored) — init them so
      // the downstream Lane M reconcile has schemas to fill.
      await initVaultDbs(targetPath);
      // fed-v2 Layer-2 P1 — recover-pod is the identity-PRESERVING
      // restore axis: a genuine reconstitution re-homes an existing rid (same
      // name) to this machine's path, so it carries trustedReconstruction. The
      // name-mismatch refusal in upsertVault stays UNCONDITIONAL, so a hostile
      // clone whose vault.yon asserts a DIFFERENT-named local victim's rid is
      // still refused here (the impersonation defense the rid-keyed idempotency
      // probe above cannot catch — that probe keys off the pod.yon MANIFEST rid,
      // not the cloned vault.yon rid). NOTE: trustedReconstruction is a no-op
      // today (upsertVault :267 `void`s it); pre-wired for the P5 same-name-arm
      // gate.
      const reg = await registerVaultFromYon(db, {
        vaultPath: targetPath,
        trustedReconstruction: true,
        ridOverride: ridBytes,
        homeMeshRidOverride: hexToUuid7Bytes(manifestHomeMeshRidHex),
      });
      const recoveredVault = await getVaultByRid(db, ridBytes);
      if (recoveredVault?.source === "own") {
        await applyRecoveredOwnedVaultPolicy(
          db,
          ridBytes,
          recoveredVault,
          homeMesh,
          vaultPolicyWinner,
          doc.federation.fedRidHex,
          podDir,
        );
      }
      vaultsRecovered.push({ vaultName: reg.name, repo, path: targetPath });
    } catch (err) {
      const reason = errMsg(err);
      warnings.push(`vault ${v.vaultName}: ${reason}`);
      skipped.push({ vaultName: v.vaultName, reason });
      // G1 — a clone/register failure is also a DROP.
      drops.push({
        vaultName: v.vaultName,
        repo,
        owner,
        classification: classifyRecoverDrop(manifestRole, homeMesh, owner),
        reason,
      });
    }
  }

  // G1 — a reconstruction that dropped any vault is INCOMPLETE. Summarize LOUDLY
  // (regardless of caller), separating the BUG shape from the STATE shape, and
  // hand the caller a nonzero exit code via reconstructionExitCode.
  if (drops.length > 0) {
    const bug = drops.filter((d) => d.classification === "owner-misresolved");
    const state = drops.filter((d) => d.classification === "repo-moved-or-deleted");
    // eslint-disable-next-line no-console
    console.error(
      `lyt reconstruction INCOMPLETE — dropped ${drops.length} vault(s) during the ` +
        `clone-walk (exit ${reconstructionExitCode({ drops })}).`,
    );
    for (const d of bug) {
      // eslint-disable-next-line no-console
      console.error(
        `  ✗ ${d.vaultName} [owner-misresolved — likely a BUG: cloned under ` +
          `${JSON.stringify(d.owner)}, repo ${JSON.stringify(d.repo)}]: ${d.reason}`,
      );
    }
    for (const d of state) {
      // eslint-disable-next-line no-console
      console.error(
        `  ✗ ${d.vaultName} [repo-moved-or-deleted — likely STATE drift: owner ` +
          `${JSON.stringify(d.owner)}, repo ${JSON.stringify(d.repo)}]: ${d.reason}`,
      );
    }
  }

  return { meshesRecovered, vaultsRecovered, skipped, warnings, drops };
}

function meshProjectionFromPolicy(policy: DestinationPolicyRecordV1): MeshDestinationProjection {
  if (
    policy.subjectKind !== "mesh" ||
    (policy.source !== "explicit" &&
      policy.source !== "authenticated-default" &&
      policy.source !== "legacy-derived")
  ) {
    throw new Error("Destination-policy winner does not contain a mesh policy.");
  }
  return {
    destinationKind: policy.destinationKind,
    targetOwner: policy.targetOwner,
    targetKind: policy.targetKind,
    source: policy.source,
  };
}

async function applyOwnedVaultPolicyWinner(
  db: Client,
  vaultRid: Uint8Array,
  policy: DestinationPolicyRecordV1,
): Promise<void> {
  if (policy.subjectKind !== "vault") {
    throw new Error("Destination-policy winner does not contain a vault policy.");
  }
  if (policy.state === "tombstoned") {
    await clearOwnedVaultDestinationProjection(db, vaultRid);
    return;
  }
  await projectOwnedVaultDestination(db, vaultRid, vaultProjectionFromPolicy(policy));
}

async function applyRecoveredOwnedVaultPolicy(
  db: Client,
  vaultRid: Uint8Array,
  vault: NonNullable<Awaited<ReturnType<typeof getVaultByRid>>>,
  homeMesh: MeshRow | null,
  winner: DestinationPolicyRecordV1 | null,
  podRid: string,
  podRoot: string,
): Promise<void> {
  if (winner !== null) {
    await applyOwnedVaultPolicyWinner(db, vaultRid, winner);
    return;
  }

  // Preserve an exact projected override/inherited snapshot before consulting
  // the current mesh. The projection is migration input only: recovery emits a
  // canonical vault ledger record before any later publication can proceed.
  const inherited =
    (vault.destinationSource === "mesh-inherited" ||
      vault.destinationSource === "vault-override") &&
    (vault.destinationKind === "local" || vault.destinationKind === "github")
      ? {
          destinationKind: vault.destinationKind,
          targetOwner: vault.destinationKind === "github" ? vault.destinationTarget : null,
          targetKind: vault.destinationKind === "github" ? vault.destinationTargetKind : null,
          repositoryName:
            vault.destinationKind === "github" ? vault.destinationRepositoryName : null,
          source: vault.destinationSource,
        }
      : homeMesh?.ownCreated === true &&
          homeMesh.destinationSource !== null &&
          homeMesh.destinationSource !== "legacy-derived" &&
          homeMesh.destinationKind === "local"
        ? {
            destinationKind: "local" as const,
            targetOwner: null,
            targetKind: null,
            repositoryName: null,
            source: "mesh-inherited" as const,
          }
        : null;
  if (inherited === null) return;
  if (inherited.destinationKind === "github" && inherited.repositoryName === null) return;

  await setCanonicalDestinationPolicy(db, {
    podRid,
    podRoot,
    subjectKind: "vault",
    subjectRid: vaultRid,
    destinationKind: inherited.destinationKind,
    targetOwner: inherited.targetOwner,
    targetKind: inherited.targetKind,
    repositoryName: inherited.repositoryName,
    source: inherited.source,
  });
}

function vaultProjectionFromPolicy(policy: DestinationPolicyRecordV1): VaultDestinationProjection {
  if (
    policy.subjectKind !== "vault" ||
    (policy.source !== "mesh-inherited" &&
      policy.source !== "vault-override" &&
      policy.source !== "legacy-derived")
  ) {
    throw new Error("Destination-policy winner does not contain a vault policy.");
  }
  return {
    destinationKind: policy.destinationKind,
    targetOwner: policy.targetOwner,
    targetKind: policy.targetKind,
    repositoryName: policy.repositoryName ?? null,
    source: policy.source,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
