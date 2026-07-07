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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { getIdentity } from "../util/identity.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { getVaultGitignore } from "../templates/index.js";
import { renderMemscopeYon } from "../yon/memscope.js";
import { renderVaultYon } from "../yon/vault.js";
import { copyBundledAutomators, writeScaffoldConformance } from "./init.js";

export interface AdoptOptions {
  vaultPath: string;
  name?: string | undefined;
  // Parent vault NAME (display + CLI surface).
  parent?: string | undefined;
  // Parent vault rid bytes. v1.A.1b on-disk shape per renderVaultYon.
  parentVaultRid?: Uint8Array | undefined;
  tierHint?: string | undefined;
  // G1 guided-adopt — the mesh to home the adopted vault into (find-or-create).
  // Defaults to `personal` at the flow layer. Ignored by the scaffold step
  // (which only writes `.lyt/` files); consumed by adoptVaultFlow.
  mesh?: string | undefined;
}

export interface AdoptResult {
  vaultPath: string;
  vaultRid: Uint8Array;
  memscopeRid: Uint8Array;
  name: string;
  addedLytDir: boolean;
  alreadyLytAware: boolean;
  // UNIT 4 — relative paths of scaffold-conformance priming files written on
  // adopt (sentinel-bearing lyt-overview.md / agents.md / README.md when absent).
  conformanceFilesWritten: string[];
  // 2026-07-05 pre-merge release review (MAJOR-1) — outcome of landing the Lyt
  // derived-state gitignore rules (crucially `.lyt/patterns/`) in the adopted
  // vault. "created" = wrote a fresh .gitignore; "appended" = additively added
  // the Lyt block to the handler's existing one; "present" = the rules were
  // already there (idempotent re-adopt). Adopt creates git-visible pattern-link
  // junctions under `.lyt/patterns/`, so without this they would be tracked —
  // contradicting the "machine-local, gitignored" contract in the SoT + skill.
  gitignore: "created" | "appended" | "present";
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

  // UNIT 4 — scaffold conformance on adopt (the adopt-an-existing-vault path for
  // semantic-folder vaults). Additively writes the sentinel-bearing priming
  // seeds (lyt-overview.md / agents.md) so an adopted vault does NOT FTS-pollute
  // the primer with un-flagged Lyt-authored boilerplate. Never clobbers existing
  // handler content (see writeScaffoldConformance blast-radius notes).
  const conformance = writeScaffoldConformance({ vaultPath: abs, name, owner });

  // MAJOR-1 (2026-07-05 pre-merge release review): land the Lyt derived-state
  // gitignore rules in the adopted vault. Additive by design — see
  // ensureVaultGitignore.
  const gitignore = ensureVaultGitignore(abs);

  return {
    vaultPath: abs,
    vaultRid,
    memscopeRid,
    name,
    addedLytDir: true,
    alreadyLytAware: false,
    conformanceFilesWritten: conformance.written,
    gitignore,
  };
}

// MAJOR-1 (2026-07-05 pre-merge release review): ensure the Lyt derived-state
// gitignore rules — crucially the load-bearing `.lyt/patterns/` rule — land in
// the adopted vault. `init` writes `.gitignore` from scratch; `adopt` must be
// ADDITIVE: a plain Obsidian vault may already carry a handler `.gitignore` we
// must NEVER clobber. So:
//   - no `.gitignore`      → write the full Lyt template
//   - `.gitignore` present → append the Lyt block, UNLESS the rules are already
//                            there (marker = the `.lyt/patterns/` rule) → no-op
// Idempotent: a re-adopt over a vault that already carries the rules is a no-op
// (the round-trip init→delete→adopt path, where the init-written `.gitignore`
// survives the `.lyt/`-only delete).
function ensureVaultGitignore(vaultPath: string): "created" | "appended" | "present" {
  const gitignorePath = join(vaultPath, ".gitignore");
  const block = getVaultGitignore();
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, block, "utf8");
    return "created";
  }
  const existing = readFileSync(gitignorePath, "utf8");
  // Presence marker = the load-bearing junction-ignore rule. If it is already
  // there, the Lyt block was written before (a prior adopt/init) — do not
  // duplicate it.
  if (existing.includes(".lyt/patterns/")) {
    return "present";
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(gitignorePath, existing + sep + block, "utf8");
  return "appended";
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
