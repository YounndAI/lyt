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

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { listFederationStates, readFederationState } from "../../registry/federation-state.js";
import { getFederationRepoDir } from "../../util/federation-paths.js";
import { runGit as defaultRunGit } from "../../util/git-run.js";
import { rebuildFederationCacheFlow } from "./rebuildFederationCacheFlow.js";
import type { GitRunner } from "./vault-publish.js";

// Fed-v2 Layer-1 (Phase D1d) — POD-REPO LEDGER GIT-SYNC. FULLY NET-NEW.
//
// Today `lyt sync` is PER-VAULT only: syncFlow (lyt-mesh) iterates the
// registered vaults and runs git per-vault, and reconcilePublishFlow
// commits/pushes ONLY the pod manifest (pod.yon + identity.yon) via
// commitPodRepo. NOTHING syncs the per-writer subscription/alias SHARD ledger
// under `<podRoot>/ledger/` — the git SoT for cross-machine convergence (design
// §1). This flow is that missing leg.
//
// The convergence model (design §3): each writer appends ONLY to its own shard
// (`ledger/subscriptions/<writerId>/…`), so two machines' shards are disjoint
// files. A plain `git pull --rebase` of the pod repo UNION-MERGES them with
// ZERO conflict — there is no merge driver to build for the common case. The
// derived view (registry.db cache) is reconstituted LOCALLY from the union via
// rebuildFederationCacheFlow and is NEVER committed (committing it would
// reintroduce the conflict we removed). So this flow's job is the thin git
// envelope around that:
//
//   locate pod working tree (handle discovery → getFederationRepoDir)
//     → pull --rebase  (union-merge other writers' shards; CONFLICT → abort,
//                        surface-and-halt, NEVER overwrite — locked posture)
//     → stage + commit local `ledger/` changes (explicit pathspec, never -A)
//     → push (non-fatal; pull-only pods / offline degrade gracefully)
//     → rebuildFederationCacheFlow (reconstitute the LOCAL cache from the union)
//
// Order matters: PULL BEFORE COMMIT so a remote shard that lands during this
// run is in the working tree before we reconstitute, and so the rebase replays
// our local shard commit on top of the union (append-only shards never textually
// collide, so the rebase is trivial). Reconstitution runs AFTER the union is on
// disk regardless of whether we had local changes to push — a peer's pull alone
// must update our cache.
//
// REUSE vs NET-NEW: the git PRIMITIVE (runGit) and the pull-rebase-if-behind
// SHAPE are reused from commitPodRepo (vault-publish.ts) — but commitPodRepo
// stages ONLY pod.yon/identity.yon/.gitignore and never reconstitutes, so the
// `ledger/`-staging + reconstitution ORCHESTRATION here is net-new. The OR-Set
// fold + cache rebuild is REUSED wholesale (rebuildFederationCacheFlow); no
// convergence logic is re-implemented here.

export type PodLedgerSyncStatus =
  // No pod / no single resolvable handle / pod dir absent or not a git repo —
  // nothing to sync. Non-error: a pod-less install runs `lyt sync` cleanly.
  | "skipped"
  // Pulled (union-merged peers' shards) and/or committed+pushed local shards,
  // then reconstituted. The healthy outcome.
  | "synced"
  // Pull-rebase hit a conflict beyond the append-only shard model (e.g. a
  // hand-edited pod.yon collision) — rebase ABORTED, no overwrite. The local
  // cache is reconstituted from the PRE-PULL working tree, so it reflects
  // LOCAL-ONLY state (the peer shards that the aborted pull would have brought
  // in are NOT yet folded) until the handler resolves the conflict and re-syncs.
  | "conflict"
  // A git step errored unexpectedly (not a conflict). Surfaced, non-fatal to
  // the wider sync.
  | "error";

export interface SyncPodLedgerResult {
  status: PodLedgerSyncStatus;
  // The resolved pod working tree (absent when skipped before discovery).
  podDir?: string;
  // True when `pull --rebase` brought in remote commits (peers' shards).
  pulled: boolean;
  // True when a local `ledger/` commit was created this run.
  committed: boolean;
  // True when the local commit was pushed to the pod remote.
  pushed: boolean;
  // True when rebuildFederationCacheFlow ran (reconstituted the cache).
  reconstituted: boolean;
  // Count of live subscriptions reconstituted (0 when skipped/not-run).
  subscriptionsReconstituted: number;
  // Non-fatal degradations (offline push, no upstream, reconstitution warning).
  warnings: string[];
  // Set on status === "skipped" / "conflict" / "error".
  reason?: string;
}

export interface SyncPodLedgerArgs {
  // Pod handle. When omitted, resolved from federation_state (the single-pod
  // default — mirrors reconcilePublishFlow's resolution).
  handle?: string | undefined;
  // Outward push of the local `ledger/` commit. Default true (sync is the
  // consented outward step). false = local pull+commit+reconstitute, push held.
  push?: boolean | undefined;
  // Pull-rebase before commit. Default true. On conflict → abort + surface.
  pull?: boolean | undefined;
  runGit?: GitRunner | undefined;
  // Open-once registry seam (the reconstitution shares it).
  registryDb?: Client | undefined;
  // Deterministic stamp for the downstream pod.yon regen in reconstitution.
  nowIso?: string | undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The pod-repo `ledger/` dir is the only pathspec this flow ever stages — the
// per-writer shard tree (subscriptions/ + aliases/). Explicit pathspec, never
// `git add -A` (mirrors commitPodRepo + the per-vault sync's explicit-paths
// rule — a stray file is never swept into the pod commit).
const LEDGER_PATHSPEC = "ledger";

export async function syncPodLedgerFlow(
  args: SyncPodLedgerArgs = {},
): Promise<SyncPodLedgerResult> {
  const git = args.runGit ?? defaultRunGit;
  const push = args.push ?? true;
  const pull = args.pull ?? true;
  const warnings: string[] = [];

  const result: SyncPodLedgerResult = {
    status: "skipped",
    pulled: false,
    committed: false,
    pushed: false,
    reconstituted: false,
    subscriptionsReconstituted: 0,
    warnings,
  };

  const ownDb = args.registryDb === undefined;
  const db = args.registryDb ?? (await openRegistry());
  try {
    // 1. Handle discovery (mirrors reconcilePublishFlow). No gh call — the
    //    handle comes from the local federation_state. A pod-less install
    //    (no single state) skips cleanly.
    let handle = args.handle;
    if (handle === undefined || handle.length === 0) {
      const states = await listFederationStates(db);
      if (states.length !== 1) {
        return { ...result, status: "skipped", reason: "no-single-pod" };
      }
      handle = states[0]!.handle;
    }
    if ((await readFederationState(db, handle)) === null) {
      return { ...result, status: "skipped", reason: "no-federation-state" };
    }

    const podDir = getFederationRepoDir(handle);
    result.podDir = podDir;
    if (!existsSync(podDir)) {
      return { ...result, status: "skipped", reason: "pod-dir-missing", podDir };
    }
    const gitDir = await git(["rev-parse", "--git-dir"], { cwd: podDir, allowFailure: true });
    if (gitDir.code !== 0) {
      return { ...result, status: "skipped", reason: "pod-not-git-repo", podDir };
    }

    // 2. PULL --rebase the pod (union-merge peers' shards). Only when there is
    //    an upstream AND we are behind. On a non-shard conflict (hand-edited
    //    pod.yon, etc.) ABORT — never overwrite. Append-only shards never
    //    textually collide, so a real conflict here is the manifest, not the
    //    ledger — surface it. We still reconstitute below, but ONLY from the
    //    pre-pull tree: the cache then reflects LOCAL-ONLY state (the peer
    //    shards the aborted pull would have unioned in are NOT folded yet), not
    //    the converged set. This keeps the cache self-consistent with what is
    //    actually on disk rather than leaving it untouched; it is NOT a
    //    substitute for resolving the conflict and re-syncing.
    let conflicted = false;
    if (pull) {
      const hasUpstream = await git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        { cwd: podDir, allowFailure: true },
      );
      if (hasUpstream.code === 0) {
        await git(["fetch", "--quiet"], { cwd: podDir, allowFailure: true });
        const ab = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
          cwd: podDir,
          allowFailure: true,
        });
        // Fail SAFE: an unreadable rev-list (code != 0) is treated as
        // possibly-behind (→ attempt pull-rebase) rather than assume-not-behind
        // (mirrors commitPodRepo). Never default to the unsafe skip-the-pull.
        const behind = ab.code === 0 ? Number(ab.stdout.trim().split(/\s+/)[1] ?? 0) || 0 : 1;
        if (behind > 0) {
          // --autostash: the local `ledger/` shard may have UNCOMMITTED changes
          // (a fresh append not yet staged/committed — this flow commits AFTER
          // the pull, step 3). Without autostash, `pull --rebase` ABORTS on a
          // dirty tracked file ("cannot rebase: you have unstaged changes"),
          // the abort path below trips, and the whole sync no-ops to "conflict"
          // — local writes never push, the remote union never integrates (
          // bug 1). Autostash stashes the working-tree change, replays the
          // rebase on the pulled union, then pops it back; an append-only shard
          // pops cleanly (the stash applies on top of the union with no textual
          // collision). A genuine non-shard collision still surfaces below.
          const rebased = await git(["pull", "--rebase", "--autostash", "--quiet"], {
            cwd: podDir,
            allowFailure: true,
          });
          if (rebased.code === 0) {
            result.pulled = true;
          } else {
            // Abort: leave NO half-rebased tree. Surface; reconstitute the
            // local cache below from the (pre-pull) working tree anyway.
            await git(["rebase", "--abort"], { cwd: podDir, allowFailure: true });
            conflicted = true;
            warnings.push(
              "pod ledger pull-rebase conflict — run `git pull --rebase` in " +
                `${podDir}, resolve, then re-run \`lyt sync\` (no data overwritten). ` +
                "Append-only shards do not collide; a conflict here is a non-shard " +
                "file (e.g. a hand-edited pod.yon). Until you resolve it, the local " +
                "cache reflects LOCAL-ONLY state — the peer shards from the aborted " +
                "pull are not yet merged.",
            );
          }
        }
      }
    }

    // 3. Stage + commit local `ledger/` changes (explicit pathspec, never -A).
    //    Skipped on conflict (the tree is back at pre-pull HEAD after the abort;
    //    committing now would race the unresolved divergence). Commit only when
    //    the ledger pathspec actually has staged changes (no empty commits).
    if (!conflicted) {
      await git(["add", "--", LEDGER_PATHSPEC], { cwd: podDir, allowFailure: true });
      const staged = await git(["status", "--porcelain", "--", LEDGER_PATHSPEC], {
        cwd: podDir,
        allowFailure: true,
      });
      const dirty = staged.stdout.split(/\r?\n/).some((l) => l.trim().length > 0);
      if (dirty) {
        const committed = await git(
          ["commit", "-m", "chore(lyt): sync federation ledger shards"],
          { cwd: podDir, allowFailure: true },
        );
        if (committed.code === 0) {
          result.committed = true;
        } else {
          warnings.push(`pod ledger commit failed: ${committed.stderr.trim().slice(0, 200)}`);
        }
      }

      // 4. PUSH (outward — only when push AND we created a local commit).
      //    Non-fatal: a pull-only pod (no upstream) or an offline push degrades
      //    to committed-locally; the next sync retries.
      if (push && result.committed) {
        const hasUpstream = await git(
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
          { cwd: podDir, allowFailure: true },
        );
        const pushArgs = hasUpstream.code === 0 ? ["push"] : ["push", "-u", "origin", "main"];
        const pushed = await git(pushArgs, { cwd: podDir, allowFailure: true });
        if (pushed.code === 0) {
          result.pushed = true;
        } else {
          warnings.push(`pod ledger push failed: ${pushed.stderr.trim().slice(0, 200)}`);
        }
      }
    }

    // 5. RECONSTITUTE the local cache from the union (REUSED wholesale — no
    //    fold/cache logic here). Runs whether or not we pushed: a peer's shards
    //    pulled in step 2 must update our derived cache. Best-effort + non-fatal
    //    (the git sync already succeeded; a cache rebuild hiccup must not fail
    //    the wider `lyt sync`). Shares the open registry so the reconstitution
    //    writes the same db this flow opened.
    try {
      const rebuilt = await rebuildFederationCacheFlow({
        registryDb: db,
        handle,
        ...(args.nowIso !== undefined ? { nowIso: args.nowIso } : {}),
      });
      result.reconstituted = true;
      result.subscriptionsReconstituted = rebuilt.subscriptionsReconstituted;
    } catch (err) {
      warnings.push(`pod ledger reconstitution failed: ${errMsg(err)}`);
    }

    if (conflicted) {
      return { ...result, status: "conflict", reason: "pull-rebase-conflict" };
    }
    return { ...result, status: "synced" };
  } catch (err) {
    return { ...result, status: "error", reason: errMsg(err) };
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}
