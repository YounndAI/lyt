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

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listFederationStates } from "../registry/federation-state.js";
import { listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { listVaults } from "../registry/repo.js";
import {
  assessCanonicalOwnedVaultDestination,
  loadDestinationPolicyContext,
} from "./federation/destination-policy-service.js";
import { vaultRepoName } from "../util/federation-paths.js";
import { isValidGhHandle } from "../util/identity.js";
import { parseOwnerRepoFromUrl } from "../util/gh.js";
import { resolveRemoteUrl } from "../util/remote-url.js";
import { runGit as defaultRunGit, type GitRunOptions, type GitRunResult } from "../util/git-run.js";
import { ridsEqual } from "../util/uuid7.js";

// B2a (Inc-2 Phase B slice 2) — IDEMPOTENT LAZY REPAIR for an already-wired
// vault ORIGIN whose owner was mis-derived from the personal federation handle
// instead of its home mesh's ORG `push_target`. Before B2a a LEAF vault homed in
// an org mesh had its `origin` wired to `github.com/{personal-handle}/lyt-vault-…`
// (materializeVaultPublishable used the federation handle for every vault); the
// correct owner is the mesh's org handle. This pass re-points such origins with
// `git remote set-url origin <correct>` — it NEVER deletes a directory (it
// rewrites git REMOTE CONFIG only), mirroring repair-foreign-homing's
// non-destructive posture.
//
// SAFETY CONTRACT:
//   - VERIFY-BEFORE-REWRITE: only an origin that (a) exists, (b) points at the
//     vault's OWN canonical repo name (`lyt-vault-<mesh>--<leaf>`), and (c) sits
//     under the WRONG owner is rewritten. A handler's custom remote pointing at a
//     different repo is LEFT UNTOUCHED (never clobbered).
//   - OWN-ONLY: foreign vaults (source !== 'own') are skipped — their origin
//     legitimately points at the upstream owner (subscribe/adopt semantics).
//   - IDEMPOTENT: a re-run finds the owner already correct → no-op.
//   - NO DATA LOSS: no working-tree or history mutation; only the `origin` URL
//     config value changes. No directory is created, moved, or deleted.
//   - UNION-SAFE: each vault is handled independently; one failure skips only
//     that vault and the pass continues.

export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

export interface RepairVaultOriginOwnerArgs {
  // Open-once seam — the flow opens its own registry when omitted.
  registryDb?: Client | undefined;
  // dry-run (default true, safer for a config-mutating verb) vs apply.
  mode?: "dry-run" | "apply" | undefined;
  // Injectable git runner (test seam).
  runGit?: GitRunner | undefined;
  // M1 (release review) — scope the scan to a SINGLE vault by rid hex. Used by
  // `repairFlow`'s per-finding apply path so `lyt repair --apply --target
  // origin-owner:<rid>` repoints exactly that vault. Omitted → whole-fleet scan.
  onlyVaultRidHex?: string | undefined;
}

export interface RepointedOrigin {
  vaultRidHex: string;
  name: string;
  fromUrl: string;
  toUrl: string;
  derivedOwner: string;
  // true = the `git remote set-url` actually ran (apply mode); false = dry-run
  // (the repoint was identified but not written).
  applied: boolean;
}

export interface RepairVaultOriginOwnerResult {
  scanned: number;
  repointed: RepointedOrigin[];
  skipped: { name: string; reason: string }[];
  durationMs: number;
}

export async function repairVaultOriginOwnerFlow(
  args: RepairVaultOriginOwnerArgs = {},
): Promise<RepairVaultOriginOwnerResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  const git = args.runGit ?? defaultRunGit;
  const mode = args.mode ?? "dry-run";

  const repointed: RepointedOrigin[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let scanned = 0;

  try {
    const meshes = await listMeshes(db);
    const policyContext = await loadDestinationPolicyContext(db);
    const meshByRid = (rid: Uint8Array | null): MeshRow | null =>
      rid === null ? null : (meshes.find((m) => ridsEqual(m.rid, rid)) ?? null);

    // OWN vaults only — a foreign vault's origin legitimately points upstream.
    // M1 — optionally scope to a single vault (repairFlow per-finding apply).
    // The known-owner set below is a POD-WIDE property and must be derived from
    // every own vault, not the scoped selection — otherwise `--target` builds a
    // smaller set than an unscoped run and refuses the same vault it would
    // otherwise repair. `resolveMeshOwnerEvidence` can source a canonical owner
    // from the destination-policy ledger winner or `mesh.destinationTarget`,
    // neither of which appears in `federation_state.handle` or any
    // `mesh.pushTarget`, so this loop is the only path that contributes them.
    const allOwnVaults = (await listVaults(db)).filter(
      (v) => v.source === "own" && v.status !== "tombstoned",
    );
    const ownVaults =
      args.onlyVaultRidHex === undefined
        ? allOwnVaults
        : allOwnVaults.filter((v) => v.ridHex === args.onlyVaultRidHex);

    // The set of GitHub owners this pod actually publishes to — every mesh push
    // target plus every own vault's canonical destination owner. Used by the
    // mis-owned fence below: an origin pointing at an owner OUTSIDE this set is a
    // stranger's repository, never a local misconfiguration to repair. Derived
    // from policy, never from the observed remote, so a hijacked origin cannot
    // vote itself into the set.
    const knownPodOwners = new Set<string>();
    for (const state of await listFederationStates(db)) {
      // The pod's own account handle. A personal mesh often carries no explicit
      // push target, so its vaults' origins sit under the handle and nowhere else
      // — omitting it would refuse every legitimate personal-vault repair.
      if (isValidGhHandle(state.handle)) knownPodOwners.add(state.handle.toLowerCase());
    }
    for (const mesh of meshes) {
      const target = mesh.pushTarget ?? "";
      if (target.length > 0 && isValidGhHandle(target)) knownPodOwners.add(target.toLowerCase());
    }
    for (const vault of allOwnVaults) {
      const canonical = assessCanonicalOwnedVaultDestination(
        vault,
        meshByRid(vault.homeMeshRid),
        policyContext,
      );
      if (canonical.status !== "refused" && canonical.destination.kind === "github") {
        const owner = canonical.destination.owner;
        if (isValidGhHandle(owner)) knownPodOwners.add(owner.toLowerCase());
      }
    }

    for (const vault of ownVaults) {
      const homeMesh = meshByRid(vault.homeMeshRid);
      if (!existsSync(vault.path)) {
        skipped.push({ name: vault.name, reason: "vault-dir-missing" });
        continue;
      }

      const assessment = assessCanonicalOwnedVaultDestination(vault, homeMesh, policyContext);
      if (assessment.status === "refused") {
        skipped.push({ name: vault.name, reason: assessment.reason });
        continue;
      }
      if (assessment.destination.kind !== "github") {
        skipped.push({ name: vault.name, reason: "missing-policy" });
        continue;
      }

      const originRes = await git(["remote", "get-url", "origin"], {
        cwd: vault.path,
        allowFailure: true,
      });
      if (originRes.code !== 0) {
        // No origin wired yet — the next publish wires it correctly (B2a
        // forward-fix). Nothing to repoint.
        skipped.push({ name: vault.name, reason: "no-origin" });
        continue;
      }
      const currentUrl = originRes.stdout.trim();
      const parsed = parseOwnerRepoFromUrl(currentUrl);
      if (parsed === null) {
        skipped.push({ name: vault.name, reason: "origin-unparseable" });
        continue;
      }

      // VERIFY-BEFORE-REWRITE: only OUR canonical repo, only a WRONG owner.
      const repoName = vaultRepoName(vault.name);
      if (parsed.repo.toLowerCase() !== repoName.toLowerCase()) {
        // A custom remote pointing at a different repo — never clobber it.
        skipped.push({ name: vault.name, reason: "custom-remote-repo" });
        continue;
      }

      // MIS-OWNED FENCE. Everything above this point trusts `source === "own"`,
      // and that is the one field known to lie: a vault received by accepting a
      // GitHub invitation outside Lyt and registering it with `lyt vault join`
      // (whose `source` is optional and fail-closes to `own`) is FOREIGN while
      // claiming to be owned. Such a vault clears the `custom-remote-repo` escape
      // too, because the publisher's repo follows the same `lyt-vault-{mesh}--{leaf}`
      // convention this repair derives — so without a fence, `lyt repair --apply`
      // (which the agent manual recommends as the fix-everything verb, and which
      // is not `--target`-gated) rewrites the PUBLISHER's origin to point at the
      // local account, after which the write gate treats the vault as pushable.
      //
      // The discriminator is the CURRENT origin owner, not the mesh provenance.
      // A vault this pod genuinely owns always points at an owner this pod has a
      // publishing relationship with — its account handle, a mesh push target, or
      // a canonical destination owner — even when the specific owner recorded is
      // wrong, which is the case this repair exists to fix. A vault pointing at an
      // owner OUTSIDE that set is someone else's repository, and repointing it is
      // never a repair.
      //
      // `ownCreated` is deliberately NOT used here. It is false for legacy and
      // migrated meshes as well as foreign-joined ones, so it cannot separate
      // "not ours" from "we don't know" — gating on it refuses legitimate repairs
      // on any pod predating the flag.
      if (!knownPodOwners.has(parsed.owner.toLowerCase())) {
        skipped.push({ name: vault.name, reason: "origin-owner-unknown-to-pod" });
        continue;
      }
      // The fresh origin is supplied explicitly as observation for this repair
      // caller. The authority assessment never derives policy from it.
      const observedAssessment = assessCanonicalOwnedVaultDestination(
        vault,
        homeMesh,
        policyContext,
        currentUrl,
      );
      if (observedAssessment.status === "refused") {
        skipped.push({ name: vault.name, reason: observedAssessment.reason });
        continue;
      }
      if (observedAssessment.destination.kind !== "github") {
        skipped.push({ name: vault.name, reason: "missing-policy" });
        continue;
      }
      const derivedOwner = observedAssessment.destination.owner;
      // C1 (release review, defense-in-depth) — `derivedOwner` (the org push_target
      // from an [lyt.untrusted] joined mesh.yon) feeds resolveRemoteUrl → a
      // `git remote set-url origin <url>` spawn. Refuse a non-handle owner before
      // it can reach that spawn (parity with vault-publish.ts / mesh-join.ts).
      if (!isValidGhHandle(derivedOwner)) {
        skipped.push({ name: vault.name, reason: "invalid-derived-owner" });
        continue;
      }
      scanned += 1;
      if (parsed.owner.toLowerCase() === derivedOwner.toLowerCase()) {
        // Already correct — idempotent no-op.
        skipped.push({ name: vault.name, reason: "already-correct-live-origin" });
        continue;
      }

      const toUrl = resolveRemoteUrl(derivedOwner, repoName);
      let applied = false;
      if (mode === "apply") {
        const setRes = await git(["remote", "set-url", "origin", toUrl], {
          cwd: vault.path,
          allowFailure: true,
        });
        if (setRes.code !== 0) {
          skipped.push({ name: vault.name, reason: "set-url-failed" });
          continue;
        }
        applied = true;
      }
      repointed.push({
        vaultRidHex: vault.ridHex,
        name: vault.name,
        fromUrl: currentUrl,
        toUrl,
        derivedOwner,
        applied,
      });
    }

    return { scanned, repointed, skipped, durationMs: Date.now() - startedAt };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}
