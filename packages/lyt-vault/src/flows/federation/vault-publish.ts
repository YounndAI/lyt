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
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";

import { resolveConfig } from "../../util/config.js";
import { resolveRemoteUrl } from "../../util/remote-url.js";
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
import { closeRegistry, openRegistry } from "../../registry/client.js";
import { getMeshByRid } from "../../registry/meshes-repo.js";
import { getVaultByRid, setVaultGitUrl, type VaultRow } from "../../registry/repo.js";
import {
  observePublicationPermission,
  type PublicationPermissionObserver,
} from "./publication-permission.js";
import {
  loadDestinationPolicyContext,
  resolveCanonicalOwnedVaultPublicationAuthority,
  type CanonicalVaultPublicationAuthority,
} from "./destination-policy-service.js";
import {
  withCanonicalVaultPublicationAttempt,
  type CanonicalVaultPublicationAttemptContext,
} from "./publication-authority.js";
import { withFreshPublicationPermission } from "./publication-authority.js";

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
  // B2a (Inc-2 Phase B slice 2) — the GitHub OWNER the vault repo lives under
  // (gh-create target + `origin` URL owner). Defaults to `handle`. A vault homed
  // in an ORG mesh passes the mesh's org `push_target` here so its repo is
  // created/wired under the ORG, not the user's personal federation handle. Kept
  // SEPARATE from `handle` (which still drives the local git commit identity +
  // the invalid-handle skip) so the org owner only ever reaches the repo owner,
  // never the commit author. Validated against isValidGhHandle before it can
  // reach a git-remote/gh spawn.
  repoOwner?: string | undefined;
  /** Exact semantic owner kind from the effective destination-policy winner. */
  repoTargetKind?: "user" | "org" | undefined;
  // Phase A authority label. Existing 0.13 library callers may omit it for the
  // compatibility window; every lifecycle caller in this tree supplies it.
  repoOwnerAuthority?:
    | "effective-owned-destination"
    | "legacy-origin-hint"
    | "local-only"
    | undefined;
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
  permissionObserver?: PublicationPermissionObserver | undefined;
  /** One id binds every fresh observation to this materialization attempt. */
  permissionAttemptId?: string | undefined;
  /** Reuse an already-open registry connection; policy is still resolved here. */
  registryDb?: Client | undefined;
  /** RID-addressed pod-manifest mapping; display name is never publication identity. */
  repoName?: string | undefined;
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
  /** Validated existing/installed origin coordinate used for the receipt. */
  remoteCoordinate: string | null;
  // Non-fatal degradations (gh offline / auth / push reject). Empty = fully
  // materialized to the requested level.
  warnings: string[];
  skipped: boolean;
  skippedReason?: string;
}

export async function establishPublishedVaultTracking(args: {
  vault: VaultRow;
  canonicalUrl: string;
  git: GitRunner;
  registryDb: Client;
}): Promise<void> {
  const { vault, canonicalUrl, git, registryDb } = args;
  const cwd = vault.path;
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd, allowFailure: true },
  );
  if (upstream.code !== 0) {
    const remoteTracking = await git(["config", "branch.main.remote", "origin"], {
      cwd,
      allowFailure: true,
    });
    const mergeTracking = await git(
      ["config", "branch.main.merge", "refs/heads/main"],
      { cwd, allowFailure: true },
    );
    const remoteRef = await git(["update-ref", "refs/remotes/origin/main", "HEAD"], {
      cwd,
      allowFailure: true,
    });
    if (remoteTracking.code !== 0 || mergeTracking.code !== 0 || remoteRef.code !== 0) {
      throw new Error("push completed, but local tracking could not be established");
    }
    const verified = await git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd, allowFailure: true },
    );
    if (verified.code !== 0) {
      throw new Error("push completed, but local tracking could not be verified");
    }
  }
  await setVaultGitUrl(registryDb, vault.rid, canonicalUrl);
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
  // B2a — the repo owner (gh-create + origin URL). Defaults to the federation
  // handle; an org-mesh vault passes the mesh's org push_target.
  let repoName = opts.repoName ?? "";
  let repoOwner = opts.repoOwner ?? handle;
  let repoTargetKind = opts.repoTargetKind ?? (repoOwner === handle ? "user" : "org");
  const permissionObserver = opts.permissionObserver ?? observePublicationPermission;
  const permissionAttemptId = opts.permissionAttemptId ?? randomUUID();
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
    remoteCoordinate: null,
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
  // B2a — the repo owner ALSO feeds a git-remote URL + gh-create spawn, so it
  // gets the same defense-in-depth handle validation (a poisoned org push_target
  // must never reach the spawn as a `-`/`/`-bearing owner).
  if (!isValidGhHandle(repoOwner)) {
    return { ...result, skipped: true, skippedReason: "invalid-repo-owner" };
  }
  // Skip non-live vaults + missing paths — never materialize a tombstoned or
  // absent vault.
  if (vault.status === "tombstoned") {
    return { ...result, skipped: true, skippedReason: "tombstoned" };
  }
  if (!existsSync(vault.path)) {
    return { ...result, skipped: true, skippedReason: "path-missing" };
  }

  const targetMutation = setRemote || createRemote || push;
  let publicationAuthority:
    | { authority: CanonicalVaultPublicationAuthority; podRid: string; podRoot?: string }
    | undefined;
  if (targetMutation) {
    publicationAuthority = await resolveMaterializeDestinationPolicy(vault, opts.registryDb);
    if (publicationAuthority === undefined) {
      return { ...result, skipped: true, skippedReason: "destination-policy-required" };
    }
    const { destination } = publicationAuthority.authority;
    if (
      (opts.repoOwner !== undefined &&
        opts.repoOwner.toLowerCase() !== destination.owner.toLowerCase()) ||
      (opts.repoTargetKind !== undefined && opts.repoTargetKind !== destination.targetKind) ||
      (opts.repoName !== undefined &&
        opts.repoName.toLowerCase() !== destination.repositoryName.toLowerCase()) ||
      (opts.repoOwnerAuthority !== undefined &&
        opts.repoOwnerAuthority !== "effective-owned-destination")
    ) {
      return { ...result, skipped: true, skippedReason: "destination-policy-drift" };
    }
    repoOwner = destination.owner;
    repoTargetKind = destination.targetKind;
    repoName = destination.repositoryName;
    result.repoName = repoName;
  }
  if (targetMutation && repoName.length === 0) {
    return { ...result, skipped: true, skippedReason: "destination-policy-required" };
  }
  const repository = `${repoOwner}/${repoName}`;
  const permissionTarget = `github:${repoTargetKind}/${repoOwner}`;
  const authorized = <T>(
    capability: "repository-create" | "repository-push",
    action: (context: CanonicalVaultPublicationAttemptContext) => Promise<T>,
  ) => {
    if (publicationAuthority === undefined) {
      throw new Error("Publication refused: canonical destination policy is unavailable.");
    }
    return withCanonicalVaultPublicationAttempt({
      ...(opts.registryDb === undefined ? {} : { db: opts.registryDb }),
      vaultRid: vault.rid,
      podRid: publicationAuthority.podRid,
      ...(publicationAuthority.podRoot === undefined
        ? {}
        : { podRoot: publicationAuthority.podRoot }),
      authority: publicationAuthority.authority,
      expectedRepository: repository,
      capability,
      target: permissionTarget,
      repository,
      actor: handle,
      attemptId: permissionAttemptId,
      permissionObserver,
      action,
    });
  };

  const expectedCoordinate = `${repoOwner}/${repoName}`;
  // Capture the immutable publication destination from the canonical policy
  // winner. The push below uses this URL directly: repository-local pushurl,
  // pushRemote, and pushDefault configuration are never consulted.
  const canonicalPushUrl = resolveRemoteUrl(repoOwner, repoName);
  // Shared-boundary guard: every caller (scoped or pod-wide) passes through
  // this materializer. Validate an existing origin before any GitHub action or
  // remote mutation, so a vault accidentally wired to another repository can
  // never create/push to the mesh-derived target or have its remote clobbered.
  const initialOrigin = await git(["remote", "get-url", "origin"], {
    cwd: vault.path,
    allowFailure: true,
  });
  if (initialOrigin.code === 0) {
    const actual = normalizeGitHubRepoCoordinate(initialOrigin.stdout);
    if (actual === null || !sameRepoCoordinate(actual, expectedCoordinate)) {
      return {
        ...result,
        skipped: true,
        skippedReason: "origin-mismatch",
        warnings: [
          `origin mismatch: expected ${expectedCoordinate}, found ${actual ?? (initialOrigin.stdout.trim() || "unrecognized origin")}`,
        ],
      };
    }
    result.remoteCoordinate = actual;
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

  // 3. Ensure `origin` points at the vault repo. Missing is safe to install;
  // an existing origin was validated above and is never mutated. Read back the
  // installed value so subsequent outward actions and receipts use evidence,
  // not a merely intended URL.
  if (setRemote && initialOrigin.code !== 0) {
    const originUrl = resolveRemoteUrl(repoOwner, repoName);
    try {
      const capability = createRemote ? "repository-create" : "repository-push";
      await authorized(capability, () =>
        git(["remote", "add", "origin", originUrl], { cwd: vault.path }),
      );
    } catch (error) {
      return {
        ...result,
        skipped: true,
        skippedReason: "permission-unverified",
        warnings: [errMsg(error)],
      };
    }
    result.remoteSet = true;
    const installed = await git(["remote", "get-url", "origin"], {
      cwd: vault.path,
      allowFailure: true,
    });
    const actual = installed.code === 0 ? normalizeGitHubRepoCoordinate(installed.stdout) : null;
    if (actual === null || !sameRepoCoordinate(actual, expectedCoordinate)) {
      return {
        ...result,
        skipped: true,
        skippedReason: "origin-mismatch",
        warnings: [`origin validation failed after install; expected ${expectedCoordinate}`],
      };
    }
    result.remoteCoordinate = actual;
  }

  // 4. Ensure the gh repo exists (OUTWARD — only when createRemoteIfMissing).
  // Non-fatal on gh-offline/auth: record + continue; the next `lyt sync`
  // retries (B.2 create-if-missing is the durable path via outbox).
  if (createRemote) {
    try {
      // B2a — create/probe under `repoOwner` (the org for an org-mesh vault),
      // not the personal `handle`.
      const exists = await gh.repoExists(repoOwner, repoName);
      if (!exists) {
        try {
          await authorized("repository-create", (attempt) =>
            attempt.runOutwardChild(() =>
              gh.createRepo(repoOwner, repoName, visibility, formatRepoDescription(vault.name)),
            ),
          );
        } catch (error) {
          return {
            ...result,
            skipped: true,
            skippedReason: "permission-unverified",
            warnings: [errMsg(error)],
          };
        }
        result.repoCreated = true;
        try {
          await authorized("repository-push", (attempt) =>
            attempt.runOutwardChild(() => gh.setRepoTopics(repoOwner, repoName, BRAND_TOPICS)),
          );
        } catch (err) {
          warnings.push(`topic-set failed for ${repoOwner}/${repoName}: ${errMsg(err)}`);
        }
      }
    } catch (err) {
      warnings.push(`gh repo ensure deferred (offline/auth?): ${errMsg(err)}`);
    }
  }

  // 5. Push (OUTWARD — only when push). Revalidate immediately before spawn so
  // a caller cannot bypass the origin guard between create and push.
  // and surfaced; the outbox (B.2) is the resumable retry path.
  if (push) {
    const currentOrigin = await git(["remote", "get-url", "origin"], {
      cwd: vault.path,
      allowFailure: true,
    });
    const currentCoordinate =
      currentOrigin.code === 0 ? normalizeGitHubRepoCoordinate(currentOrigin.stdout) : null;
    if (currentCoordinate === null || !sameRepoCoordinate(currentCoordinate, expectedCoordinate)) {
      return {
        ...result,
        skipped: true,
        skippedReason: "origin-mismatch",
        warnings: [`origin changed before push; expected ${expectedCoordinate}`],
      };
    }
    result.remoteCoordinate = currentCoordinate;
    try {
      const pushed = await authorized("repository-push", (attempt) =>
        attempt.runOutwardChild(() =>
          git(["push", canonicalPushUrl, "HEAD:refs/heads/main"], {
            cwd: vault.path,
            allowFailure: true,
          }),
        ),
      );
      if (pushed.code === 0) {
        result.pushed = true;
        if (opts.registryDb === undefined) {
          throw new Error("push completed, but registry persistence is unavailable");
        }
        await establishPublishedVaultTracking({
          vault,
          canonicalUrl: canonicalPushUrl,
          git,
          registryDb: opts.registryDb,
        });
      } else {
        warnings.push(`push failed for ${vault.name}: ${pushed.stderr.trim().slice(0, 200)}`);
      }
    } catch (error) {
      return {
        ...result,
        skipped: true,
        skippedReason: "permission-unverified",
        warnings: [errMsg(error)],
      };
    }
  }

  return result;
}

async function resolveMaterializeDestinationPolicy(
  suppliedVault: VaultRow,
  suppliedDb?: Client,
): Promise<
  { authority: CanonicalVaultPublicationAuthority; podRid: string; podRoot?: string } | undefined
> {
  const db = suppliedDb ?? (await openRegistry());
  try {
    const vault = await getVaultByRid(db, suppliedVault.rid);
    if (vault === null) return undefined;
    const mesh = vault.homeMeshRid === null ? null : await getMeshByRid(db, vault.homeMeshRid);
    const context = await loadDestinationPolicyContext(db);
    if (context.podRid === null) return undefined;
    const authority = resolveCanonicalOwnedVaultPublicationAuthority(vault, mesh, context);
    return authority === null
      ? undefined
      : {
          authority,
          podRid: context.podRid,
          ...(context.podRoot === undefined ? {} : { podRoot: context.podRoot }),
        };
  } finally {
    if (suppliedDb === undefined) await closeRegistry(db);
  }
}

/** Normalize supported GitHub HTTPS/SSH/git URL forms to owner/repo. */
export function normalizeGitHubRepoCoordinate(url: string): string | null {
  const value = url
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/i, "");
  const match =
    /^(?:https?|git):\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(value) ??
    /^ssh:\/\/(?:git@)?github\.com\/([^/]+)\/([^/]+)$/i.exec(value) ??
    /^(?:git@)?github\.com:([^/]+)\/([^/]+)$/i.exec(value);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function sameRepoCoordinate(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

export interface CommitPodRepoOptions {
  push?: boolean | undefined; // B.1 = false (held); B.2 = true. Default false.
  runGit?: GitRunner | undefined;
  permissionObserver?: PublicationPermissionObserver | undefined;
  permissionActor?: string | undefined;
  permissionRepository?: string | undefined;
  permissionAttemptId?: string | undefined;
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
    const actor = opts.permissionActor;
    const repository = opts.permissionRepository;
    const repositoryParts = repository?.split("/") ?? [];
    const owner = repositoryParts.length === 2 ? repositoryParts[0] : undefined;
    if (
      actor === undefined ||
      repository === undefined ||
      owner === undefined ||
      owner.toLowerCase() !== actor.toLowerCase() ||
      repositoryParts[1] !== "lyt-pod"
    ) {
      warnings.push("pod push held: publication policy was not bound to this pod destination");
      return result;
    }
    const canonicalUrl = `https://github.com/${repository}.git`;
    const originBefore = await git(["remote", "get-url", "origin"], {
      cwd: podDir,
      allowFailure: true,
    });
    const originCoordinate =
      originBefore.code === 0 ? normalizeGitHubRepoCoordinate(originBefore.stdout) : null;
    if (originCoordinate === null || !sameRepoCoordinate(originCoordinate, repository)) {
      warnings.push(`pod push held: origin does not match ${repository}`);
      return result;
    }
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
      const fetched = await withFreshPublicationPermission({
        capability: "repository-push",
        target: `github:user/${owner}`,
        repository,
        actor,
        attemptId: opts.permissionAttemptId ?? randomUUID(),
        policyEpoch: 0,
        permissionObserver: opts.permissionObserver ?? observePublicationPermission,
        publicationSubject: {
          identity: `pod:${repository.toLowerCase()}`,
          podRoot: podDir,
        },
        action: (attempt) =>
          attempt.runOutwardChild(() =>
            git(["fetch", "--quiet", canonicalUrl, "refs/heads/main"], {
              cwd: podDir,
              allowFailure: true,
            }),
          ),
      });
      if (fetched.code !== 0) {
        warnings.push(`pod fetch failed: ${fetched.stderr.trim().slice(0, 200)}`);
        return result;
      }
      const ab = await git(["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"], {
        cwd: podDir,
        allowFailure: true,
      });
      const behind = ab.code === 0 ? Number(ab.stdout.trim().split(/\s+/)[1] ?? 0) || 0 : 1;
      if (behind > 0) {
        const rebased = await git(["rebase", "--quiet", "FETCH_HEAD"], {
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
    const attemptId = opts.permissionAttemptId ?? randomUUID();
    try {
      const pushed = await withFreshPublicationPermission({
        capability: "repository-push",
        target: `github:user/${owner}`,
        repository,
        actor,
        attemptId,
        policyEpoch: 0,
        permissionObserver: opts.permissionObserver ?? observePublicationPermission,
        publicationSubject: {
          identity: `pod:${repository.toLowerCase()}`,
          podRoot: podDir,
        },
        action: async (attempt) => {
          const currentOrigin = await git(["remote", "get-url", "origin"], {
            cwd: podDir,
            allowFailure: true,
          });
          const currentCoordinate =
            currentOrigin.code === 0 ? normalizeGitHubRepoCoordinate(currentOrigin.stdout) : null;
          if (currentCoordinate === null || !sameRepoCoordinate(currentCoordinate, repository)) {
            throw new Error(`pod origin changed before push; expected ${repository}`);
          }
          return attempt.runOutwardChild(() =>
            git(["push", canonicalUrl, "HEAD:refs/heads/main"], {
              cwd: podDir,
              allowFailure: true,
            }),
          );
        },
      });
      if (pushed.code === 0) {
        result.pushed = true;
        const originAfter = await git(["remote", "get-url", "origin"], {
          cwd: podDir,
          allowFailure: true,
        });
        const originAfterCoordinate =
          originAfter.code === 0 ? normalizeGitHubRepoCoordinate(originAfter.stdout) : null;
        if (
          originAfterCoordinate !== null &&
          sameRepoCoordinate(originAfterCoordinate, repository)
        ) {
          const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: podDir,
            allowFailure: true,
          });
          const branchName = branch.stdout.trim();
          if (branch.code === 0 && branchName.length > 0 && !branchName.startsWith("-")) {
            await git(["config", `branch.${branchName}.remote`, "origin"], {
              cwd: podDir,
              allowFailure: true,
            });
            await git(["config", `branch.${branchName}.merge`, "refs/heads/main"], {
              cwd: podDir,
              allowFailure: true,
            });
          }
        }
      } else warnings.push(`pod push failed: ${pushed.stderr.trim().slice(0, 200)}`);
    } catch (error) {
      warnings.push(`pod push held: ${errMsg(error)}`);
      return result;
    }
  }

  return result;
}
