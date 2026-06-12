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

import { existsSync } from "node:fs";

import chokidar, { type FSWatcher } from "chokidar";

import {
  backfillFigmentCaches,
  closeRegistry,
  listVaults,
  openRegistry,
  reconcileFigmentWrite,
  toVaultRelPosix,
  type ReconcileFigmentOp,
  type VaultRow,
} from "@younndai/lyt-vault";

import { syncFlow, type VaultSyncReport } from "./sync.js";

export interface SyncWatchOptions {
  commitDebounceMs?: number;
  pushDebounceMs?: number;
  resolveMeshContext?: boolean;
  // Inject for tests so chokidar isn't actually spawned. `ignored` is the
  // chokidar v4 predicate (Matcher function) that filters watched paths.
  watcherFactory?: (paths: readonly string[], ignored: IgnoredMatcher) => FSWatcher;
  onTick?: (report: VaultSyncReport) => void;
  // Lane M Wave 0 v2 — skip the per-vault startup FTS backfill (tests that
  // assert only on incremental events set this to keep the fixture lean).
  skipStartupBackfill?: boolean;
  // Lane M Wave 0 v2 — observe each completed reconcile (for tests). Fires
  // after the reconcile settles (success path only).
  onReconcile?: (vaultName: string, op: ReconcileFigmentOp, relPath: string) => void;
  // Returns once the watcher is set up; the watcher keeps running until stop() is called.
  signal?: AbortSignal;
}

export interface SyncWatchHandle {
  // Stop all watchers + timers; flush any in-flight commits via a final syncFlow.
  stop: () => Promise<void>;
  // Triggers a manual debounced commit for a vault (used by tests).
  triggerChange: (vaultName: string) => void;
  // Lane M Wave 0 v2 — resolves once all startup backfills + all in-flight
  // reconciles have settled. Tests await this to assert deterministically on
  // the FTS state without polling.
  whenIdle: () => Promise<void>;
}

export const DEFAULT_COMMIT_DEBOUNCE_MS = 30_000;

// C1 (Lane M Wave 0 v2.1) — chokidar v4.0.3 removed glob support, so the
// previous `**/.git/**`-style string matchers were inert (string matchers
// are exact-equality in v4, not globs). That left `.git/`, `node_modules/`,
// and the vault's own `.lyt/indexes/*.db` ALL watched — and combined with
// the unconditional full-walk reconcile this self-perpetuated a 30s
// commit/reconcile loop. The fix is the chokidar v4 idiom: an `ignored`
// PREDICATE function. We ignore any path that contains a `.git`,
// `node_modules`, or `.lyt` path segment (cross-platform — matches both
// `/` and `\` separators). Note `.lyt` covers the legacy single-DB path,
// the split `indexes/*.db`, and `outbox.db` in one segment match.
type IgnoredMatcher = (path: string) => boolean;

const IGNORED_SEGMENTS = /(?:^|[\\/])(?:\.git|node_modules|\.lyt)(?:[\\/]|$)/;

export const isIgnoredWatchPath: IgnoredMatcher = (path) => IGNORED_SEGMENTS.test(path);

export async function syncWatchFlow(opts: SyncWatchOptions = {}): Promise<SyncWatchHandle> {
  const commitDebounceMs = opts.commitDebounceMs ?? DEFAULT_COMMIT_DEBOUNCE_MS;
  const watcherFactory =
    opts.watcherFactory ??
    ((paths, ignored) =>
      chokidar.watch(paths as string[], {
        ignored,
        ignoreInitial: true,
        persistent: true,
        // C2 (Lane M Wave 0 v2.1) — never traverse a symlink out of the
        // vault root, so a symlinked dir/file in `notes/` can't have its
        // out-of-vault target indexed (info-disclosure). Paired with the
        // lstat guard in reconcile-figment-write.ts:readFigmentBody.
        followSymlinks: false,
      }));

  const db = await openRegistry();
  let activeVaults: VaultRow[];
  try {
    activeVaults = (await listVaults(db)).filter(
      (v) => v.status === "active" && existsSync(v.path),
    );
  } finally {
    await closeRegistry(db);
  }

  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const watchedPaths = activeVaults.map((v) => v.path);
  const watcher = watcherFactory(watchedPaths, isIgnoredWatchPath);

  // Track every in-flight reconcile / backfill so whenIdle() can await the
  // full set. A reconcile is non-fatal (the markdown is the SoT and is
  // already on disk); we never let a reconcile rejection escape.
  const pending = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  // M1 (Lane M Wave 0 v2.1) — per-vault serialization. Two FTS writers can
  // target the same vault concurrently: the per-event incremental reconcile
  // (reconcileNotesEvent → reconcileFigmentWrite, delete+insert) and the
  // debounced full-walk (runSyncForVault → syncFlow → upsertFtsCache, which
  // truncates the whole table then bulk-inserts). Running them at once on
  // the same DB risks a torn cache. We chain every per-vault DB operation
  // through a promise tail so they run strictly one-at-a-time PER VAULT
  // (different vaults stay parallel). QUEUE, never drop — an edit landing
  // mid-sync still reconciles after the sync drains. The chain swallows
  // rejections so one failed op never poisons the tail.
  const vaultChains = new Map<string, Promise<void>>();
  const serialize = (vaultName: string, fn: () => Promise<void>): Promise<void> => {
    const prev = vaultChains.get(vaultName) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the tail rejection-proof so the next queued op always runs.
    const guarded = next.catch(() => undefined);
    vaultChains.set(vaultName, guarded);
    void guarded.finally(() => {
      // Drop the chain entry only if no newer op has replaced it (avoids an
      // unbounded map for long-lived watchers over many vaults).
      if (vaultChains.get(vaultName) === guarded) vaultChains.delete(vaultName);
    });
    return next;
  };

  const scheduleCommit = (vaultName: string): void => {
    const existing = debounceTimers.get(vaultName);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      debounceTimers.delete(vaultName);
      // M1 — the debounced full-sync (which runs the full-walk FTS reconcile
      // inside syncFlow) goes through the SAME per-vault chain as the
      // incremental reconcile, so the two never run concurrently for one
      // vault. Tracked so whenIdle() awaits an in-flight sync.
      track(serialize(vaultName, () => runSyncForVault(vaultName, opts)));
    }, commitDebounceMs);
    debounceTimers.set(vaultName, t);
  };

  const resolveVaultForPath = (changedPath: string): VaultRow | null => {
    // chokidar emits absolute paths on Windows + POSIX.
    for (const v of activeVaults) {
      if (
        changedPath === v.path ||
        changedPath.startsWith(v.path + "/") ||
        changedPath.startsWith(v.path + "\\")
      ) {
        return v;
      }
    }
    return null;
  };

  // Lane M Wave 0 v2 — incremental FTS reconcile on a notes/** file event.
  // CHEAP-SEARCH INVARIANT: fresh search is the cheap universal layer, so
  // we reconcile the FTS cache ONLY (provenance:false). The reconcile is
  // non-fatal: a failure logs + is swallowed (the markdown SoT is on disk;
  // the cache heals on the next startup backfill / `lyt vault rebuild-fts`).
  const reconcileNotesEvent = (vault: VaultRow, op: ReconcileFigmentOp, relPath: string): void => {
    // M1 — queue through the per-vault chain so this incremental reconcile
    // never overlaps the debounced full-walk for the same vault.
    const p = serialize(vault.name, async () => {
      await reconcileFigmentWrite(vault.path, op, { relPath }, { provenance: false });
      opts.onReconcile?.(vault.name, op, relPath);
    }).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(
        `sync-watch: FTS reconcile failed for ${vault.name}:${relPath} (${op}); markdown SoT preserved, heals on next backfill/rebuild-fts`,
        err,
      );
    });
    track(p);
  };

  watcher.on("all", (evt: string, changedPath: string) => {
    const v = resolveVaultForPath(changedPath);
    if (!v) return;

    // Commit-debounce fires for ANY change in the vault (unchanged behavior).
    scheduleCommit(v.name);

    // FTS reconcile is notes/**-ONLY (the figment_fts source set). Changes
    // under work/, handoffs/, .lyt/, .git/ etc. are NOT part of the cheap
    // search cache and are skipped here.
    const relPath = toVaultRelPosix(changedPath, v.path);
    if (!isNotesFigment(relPath)) return;

    // Map the chokidar event → reconcile op. chokidar's default config does
    // not emit rename as a single event (it surfaces unlink + add), so we
    // only handle add/change (→ upsert) and unlink (→ delete). A rename is
    // therefore an unlink of the old path + an add of the new path, each of
    // which reconciles correctly on its own.
    if (evt === "add" || evt === "change") {
      reconcileNotesEvent(v, "upsert", relPath);
    } else if (evt === "unlink") {
      reconcileNotesEvent(v, "delete", relPath);
    }
  });

  // Lane M Wave 0 v2 — one-time startup backfill per watched vault so an
  // existing stale/empty figment_fts heals the moment the watcher starts.
  // Non-fatal: a backfill failure logs + is swallowed.
  if (opts.skipStartupBackfill !== true) {
    for (const v of activeVaults) {
      const p = backfillFigmentCaches(v.path)
        .then(() => undefined)
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(`sync-watch: startup FTS backfill failed for ${v.name}`, err);
        });
      track(p);
    }
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    await watcher.close();
    // Let any in-flight reconciles settle so we don't close over a busy DB.
    await whenIdle();
    // Flush: run sync one last time so any pending changes get committed.
    try {
      await syncFlow({ resolveMeshContext: opts.resolveMeshContext === true });
    } catch {
      // Best-effort flush.
    }
  };

  const whenIdle = async (): Promise<void> => {
    // Drain the pending set until it stabilises (a settling reconcile can
    // enqueue nothing further, but a backfill completing while events arrive
    // means we re-check until empty).
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  };

  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      void stop();
    });
  }

  const triggerChange = (vaultName: string): void => {
    scheduleCommit(vaultName);
  };

  return { stop, triggerChange, whenIdle };
}

// A figment lives under the vault's `notes/` tree (the figment_fts source
// set per upsert-fts-cache.ts) and is a markdown file. Matches both
// `notes/x.md` and nested `notes/sub/x.md`; excludes everything else.
function isNotesFigment(relPath: string): boolean {
  return relPath.startsWith("notes/") && relPath.toLowerCase().endsWith(".md");
}

async function runSyncForVault(vaultName: string, opts: SyncWatchOptions): Promise<void> {
  try {
    const result = await syncFlow({
      vaultNames: [vaultName],
      resolveMeshContext: opts.resolveMeshContext === true,
    });
    if (opts.onTick && result.reports.length > 0) {
      opts.onTick(result.reports[0]!);
    }
  } catch {
    // Swallow — watcher must keep running.
  }
}
