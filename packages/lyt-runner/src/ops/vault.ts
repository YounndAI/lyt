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

// Real vault ops.
//
// Per arc-thoughts §6.6:201-216 the 5-step protocol fronts the automator
// body with `std:vault.sync@v1` (git pull) and follows it with
// `std:vault.commit@v1` (git add . && git commit && git push, gated on
// `--no-push`). Per arc-thoughts §6.11:443-447 these two ops are
// lyt-runner's canonical wrapper around the shared `runGit` helper in
// `@younndai/lyt-vault/util/git-run` — the same helper every other
// vault-side flow uses, so the shape stays single-source-of-truth.
//
// Args:
// vault.sync { vault_path?: string } — defaults to runtime.vaultPath
// vault.commit { vault_path?: string, message?: string, no_push?: boolean }
// — message defaults to "automator:<runId>" when run-context
// supplies a runId; otherwise "lyt-runner: vault.commit"
//
// On a missing runtime.vaultPath AND no args.vault_path, the handler throws
// with a clear error so callers (and the test suite) get a loud failure
// rather than a silent skip. Same shape as the lease ops — fail-loud at
// the LytRuntime boundary, no implicit defaults that could regress data.

import type { ExecutionContext, OpHandler } from "@younndai/yon-runner";
import { gitStatusPorcelain, hasUpstream, isGitRepo, runGit } from "@younndai/lyt-vault";

import type { LytRuntime } from "../runtime.js";

export interface VaultSyncOpArgs {
  vault_path?: string;
}

export interface VaultSyncOpResult {
  status: "synced" | "noop";
  vault_path: string;
  ahead: number;
  behind: number;
  stdout: string;
}

export interface VaultCommitOpArgs {
  vault_path?: string;
  message?: string;
  no_push?: boolean;
}

export interface VaultCommitOpResult {
  status: "committed" | "nothing_to_commit" | "committed_no_push";
  vault_path: string;
  commit_sha: string | null;
  pushed: boolean;
  stdout: string;
}

function resolveVaultPath(runtime: LytRuntime, args: Record<string, unknown>, op: string): string {
  const argVal = args["vault_path"];
  if (typeof argVal === "string" && argVal.length > 0) return argVal;
  if (typeof runtime.vaultPath === "string" && runtime.vaultPath.length > 0) {
    return runtime.vaultPath;
  }
  throw new Error(
    `${op}: no vault_path supplied — pass via @STEP args.vault_path or set LytRuntime.vaultPath at runner construction`,
  );
}

export function createVaultOps(runtime: LytRuntime): Record<string, OpHandler> {
  return {
    "vault.sync": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<VaultSyncOpResult> => {
      const vaultPath = resolveVaultPath(runtime, args, "std:vault.sync@v1");
      if (!(await isGitRepo(vaultPath))) {
        throw new Error(
          `std:vault.sync@v1: ${vaultPath} is not a git repository (git rev-parse --git-dir failed)`,
        );
      }
      if (!(await hasUpstream(vaultPath))) {
        // No upstream → there is nothing to pull from. Treat as a non-error
        // noop so a freshly-init'd local vault (still --no-push) doesn't fail
        // the protocol mid-run. Surfaces ahead/behind=0 + stdout=informational.
        return {
          status: "noop",
          vault_path: vaultPath,
          ahead: 0,
          behind: 0,
          stdout: "vault has no upstream; nothing to pull",
        };
      }
      const pullResult = await runGit(["pull", "--ff-only"], {
        cwd: vaultPath,
        allowFailure: true,
      });
      if (pullResult.code !== 0) {
        throw new Error(
          `std:vault.sync@v1: git pull --ff-only exited ${pullResult.code}: ${pullResult.stderr.trim() || pullResult.stdout.trim()}`,
        );
      }
      // Surface ahead/behind so callers can see whether the pull was a no-op
      // (already up to date) or actually advanced.
      const rev = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
        cwd: vaultPath,
        allowFailure: true,
      });
      let ahead = 0;
      let behind = 0;
      if (rev.code === 0) {
        const parts = rev.stdout.trim().split(/\s+/);
        ahead = Number(parts[0]) || 0;
        behind = Number(parts[1]) || 0;
      }
      return {
        status: "synced",
        vault_path: vaultPath,
        ahead,
        behind,
        stdout: pullResult.stdout.trim(),
      };
    },
    "vault.commit": async (
      _ctx: ExecutionContext,
      args: Record<string, unknown>,
    ): Promise<VaultCommitOpResult> => {
      const vaultPath = resolveVaultPath(runtime, args, "std:vault.commit@v1");
      if (!(await isGitRepo(vaultPath))) {
        throw new Error(`std:vault.commit@v1: ${vaultPath} is not a git repository`);
      }
      const messageArg = args["message"];
      const message =
        typeof messageArg === "string" && messageArg.length > 0
          ? messageArg
          : "lyt-runner: vault.commit";
      const noPushArg = args["no_push"];
      const noPush = noPushArg === true;

      // Stage everything under the vault path, including new files. Vault
      // automators are vault-scoped (arc §6.5 reads_scope=[vault]), so
      // `git add .` is the right surface — the vault IS the unit of work.
      const addResult = await runGit(["add", "."], { cwd: vaultPath, allowFailure: true });
      if (addResult.code !== 0) {
        throw new Error(
          `std:vault.commit@v1: git add . exited ${addResult.code}: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
        );
      }

      // If nothing was staged, there's nothing to commit — return a clean
      // noop result rather than letting `git commit` error with "nothing to
      // commit, working tree clean".
      const status = await gitStatusPorcelain(vaultPath);
      if (status.clean) {
        return {
          status: "nothing_to_commit",
          vault_path: vaultPath,
          commit_sha: null,
          pushed: false,
          stdout: "working tree clean; nothing to commit",
        };
      }

      const commitResult = await runGit(["commit", "-m", message], {
        cwd: vaultPath,
        allowFailure: true,
      });
      if (commitResult.code !== 0) {
        throw new Error(
          `std:vault.commit@v1: git commit exited ${commitResult.code}: ${commitResult.stderr.trim() || commitResult.stdout.trim()}`,
        );
      }

      // Capture commit SHA (full, not abbreviated) for the run trace +
      // automator_runs row that block-B Commit 5 will write.
      const shaResult = await runGit(["rev-parse", "HEAD"], {
        cwd: vaultPath,
        allowFailure: true,
      });
      const commitSha = shaResult.code === 0 ? shaResult.stdout.trim() : null;

      if (noPush) {
        return {
          status: "committed_no_push",
          vault_path: vaultPath,
          commit_sha: commitSha,
          pushed: false,
          stdout: commitResult.stdout.trim(),
        };
      }
      if (!(await hasUpstream(vaultPath))) {
        // No upstream → can't push. Mirror vault.sync's noop posture: report,
        // don't fail. Same rationale (a freshly-init'd local vault before
        // remote setup should still let the protocol's commit step succeed).
        return {
          status: "committed_no_push",
          vault_path: vaultPath,
          commit_sha: commitSha,
          pushed: false,
          stdout: `${commitResult.stdout.trim()}\n(no upstream; skipped push)`,
        };
      }
      const pushResult = await runGit(["push"], { cwd: vaultPath, allowFailure: true });
      if (pushResult.code !== 0) {
        throw new Error(
          `std:vault.commit@v1: git push exited ${pushResult.code}: ${pushResult.stderr.trim() || pushResult.stdout.trim()}`,
        );
      }
      return {
        status: "committed",
        vault_path: vaultPath,
        commit_sha: commitSha,
        pushed: true,
        stdout: `${commitResult.stdout.trim()}\n${pushResult.stdout.trim()}`,
      };
    },
  };
}
