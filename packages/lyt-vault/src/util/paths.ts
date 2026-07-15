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

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export function getLytHome(): string {
  const override = process.env["LYT_HOME"];
  if (override && override.length > 0) {
    return resolve(override);
  }
  return join(homedir(), "lyt");
}

export function getDefaultVaultsRoot(): string {
  return join(getLytHome(), "vaults");
}

export function resolveVaultPath(name: string, pathOverride?: string): string {
  if (pathOverride && pathOverride.length > 0) {
    return resolve(pathOverride);
  }
  const root = getDefaultVaultsRoot();
  const target = resolve(join(root, name));
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Vault name '${name}' would escape vaults root ${root} (resolved to ${target}). ` +
        `Names must stay inside the vaults root — avoid '..', absolute paths, and empty/dot names.`,
    );
  }
  return target;
}

export function canonicalizeVaultPath(p: string): string {
  return resolve(p);
}

// Reserved system trees under a vault root — never a capture destination. A
// figment written into `.lyt/` (system state / caches), `.git/` (VCS internals),
// or `.obsidian/` (editor config) would corrupt managed data AND land where the
// index floor can never see it — an invisible, unsearchable figment. So `lyt
// capture --dir` fail-closed rejects any target that lands in one of them.
//
// SEE ALSO — COUPLED CONSTANT: this set MUST cover every entry of
// `INDEX_FLOOR` (util/indexable.ts) — those are exactly the never-indexed
// trees, so capturing into any of them strands an unsearchable figment.
// Kept as a local literal (not an import) to preserve paths.ts's node-builtins-
// only layering; the `RESERVED_CAPTURE_DIRS ⊇ INDEX_FLOOR` invariant is enforced
// by a coupled-constant test in tests/paths.test.ts. If INDEX_FLOOR gains an
// entry, add it here too (and the test will fail until you do).
export const RESERVED_CAPTURE_DIRS = new Set([".lyt", ".obsidian", ".git"]);

// Fail-closed guard for a user-supplied capture destination (`lyt capture
// --dir <vault-relative>`, Phase B / C9). Returns the validated vault-relative
// directory (POSIX-separated, normalized) or throws. The untrusted CLI/agent
// input is rejected BEFORE any write when it: is empty, is an absolute path,
// escapes the vault root via `..` (the same `rel`-floor idiom resolveVaultPath
// uses), resolves to the vault root itself, or names a reserved system tree
// (.lyt/.obsidian/.git) at any depth. The trusted default (`notes/`) never
// routes through here — only explicit `--dir` input does.
export function resolveCaptureDir(vaultPath: string, dir: string): string {
  const cleaned = dir.replace(/\\/g, "/").trim();
  if (cleaned.length === 0) {
    throw new Error(`capture --dir: empty directory (got '${dir}').`);
  }
  if (isAbsolute(cleaned)) {
    throw new Error(`capture --dir: must be vault-relative, not an absolute path ('${dir}').`);
  }
  const root = resolve(vaultPath);
  const target = resolve(root, cleaned);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `capture --dir: '${dir}' escapes the vault root — the destination must stay inside the vault ` +
        `(no '..', absolute paths, or the vault root itself).`,
    );
  }
  const segments = rel.split(/[\\/]/).filter((s) => s.length > 0);
  for (const seg of segments) {
    // Windows silently strips trailing dots and spaces from path components, so
    // `.lyt.` / `.git ` alias onto the real reserved tree on that filesystem.
    // Normalize the trailing dots/spaces away BEFORE the reserved-name match so a
    // trailing-dot/space variant can't smuggle a capture toward a reserved tree
    // (release review S-1). The comparison is case-insensitive to match Windows'
    // case-fold too.
    const normalizedSeg = seg.replace(/[. ]+$/, "").toLowerCase();
    if (RESERVED_CAPTURE_DIRS.has(normalizedSeg)) {
      throw new Error(
        `capture --dir: '${dir}' targets a reserved directory ('${seg}') — .lyt/, .obsidian/, and .git/ are off-limits.`,
      );
    }
  }
  return segments.join("/");
}

// Heuristic floor against catastrophic accidents (typo, env-var leak), NOT a
// security boundary against hostile input. A user who deliberately sets
// LYT_HOME=/some/path/lyt-bombs-away passes the basename regex and accepts the
// consequences. Real defense for hostile input is "don't run Lyt as a hostile user."
const LYT_HOME_BASENAME = /^(lyt|\.lyt|lyt-.+)$/i;

export function validateLytHome(home: string): void {
  const resolved = resolve(home);
  if (resolved === resolve("/")) {
    throw new Error(
      `Refusing destructive op against filesystem root (lyt home: ${resolved}). ` +
        `Set LYT_HOME to a path whose basename is "lyt", ".lyt", or "lyt-*".`,
    );
  }
  if (resolved === resolve(homedir())) {
    throw new Error(
      `Refusing destructive op against the user home directory (lyt home: ${resolved}). ` +
        `Set LYT_HOME to a path whose basename is "lyt", ".lyt", or "lyt-*".`,
    );
  }
  const base = basename(resolved);
  if (!LYT_HOME_BASENAME.test(base)) {
    throw new Error(
      `Refusing destructive op against non-lyt-shaped lyt home (lyt home: ${resolved}). ` +
        `Basename "${base}" does not match /^(lyt|\\.lyt|lyt-.+)$/i. ` +
        `Set LYT_HOME to a path whose basename is "lyt", ".lyt", or "lyt-*".`,
    );
  }
  // 🔴 L0 DESTRUCTIVE-DELETE — refuse a lyt home that IS a reparse point (a
  // Windows directory junction or POSIX symlink; lstat().isSymbolicLink() is true
  // for junctions too). The rename-aside flow's load-bearing safety assertion
  // (reparse-safe.ts) FALSE-PASSES on a reparse-point ROOT: listNestedReparsePoints
  // /stripNestedReparsePoints both BAIL (return nothing) when the root is a
  // reparse point, so a junction home would be renamed aside into a junction
  // BACKUP whose inner junctions are never enumerated or stripped — the
  // enumerate-first L0 pre-check silently sees []. Rejecting here at the safety
  // floor makes the false-pass impossible: a destructive op never operates on a
  // home it cannot atomically rename or safely enumerate. The whole-tree teardown
  // logic assumes a REAL directory it owns. Non-existent home → nothing to guard
  // (lstat ENOENT is not a reparse point); a genuine directory passes.
  let homeStat;
  try {
    homeStat = lstatSync(resolved);
  } catch {
    return; // missing / unreadable — nothing destructive to guard against yet.
  }
  if (homeStat.isSymbolicLink()) {
    throw new Error(
      `Refusing destructive op against a lyt home that is a junction/symlink (lyt home: ${resolved}). ` +
        `A reparse-point home cannot be safely enumerated or renamed aside (the reparse-safe ` +
        `enumeration bails on a reparse-point root, which would false-pass the strip assertion). ` +
        `Point LYT_HOME at a REAL directory (resolve the junction), then retry.`,
    );
  }
}
