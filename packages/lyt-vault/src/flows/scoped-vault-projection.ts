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
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Client } from "@libsql/client";
import { listFederationStates } from "../registry/federation-state.js";
import { getFederationRoot } from "../util/federation-paths.js";
import { assertSafeWritePath } from "../util/write-path-guard.js";
import { parseFederationYon } from "../yon/federation-read.js";
import { renderFederationYon } from "../yon/federation-write.js";
import { podManifestDocsEqualIgnoringStamp, projectPodManifestReadOnly } from "./federation/regenerate.js";
import { withDestinationPolicyLock } from "./federation/destination-policy-lock.js";

/** Refresh only a clean canonical projection whose unrelated entries already agree. */
export async function refreshScopedVaultProjection(db: Client, rid: string): Promise<{ pending: boolean; reason?: string; changed?: boolean }> {
  return refreshScopedProjection(db, "vault", rid);
}

export async function refreshScopedMeshProjection(db: Client, rid: string, podRoot?: string): Promise<{ pending: boolean; reason?: string; changed?: boolean }> {
  return refreshScopedProjection(db, "mesh", rid, podRoot);
}

async function refreshScopedProjection(db: Client, kind: "vault" | "mesh", rid: string, podRoot?: string): Promise<{ pending: boolean; reason?: string; changed?: boolean }> {
  let temp: string | undefined;
  try {
    const states = await listFederationStates(db);
    if (states.length === 0) return { pending: false };
    if (states.length !== 1) throw new Error("pod identity is ambiguous");
    const root = podRoot ?? getFederationRoot();
    const path = join(root, "pod.yon");
    assertSafeWritePath(path);
    if (!existsSync(path)) throw new Error("pod projection is missing");
    const lock = `${path}.lyt-mutation.lock`;
    assertSafeWritePath(lock);
    return await withDestinationPolicyLock(lock, async () => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("pod projection is not a single-link regular file");
    const clean = () => {
      const options = { encoding: "utf8" as const, timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
      const gitRoot = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], options).trim();
      const norm = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
      if (norm(gitRoot) !== norm(root)) throw new Error("pod directory is not the repository root");
      execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", "pod.yon"], options);
      const indexed = execFileSync("git", ["-C", root, "ls-files", "-v", "--", "pod.yon"], options).trim();
      if (indexed !== "H pod.yon") throw new Error("pod.yon index flags prevent a reliable dirty check");
      const out = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--", "pod.yon"], options);
      if (out.trim() !== "") throw new Error("pod.yon has local changes");
    };
    const before = readFileSync(path, "utf8");
    const prior = parseFederationYon(before);
    // Reject projections with comments or unsupported structure that rendering
    // would silently discard. The tracked clean preimage remains recoverable.
    if (renderFederationYon(prior) !== before) throw new Error("pod.yon is not a canonical round-trip");
    const desired = await projectPodManifestReadOnly(db, {
      handle: states[0]!.handle, visibility: prior.federation.visibility,
      createdAt: prior.federation.createdAt, nowIso: prior.lastSyncedAt,
    }, root);
    const key = rid.replace(/-/g, "").toLowerCase();
    if ((kind === "vault" ? desired.vaults.map((v) => v.vaultRidHex) : desired.meshes.map((m) => m.meshRidHex))
      .some((id) => id.replace(/-/g, "").toLowerCase() === key)) {
      throw new Error("target remains live in the folded ledger");
    }
    const withoutTarget = kind === "vault"
      ? { ...prior, vaults: prior.vaults.filter((v) => v.vaultRidHex.replace(/-/g, "").toLowerCase() !== key) }
      : { ...prior, meshes: prior.meshes.filter((m) => m.meshRidHex.replace(/-/g, "").toLowerCase() !== key) };
    if (!podManifestDocsEqualIgnoringStamp(withoutTarget, desired)) throw new Error("unrelated projection entries differ from the ledger");
    const after = renderFederationYon(withoutTarget);
    if (after === before) return { pending: false };
    clean();
    if (readFileSync(path, "utf8") !== before) throw new Error("pod.yon changed during projection");
    temp = `${path}.${randomUUID()}.tmp`;
    assertSafeWritePath(temp);
    writeFileSync(temp, after, { encoding: "utf8", flag: "wx" });
    assertSafeWritePath(path);
    if (readFileSync(path, "utf8") !== before) throw new Error("pod.yon changed before replacement");
    renameSync(temp, path);
    if (readFileSync(path, "utf8") !== after) throw new Error("pod.yon readback differs");
    return { pending: false, changed: true };
    }, { acquireTimeoutMs: 5_000, leaseMs: 60_000, subject: path });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { pending: true, reason: temp !== undefined && existsSync(temp) ? `${message}; temporary projection retained at ${temp}` : message };
  }
}
