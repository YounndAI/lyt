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

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { recordAudit } from "../registry/audit-write.js";
import { getMeshByRid } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByRid } from "../registry/repo.js";
import { updateMeshHomeNameInFile } from "../registry/vault-home-mesh-helpers.js";
import { openAuditDb, closeVaultDb } from "../registry/vault-db.js";
import { validateVaultName } from "../util/identity.js";
import { hexToUuid7Bytes, newUuidv7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import { parseVaultYon } from "../yon/parse.js";
import { renderVaultYon } from "../yon/vault.js";

// v1.B.3 Commit 3 — `lyt vault rename <old> <new> [--mesh <name>]`.
//
// Closes the v1.B.1 retro clause `g` deferral (main-vault rename guard).
//
// Pre-flight refusals (OD-8):
// - HARD ERROR: rename target = 'main' (MainVaultImmutableError;
// exit 2; structured error JSON when --json). The main vault is
// structurally locked per federation-design.md §3 + naming-convention
// §The main vault is locked to `main`. We also refuse rename FROM
// 'main' because the main vault's NAME is the structural invariant
// (the rid is stable; what we'd be renaming is the structural label).
// - VaultNameTakenError: target <new> name already exists in same mesh.
// - VaultNotFoundError: source <old> not registered.
//
// Side effects (in order):
// 1. fs.renameSync the vault directory (atomic on POSIX; semi-atomic
// on NTFS within same volume). The new path lives under the same
// parent directory.
// 2. UPDATE vaults.name + vaults.path registry columns.
// 3. Re-render the vault's vault.yon @VAULT.name field (vault_rid +
// memscope stable; only the name string changes).
// 4. Update the home mesh's mesh.yon @MESH_HOME vault_name in-place
// via updateMeshHomeNameInFile (vault_rid stable).
// 5. Emit @AUDIT record with action='vault.renamed' + details_json
// carrying old_name + new_name + mesh_rid_hex via recordAudit.
//
// The rename is NOT wrapped in a single DB transaction because the
// audit emission goes through recordAudit's YON-first contract (which
// has its own atomicity). If a step fails mid-rename, the surfaces are:
// - dir rename fails → no DB write; safe to retry
// - DB UPDATE fails → dir is renamed but registry stale; rebuild-
// registry or manual rename-back fixes it
// - mesh.yon update fails → registry consistent; mesh.yon stale; will
// be caught by mesh fsck / rebuild-registry
// - audit emission fails → all changes landed; audit lossy; non-fatal.

export class MainVaultImmutableError extends Error {
  readonly errorCode = "main-vault-immutable";
  constructor() {
    super(
      `lyt vault rename: the main vault of every mesh is structurally locked to the name 'main' (per federation-design.md §3 + naming-convention.md). Refusing to rename to or from 'main'.`,
    );
    this.name = "MainVaultImmutableError";
  }
}

export class VaultNameTakenError extends Error {
  readonly errorCode = "vault-name-taken";
  readonly newName: string;
  constructor(newName: string) {
    super(
      `lyt vault rename: a vault named '${newName}' already exists. Pick a different name or use 'lyt vault list' to see registered vaults.`,
    );
    this.name = "VaultNameTakenError";
    this.newName = newName;
  }
}

export class RenameVaultNotFoundError extends Error {
  readonly errorCode = "rename-vault-not-found";
  readonly vaultName: string;
  constructor(vaultName: string) {
    super(
      `lyt vault rename: no vault registered with name '${vaultName}'. Use 'lyt vault list' to see registered vaults.`,
    );
    this.name = "RenameVaultNotFoundError";
    this.vaultName = vaultName;
  }
}

export interface RenameVaultArgs {
  oldName: string;
  newName: string;
  registryDb?: Client | undefined;
  nowIso?: string | undefined;
}

export interface RenameVaultResult {
  vaultRidHex: string;
  oldName: string;
  newName: string;
  oldPath: string;
  newPath: string;
  meshName: string | null;
  meshRidHex: string | null;
  vaultYonRewritten: boolean;
  meshYonUpdated: boolean;
  auditRecorded: boolean;
}

export async function renameVaultFlow(args: RenameVaultArgs): Promise<RenameVaultResult> {
  // Main-vault refusal — applies whether <old> or <new> is 'main' or
  // ends in '/main'. The structural invariant locks BOTH directions:
  // can't rename TO main (would collide with the mesh's main vault) AND
  // can't rename FROM main (would dissolve the mesh's structural name).
  if (endsWithMain(args.oldName) || endsWithMain(args.newName)) {
    throw new MainVaultImmutableError();
  }

  // Validate the new name shape (slug-safe + Windows reserved rejection)
  // — the rename verb is the ONLY surface that lets a vault's name change
  // post-init, so we apply the same validateVaultName gate the init path
  // uses. Throws on invalid input.
  validateVaultName(args.newName);

  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // 1. Resolve source vault + collision check on the new name.
    const sourceVault = await getVaultByName(db, args.oldName);
    if (sourceVault === null) {
      throw new RenameVaultNotFoundError(args.oldName);
    }
    const collision = await getVaultByName(db, args.newName);
    if (collision !== null) {
      throw new VaultNameTakenError(args.newName);
    }

    const oldPath = sourceVault.path;
    // The new path mirrors the old parent dir; only the leaf (or the
    // <mesh>/<leaf> two-segment shape) changes.
    const newPath = computeNewPath(oldPath, args.oldName, args.newName);

    // 2. fs.renameSync the directory.
    // Both POSIX rename(2) and NTFS MoveFileEx are atomic within the
    // same volume; cross-volume renames are not atomic but throw EXDEV
    // which would surface as a generic Error here. On Windows the
    // per-vault libSQL files (.lyt/lyt.db, .lyt/audit.db, ...) can hold
    // a brief handle even after close(); EPERM/EBUSY retries follow the
    // same pattern as flows/registry-reset.ts rmWithRetry (60s budget on
    // Windows; 0 cost when no contention).
    await renameDirWithRetry(oldPath, newPath);

    // 3. UPDATE vaults.name + vaults.path.
    await db.execute({
      sql: "UPDATE vaults SET name = ?, path = ? WHERE rid = ?",
      args: [args.newName, newPath, sourceVault.rid],
    });

    // 4. Rewrite vault.yon @VAULT.name in-place. Read the post-rename
    // file (since the dir moved), re-render with new name, atomic
    // tmp+rename.
    const vaultYonPath = join(newPath, ".lyt", "vault.yon");
    const before = readFileSync(vaultYonPath, "utf8");
    const parsed = parseVaultYon(before);
    const memscopeBytes = parsed.memscopeRid ? hexToUuid7Bytes(parsed.memscopeRid) : undefined;
    const parentBytes = parsed.parentVault ? hexToUuid7Bytes(parsed.parentVault) : undefined;
    const meshRidHomeBytes = parsed.homeMesh ? hexToUuid7Bytes(parsed.homeMesh.meshRid) : undefined;
    const newVaultYon = renderVaultYon({
      vault: {
        rid: sourceVault.rid,
        name: args.newName,
        ...(parsed.desc !== null ? { desc: parsed.desc } : {}),
        ...(parentBytes !== undefined ? { parentVault: parentBytes } : {}),
        ...(parsed.tierHint !== null ? { tierHint: parsed.tierHint } : {}),
        ...(memscopeBytes !== undefined ? { memscope: memscopeBytes } : {}),
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        version: parsed.version ?? "0.1",
      },
      ...(parsed.gitUrl !== null ? { gitUrl: parsed.gitUrl } : {}),
      primaryOwner: parsed.primaryOwner ?? "github:unknown",
      lifecycle:
        parsed.lifecycle === "active" ||
        parsed.lifecycle === "archived" ||
        parsed.lifecycle === "frozen"
          ? parsed.lifecycle
          : "active",
      topics: parsed.topics,
      ...(parsed.agentTemplateVersion !== null
        ? { agentTemplateVersion: parsed.agentTemplateVersion }
        : {}),
      ...(parsed.homeMesh !== null && meshRidHomeBytes !== undefined
        ? {
            homeMesh: {
              vaultRid: sourceVault.rid,
              meshRid: meshRidHomeBytes,
              meshName: parsed.homeMesh.meshName,
              assignedAt: parsed.homeMesh.assignedAt,
            },
          }
        : {}),
    });
    const vaultTmp = `${vaultYonPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(vaultTmp, newVaultYon, "utf8");
    renameSync(vaultTmp, vaultYonPath);

    // 5. Update the home mesh's mesh.yon @MESH_HOME vault_name in-place.
    let meshUpdated = false;
    let mesh: { name: string; ridHex: string; rid: Uint8Array } | null = null;
    if (sourceVault.homeMeshRid !== null) {
      const meshRow = await getMeshByRid(db, sourceVault.homeMeshRid);
      if (meshRow !== null) {
        mesh = { name: meshRow.name, ridHex: meshRow.ridHex, rid: meshRow.rid };
        if (meshRow.mainVaultRid !== null) {
          const meshMainVault = await getVaultByRid(db, meshRow.mainVaultRid);
          if (meshMainVault !== null) {
            // mesh main vault path is in meshMainVault.path (registry path
            // was updated for THIS vault but the main vault's path is
            // unchanged unless the renamed vault WAS the main — which we
            // already rejected upstream).
            try {
              updateMeshHomeNameInFile({
                mainVaultPath: meshMainVault.path,
                vaultRid: sourceVault.rid,
                newName: args.newName,
              });
              meshUpdated = true;
            } catch {
              // Non-fatal: registry is canonical; mesh fsck will detect.
              meshUpdated = false;
            }
          }
        }
      }
    }

    // 6. @AUDIT record. Goes to the renamed vault's own audit ledger.
    // audit_log.ts column is epoch ms (per v1.A.2 schema), not ISO; the
    // YON @AUDIT.ts string is derived from this number inside recordAudit
    // via Date(ts).toISOString().
    let auditRecorded = false;
    try {
      const auditDb = await openAuditDb(newPath);
      try {
        const auditTs = args.nowIso !== undefined ? Date.parse(args.nowIso) : Date.now();
        await recordAudit(newPath, auditDb, {
          id: newUuidv7Bytes(),
          ts: auditTs,
          actor: "user:lyt",
          action: "vault.renamed",
          targetType: "vault",
          targetId: uuid7BytesToHex(sourceVault.rid),
          result: "success",
          details: {
            old_name: args.oldName,
            new_name: args.newName,
            mesh_rid_hex: mesh?.ridHex ?? null,
            mesh_name: mesh?.name ?? null,
          },
          stampSrc: "flows/rename",
        });
        auditRecorded = true;
      } finally {
        await closeVaultDb(auditDb);
      }
    } catch {
      // Best-effort: rename body landed; audit emission failure is
      // non-fatal (logged at runtime; rebuild-index reconstructs).
      auditRecorded = false;
    }

    return {
      vaultRidHex: uuid7BytesToHex(sourceVault.rid),
      oldName: args.oldName,
      newName: args.newName,
      oldPath,
      newPath,
      meshName: mesh?.name ?? null,
      meshRidHex: mesh?.ridHex ?? null,
      vaultYonRewritten: true,
      meshYonUpdated: meshUpdated,
      auditRecorded,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

function endsWithMain(name: string): boolean {
  if (name === "main") return true;
  const slashIdx = name.lastIndexOf("/");
  if (slashIdx === -1) return false;
  return name.slice(slashIdx + 1) === "main";
}

const isWindows = process.platform === "win32";

async function renameDirWithRetry(from: string, to: string): Promise<void> {
  // 720 × 250ms = 180s on Windows; matches the v1.C.4.2 rmWithRetry budget in
  // flows/registry-reset.ts + scaffold/delete.ts + tests/_helpers/fs-retry.ts.
  // The 4th rmRetry site in the codebase — keep budgets unified at 180s.
  // Non-Windows takes a single attempt because POSIX rename(2) doesn't return
  // EBUSY for in-use dirs.
  // SEE ALSO: src/flows/registry-reset.ts rmWithRetry — keep budgets in sync (180s).
  // SEE ALSO: tests/_helpers/fs-retry.ts rmStrict — keep budgets in sync (180s).
  const attempts = isWindows ? 720 : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES" && code !== "ENOTEMPTY") {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}

// Compute the new directory path given the old path + old/new vault
// names. The vault dir's leaf is conventionally the vault NAME (slash-
// containing names map to nested dirs under the mesh segment). For a
// simple <mesh>/<old-leaf> name living at <root>/<mesh>/<old-leaf>,
// renaming to <mesh>/<new-leaf> moves the dir to <root>/<mesh>/<new-leaf>.
function computeNewPath(oldPath: string, oldName: string, newName: string): string {
  // The old path conventionally ends with the vault's name segments.
  // Strip the old name suffix and append the new name. This handles both
  // bare names and <mesh>/<leaf> shapes consistently. Use forward slashes
  // for the suffix comparison since paths may use either separator on
  // Windows.
  const oldAbs = resolve(oldPath);
  const normOldAbs = oldAbs.replace(/\\/g, "/");
  const oldNameSlashed = oldName;
  if (normOldAbs.endsWith(`/${oldNameSlashed}`)) {
    const parent = normOldAbs.slice(0, normOldAbs.length - oldNameSlashed.length - 1);
    return resolve(parent, newName);
  }
  // Fallback: rename within the same parent dir using just the last
  // segment of the new name. Rare: only triggers if oldPath doesn't have
  // the conventional <root>/<mesh>/<leaf> shape.
  const parent = dirname(oldAbs);
  const newLeaf = newName.includes("/") ? newName.split("/").pop()! : newName;
  return resolve(parent, newLeaf);
}
