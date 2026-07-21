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

// CRIT-A (residual sweep) — installed-base self-heal for the `.lyt/indexes/`
// gitignore rule.
//
// The lanes.yon/arcs.yon reinclude fix (Option A) only lands the
// contents-glob `.lyt/indexes/*` rule via `getVaultGitignore()`, which is
// written on a FRESH `init`. `adopt`'s `ensureVaultGitignore` no-ops the whole
// block when the load-bearing `.lyt/patterns/` marker is already present — and
// every existing vault carries it, ALONGSIDE the stale BARE `.lyt/indexes/`
// rule. A bare rule excludes the directory itself, so Git cannot re-include a
// file whose parent dir is excluded → the `!.lyt/indexes/lanes.yon` /
// `!.lyt/indexes/arcs.yon` reincludes are dead and the cluster YON never stages.
// No init/adopt path rewrites the existing rule, so the feature never bootstraps
// on the installed base (the dogfood mesh).
//
// This migration is the surgical, idempotent fix: rewrite ONLY an exact bare
// `.lyt/indexes/` line to `.lyt/indexes/*`, preserving every other line, the
// EOL style (LF vs CRLF), and the trailing-newline style. It is wired into
// reliably-invoked heal points (`rebuild-index` / `reindex`, and the lyt-mesh
// sync post-pull cache reconcile) so a normal operation self-heals the vault —
// crucially NOT gated on the `.lyt/patterns/` marker (that gate is exactly what
// makes adopt miss this).

import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoReparsePointInPath } from "../util/write-path-guard.js";

// The stale rule: a BARE directory-exclude that shadows the reincludes.
const BARE_INDEXES_RULE = ".lyt/indexes/";
// The corrected rule: a CONTENTS-glob that leaves the directory walkable so the
// named YON SoT files below it can be reincluded by Git.
const GLOB_INDEXES_RULE = ".lyt/indexes/*";
export const SYNC_PENDING_RULE = ".lyt/sync-provenance-pending/";

export interface MigrateGitignoreResult {
  vaultPath: string;
  // True only when a bare `.lyt/indexes/` line was rewritten on THIS call.
  // False when: no `.gitignore`, already `*`, or the bare rule is absent.
  migrated: boolean;
}

export function migrateVaultGitignoreIndexRule(vaultPath: string): MigrateGitignoreResult {
  const gitignorePath = join(vaultPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return { vaultPath, migrated: false };
  }
  // Write-path symlink guard (global standing directive): this path's leaf comes
  // from a handler-controlled `vaultPath`, and we are about to read+rewrite it
  // in place. `lstat` the `.gitignore` leaf and REFUSE (best-effort no-op, never
  // follow it) if it is a symlink, so a malicious/misconfigured symlinked
  // `.gitignore` can never redirect this write onto an out-of-vault target. The
  // parent (the vault root) is already trusted, so the leaf check suffices.
  try {
    if (lstatSync(gitignorePath).isSymbolicLink()) {
      return { vaultPath, migrated: false };
    }
  } catch {
    // lstat failure (e.g. transient race) — non-fatal; treat as nothing to do.
    return { vaultPath, migrated: false };
  }
  const original = readFileSync(gitignorePath, "utf8");
  // Split on LF; each line may retain a trailing CR (CRLF files). A trailing
  // newline yields a final empty element that join() restores verbatim, so the
  // trailing-newline style is preserved.
  const lines = original.split("\n");
  let changed = false;
  const rewritten = lines.map((line) => {
    const withoutCr = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (withoutCr === BARE_INDEXES_RULE) {
      changed = true;
      // Preserve the CRLF EOL if this file uses it.
      return line.endsWith("\r") ? `${GLOB_INDEXES_RULE}\r` : GLOB_INDEXES_RULE;
    }
    return line;
  });
  if (!changed) {
    return { vaultPath, migrated: false };
  }
  writeFileSync(gitignorePath, rewritten.join("\n"), "utf8");
  return { vaultPath, migrated: true };
}

/** Ensure the untracked sync outbox can never be staged or published. */
export function ensureSyncProvenancePendingIgnored(vaultPath: string): MigrateGitignoreResult {
  const gitignorePath = join(vaultPath, ".gitignore");
  assertNoReparsePointInPath(gitignorePath);
  const original = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (original.split(/\r?\n/u).includes(SYNC_PENDING_RULE)) {
    return { vaultPath, migrated: false };
  }
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const separator = original.length === 0 || original.endsWith("\n") ? "" : eol;
  const next = `${original}${separator}${SYNC_PENDING_RULE}${eol}`;
  const tmp = `${gitignorePath}.${process.pid}.tmp`;
  assertNoReparsePointInPath(tmp);
  writeFileSync(tmp, next, "utf8");
  assertNoReparsePointInPath(gitignorePath);
  renameSync(tmp, gitignorePath);
  return { vaultPath, migrated: true };
}
