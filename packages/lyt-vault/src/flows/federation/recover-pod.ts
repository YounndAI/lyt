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

import { getMeshByRid, insertMesh, type MeshRow } from "../../registry/meshes-repo.js";
import { getVaultByRid } from "../../registry/repo.js";
import { initVaultDbs } from "../../registry/vault-db.js";
import {
  deriveVaultRepoOwner,
  federationRepoFullName,
  getFederationRepoDir,
  vaultRepoName,
} from "../../util/federation-paths.js";
import { realFederationGhClient } from "../../util/gh-federation.js";
import { isValidGhHandle, validateMeshName } from "../../util/identity.js";
import { resolveVaultPath } from "../../util/paths.js";
import { hexToUuid7Bytes } from "../../util/uuid7.js";
import { validatePodManifestSemantics } from "../../yon/federation-manifest-validate.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import type { FedMeshRole } from "../../yon/federation-write.js";
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
  // FIX A (A2-R3 MAJOR-1) — a DISTINGUISHABLE semantic-refusal signal. Set ONLY on
  // the semantic-validation refusal return (a parseable-but-incoherent pod.yon):
  // fail-closed-EARLY. A legitimately-empty COHERENT pod (0 issues, 0 vaults) MUST
  // NOT set it — it is a legit success (exit 0). Threaded end-to-end so the exit
  // code is a distinct nonzero (13), the step-3b gh-discovery walk is NOT run, and
  // the wizard/command layer reports FAILURE, never "Adopted successfully".
  refused?: boolean;
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
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
      drops,
      warnings: [`pod.yon parse failed: ${errMsg(err)}`],
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
    // eslint-disable-next-line no-console
    console.error(
      `lyt reconstruction REFUSED — pod.yon parsed but is semantically incoherent ` +
        `(${semanticIssues.length} issue(s)); no vault was cloned: ${detail}. ${remedy}`,
    );
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
      drops,
      // FIX A — the DISTINGUISHABLE fail-closed-early signal (set ONLY here). A
      // legit-empty coherent pod never reaches this branch, so it never sets it.
      refused: true,
      refusedReason: `pod.yon failed semantic validation (${semanticIssues.length} issue(s)): ${detail}`,
      warnings: [
        `pod.yon failed semantic validation (${semanticIssues.length} issue(s)) — refusing ` +
          `to reconstruct before any clone: ${detail}. ${remedy}`,
      ],
    };
  }

  // R1-m1 fix-pass — index the MANIFEST mesh records by rid so the vault loop
  // can classify a drop against the manifest's declared `role` (not just the
  // registry row's push shape).
  const manifestMeshByRidHex = new Map<string, FedMeshRole>();
  for (const m of doc.meshes) manifestMeshByRidHex.set(m.meshRidHex, m.role);

  // 1. Recover meshes first (so vault home-mesh FK is satisfiable). Idempotent.
  let meshesRecovered = 0;
  for (const m of doc.meshes) {
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
      if ((await getMeshByRid(db, rid)) === null) {
        await insertMesh(db, {
          rid,
          name: m.meshName,
          pushTarget: m.pushTarget,
          pushKind: m.pushKind,
          // #1 (SC2) — RESTORE ownership from the manifest's `role`. Omitting
          // ownCreated fail-closed to false, which reconstructed every OWN mesh
          // as `join` and (via deriveVaultRepoOwner) refused the org push_target,
          // clone-404ing every org vault. The manifest's `role` IS the
          // ownership authority (H1: manifest-derivable, no gh call). M2 keeps
          // this fail-CLOSED: only an explicit `role=="own"` confers ownership.
          //
          // LOAD-BEARING INVARIANT (a review finding) — recover-pod reads ONLY the
          // user's OWN `{handle}/lyt-pod`, a PROJECTED manifest view with NO
          // per-writer `writerId`, so this path structurally CANNOT apply the
          // origin-writer guard the ledger write-back uses. Trusting `role=own`
          // here is safe ONLY because the invariant "pod.yon role=own ⇒
          // user-authored via `lyt mesh init`" holds: `mesh join` hard-sets
          // ownCreated=false (mesh-join.ts) and `mesh subscribe` never touches
          // the mesh ledger, so no foreign mesh is ever folded into this pod.yon
          // with role=own. If any FUTURE flow folds a foreign mesh into pod.yon
          // as role=own (e.g. a cross-pod mesh-ledger merge), THIS restore
          // re-opens the origin-hijack — such a flow MUST re-establish writer
          // provenance before it can rely on this path.
          ownCreated: m.role === "own",
        });
        meshesRecovered += 1;
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
    // #2 — resolve each vault's REAL repo owner from its HOME MESH push_target,
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
    const manifestRole =
      v.homeMeshRidHex !== null ? manifestMeshByRidHex.get(v.homeMeshRidHex) : undefined;
    try {
      if (v.homeMeshRidHex !== null) {
        homeMesh = await getMeshByRid(db, hexToUuid7Bytes(v.homeMeshRidHex));
      }
      owner = deriveVaultRepoOwner(homeMesh, args.handle);
    } catch {
      owner = args.handle;
    }
    // Defense-in-depth (mirror the top-level handle guard): a derived owner that
    // isn't a valid GitHub username must never reach the clone spawn.
    if (!isValidGhHandle(owner)) owner = args.handle;
    try {
      // Idempotency probe is rid-keyed, NOT name-keyed. The vault `rid`
      // (UUIDv7 identity) is stable across rename/move; the name in pod.yon can
      // diverge from the registry (a local rename, or a colliding name across
      // meshes). A name-keyed probe (`getVaultByName`) routes through the
      // leaf/alias resolver and would either miss an already-recovered vault
      // under a changed name (→ re-clone + re-register, a duplicate-identity
      // clobber) or resolve a bare leaf to a DIFFERENT vault. Match on identity.
      const ridBytes = hexToUuid7Bytes(v.vaultRidHex);
      if ((await getVaultByRid(db, ridBytes)) !== null) {
        skipped.push({ vaultName: v.vaultName, reason: "already-registered" });
        continue;
      }
      const targetPath = resolveVaultPath(v.vaultName);
      const vaultYonPath = join(targetPath, ".lyt", "vault.yon");
      if (!existsSync(vaultYonPath)) {
        await cloneFn({ handle: owner, repo, targetPath });
      }
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
      });
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
