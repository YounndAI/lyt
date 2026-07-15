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

import { lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// 🔴 L0 DESTRUCTIVE-SAFETY (2026-06-03 incident vector, generalized).
//
// A recursive directory teardown (`rmSync(root, { recursive: true })`) that runs
// over a tree which MAY contain Windows directory junctions / POSIX symlinks
// pointing OUTSIDE the delete root must NOT rely on the rm implementation to
// detach-not-descend each reparse point. The destructive-delete L0 requires we
// ENUMERATE reparse points and DETACH every one BEFORE the recursive teardown —
// for the WHOLE root, not just a single known sub-directory.
//
// This is the generalized form of the original `.lyt/patterns/<name>`-only
// pre-strip: descending a junction would wipe the linked master's contents
// (~/lyt/patterns/<name>, a source-of-truth outside the delete root). The prior
// guard only enumerated the patterns dir; a reparse point ELSEWHERE under the
// root (e.g. `.lyt/rogue`, or a symlink nested inside a cloned/reset vault tree
// when the user globally enabled `core.symlinks`) rode on the rm's implicit
// detach — exactly the unenumerated escaper the L0 forbids.
//
// THE LOAD-BEARING SAFETY PROPERTY: the walker `lstat`s every entry; when an
// entry IS a reparse point (`lstatSync().isSymbolicLink()` — TRUE for Windows
// directory junctions too) it DETACHES the LINK with `rmSync(link, { recursive:
// false, force: true })` (fallback `unlinkSync`) and NEVER recurses into it. It
// recurses ONLY into real (non-reparse) directories. A walker that descends a
// reparse point to "enumerate" it IS the incident — this one does not. Because
// reparse points are never descended, a link-induced cycle cannot loop the walk.
//
// Fail-soft per entry: a per-entry error never aborts the walk, mirroring the
// posture of the original `unlinkNestedPatternLinks`. The caller's subsequent
// recursive `rm` is the backstop for plain dirs/files this pass intentionally
// leaves in place. This util NEVER shells out to `rm -rf`/rimraf/PowerShell —
// those DO follow junctions (the incident vector); it is Node `fs` only.
//
// NOTE (release review 2026-07-10): the DELETING pass itself — Node `fs.rmSync({
// recursive:true})` in each caller — is ALSO detach-not-descend (libuv lstats
// each entry and unlinks a reparse point rather than readdir-recursing it), so
// it is the TRUE backstop. This pre-strip is L0 enumerate-first compliance +
// defense-in-depth + a test-observable signal — NOT the sole safety net. POSIX
// bind mounts present to `lstat` as plain directories and are NOT detected by
// this guard; the L0 scopes to junctions/symlinks and the build/deploy target
// is Windows (revisit this comment before any Linux deploy).

export interface StripReparsePointsOptions {
  /**
   * Test seam: invoked with each reparse-point path the walker IDENTIFIES,
   * just before it is detached. Lets a test prove the WALKER (not the caller's
   * recursive rm) found and detached the reparse point — because Node's own
   * `rm` may already detach a top-level junction, master-survival alone cannot
   * distinguish "the enumerator did it" from "rm did it". Never set in prod.
   */
  onDetach?: ((linkPath: string) => void) | undefined;
}

/**
 * Recursively strip (detach) every reparse point NESTED under `root` before the
 * caller runs its recursive teardown. Detaches junctions/symlinks with
 * recursive:false (never descending them) and recurses only into real dirs.
 *
 * The caller owns the ROOT-level decision (skip vs. delete a root that is itself
 * a reparse point). This util defensively refuses to descend a root that is
 * itself a reparse point (or not a directory) — it only strips points nested
 * WITHIN a real directory. Entirely best-effort / fail-soft.
 */
export function stripNestedReparsePoints(
  root: string,
  opts: StripReparsePointsOptions = {},
): void {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return; // missing / unreadable root — nothing to strip
  }
  // Never descend a reparse-point root (would be the incident); the caller owns
  // that case. Only a real directory has nested entries worth enumerating.
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  walk(root, opts);
}

function walk(dir: string, opts: StripReparsePointsOptions): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable dir — fail-soft, the recursive teardown is the backstop
  }
  for (const name of entries) {
    const entryPath = join(dir, name);
    try {
      const st = lstatSync(entryPath);
      if (st.isSymbolicLink()) {
        // Reparse point (junction or symlink) → DETACH the link only, NEVER
        // recurse. This is the load-bearing safety action.
        detachReparsePoint(entryPath, opts);
        continue;
      }
      if (st.isDirectory()) {
        // Real directory → safe to recurse looking for deeper reparse points.
        walk(entryPath, opts);
      }
      // Plain file → leave for the caller's recursive rm.
    } catch {
      // Fail-soft per entry — the caller's recursive teardown is the backstop.
    }
  }
}

/**
 * Read-only sibling of {@link stripNestedReparsePoints}: ENUMERATE (never
 * detach) every reparse point nested under `root`, returning their paths.
 *
 * This is the L0 "enumerate reparse points FIRST" pre-check the destructive-
 * delete directive requires before a rename/removal near junctions — it lets a
 * caller (and a test) SEE the junction topology of a tree before acting, and
 * lets a test assert a tree carries NO reparse points after a strip pass. Same
 * load-bearing safety posture as the stripper: it `lstat`s each entry and, when
 * an entry IS a reparse point (junction or symlink), records the LINK and NEVER
 * recurses into it — so a link-induced cycle cannot loop the walk and a linked
 * master's contents are never traversed. Recurses only into real directories.
 * Entirely best-effort / fail-soft (an unreadable dir yields what was found so
 * far). Windows-junction aware (`lstatSync().isSymbolicLink()` is true for
 * junctions); POSIX bind mounts present as plain dirs and are NOT detected (the
 * L0 scopes to junctions/symlinks; build/deploy target is Windows).
 */
export function listNestedReparsePoints(root: string): string[] {
  const found: string[] = [];
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return found; // missing / unreadable root — nothing to enumerate
  }
  // Never descend a reparse-point root (would be the incident vector); only a
  // real directory has nested entries worth enumerating.
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return found;
  walkList(root, found);
  return found;
}

function walkList(dir: string, found: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable dir — fail-soft, return what we have
  }
  for (const name of entries) {
    const entryPath = join(dir, name);
    try {
      const st = lstatSync(entryPath);
      if (st.isSymbolicLink()) {
        // Reparse point → RECORD the link, NEVER recurse (the safety action).
        found.push(entryPath);
        continue;
      }
      if (st.isDirectory()) {
        walkList(entryPath, found); // real dir → safe to recurse
      }
      // Plain file → ignore.
    } catch {
      // Fail-soft per entry.
    }
  }
}

function detachReparsePoint(linkPath: string, opts: StripReparsePointsOptions): void {
  opts.onDetach?.(linkPath);
  try {
    defaultDetach(linkPath);
  } catch {
    // Fail-soft — a failed detach degrades to the caller's recursive rm, which
    // (Node `fs`, not a shell) also detaches rather than descends a reparse point.
  }
}

// The safe detach: `rmSync(recursive:false)` removes JUST the reparse point
// (Windows directory junction or symlink), leaving the linked target intact.
// `unlinkSync` is the fallback for a plain file symlink (recursive:false rm can
// EPERM on some link kinds). Crucially: recursive:false — we detach, never descend.
function defaultDetach(linkPath: string): void {
  try {
    rmSync(linkPath, { recursive: false, force: true });
  } catch {
    unlinkSync(linkPath);
  }
}
