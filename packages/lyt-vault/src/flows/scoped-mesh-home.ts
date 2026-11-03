/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Client } from "@libsql/client";
import { getMeshByRid } from "../registry/meshes-repo.js";
import { getVaultByRid, type VaultRow } from "../registry/repo.js";
import { ridsEqual } from "../util/uuid7.js";
import { assertSafeWritePath } from "../util/write-path-guard.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { renderMeshYon } from "../yon/mesh-write.js";
import { withDestinationPolicyLock } from "./federation/destination-policy-lock.js";

/** Remove only this owned vault's tracked mesh-home declaration. */
export async function retractScopedMeshHome(db: Client, vault: VaultRow): Promise<boolean> {
  if (vault.source !== "own" || vault.homeMeshRid === null) return false;
  const mesh = await getMeshByRid(db, vault.homeMeshRid);
  if (mesh === null || mesh.mainVaultRid === null) throw new Error("home mesh or its main vault is unavailable");
  const main = await getVaultByRid(db, mesh.mainVaultRid);
  if (main === null) throw new Error("home mesh main vault is unavailable");
  const root = main.path; const path = join(root, ".lyt", "mesh.yon");
  assertSafeWritePath(path);
  const lock = `${path}.lyt-mutation.lock`; assertSafeWritePath(lock);
  return withDestinationPolicyLock(lock, async () => {
  const st = lstatSync(path);
  if (!st.isFile() || st.nlink !== 1) throw new Error("mesh.yon is not a single-link regular file");
  const clean = () => {
    const options = { encoding: "utf8" as const, timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], options).trim();
    const norm = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
    if (norm(top) !== norm(root)) throw new Error("mesh main is not the repository root");
    const indexed = execFileSync("git", ["-C", root, "ls-files", "-v", "--", ".lyt/mesh.yon"], options).trim();
    if (indexed !== "H .lyt/mesh.yon") throw new Error("mesh.yon is untracked or has unsafe index flags");
    if (execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--", ".lyt/mesh.yon"], options).trim() !== "") {
      throw new Error("mesh.yon has local changes");
    }
  };
  const before = readFileSync(path, "utf8"); const doc = parseMeshYon(before);
  if (!ridsEqual(doc.mesh.rid, mesh.rid)) throw new Error("mesh.yon identity differs from registry");
  const matches = doc.homeVaults.filter((h) => ridsEqual(h.vaultRid, vault.rid));
  if (matches.length === 0) return false;
  if (matches.length !== 1) throw new Error("mesh.yon contains duplicate vault-home declarations");
  if (renderMeshYon(doc) !== before) throw new Error("mesh.yon is not a canonical round-trip");
  const after = renderMeshYon({ ...doc, homeVaults: doc.homeVaults.filter((h) => !ridsEqual(h.vaultRid, vault.rid)) });
  clean();
  if (readFileSync(path, "utf8") !== before) throw new Error("mesh.yon changed during scoped retraction");
  const temp = `${path}.${randomUUID()}.tmp`; assertSafeWritePath(temp);
  writeFileSync(temp, after, { encoding: "utf8", flag: "wx" });
  assertSafeWritePath(path);
  if (readFileSync(path, "utf8") !== before) throw new Error(`mesh.yon changed before replacement; temporary file retained at ${temp}`);
  renameSync(temp, path);
  if (readFileSync(path, "utf8") !== after) throw new Error("mesh.yon readback differs");
  return true;
  }, { acquireTimeoutMs: 5_000, leaseMs: 60_000, subject: path });
}
