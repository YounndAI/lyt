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

import { resolveConfig } from "../../util/config.js";
import { vaultRepoName } from "../../util/federation-paths.js";
import { isValidGhHandle } from "../../util/identity.js";
import {
  realFederationGhClient,
  type FederationGhClient,
  type FederationRepoVisibility,
} from "../../util/gh-federation.js";
import {
  runGit as defaultRunGit,
  type GitRunOptions,
  type GitRunResult,
} from "../../util/git-run.js";
import { BRAND_TOPICS, formatRepoDescription } from "../../scaffold/github-defaults.js";
import type { VaultRow } from "../../registry/repo.js";

// Brief B (§3-§6) — the SHARED vault-publish materialization, used by both
// init/adopt (B.1, LOCAL only — push + gh-create held) and `lyt sync` (B.2,
// post-consent — gh-create + push). One definition of "make this vault
// publishable", so init and sync can never diverge.
//
// DELTA from the brief's literal B.1 (documented in the retro): B.1's text lists
// `gh repo create` as part of the un-consented init materialize. That is an
// OUTWARD GitHub mutation; + B.3 (the staged-HIL gate) + the handler's
// "outward = explicit consent" stance require NO outward effect until the
// handler answers the publish prompt. So init does LOCAL materialize
// (createRemote=false, push=false); the consented sync engine does gh-create +
// push (createRemote=true, push=true). `git remote add` still runs at init — it
// sets the URL where the repo WILL live (a local config write, not outward) so
// the remote is wired the moment the user consents.

export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

export interface MaterializeVaultOptions {
  handle: string;
  // Outward gh-create. B.1 = false (held); B.2 = true (post-consent). Default false.
  createRemoteIfMissing?: boolean | undefined;
  // Outward push. B.1 = false (held); B.2 = true (post-consent). Default false.
  push?: boolean | undefined;
  // (2026-06-04) — wire the `origin` remote. Default true
  // (existing init/sync behavior: the remote URL is a LOCAL git config write,
  // safe to set before the repo exists). A no-gh LOCAL init passes false so the
  // provisional handle never reaches a remote URL — connect adds `origin` under
  // the REAL handle (materialize is called again at connect with setRemote=true,
  // and step 4 below only adds origin when absent, so it wires cleanly then).
  setRemote?: boolean | undefined;
  // default "private" (per-vault visibility seam). The conscious-public
  // flip overrides this; never defaults public.
  visibility?: FederationRepoVisibility | undefined;
  ghClient?: FederationGhClient | undefined;
  runGit?: GitRunner | undefined;
}

export interface MaterializeVaultResult {
  vaultName: string;
  repoName: string;
  visibility: FederationRepoVisibility;
  gitInitialized: boolean; // ran `git init`
  committed: boolean; // made the initial commit (HEAD was unborn)
  remoteSet: boolean; // added `origin` (was absent)
  repoCreated: boolean; // created the gh repo (createRemoteIfMissing path)
  pushed: boolean;
  // Non-fatal degradations (gh offline / auth / push reject). Empty = fully
  // materialized to the requested level.
  warnings: string[];
  skipped: boolean;
  skippedReason?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Materialize a single vault toward a publishable state. Idempotent: re-running
// is a no-op once the vault has a repo + commit + remote (each step probes
// before acting). Local steps (git) always run; outward steps (gh-create, push)
// run only when their flag is set.
export async function materializeVaultPublishable(
  vault: VaultRow,
  opts: MaterializeVaultOptions,
): Promise<MaterializeVaultResult> {
  const gh = opts.ghClient ?? realFederationGhClient;
  const git = opts.runGit ?? defaultRunGit;
  const push = opts.push ?? false;
  const createRemote = opts.createRemoteIfMissing ?? false;
  const setRemote = opts.setRemote ?? true;
  const visibility = opts.visibility ?? resolveConfig().defaultRepoVisibility;
  const { handle } = opts;
  const repoName = vaultRepoName(vault.name);
  const warnings: string[] = [];

  const result: MaterializeVaultResult = {
    vaultName: vault.name,
    repoName,
    visibility,
    gitInitialized: false,
    committed: false,
    remoteSet: false,
    repoCreated: false,
    pushed: false,
    warnings,
    skipped: false,
  };

  // release review / a review finding — defense-in-depth: NEVER let an invalid handle
  // reach a `git remote add https://github.com/<handle>/...` or `gh repo create`
  // spawn. A poisoned identity.yon (cloned-pod recovery) could seed a
  // metachar/flag-bearing handle; the argv-verbatim spawn blocks shell injection
  // but a `-`-leading or `/`-bearing handle is still an argv/flag-injection +
  // wrong-target risk. Refuse to materialize (the remote URL would be malformed
  // anyway). Mirrors the guard adopt-and-prime + wizard apply before gh-walk.
  if (!isValidGhHandle(handle)) {
    return { ...result, skipped: true, skippedReason: "invalid-handle" };
  }
  // Skip non-live vaults + missing paths — never materialize a tombstoned or
  // absent vault.
  if (vault.status === "tombstoned") {
    return { ...result, skipped: true, skippedReason: "tombstoned" };
  }
  if (!existsSync(vault.path)) {
    return { ...result, skipped: true, skippedReason: "path-missing" };
  }

  // 1. Ensure a git repo + a pinned local identity. The fresh-machine guard
  // (mirrors gh-federation.ts): pin user.name/email from the handle so a
  // `git commit` never blocks on missing global git config.
  const gitDir = await git(["rev-parse", "--git-dir"], {
    cwd: vault.path,
    allowFailure: true,
  });
  if (gitDir.code !== 0) {
    await git(["init", "--initial-branch=main"], { cwd: vault.path });
    result.gitInitialized = true;
  }
  await git(["config", "user.name", handle], { cwd: vault.path, allowFailure: true });
  await git(["config", "user.email", `${handle}@users.noreply.github.com`], {
    cwd: vault.path,
    allowFailure: true,
  });

  // 2. Ensure >=1 commit (B.1 exit). If HEAD is unborn, stage everything + make
  // the initial commit. (Dirty-but-committed vaults are the sync engine's
  // job — B.2 commits ongoing changes; here we only guarantee the floor.)
  const hasHead = await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: vault.path,
    allowFailure: true,
  });
  if (hasHead.code !== 0) {
    await git(["add", "-A"], { cwd: vault.path });
    await git(["commit", "--allow-empty", "-m", `chore(lyt): initialize vault ${vault.name}`], {
      cwd: vault.path,
    });
    result.committed = true;
  }

  // 3. Ensure the gh repo exists (OUTWARD — only when createRemoteIfMissing).
  // Non-fatal on gh-offline/auth: record + continue; the next `lyt sync`
  // retries (B.2 create-if-missing is the durable path via outbox).
  if (createRemote) {
    try {
      const exists = await gh.repoExists(handle, repoName);
      if (!exists) {
        await gh.createRepo(handle, repoName, visibility, formatRepoDescription(vault.name));
        result.repoCreated = true;
        try {
          await gh.setRepoTopics(handle, repoName, BRAND_TOPICS);
        } catch (err) {
          warnings.push(`topic-set failed for ${handle}/${repoName}: ${errMsg(err)}`);
        }
      }
    } catch (err) {
      warnings.push(`gh repo ensure deferred (offline/auth?): ${errMsg(err)}`);
    }
  }

  // 4. Ensure `origin` points at the vault repo. This is a LOCAL git config
  // write (not outward) — safe at init even before the repo exists, so the
  // remote is wired the moment the handler consents to publish. Never clobber
  // an existing origin (a handler may have set a custom remote).
  // a no-gh LOCAL init passes setRemote=false so the provisional handle
  // never lands in a remote URL; connect re-materializes with setRemote=true.
  if (setRemote) {
    const originUrl = `https://github.com/${handle}/${repoName}.git`;
    const origin = await git(["remote", "get-url", "origin"], {
      cwd: vault.path,
      allowFailure: true,
    });
    if (origin.code !== 0) {
      await git(["remote", "add", "origin", originUrl], { cwd: vault.path });
      result.remoteSet = true;
    }
  }

  // 5. Push (OUTWARD — only when push). Non-fatal: a push failure is recorded
  // and surfaced; the outbox (B.2) is the resumable retry path.
  if (push) {
    const pushed = await git(["push", "-u", "origin", "main"], {
      cwd: vault.path,
      allowFailure: true,
    });
    if (pushed.code === 0) {
      result.pushed = true;
    } else {
      warnings.push(`push failed for ${vault.name}: ${pushed.stderr.trim().slice(0, 200)}`);
    }
  }

  return result;
}

export interface CommitPodRepoOptions {
  push?: boolean | undefined; // B.1 = false (held); B.2 = true. Default false.
  runGit?: GitRunner | undefined;
}

export interface CommitPodRepoResult {
  committed: boolean; // a new commit was created (tree was dirty)
  pushed: boolean;
  warnings: string[];
}

// Brief B (a review finding) — commit the regenerated pod.yon (+ identity.yon) in the pod
// repo. Brief A's lifecycle regen WRITES pod.yon but leaves the pod working tree
// DIRTY + UNCOMMITTED (the regen runs after federationInitFlow's own commit).
// This commits it so the staged pod is a clean "committed, awaiting-push" state
// rather than a dirty tree. Push is HELD at init (B.1) and done by the consented
// sync engine (B.2). Idempotent: a no-op when the tree is already clean.
export async function commitPodRepo(
  podDir: string,
  message: string,
  opts: CommitPodRepoOptions = {},
): Promise<CommitPodRepoResult> {
  const git = opts.runGit ?? defaultRunGit;
  const push = opts.push ?? false;
  const warnings: string[] = [];
  const result: CommitPodRepoResult = { committed: false, pushed: false, warnings };

  if (!existsSync(podDir)) {
    warnings.push(`pod dir missing: ${podDir}`);
    return result;
  }
  const gitDir = await git(["rev-parse", "--git-dir"], { cwd: podDir, allowFailure: true });
  if (gitDir.code !== 0) {
    warnings.push(`pod dir is not a git repo: ${podDir}`);
    return result;
  }

  // Stage explicit pod artifacts only (never `git add -A` — avoids sweeping a
  // stray file into the pod commit). Each add is allowFailure (a file may be
  // absent on a given run).
  for (const f of ["pod.yon", "identity.yon", ".gitignore"]) {
    await git(["add", "--", f], { cwd: podDir, allowFailure: true });
  }

  // Commit only when the index has staged changes (porcelain shows none → clean,
  // skip to keep idempotency + avoid empty commits cluttering history).
  const status = await git(["status", "--porcelain"], { cwd: podDir });
  const dirty = status.stdout.split(/\r?\n/).some((l) => l.trim().length > 0);
  if (dirty) {
    await git(["commit", "-m", message], { cwd: podDir });
    result.committed = true;
  }

  if (push) {
    const hasUpstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: podDir,
      allowFailure: true,
    });
    // release review — the pod is the cross-machine convergence point (most
    // likely to be behind); give it the SAME pull-rebase-if-behind the
    // vaults get, so a non-fast-forward doesn't wedge the outbox forever. On
    // conflict: abort + surface, do NOT push (no overwrite). a review finding — the behind
    // parse fails SAFE: an unreadable rev-list (code != 0) is treated as
    // possibly-behind (→ attempt pull-rebase) rather than assume-not-behind.
    if (hasUpstream.code === 0) {
      await git(["fetch", "--quiet"], { cwd: podDir, allowFailure: true });
      const ab = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
        cwd: podDir,
        allowFailure: true,
      });
      const behind = ab.code === 0 ? Number(ab.stdout.trim().split(/\s+/)[1] ?? 0) || 0 : 1;
      if (behind > 0) {
        const rebased = await git(["pull", "--rebase", "--quiet"], {
          cwd: podDir,
          allowFailure: true,
        });
        if (rebased.code !== 0) {
          await git(["rebase", "--abort"], { cwd: podDir, allowFailure: true });
          warnings.push(
            "pod rebase conflict — run `git pull` in ~/lyt/pod, then re-run `lyt sync` (no data overwritten)",
          );
          return result; // committed locally; push withheld (result.pushed stays false)
        }
      }
    }
    const args = hasUpstream.code === 0 ? ["push"] : ["push", "-u", "origin", "main"];
    const pushed = await git(args, { cwd: podDir, allowFailure: true });
    if (pushed.code === 0) {
      result.pushed = true;
    } else {
      warnings.push(`pod push failed: ${pushed.stderr.trim().slice(0, 200)}`);
    }
  }

  return result;
}
