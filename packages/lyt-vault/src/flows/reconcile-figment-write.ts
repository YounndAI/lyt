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

// Lane M Wave 0 v2 (P0-a / P0-c) — single reconcile entry point coupling a
// figment markdown write to the derived FTS5 search cache (and, behind an
// opt-in flag, the provenance ledger). Before Lane M, a captured markdown
// file recorded NOTHING into the caches — they only reconciled to disk on
// a successful `git pull` (the post-pull full-walk in upsert-fts-cache.ts).
// That left search silently stale on every local capture; agents fell back
// to glob+read.
//
// SEAM (v2 re-scope, post-release review R1 "wrong-seam"): this reconcile is
// triggered by the EVENT-DRIVEN WATCHER (lyt-mesh/src/flows/sync-watch.ts)
// on a chokidar file event under `notes/**`, NOT from an agent code path.
// The prior v1 wired it into flows/pattern-run.ts, but real `/lyt-capture`
// writes the markdown with the agent's raw `Write` tool (bypassing
// pattern-run), so the reconcile never fired for real captures. The watcher
// catches any file write regardless of how it happened — volatility-robust.
//
// CHEAP-SEARCH INVARIANT (v2): the cheap universal layer is fresh search,
// nothing else. By default (`provenance:false`) this flow touches ONLY the
// FTS cache — it never opens the provenance DB. Provenance/ledger is the
// future "expensive/opt-in memory tier" (`provenance:true`); no caller in
// this wave passes true. The provenance code path is kept intact for that
// future tier.
//
// It is deliberately SEPARATE from the lyt-runner @STAMP pre-write hook
// (lyt-runner/src/hooks/stamp-on-write.ts): that hook is inert for
// handler-written notes by design (§11.6 guard — `runContext===null` →
// no provenance) and MUST stay inert.
//
// Posture (Lock 0.2): the markdown file on disk is the source of truth;
// FTS5 + provenance are regenerable caches. A reconcile failure here is
// non-fatal to the write (the file is already on disk) and recoverable
// via the full-walk heal (`upsertFtsCache` / `backfillFigmentCaches` /
// `lyt vault rebuild-fts`).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { Client } from "@libsql/client";

import { closeVaultDb, openLytDb, openProvenanceDb } from "../registry/vault-db.js";
import { deleteFtsByPath, upsertFtsDocByPath } from "../registry/fts-repo.js";
import { deleteEdgesByPath, replaceEdgesForFigment } from "../registry/figment-edges-repo.js";
import { deleteMetaByPath, upsertFigmentMeta } from "../registry/figment-meta-repo.js";
import { recordProvenance } from "../registry/provenance-write.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import {
  extractFtsBody,
  isScaffoldNote,
  parseFigmentDates,
  parseFigmentTopicTags,
  type ExtractedFtsBody,
  type FigmentDates,
  type FigmentTopicTags,
} from "./upsert-fts-cache.js";

// src= attribution carried in the provenance ledger + @STAMP for
// capture-time reconciles. Distinct from `automator:*` (those are
// machine-driven writes) and `lyt-runner/pre-write-hook` (the @STAMP
// hook). A handler-driven capture is attributed to the capture seam.
export const RECONCILE_PROVENANCE_SRC = "lyt-vault/reconcile-figment-write";

export type ReconcileFigmentOp = "upsert" | "delete" | "rename";

export interface ReconcileFigmentWriteArgs {
  // Vault-relative POSIX path of the figment for upsert/delete ops, OR
  // the NEW path for a rename. Always vault-relative + POSIX-separated
  // (matches the FTS `figment_rid` key + provenance `target_id`).
  relPath: string;
  // For op="rename": the OLD vault-relative POSIX path being moved away
  // from. Ignored for upsert/delete.
  fromRelPath?: string | undefined;
}

export interface ReconcileFigmentWriteOptions {
  // P0-c: when true (default), the caller awaits the reconcile to
  // completion. When false, the reconcile is fire-and-forget — the
  // returned promise still settles, but capture can ignore it so a slow
  // cache write never blocks the user-facing write path. Tests pass
  // `await: true` to assert on the result.
  await?: boolean | undefined;
  // Open-once seam: when supplied, the flow uses the caller's clients and
  // does NOT close them. When omitted, the flow opens + closes its own.
  // All-or-nothing per client — pass a client to own its lifecycle.
  lytDb?: Client | undefined;
  provenanceDb?: Client | undefined;
  // CHEAP-SEARCH INVARIANT (v2). When false (DEFAULT), the reconcile does
  // the FTS upsert/delete/rename ONLY — it never opens the provenance DB
  // or calls recordProvenance. The cheap universal layer is fresh search,
  // nothing else. When true (future "expensive/opt-in memory tier"; no
  // caller passes true in this wave), provenance rows are also recorded.
  provenance?: boolean | undefined;
}

export interface ReconcileFigmentWriteResult {
  vaultPath: string;
  op: ReconcileFigmentOp;
  relPath: string;
  fromRelPath: string | null;
  // True when the FTS row for relPath ended up present (upsert/rename) or
  // the delete removed the row. False on a no-op (e.g. delete of a path
  // that was never indexed).
  ftsChanged: boolean;
  // True when a provenance row was recorded for this reconcile.
  provenanceRecorded: boolean;
}

// ---------------------------------------------------------------------------
// P0-c — bounded retry/backoff on SQLITE_BUSY / EBUSY.
//
// SEE ALSO: registry/vault-db.ts closeVaultDb's 200ms Windows file-lock
// guard (the reciprocal back-reference lives there). That guard waits for
// the OS to RELEASE a handle after close; this budget bounds RETRIES on a
// busy/locked DB during a write. They address different points in the
// lifecycle (post-close release vs. mid-write contention) so the numbers
// are intentionally independent — if either changes, re-evaluate both
// (coupled-constant discipline).
const RECONCILE_RETRY_MAX_ATTEMPTS = 6;
const RECONCILE_RETRY_BASE_DELAY_MS = 25;

function isBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Match libSQL lock CONTENTION only — the conditions a retry+backoff can
  // actually clear. Release review fix: dropped bare `EBUSY` (a generic OS
  // file-busy that is not necessarily a transient DB lock; retrying it
  // masks real errors / spins on a genuinely stuck handle).
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(msg);
}

async function withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RECONCILE_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastErr = err;
      // Exponential backoff with a small jitter to de-correlate
      // concurrent retriers fanning at the same vault.
      const backoff =
        RECONCILE_RETRY_BASE_DELAY_MS * 2 ** attempt +
        Math.floor(Math.random() * RECONCILE_RETRY_BASE_DELAY_MS);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Read + extract the figment body (+ outbound links) for the caches via the
// shared `extractFtsBody` pipeline (frontmatter + code-fence + wikilink
// hygiene — identical to the full-walk path). Returns null when the file is
// absent/unreadable (a delete, or a write that vanished between writeFileSync
// and this reconcile), or when it is the scaffold index.md (not a figment;
// never indexed — V-F12).
function readFigmentBody(
  vaultPath: string,
  relPath: string,
): (ExtractedFtsBody & FigmentDates & FigmentTopicTags) | null {
  if (isScaffoldNote(relPath)) return null;
  const abs = join(vaultPath, relPath);
  if (!existsSync(abs)) return null;
  // C2 (Lane M Wave 0 v2.1) — symlink info-disclosure guard. `lstat` does
  // NOT follow the link, so a symlink placed in `notes/` (pointing at, e.g.,
  // /etc/passwd or any out-of-vault file) is rejected here and its target
  // content is never read into the FTS cache. Pairs with `followSymlinks:
  // false` on the watcher (sync-watch.ts) — defense in depth. The path is
  // already containment-checked by assertContained before we get here.
  try {
    if (lstatSync(abs).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  try {
    const raw = readFileSync(abs, "utf8");
    return {
      ...extractFtsBody(raw),
      ...parseFigmentDates(raw),
      ...parseFigmentTopicTags(raw),
    };
  } catch {
    return null;
  }
}

// Path-containment guard (release review defense-in-depth — the watcher made
// this a public, externally-triggered API). Rejects an absolute path or a
// vault-relative path that escapes the vault root via `..`. The FTS key is
// always a vault-relative POSIX path; anything else is a caller bug or a
// malicious/garbled chokidar event.
function assertContained(vaultPath: string, relPath: string): void {
  if (isAbsolute(relPath)) {
    throw new Error(
      `reconcileFigmentWrite: relPath must be vault-relative, got absolute: ${relPath}`,
    );
  }
  const rel = relative(vaultPath, join(vaultPath, relPath));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`reconcileFigmentWrite: relPath escapes the vault root: ${relPath}`);
  }
}

// Single reconcile entry point. `op` selects the cache mutation:
// upsert — index (or re-index) relPath in FTS.
// delete — tombstone relPath out of FTS.
// rename — delete the old path + upsert the new path in FTS.
//
// Provenance (the ledger YON + provenance.db) is recorded ONLY when
// `opts.provenance === true` (the future expensive/opt-in memory tier).
// By default the flow is FTS-only and never opens the provenance DB.
//
// P0-c: when `opts.await === false`, the caller can ignore the returned
// promise (fire-and-forget). The reconcile still runs to completion in
// the background; the returned promise settles so tests / callers that
// DO want to await can.
export async function reconcileFigmentWrite(
  vaultPath: string,
  op: ReconcileFigmentOp,
  args: ReconcileFigmentWriteArgs,
  opts: ReconcileFigmentWriteOptions = {},
): Promise<ReconcileFigmentWriteResult> {
  assertContained(vaultPath, args.relPath);
  if (args.fromRelPath !== undefined && args.fromRelPath.length > 0) {
    assertContained(vaultPath, args.fromRelPath);
  }
  const recordProv = opts.provenance === true;
  const run = async (): Promise<ReconcileFigmentWriteResult> => {
    const callerLyt = opts.lytDb !== undefined;
    const callerProv = opts.provenanceDb !== undefined;
    const lytDb = opts.lytDb ?? (await openLytDb(vaultPath));
    let provenanceDb: Client | null = null;
    let ftsChanged = false;
    let provenanceRecorded = false;
    // Open the provenance DB lazily, only on the expensive tier.
    const ensureProvDb = async (): Promise<Client> => {
      provenanceDb ??= opts.provenanceDb ?? (await openProvenanceDb(vaultPath));
      return provenanceDb;
    };
    try {
      switch (op) {
        case "upsert": {
          const extracted = readFigmentBody(vaultPath, args.relPath);
          if (extracted !== null) {
            // Only the idempotent FTS/edge ops are wrapped in withBusyRetry. A
            // provenance append is NON-idempotent (a retried append would
            // double-append), so it is never retried — release review fix.
            await withBusyRetry(() =>
              upsertFtsDocByPath(lytDb, { figmentPath: args.relPath, body: extracted.body }),
            );
            await withBusyRetry(() => replaceEdgesForFigment(lytDb, args.relPath, extracted.links));
            await withBusyRetry(() =>
              upsertFigmentMeta(lytDb, {
                figmentPath: args.relPath,
                createdIso: extracted.createdIso,
                modifiedIso: extracted.modifiedIso,
                topic: extracted.topic,
                tags: extracted.tags,
              }),
            );
            ftsChanged = true;
            if (recordProv) {
              await recordProvenance(vaultPath, await ensureProvDb(), {
                id: newProvenanceId(),
                targetType: "note",
                targetId: args.relPath,
                ts: Date.now(),
                src: RECONCILE_PROVENANCE_SRC,
                method: "capture",
                hash: `sha256:${sha256(extracted.body)}`,
                details: { op },
                stampSrc: RECONCILE_PROVENANCE_SRC,
              });
              provenanceRecorded = true;
            }
          }
          break;
        }
        case "delete": {
          const removed = await withBusyRetry(() => deleteFtsByPath(lytDb, args.relPath));
          await withBusyRetry(() => deleteEdgesByPath(lytDb, args.relPath));
          await withBusyRetry(() => deleteMetaByPath(lytDb, args.relPath));
          ftsChanged = removed > 0;
          // Gate the provenance write on an actual removal — no phantom
          // provenance row on a no-op delete (release review fix).
          if (recordProv && removed > 0) {
            await recordProvenance(vaultPath, await ensureProvDb(), {
              id: newProvenanceId(),
              targetType: "note",
              targetId: args.relPath,
              ts: Date.now(),
              src: RECONCILE_PROVENANCE_SRC,
              method: "delete",
              details: { op },
              stampSrc: RECONCILE_PROVENANCE_SRC,
            });
            provenanceRecorded = true;
          }
          break;
        }
        case "rename": {
          const fromRel = args.fromRelPath;
          if (fromRel === undefined || fromRel.length === 0) {
            throw new Error(
              "reconcileFigmentWrite: op='rename' requires args.fromRelPath (the old vault-relative POSIX path).",
            );
          }
          // delete-old then upsert-new (FTS + edges + meta).
          await withBusyRetry(() => deleteFtsByPath(lytDb, fromRel));
          await withBusyRetry(() => deleteEdgesByPath(lytDb, fromRel));
          await withBusyRetry(() => deleteMetaByPath(lytDb, fromRel));
          const extracted = readFigmentBody(vaultPath, args.relPath);
          if (extracted !== null) {
            await withBusyRetry(() =>
              upsertFtsDocByPath(lytDb, { figmentPath: args.relPath, body: extracted.body }),
            );
            await withBusyRetry(() => replaceEdgesForFigment(lytDb, args.relPath, extracted.links));
            await withBusyRetry(() =>
              upsertFigmentMeta(lytDb, {
                figmentPath: args.relPath,
                createdIso: extracted.createdIso,
                modifiedIso: extracted.modifiedIso,
                topic: extracted.topic,
                tags: extracted.tags,
              }),
            );
            ftsChanged = true;
          }
          if (recordProv) {
            await recordProvenance(vaultPath, await ensureProvDb(), {
              id: newProvenanceId(),
              targetType: "note",
              targetId: args.relPath,
              ts: Date.now(),
              src: RECONCILE_PROVENANCE_SRC,
              method: "rename",
              ...(extracted !== null ? { hash: `sha256:${sha256(extracted.body)}` } : {}),
              details: { op, from: fromRel },
              stampSrc: RECONCILE_PROVENANCE_SRC,
            });
            provenanceRecorded = true;
          }
          break;
        }
      }
    } finally {
      if (!callerProv && provenanceDb !== null) await closeVaultDb(provenanceDb);
      if (!callerLyt) await closeVaultDb(lytDb);
    }

    return {
      vaultPath,
      op,
      relPath: args.relPath,
      fromRelPath: args.fromRelPath ?? null,
      ftsChanged,
      provenanceRecorded,
    };
  };

  const promise = run();
  // P0-c fire-and-forget: when the caller opts out of awaiting, attach a
  // catch so an unhandled rejection never crashes the process — the file
  // SoT is already on disk; the cache heals on the next full-walk.
  if (opts.await === false) {
    promise.catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        `reconcileFigmentWrite(${op}, ${args.relPath}): background reconcile failed (markdown SoT preserved; recoverable via rebuild-fts / rebuild-index --ledger provenance)`,
        err,
      );
    });
  }
  return promise;
}

function newProvenanceId(): Uint8Array {
  return newUuidv7Bytes();
}
