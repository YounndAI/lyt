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

// Increment 1 · Phase A.4 — the RemoteProvider port (the git-remote seam that
// makes the safe-write spine's honest-none horizon possible).
//
// This is the GH-AGNOSTIC port over the ONE remote primitive the sync flow
// leans on: move local commits to/from a remote and report — as a STRUCTURED
// RESULT — what ACTUALLY happened. It is the sibling of `AccessProvider` (the
// auth-primitive seam, access/access-provider.ts): callers speak "push / pull"
// and read a typed outcome, never a git exit code or a gh permission string.
//
// The load-bearing reason it exists is the cross-examine's sharpest catch
// (D, 2026-07-06): a `sync` Operation is honest-`none` (un-undoable) ONLY once
// the push has ACTUALLY landed on the remote. A push that FAILED after a local
// commit leaves that commit unshared — `committed-not-pushed`, which is still
// `clean-undo` (reset the local commit). The SyncOperation reads that fact back
// FROM the `PushResult` this port returns; it never asserts the horizon from
// the verb. A static `none` on a failed push would be a *dishonest* none in
// exactly the firewall's own failure modes — the thing this port prevents.
//
// v1 impl (`GitRemoteProvider`) wraps the firewalled, already-injectable
// `runGit` (util/git-run.ts) with `allowFailure`, so a push rejection becomes a
// structured result the sync flow classifies (terminal permission-denied vs
// retryable) — never a throw — and the raw code+stderr are preserved. A
// non-GitHub provider (a different host, a token store, a test double)
// implements the same port with no caller change (non-GitHub slot
// reserved).

import { runGit as defaultRunGit, type GitRunOptions, type GitRunResult } from "../util/git-run.js";

/**
 * The git-runner seam the default impl calls (exactly `runGit`'s shape). Tests
 * that want to exercise the sync flow inject a fake at the flow's own `runGit`
 * seam; a unit test of the port itself injects one here.
 */
export type GitRunnerFn = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

/**
 * The structured outcome of a push — the fact the SyncOperation's honest-none
 * horizon is READ BACK from. `pushed === true` is the ONLY outcome that yields
 * a `pushed` horizon (→ inverse `none`); a non-zero push leaves local commit(s)
 * unshared → `committed-not-pushed` (→ clean-undo). `code`+`stderr` are the raw
 * git signals, preserved verbatim so the sync flow's terminal-vs-retryable push
 * classifier (`isPermissionDeniedPush`) keeps working unchanged.
 */
export interface PushResult {
  pushed: boolean;
  code: number;
  stderr: string;
}

/**
 * The exact destination authorized by the caller. The immutable URL and
 * refspec are passed to Git explicitly so repository-level pushurl,
 * pushRemote, or pushDefault configuration cannot redirect an outward write
 * after the authority check.
 */
export interface PushTarget {
  url: string;
  refspec: string;
}

/** The immutable fetch URL + branch ref captured after caller-side validation. */
export interface PullTarget {
  url: string;
  ref: string;
}

/**
 * The structured outcome of a pull. `code`+`stderr` are preserved so the sync
 * flow's conflict-recovery path (rebase --continue / --abort, mesh-context
 * heal) reads exactly the signals it read from the raw `runGit` result.
 */
export interface PullResult {
  pulled: boolean;
  code: number;
  stderr: string;
}

/**
 * The gh-agnostic remote seam. `provider` names the backing host ("github" in
 * v1); the non-GitHub slot is reserved — a new provider implements this
 * port with no caller change. `push`/`pull` return STRUCTURED results, never a
 * bare exit code, so the honest-none horizon is computed from what happened.
 */
export interface RemoteProvider {
  /** The backing host — "github" in v1; a reserved slot for non-GitHub principals. */
  readonly provider: string;
  /**
   * Push local commit(s) to the remote. MUST NOT throw on a push rejection —
   * it reports the failure in the result (allowFailure semantics) so the caller
   * can classify terminal vs retryable and compute an honest horizon.
   */
  push(cwd: string, target: PushTarget): Promise<PushResult>;
  /**
   * Pull + rebase remote commit(s) into local. MUST NOT throw on a rebase
   * conflict — it reports the failure in the result so the caller can run its
   * conflict-recovery recipe.
   */
  pull(cwd: string, target: PullTarget): Promise<PullResult>;
}

/**
 * The v1 GitHub-backed provider: a thin, honest wrapper over the firewalled
 * `runGit`. Push receives an authority-checked URL + refspec and passes both
 * explicitly. Pull fetches the caller-authorized URL/ref explicitly, then
 * rebases the exact fetched object (`FETCH_HEAD`), so mutable remote/upstream
 * configuration cannot redirect either network contact or integration after
 * validation. Each runs with `allowFailure` so a rejection resolves to a
 * structured result (the sync flow classifies it) rather than throwing.
 */
export class GitRemoteProvider implements RemoteProvider {
  readonly provider = "github";

  constructor(private readonly runGit: GitRunnerFn = defaultRunGit) {}

  async push(cwd: string, target: PushTarget): Promise<PushResult> {
    if (!isSafeDestinationUrl(target.url) || !isSafePushRefspec(target.refspec)) {
      return {
        pushed: false,
        code: -1,
        stderr: "refusing unsafe publication destination",
      };
    }
    const r = await this.runGit(["push", target.url, target.refspec], {
      cwd,
      allowFailure: true,
    });
    return { pushed: r.code === 0, code: r.code, stderr: r.stderr };
  }

  async pull(cwd: string, target: PullTarget): Promise<PullResult> {
    if (!isSafeDestinationUrl(target.url) || !isSafeBranchRef(target.ref)) {
      return {
        pulled: false,
        code: -1,
        stderr: "refusing unsafe sync source",
      };
    }
    const fetched = await this.runGit(["fetch", "--quiet", target.url, target.ref], {
      cwd,
      allowFailure: true,
    });
    if (fetched.code !== 0) {
      return { pulled: false, code: fetched.code, stderr: fetched.stderr };
    }
    const rebased = await this.runGit(["rebase", "--quiet", "FETCH_HEAD"], {
      cwd,
      allowFailure: true,
    });
    return { pulled: rebased.code === 0, code: rebased.code, stderr: rebased.stderr };
  }
}

function isSafeDestinationUrl(url: string): boolean {
  return url.length > 0 && !url.startsWith("-") && !/[\0\r\n]/u.test(url);
}

function isSafeBranchRef(ref: string): boolean {
  return (
    ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length && !/[\0\r\n]/u.test(ref)
  );
}

function isSafePushRefspec(refspec: string): boolean {
  return refspec.startsWith("HEAD:") && isSafeBranchRef(refspec.slice("HEAD:".length));
}
