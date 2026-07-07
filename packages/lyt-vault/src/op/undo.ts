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

// Increment 1 · Phase A.3 — the undo engine behind `lyt undo [--preview]`.
//
// SINGLE-STEP POP: reads the most-recent APPLIED op from the pod-level op-log
// (A.2, ordered by the monotonic uuidv7 id) and dispatches on its inverse:
//   - clean-undo + a delete-figment action → reverse the capture;
//   - none / compensating → refuse HONESTLY, in plain language (NEVER a git/gh
//     noun — the firewall voice), naming why it can't be undone.
// Multi-step / multi-file / redo are deferred (stated, not built) — the undo is
// itself LOGGED as an op so undo-the-undo is expressible later.
//
// RESILIENCE: the LOAD-BEARING reversal is removing the figment FILE (the write
// the human wants gone). De-indexing is BEST-EFFORT + self-healing — a stale FTS
// row is regenerable (Lock 0.2) and self-heals on the next search / `lyt
// reindex` (the capture-index never-throw contract, inverted). So undo NEVER
// fails on a de-index hiccup: the note is gone, the cache catches up.

import { existsSync, lstatSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { Client } from "@libsql/client";

import { reconcileFigmentWrite } from "../flows/reconcile-figment-write.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { listVaults } from "../registry/repo.js";
import { appendPendingOp, markOpApplied, readLastAppliedOp } from "./operation-log.js";

export interface UndoDeps {
  /** The pod-level op-log (A.2). */
  opLogDb: Client;
  /** ISO clock — defaults to wall time. */
  now?: () => string;
  /**
   * The figment-removal mechanic — defaults to unlink + best-effort de-index.
   * Returns whether a file was ACTUALLY removed (false when it was already gone)
   * so undo can report honestly instead of claiming a phantom removal.
   */
  deleteFigment?: (vaultPath: string, relPath: string) => Promise<boolean>;
  /**
   * The set of currently-registered vault roots, used to validate the op-log
   * row's `vaultPath` before any delete (release review A.G a review finding). Defaults to the
   * live registry (openRegistry → listVaults). Injected in tests to drive the
   * corrupt-row refusal deterministically.
   */
  knownVaultRoots?: () => Promise<string[]>;
}

export interface UndoOutcome {
  undone: boolean;
  /** Plain-language, human-facing — NEVER a git/gh noun. */
  message: string;
  /** The kind of op that was (or would be) undone, when there was one. */
  kind?: string;
}

/**
 * Preview what `lyt undo` WOULD do — zero mutation. Turns the silent LIFO guess
 * into a confirmable fact ("this will remove the note you saved").
 */
export async function previewUndo(deps: Pick<UndoDeps, "opLogDb">): Promise<UndoOutcome> {
  const last = await readLastAppliedOp(deps.opLogDb);
  if (last === null) return { undone: false, message: "There's nothing to undo." };
  const inv = last.inverse;
  if (inv.class === "clean-undo" && inv.action?.type === "delete-figment") {
    return { undone: false, message: `This will remove the note you saved (${inv.action.relPath}).`, kind: last.kind };
  }
  return { undone: false, message: refusal(last.kind, inv), kind: last.kind };
}

/**
 * Reverse the most-recent applied op (single-step). Returns a plain-language
 * outcome; never throws for an ordinary "nothing/​can't undo" — only a genuine
 * IO failure on the load-bearing file removal propagates.
 */
export async function undoLast(deps: UndoDeps): Promise<UndoOutcome> {
  const now = deps.now ?? isoNow;
  const last = await readLastAppliedOp(deps.opLogDb);
  if (last === null) return { undone: false, message: "There's nothing to undo." };

  const inv = last.inverse;
  if (inv.class !== "clean-undo" || inv.action === undefined) {
    // Honest refusal — no git noun. A pushed sync (none), a compensating op, or
    // a clean-undo with no recorded action all land here.
    return { undone: false, message: refusal(last.kind, inv), kind: last.kind };
  }

  if (inv.action.type === "delete-figment") {
    const { vaultPath, relPath } = inv.action;
    // SAFETY (repo destructive-delete L0; release review R3 + A.G a review finding): the ENTIRE
    // action — vaultPath AND relPath — comes from the persisted, pod-level,
    // externally-editable op-log ([lyt.untrusted] / agent-corruptor reflex). BOTH
    // legs are validated before any `rmSync`:
    //   (1) vaultPath MUST be a CURRENTLY-REGISTERED vault root — a crafted/corrupt
    // row can't point the delete at an arbitrary directory (the A.G a review finding
    //       hole: the prior guard checked only relPath-vs-vaultPath, trusting
    //       vaultPath itself). (2) relPath MUST stay inside it.
    // Either failing → treat the row as corrupt and refuse.
    const knownRoots = deps.knownVaultRoots
      ? await deps.knownVaultRoots()
      : await defaultKnownVaultRoots();
    if (!isRegisteredVaultRoot(vaultPath, knownRoots) || !isVaultContained(vaultPath, relPath)) {
      return { undone: false, message: "That can't be undone — its saved record looks corrupted.", kind: last.kind };
    }
    const del = deps.deleteFigment ?? defaultDeleteFigment;
    const removed = await del(vaultPath, relPath);
    // Log the undo as its OWN op so it consumes the LIFO slot (a second `lyt undo`
    // won't re-target this capture) and undo-the-undo is well-defined later. It is
    // itself `none` — A.3 does not snapshot content for a redo (stated).
    await logUndoOp(deps.opLogDb, relPath, now);
    // Report on the ACTUAL effect — never a phantom "Removed" (release review R1/R2).
    return removed
      ? { undone: true, message: "Removed the note you just saved.", kind: last.kind }
      : { undone: false, message: "That note was already gone — nothing to remove.", kind: last.kind };
  }

  // An action type this engine doesn't handle yet — refuse honestly.
  return { undone: false, message: "That can't be undone here yet.", kind: last.kind };
}

// The default figment-removal: remove the FILE (load-bearing), then a best-effort
// de-index. Returns whether a file was actually removed (false when it was
// already gone) so the caller reports honestly. reconcileFigmentWrite('delete')
// drops the FTS/edges/meta rows; any failure is swallowed — the file is gone and
// the cache self-heals on the next search/reindex.
async function defaultDeleteFigment(vaultPath: string, relPath: string): Promise<boolean> {
  // Guard TRAVELS WITH the delete (release review A.G a review finding): re-assert
  // containment here so no caller — or injected `deleteFigment` dep — can reach
  // `rmSync` unguarded. The safety check lives with the destructive op, not only
  // at the (bypassable) call site.
  if (!isVaultContained(vaultPath, relPath)) return false;
  const abs = join(vaultPath, relPath);
  // M1 (destructive-delete L0): NEVER `rmSync` a reparse point / symlink — a
  // junction at a contained path could resolve OUTSIDE the vault (the L0's
  // canonical trap). `lstatSync` does NOT follow the link; refuse if it is one.
  // A missing target throws → treat as already-gone (nothing to remove).
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return false; // already gone
  }
  if (stat.isSymbolicLink()) return false; // refuse to delete through a link
  const existed = existsSync(abs);
  rmSync(abs, { force: true });
  try {
    await reconcileFigmentWrite(vaultPath, "delete", { relPath });
  } catch {
    /* de-index is best-effort — a stale FTS row self-heals on next search/reindex */
  }
  return existed && !existsSync(abs);
}

// Vault-containment predicate for an op-log-sourced path: reject absolute paths
// and any relative path that `..`-escapes the vault root. Same logic as the write
// path's assertContained + receipt.ts's assertFileBytes guard (kept inline to
// avoid coupling undo to the reconcile module; a shared util is a later cleanup —
// tracked; A.G R2-NIT-1).
function isVaultContained(vaultPath: string, relPath: string): boolean {
  if (isAbsolute(relPath)) return false;
  const rel = relative(vaultPath, join(vaultPath, relPath));
  return !(rel.startsWith("..") || isAbsolute(rel));
}

// The live registered vault roots — the allow-list `vaultPath` from an op-log row
// is validated against (release review A.G a review finding). Default wiring; tests inject.
async function defaultKnownVaultRoots(): Promise<string[]> {
  const db = await openRegistry();
  try {
    const vaults = await listVaults(db);
    return vaults.map((v) => v.path);
  } finally {
    await closeRegistry(db);
  }
}

// Is `vaultPath` (from the untrusted op-log row) one of the registered vault
// roots? Path-normalized (resolve + strip trailing separators), case-folded on
// Windows (the dev/target platform is case-insensitive). A row whose vaultPath
// matches no registered root can NEVER drive a delete.
function isRegisteredVaultRoot(vaultPath: string, roots: readonly string[]): boolean {
  const norm = (p: string): string => {
    const r = resolve(p).replace(/[/\\]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const target = norm(vaultPath);
  return roots.some((r) => norm(r) === target);
}

async function logUndoOp(db: Client, relPath: string, now: () => string): Promise<void> {
  const reason = "Undoing a capture can't itself be undone here.";
  const id = await appendPendingOp(
    db,
    { kind: "undo", horizon: "local", fileSet: [relPath], inverse: { class: "none", reason } },
    now(),
  );
  await markOpApplied(db, id, { horizon: "local", inverse: { class: "none", reason } }, now());
}

// Plain-language refusal for an op that can't be cleanly undone — carries the
// class's own human-facing reason/note, never a git noun.
function refusal(kind: string, inv: { class: string; reason?: string; note?: string }): string {
  if (inv.class === "none" && inv.reason !== undefined) return `That can't be undone: ${inv.reason}`;
  if (inv.class === "compensating" && inv.note !== undefined) return `That can't be simply undone: ${inv.note}`;
  return `The last thing (${kind}) can't be undone here.`;
}

function isoNow(): string {
  return new Date().toISOString();
}
