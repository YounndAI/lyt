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

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { getIdentity } from "../util/identity.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { renderMemscopeYon } from "../yon/memscope.js";
import { renderVaultYon } from "../yon/vault.js";
import { copyBundledAutomators } from "./init.js";

export interface AdoptOptions {
  vaultPath: string;
  name?: string | undefined;
  // Parent vault NAME (display + CLI surface).
  parent?: string | undefined;
  // Parent vault rid bytes. v1.A.1b on-disk shape per renderVaultYon.
  parentVaultRid?: Uint8Array | undefined;
  tierHint?: string | undefined;
}

export interface AdoptResult {
  vaultPath: string;
  vaultRid: Uint8Array;
  memscopeRid: Uint8Array;
  name: string;
  addedLytDir: boolean;
  alreadyLytAware: boolean;
}

export function adoptVault(opts: AdoptOptions): AdoptResult {
  const abs = resolve(opts.vaultPath);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }

  const lytDir = join(abs, ".lyt");
  const vaultYonPath = join(lytDir, "vault.yon");
  if (existsSync(vaultYonPath)) {
    throw new Error(
      `${abs} is already Lyt-aware (.lyt/vault.yon exists). Use 'lyt vault join' to register it.`,
    );
  }

  const name = opts.name ?? deriveNameFromPath(abs);
  const vaultRid = newUuidv7Bytes();
  const memscopeRid = newUuidv7Bytes();
  const owner = getIdentity();
  const createdAt = new Date().toISOString();

  mkdirSync(lytDir, { recursive: true });

  writeFileSync(
    vaultYonPath,
    renderVaultYon({
      vault: {
        rid: vaultRid,
        name,
        parentVault: opts.parentVaultRid,
        tierHint: opts.tierHint,
        memscope: memscopeRid,
        createdAt,
        version: "0.1",
      },
      primaryOwner: owner,
      lifecycle: "active",
    }),
    "utf8",
  );

  writeFileSync(
    join(lytDir, "memscope.yon"),
    renderMemscopeYon({
      vaultRid,
      vaultName: name,
      scope: {
        rid: memscopeRid,
        scopeLevel: "vault",
        readRoles: [owner],
        writeRoles: [owner],
        adminRoles: [owner],
        defaultView: "private",
      },
      allowExpandToProject: false,
      allowExpandToWorkspace: false,
    }),
    "utf8",
  );

  // Additive: copies bundled @AUTOMATOR YON declarations only if the handler
  // doesn't already have a file at .lyt/automators/<name>.yon. block-A.3
  // Commit 10.
  copyBundledAutomators(abs);

  return {
    vaultPath: abs,
    vaultRid,
    memscopeRid,
    name,
    addedLytDir: true,
    alreadyLytAware: false,
  };
}

export function deriveNameFromPath(abs: string): string {
  const root = getDefaultVaultsRoot();
  const rel = relative(root, abs);
  if (rel && rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    return rel
      .split(/[\\/]+/)
      .filter(Boolean)
      .join("/");
  }
  return basename(abs);
}
