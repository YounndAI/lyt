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

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { ridsEqual } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { renderMeshYon, type MeshDoc, type MeshHomeRecord } from "../yon/mesh-write.js";

// v1.B.3 — atomic round-trip helper for adding/removing/updating @MESH_HOME
// rows in a main vault's `.lyt/mesh.yon` SoT file. The round-trip goes
// through v1.B.2's `renderMeshYon` deterministic emitter so the rewrite
// preserves canonical key order + sort and the rest of the document
// (edges, subscriptions, other home rows) survives byte-stable.
//
// Used by:
// - `flows/init.ts` (v1.B.3 auto-personal branch) when a fresh vault
// joins its newly-created (or pre-existing) home mesh
// - `flows/clone.ts --to-mesh` (v1.B.3) when a clone targets a mesh
// - `flows/move.ts` (v1.B.3 Commit 2) for both source-side removal
// and target-side addition
// - `flows/rename.ts` (v1.B.3 Commit 3) for in-place vault_name update
//
// Atomicity: tmp+rename mirrors the v1.D.4/D.5/B.2 atomic-write pattern.
// On NTFS within the same volume this is semi-atomic; on POSIX it's
// atomic.

export interface AppendMeshHomeArgs {
  mainVaultPath: string;
  meshRid: Uint8Array;
  vaultRid: Uint8Array;
  vaultName: string;
}

// Idempotently append a @MESH_HOME row. If a row already exists with the
// same vault_rid, the existing row is replaced (name + rid alignment) —
// the round-trip stays a fixed point.
export function appendMeshHomeToFile(args: AppendMeshHomeArgs): void {
  const meshYonPath = join(args.mainVaultPath, ".lyt", "mesh.yon");
  const before = readFileSync(meshYonPath, "utf8");
  const doc = parseMeshYon(before);

  const newHome: MeshHomeRecord = {
    meshRid: args.meshRid,
    vaultRid: args.vaultRid,
    vaultName: args.vaultName,
  };
  const filtered = doc.homeVaults.filter((h) => !ridsEqual(h.vaultRid, args.vaultRid));
  const updated: MeshDoc = {
    ...doc,
    homeVaults: [...filtered, newHome],
  };
  atomicWrite(meshYonPath, renderMeshYon(updated));
}

export interface RemoveMeshHomeArgs {
  mainVaultPath: string;
  vaultRid: Uint8Array;
}

// Remove a @MESH_HOME row by vault_rid. Caller is responsible for not
// removing the mesh's main vault (that would dissolve the mesh per
// federation-design.md §3); the helper does NOT enforce this — the move
// flow's pre-flight check handles main-vault refusal.
export function removeMeshHomeFromFile(args: RemoveMeshHomeArgs): void {
  const meshYonPath = join(args.mainVaultPath, ".lyt", "mesh.yon");
  const before = readFileSync(meshYonPath, "utf8");
  const doc = parseMeshYon(before);
  const updated: MeshDoc = {
    ...doc,
    homeVaults: doc.homeVaults.filter((h) => !ridsEqual(h.vaultRid, args.vaultRid)),
  };
  atomicWrite(meshYonPath, renderMeshYon(updated));
}

export interface UpdateMeshHomeNameArgs {
  mainVaultPath: string;
  vaultRid: Uint8Array;
  newName: string;
}

// v1.B.3 Commit 3 — used by `lyt vault rename` to flip the human-facing
// `vault_name` field on a @MESH_HOME row while keeping `vault_rid` stable.
// No-op if the row doesn't exist (caller is responsible for the upstream
// "vault registered in this mesh" check).
export function updateMeshHomeNameInFile(args: UpdateMeshHomeNameArgs): void {
  const meshYonPath = join(args.mainVaultPath, ".lyt", "mesh.yon");
  const before = readFileSync(meshYonPath, "utf8");
  const doc = parseMeshYon(before);
  const updated: MeshDoc = {
    ...doc,
    homeVaults: doc.homeVaults.map((h) =>
      ridsEqual(h.vaultRid, args.vaultRid) ? { ...h, vaultName: args.newName } : h,
    ),
  };
  atomicWrite(meshYonPath, renderMeshYon(updated));
}

function atomicWrite(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, "utf8");
  try {
    if (existsSync(targetPath)) {
      // NTFS: renameSync replaces atomically within the same volume.
      // POSIX: rename(2) is atomic by spec.
      renameSync(tmpPath, targetPath);
    } else {
      renameSync(tmpPath, targetPath);
    }
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort
    }
    throw err;
  }
}
