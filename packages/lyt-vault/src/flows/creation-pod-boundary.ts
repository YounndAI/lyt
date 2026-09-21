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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { LocalCheckpointResult } from "../scaffold/local-checkpoint.js";
import { openRegistryReadOnly } from "../registry/read-only-client.js";
import { parseFederationYon } from "../yon/federation-read.js";
import { renderFederationYon, type FederationDoc } from "../yon/federation-write.js";
import { projectPodManifestReadOnly, podManifestDocsEqualIgnoringStamp } from "./federation/regenerate.js";
import type { CreationIntendedEffectsV1 } from "./creation-plan.js";

/** Existing work is never implicitly included in a creation checkpoint. */
export interface ExistingPodBoundary {
  repositoryRoot: string;
  dirty: boolean;
  manifestDigest: string;
  plannedPaths: readonly string[];
  indexEntries: string;
  ledgerPreimages: ReadonlyMap<string, Buffer>;
  manifestStatus: string;
  generatedDoc: FederationDoc | null;
  additions: { meshRids: readonly string[]; vaultRids: readonly string[] };
}

export async function captureExistingPodBoundary(
  repositoryRoot: string,
  plannedPaths: readonly string[],
  effects: CreationIntendedEffectsV1,
  registryPath?: string,
): Promise<ExistingPodBoundary> {
  if (!plannedPaths.includes("pod.yon")) {
    throw new Error("Creation plan is missing the existing pod manifest boundary.");
  }
  // The legacy regeneration owner deletes this sibling, even though creation
  // does not own it. Refuse instead of silently removing unrelated data.
  if (existsSync(join(repositoryRoot, "federation.yon"))) {
    throw new Error("Creation cannot preserve a legacy federation.yon beside pod.yon; resolve that exact legacy file before retrying.");
  }
  // Porcelain excludes ignored files. A manifest outside the index is never
  // implicitly adopted or overwritten, even when ignored by local settings.
  const trackedManifest = readGit(repositoryRoot, ["ls-files", "--error-unmatch", "--", "pod.yon"]);
  if (trackedManifest.trim() !== "pod.yon") {
    throw new Error("Creation requires an already tracked pod.yon; untracked or ignored manifests must be resolved first.");
  }
  const entries = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).split("\0").filter(Boolean);
  const planned = new Set(plannedPaths);
  let dirtyManifest = false;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.length < 4) throw new Error("Creation cannot inspect the pod worktree safely.");
    const status = entry.slice(0, 2);
    const path = entry.slice(3).replaceAll("\\", "/");
    const renamed = status.includes("R") || status.includes("C");
    const source = renamed ? entries[++i] : undefined;
    if (renamed && source === undefined) {
      throw new Error("Creation cannot inspect a pod rename safely.");
    }
    for (const affected of [path, ...(source === undefined ? [] : [source])]) {
      if (!planned.has(affected)) continue;
      if (affected === "pod.yon") {
        if (status === " M") {
          dirtyManifest = true;
          continue;
        }
        throw new Error(
          "Creation would overwrite pre-existing changes in pod.yon. " +
          "No creation changes were applied. Preserve and resolve that exact overlap before retrying; " +
          "do not reset, stash, or commit unrelated pod changes.",
        );
      }
      // Ledger writers append to their own shards. Never append through an
      // index/worktree disagreement, removal, rename, or merge conflict.
      if (!affected.startsWith("ledger/") || (status !== " M" && status !== "??")) {
        throw new Error(`Creation overlaps pre-existing pod changes at ${affected}; resolve that exact path before retrying.`);
      }
    }
  }
  const manifestDigest = digestManifest(repositoryRoot);
  let generatedDoc: FederationDoc | null = null;
  if (dirtyManifest) {
    const bytes = readFileSync(join(repositoryRoot, "pod.yon"));
    const doc = parseFederationYon(bytes.toString("utf8"));
    if (!Buffer.from(renderFederationYon(doc), "utf8").equals(bytes)) {
      throw new Error("Creation refuses noncanonical pod.yon changes; the exact existing bytes were preserved. No creation changes were applied.");
    }
    const indexed = parseFederationYon(readGit(repositoryRoot, ["show", ":pod.yon"]));
    if (JSON.stringify(indexed.federation) !== JSON.stringify(doc.federation)) {
      throw new Error("Creation refuses uncheckpointed pod identity/visibility metadata changes; preserve and resolve them first.");
    }
    const opened = openRegistryReadOnly(registryPath === undefined ? undefined : { path: registryPath });
    if (opened.kind === "missing") throw new Error("Creation cannot verify generated pod.yon without its existing registry.");
    try {
      const projected = await projectPodManifestReadOnly(opened.client, {
        handle: doc.federation.handle,
        visibility: doc.federation.visibility,
        createdAt: doc.federation.createdAt,
        nowIso: doc.lastSyncedAt,
      }, repositoryRoot);
      if (!podManifestDocsEqualIgnoringStamp(doc, projected) || doc.federation.fedRidHex !== effects.identity.rid) {
        throw new Error("Creation refuses pod.yon changes that differ from the current canonical fold; existing bytes were preserved. No creation changes were applied.");
      }
      generatedDoc = doc;
    } finally {
      opened.close();
    }
    if (digestManifest(repositoryRoot) !== manifestDigest) throw new Error("pod.yon changed during creation preflight; retry after resolving concurrent activity.");
  }
  return {
    repositoryRoot,
    dirty: entries.length > 0,
    manifestDigest,
    manifestStatus: readGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--", "pod.yon"]),
    generatedDoc,
    additions: {
      meshRids: effects.mesh.kind === "create" ? [effects.mesh.rid] : [],
      vaultRids: effects.vaults.map((vault) => vault.rid),
    },
    plannedPaths: [...plannedPaths],
    indexEntries: readGit(repositoryRoot, ["ls-files", "--stage", "-z", "--", ...plannedPaths]),
    ledgerPreimages: new Map(plannedPaths.filter(
      (path) => path.startsWith("ledger/") && existsSync(join(repositoryRoot, path)),
    ).map((path) => [path, readFileSync(join(repositoryRoot, path))])),
  };
}

/** Optimistic drift detection only, not a concurrent-writer exclusion lock. */
export function assertExistingPodBoundaryUnchanged(boundary: ExistingPodBoundary, candidate?: FederationDoc): void {
  if (candidate !== undefined && boundary.generatedDoc !== null) {
    const prior = boundary.generatedDoc;
    const oldMeshes = new Set(prior.meshes.map((m) => m.meshRidHex));
    const oldVaults = new Set(prior.vaults.map((v) => v.vaultRidHex));
    const retained: FederationDoc = {
      ...candidate,
      meshes: candidate.meshes.filter((m) => oldMeshes.has(m.meshRidHex)),
      vaults: candidate.vaults.filter((v) => oldVaults.has(v.vaultRidHex)),
    };
    if (!podManifestDocsEqualIgnoringStamp(prior, retained) ||
      candidate.meshes.some((m) => !oldMeshes.has(m.meshRidHex) && !boundary.additions.meshRids.includes(m.meshRidHex)) ||
      candidate.vaults.some((v) => !oldVaults.has(v.vaultRidHex) && !boundary.additions.vaultRids.includes(v.vaultRidHex))) {
      throw new Error("Creation projection changed existing records or introduced unplanned identities; pod.yon replacement refused.");
    }
  }
  for (const [path, before] of boundary.ledgerPreimages) {
    const current = readFileSync(join(boundary.repositoryRoot, path));
    if (!current.subarray(0, before.length).equals(before)) {
      throw new Error("Planned pod ledger preimage changed during creation; regeneration was refused to preserve that work.");
    }
  }
  if (
    digestManifest(boundary.repositoryRoot) !== boundary.manifestDigest ||
    readGit(boundary.repositoryRoot, ["ls-files", "--stage", "-z", "--", ...boundary.plannedPaths]) !== boundary.indexEntries ||
    readGit(boundary.repositoryRoot, ["status", "--porcelain=v1", "-z", "--", "pod.yon"]) !== boundary.manifestStatus ||
    existsSync(join(boundary.repositoryRoot, "federation.yon"))
  ) {
    throw new Error("Pod manifest or planned index state changed during creation; regeneration was refused to preserve that work.");
  }
}

function digestManifest(repositoryRoot: string): string {
  return createHash("sha256").update(readFileSync(join(repositoryRoot, "pod.yon"))).digest("hex");
}

function readGit(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function deferredPodCheckpoint(paths: readonly string[]): LocalCheckpointResult {
  return {
    status: "partial",
    paths: [...paths],
    affectedRepositoryCount: 1,
    failure: {
      stage: "add",
      kind: "git-command-failed",
      recoveryAction:
        "Creation is local. The pod checkpoint was deliberately deferred to preserve pre-existing changes. " +
        "Inspect and resolve the exact pending pod changes first; do not sync, repair, or retry creation automatically. " +
        "Sync can regenerate pod.yon and requires a separate preservation check.",
    },
  };
}
