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

import { getMeshByRid, insertMesh } from "../../registry/meshes-repo.js";
import { getVaultByRid } from "../../registry/repo.js";
import { initVaultDbs } from "../../registry/vault-db.js";
import { getFederationRepoDir, vaultRepoName } from "../../util/federation-paths.js";
import { realFederationGhClient } from "../../util/gh-federation.js";
import { isValidGhHandle, validateMeshName } from "../../util/identity.js";
import { resolveVaultPath } from "../../util/paths.js";
import { hexToUuid7Bytes } from "../../util/uuid7.js";
import { parseFederationYon } from "../../yon/federation-read.js";
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

export interface RecoverPodResult {
  meshesRecovered: number;
  vaultsRecovered: { vaultName: string; repo: string; path: string }[];
  skipped: { vaultName: string; reason: string }[];
  warnings: string[];
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

  // release review / a review finding — the handle is resolved from the CLONED pod's
  // identity.yon (resolvePodIdentity precedence) and reaches `git clone
  // https://github.com/<handle>/...`. Refuse to clone with a handle that isn't a
  // valid GitHub username (poisoned-identity guard) BEFORE any git spawn.
  if (!isValidGhHandle(args.handle)) {
    return {
      meshesRecovered: 0,
      vaultsRecovered,
      skipped,
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
      warnings: [`pod.yon parse failed: ${errMsg(err)}`],
    };
  }

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
        });
        meshesRecovered += 1;
      }
    } catch (err) {
      warnings.push(`mesh ${m.meshName}: ${errMsg(err)}`);
    }
  }

  // 2. Recover vaults from @FED_VAULT — clone the repo + register (rid preserved).
  for (const v of doc.vaults) {
    if (v.status === "tombstoned") {
      skipped.push({ vaultName: v.vaultName, reason: "tombstoned" });
      continue;
    }
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
      const repo = v.repo.length > 0 ? v.repo : vaultRepoName(v.vaultName);
      if (!existsSync(vaultYonPath)) {
        await cloneFn({ handle: args.handle, repo, targetPath });
      }
      if (!existsSync(vaultYonPath)) {
        skipped.push({ vaultName: v.vaultName, reason: "clone produced no .lyt/vault.yon" });
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
      warnings.push(`vault ${v.vaultName}: ${errMsg(err)}`);
      skipped.push({ vaultName: v.vaultName, reason: errMsg(err) });
    }
  }

  return { meshesRecovered, vaultsRecovered, skipped, warnings };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
