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

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { readKnownPaths } from "../registry/known-paths.js";
import { deleteAllVaults } from "../registry/repo.js";
import { SHARED_BUCKET_MESH, SUBSCRIPTION_BUCKET_MESH } from "../util/bucket-mesh.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { registerVaultFromYon } from "./register.js";

export interface RebuildFlowResult {
  scanned: string[];
  registered: { rid: Uint8Array; ridHex: string; name: string; path: string }[];
  skipped: { path: string; reason: string }[];
}

export async function registryRebuildFlow(): Promise<RebuildFlowResult> {
  const candidatePaths = collectCandidatePaths();
  const scanned: string[] = [];
  const registered: RebuildFlowResult["registered"] = [];
  const skipped: RebuildFlowResult["skipped"] = [];

  const db = await openRegistry();
  try {
    await deleteAllVaults(db);

    for (const path of candidatePaths) {
      scanned.push(path);
      const yonPath = join(path, ".lyt", "vault.yon");
      if (!existsSync(yonPath)) {
        skipped.push({ path, reason: "no .lyt/vault.yon" });
        continue;
      }
      try {
        // fed-v2 Layer-2 P1 — rebuild wipes the vaults table
        // (deleteAllVaults above) then re-registers the user's OWN local vaults
        // by scanning known paths: an identity-preserving restore of trusted
        // local content, so it carries trustedReconstruction (re-homing a rid to
        // its current local path is legitimate). The name-mismatch refusal stays
        // unconditional regardless. A1 (0.20.17): trustedReconstruction is now
        // LOAD-BEARING -- upsertVault enforces it on the same-name/path-change
        // arm, so this rail keeps working precisely because it passes it.
        // `fromDiskReconstruction` is the SEPARATE key that opens register's
        // owner-bucket arm (final review): rebuild re-derives every row from the
        // directory tree this pod's own receive path wrote, so a bucket-shaped
        // path is authoritative here in a way it never is on `lyt vault join`.
        const v = await registerVaultFromYon(db, {
          vaultPath: path,
          trustedReconstruction: true,
          fromDiskReconstruction: true,
        });
        registered.push(v);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        skipped.push({ path, reason: msg });
      }
    }
  } finally {
    await closeRegistry(db);
  }

  return { scanned, registered, skipped };
}

// EXPORTED for the candidate-scope test — the scan SHAPE (which directories
// become candidates) is the load-bearing behaviour, and asserting it directly is
// cheaper and sharper than inferring it from a full rebuild.
export function collectCandidatePaths(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const addCandidate = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  // Never use `statSync` for scan boundaries: it follows a symlink/junction.
  // Rebuild subsequently writes registry state based on these candidates, so
  // each directory we descend into must be the directory entry itself.
  const isSafeDirectory = (path: string): boolean => {
    try {
      const entry = lstatSync(path);
      return entry.isDirectory() && !entry.isSymbolicLink();
    } catch {
      return false;
    }
  };

  const isRecognizedVault = (path: string): boolean => {
    const lytDir = join(path, ".lyt");
    if (!isSafeDirectory(lytDir)) return false;
    try {
      const yon = lstatSync(join(lytDir, "vault.yon"));
      return yon.isFile() && !yon.isSymbolicLink();
    } catch {
      return false;
    }
  };

  const defaultRoot = resolve(getDefaultVaultsRoot());
  if (isSafeDirectory(defaultRoot)) {
    for (const entry of readdirSync(defaultRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const abs = join(defaultRoot, entry.name);
      addCandidate(abs);

      // Owned vaults normally live at `<root>/<mesh>/<leaf>`. Keep the
      // legacy direct-root candidate, but inspect exactly one additional level
      // for non-reserved mesh directories. A direct-root vault is a terminal:
      // never treat its children as candidates.
      if (
        entry.name === SUBSCRIPTION_BUCKET_MESH ||
        entry.name === SHARED_BUCKET_MESH ||
        isRecognizedVault(abs)
      ) {
        continue;
      }
      let leafEntries;
      try {
        leafEntries = readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const leafEntry of leafEntries) {
        if (leafEntry.isSymbolicLink() || !leafEntry.isDirectory()) continue;
        addCandidate(join(abs, leafEntry.name));
      }
    }
  }

  // descend EXACTLY two extra levels into the two reserved FOREIGN bucket
  // trees: `<root>/<subscriptions|shared>/<owner>/<leaf>`. Foreign vaults received
  // via subscribe / accept-share land there, are NOT immediate children of the
  // vaults root, and (being under the root) never get a known-paths entry — so
  // before this they could not be candidates at all, and a registry rebuild
  // silently dropped every foreign vault on the machine.
  //
  // Bounded on purpose: owner level, then leaf level, and no deeper. A directory
  // inside a foreign vault is not a vault, and an unbounded walk of user content
  // is a cost and a hazard we do not need.
  //
  // LINK-SAFE: entries are classified from the `readdirSync` DIRENT, which
  // describes the entry itself and is never resolved through a link. A symlink or
  // Windows junction is therefore skipped rather than followed, so a link planted
  // in a bucket tree cannot redirect the scan (and the registration writes that
  // follow it) outside the vaults root. Deliberately NOT `statSync`, which would
  // follow the link and defeat exactly that.
  if (isSafeDirectory(defaultRoot)) {
    for (const bucketPrefix of [SUBSCRIPTION_BUCKET_MESH, SHARED_BUCKET_MESH]) {
      const bucketRoot = join(defaultRoot, bucketPrefix);
      if (!isSafeDirectory(bucketRoot) || isRecognizedVault(bucketRoot)) continue;
      let ownerEntries;
      try {
        ownerEntries = readdirSync(bucketRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ownerEntry of ownerEntries) {
        if (ownerEntry.isSymbolicLink() || !ownerEntry.isDirectory()) continue;
        const ownerDir = join(bucketRoot, ownerEntry.name);
        if (isRecognizedVault(ownerDir)) continue;
        let leafEntries;
        try {
          leafEntries = readdirSync(ownerDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const leafEntry of leafEntries) {
          if (leafEntry.isSymbolicLink() || !leafEntry.isDirectory()) continue;
          addCandidate(join(ownerDir, leafEntry.name));
        }
      }
    }
  }

  for (const p of readKnownPaths()) {
    const abs = resolve(p);
    addCandidate(abs);
  }

  return out;
}
