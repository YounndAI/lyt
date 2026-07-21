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

import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import {
  listFederationStates,
  readFederationState,
  remapFederationHandle,
} from "../../registry/federation-state.js";
import { POD_REPO_DESCRIPTION, POD_TOPICS } from "../../scaffold/github-defaults.js";
import { resolveConfig } from "../../util/config.js";
import {
  federationRepoFullName,
  federationRepoName,
  getFederationRepoDir,
} from "../../util/federation-paths.js";
import { realFederationGhClient, type FederationGhClient } from "../../util/gh-federation.js";
import { resolveRemoteUrl } from "../../util/remote-url.js";
import {
  runGit as defaultRunGit,
  type GitRunOptions,
  type GitRunResult,
} from "../../util/git-run.js";
import { isValidGhHandle, realIdentityRunner, type IdentityRunner } from "../../util/identity.js";
import {
  IDENTITY_SOURCE_GH,
  isProvisionalIdentity,
  readIdentityCache,
  readPodIdentity,
  writeIdentityCache,
  writePodIdentity,
  type CachedIdentity,
} from "../../util/identity-cache.js";
import { regeneratePodManifestNonFatal } from "./regenerate.js";
import {
  withFreshPublicationPermission,
  type CanonicalVaultPublicationAttemptContext,
} from "./publication-authority.js";
import {
  observePublicationPermission,
  type PublicationPermissionObserver,
} from "./publication-permission.js";

// (2026-06-04) — the CONNECT self-heal.
//
// A no-gh `lyt init` produces a LOCAL pod under a PROVISIONAL handle (no gh
// repo, no remote). `lyt sync` self-heals to connect (ONE verb, no
// `lyt connect`): guide gh-auth → resolve the REAL gh handle → reconcile
// provisional→real (remap federation_state PRESERVING the fed_rid, rewrite
// identity.yon source=gh, re-derive pod.yon, create the pod gh repo + wire the
// remote under the real handle) → then the caller's reconcile-publish pass does
// the outward push. When provisional ≠ real the real handle is
// AUTO-ADOPTED (it is authoritative) with a one-line notice — no prompt.
//
// D.3-GUARD (lean — DETECT + HIL, NOT a merge): before any outward step, probe
// for an EXISTING remote pod at `<realHandle>/lyt-pod`. A local-first pod was
// forged locally (never cloned), so an existing remote pod is a genuine
// collision. We DO NOT blind-push (no overwrite, either side); we surface the
// HIL choice. The rich bidirectional disk⇄remote merge is OUT OF SCOPE
// (init-redesign spec gap #5 / the conflict-resolution lane) — this phase only
// detects + guards + leaves a clear path.
//
// DELTA (documented in the retro): like reconcile-publish, this engine lives in
// lyt-vault (where the registry + gh + identity deps are); the lyt-mesh `lyt
// sync` command calls it (thin wiring, no logic duplication).

export type ConnectStatus =
  | "not-needed" // pod already connected (gh identity) — no-op
  | "no-pod" // no single federation_state — nothing to connect
  | "gh-unauthed" // gh not installed/authed — guidance surfaced, no change
  | "invalid-real-handle" // gh returned a handle that fails isValidGhHandle (defensive)
  | "guard-existing-remote" // existing remote pod collides with local content — HIL, no push
  // a review finding fix-pass: the pod gh-repo create failed (offline/transient) — identity
  // stays PROVISIONAL (re-connectable), nothing reconciled. `lyt sync` retries.
  | "pod-create-deferred"
  | "reconciled"; // provisional → real reconciled; ready for the publish pass

export interface ConnectPodResult {
  status: ConnectStatus;
  provisionalHandle?: string;
  realHandle?: string;
  // The pod gh repo was created under the real handle this run.
  podRepoCreated: boolean;
  // GUARD: the existing remote pod full name, when status=guard-existing-remote.
  existingRemote?: string;
  // GUARD: the handler's HIL choice (true=adopt remote / false=keep local).
  adoptRemoteChosen?: boolean;
  message: string;
  warnings: string[];
}

export type ConnectGitRunner = (
  args: readonly string[],
  opts: GitRunOptions,
) => Promise<GitRunResult>;

export interface ConnectPodArgs {
  ghClient?: FederationGhClient | undefined;
  identityRunner?: IdentityRunner | undefined;
  runGit?: ConnectGitRunner | undefined;
  registryDb?: Client | undefined; // open-once seam
  nowIso?: string | undefined;
  permissionObserver?: PublicationPermissionObserver | undefined;
  permissionAttemptId?: string | undefined;
  // D.3-GUARD HIL — invoked when an existing remote pod collides with local
  // content. Returns true to ADOPT the remote (the default safe choice), false
  // to keep local. EITHER WAY connect does NOT blind-push (the merge is gap #5).
  // Omitted → default adopt (non-destructive: nothing is overwritten).
  confirmAdoptExistingRemote?:
    | ((info: { existingRemote: string; localHandle: string }) => Promise<boolean>)
    | undefined;
}

// Resolve the pod's CURRENT identity (pod identity.yon > local cache). Used to
// decide whether connect is needed (provisional) and to carry verified_at
// forward into the reconciled record.
function readCurrentIdentity(podDir: string): CachedIdentity | null {
  return readPodIdentity(podDir) ?? readIdentityCache();
}

export async function connectPodFlow(args: ConnectPodArgs = {}): Promise<ConnectPodResult> {
  const gh = args.ghClient ?? realFederationGhClient;
  const runner = args.identityRunner ?? realIdentityRunner;
  const git = args.runGit ?? defaultRunGit;
  const nowIso = args.nowIso ?? new Date().toISOString();
  const warnings: string[] = [];
  const permissionObserver = args.permissionObserver ?? observePublicationPermission;
  const permissionAttemptId = args.permissionAttemptId ?? randomUUID();

  const base: ConnectPodResult = {
    status: "not-needed",
    podRepoCreated: false,
    message: "",
    warnings,
  };

  const ownDb = args.registryDb === undefined;
  const db = args.registryDb ?? (await openRegistry());
  try {
    // 1. Resolve the pod (single federation_state). 0 or >1 → nothing to do.
    const states = await listFederationStates(db);
    if (states.length !== 1) {
      return { ...base, status: "no-pod", message: "No single pod to connect." };
    }
    const provisionalHandle = states[0]!.handle;
    const podDir = getFederationRepoDir(provisionalHandle);

    // 2. Connect is needed only when the current identity is PROVISIONAL. An
    // already-gh identity → the pod is connected; this is a no-op (and we
    // avoid any gh call so a normal `lyt sync` on a connected pod is cheap).
    const current = readCurrentIdentity(podDir);
    if (current !== null && !isProvisionalIdentity(current)) {
      return { ...base, status: "not-needed", message: "Pod already connected to GitHub." };
    }

    // 3. Guide gh auth if needed (graceful — never an error). Mirrors the wizard
    // P4 posture: tell the handler to auth in their own terminal, then re-run.
    if (!runner.ghAuthStatus()) {
      return {
        ...base,
        status: "gh-unauthed",
        provisionalHandle,
        // firewall-C1 fix-pass — plain sign-in guidance (no raw `gh` CLI); "GitHub"
        // stays as the destination service name. Renders via printConnectHuman.
        message:
          "Your pod is saved on this machine only. To connect it and back it up online, " +
          "sign in to your GitHub account, then re-run `lyt sync`.",
      };
    }

    // 4. Resolve the REAL gh handle (authoritative). Validate before it reaches
    // any gh/git spawn (R3 — defense-in-depth; mirrors the engine guards).
    let realHandle: string;
    try {
      realHandle = runner.ghApiUser();
    } catch (err) {
      return {
        ...base,
        status: "gh-unauthed",
        provisionalHandle,
        // firewall-C1 fix-pass — drop the raw `gh` CLI + the raw error text; plain
        // sign-in guidance (the raw error stays out of the human message).
        message:
          "Lyt couldn't read your GitHub account details. Sign in to your GitHub account, then re-run `lyt sync`.",
      };
    }
    if (!isValidGhHandle(realHandle)) {
      return {
        ...base,
        status: "invalid-real-handle",
        provisionalHandle,
        realHandle,
        message: `GitHub returned an unexpected handle (${JSON.stringify(realHandle)}); refusing to connect.`,
      };
    }

    // 5. D.3-GUARD — probe for an existing remote pod. A local-first pod was
    // forged locally (never cloned), so an existing `<realHandle>/lyt-pod` is
    // a collision: the user has BOTH a local pod AND a remote pod. DO NOT
    // blind-push (the git layer would reject non-ff anyway, but surface it
    // gracefully). HIL: adopt remote (default) keeps local content safe; the
    // rich merge is deferred (gap #5).
    let remoteExists = false;
    try {
      remoteExists = await gh.repoExists(realHandle, federationRepoName());
    } catch (err) {
      // A probe failure (offline/auth) is non-fatal — treat as "no remote" and
      // let the publish pass surface any real network issue authoritatively.
      // firewall-C1 fix-pass — plain non-fatal note; the raw error text (which can
      // carry git/gh output) stays out of the human warning.
      warnings.push(
        `Lyt couldn't check whether you already have a pod online — you may be offline or signed out.`,
      );
    }
    if (remoteExists) {
      // Phase C amendment-5 — the remote repo EXISTS, but is it a GENUINE
      // populated pod (→ the two-pods rename-aside dance, surfaced as the guard)
      // or an empty / partial pre-created `lyt-pod` (→ NOT a collision; just
      // connect + push)? Probe the remote `pod.yon` WITHOUT cloning. FAIL SAFE:
      // an unprobable / unparseable remote is treated as HAVING content (guard/
      // defer), never as empty — we never let an unverified remote skip the guard.
      const remoteHasContent = await probeRemoteHasContent(gh, realHandle, warnings);
      // C-1 — even when there is NO pod.yon, a remote that ALREADY has commits (a
      // README-initialized repo) carries UNRELATED history. A local-first pod was
      // FORGED locally (its own root commit, never cloned from this remote), so
      // the caller's publish push into it would be non-ff. If we flipped identity
      // to gh BEFORE that push (as the empty-remote fall-through did), the push
      // would fail and the pod would be STRANDED — "reconciled" but unpushable,
      // and podNeedsConnect (keyed on identity) would never re-enter connect.
      // Route such a remote to the guard instead of the identity-flip. Only a
      // truly-empty pre-created repo (no pod.yon AND no commits) is safe to push
      // into and falls through to reconcile.
      const routeToGuard =
        remoteHasContent || (await probeRemoteHasUnrelatedHistory(gh, realHandle, warnings));
      if (routeToGuard) {
        const existingRemote = federationRepoFullName(realHandle);
        const adopt = args.confirmAdoptExistingRemote
          ? await args.confirmAdoptExistingRemote({
              existingRemote,
              localHandle: provisionalHandle,
            })
          : true; // default: adopt the remote (non-destructive — local is preserved)
        return {
          ...base,
          status: "guard-existing-remote",
          provisionalHandle,
          realHandle,
          existingRemote,
          adoptRemoteChosen: adopt,
          // firewall-C1 fix-pass — "uploaded" instead of the plumbing noun "pushed";
          // "GitHub" stays as the destination service name. The SYNC-COMMAND fold
          // turns this guard into the actionable 3-option menu; the message
          // here is the pure-detector fallback (non-TTY / no menu).
          message: adopt
            ? `You already have a pod on GitHub (${existingRemote}). Your local notes are safe on this machine — ` +
              `nothing was uploaded or overwritten. Combining your local notes into the existing pod isn't automated ` +
              `yet; for now, keep working locally and Lyt will bring them together safely later.`
            : `Keeping your local pod as-is. An existing pod (${existingRemote}) is on GitHub but was NOT touched; ` +
              `nothing was uploaded or overwritten.`,
        };
      }
      // Truly-empty pre-created remote (no pod.yon AND no commits) → NOT a
      // two-pods collision and no unrelated history, so DON'T force the
      // rename-aside dance. Fall through: skip the `createRepo` below (the repo
      // already exists) and reconcile + wire origin so the caller's publish pass
      // pushes the local pod INTO the empty remote (a clean ff push).
    }

    // 6. Create the pod gh repo (only when it is genuinely ABSENT — the empty-
    // remote amendment-5 branch above already has a repo to push into). release
    // review fix-pass: a create FAILURE (offline/transient) must NOT flip the
    // identity to gh-cli — otherwise podNeedsConnect would return false forever
    // and the pod would be permanently "connected but un-backed-up" with no
    // retry. On failure we leave EVERYTHING provisional (state + identity
    // untouched) and return a deferred status so the next `lyt sync` retries.
    let podRepoCreated = false;
    const repository = `${realHandle}/${federationRepoName()}`;
    const target = `github:user/${realHandle}`;
    const authorized = <T>(
      capability: "repository-create" | "repository-push",
      action: (context: CanonicalVaultPublicationAttemptContext) => Promise<T>,
    ) =>
      withFreshPublicationPermission({
        capability,
        target,
        repository,
        actor: realHandle,
        attemptId: permissionAttemptId,
        policyEpoch: 0,
        permissionObserver,
        publicationSubject: { identity: `pod:${repository.toLowerCase()}`, podRoot: podDir },
        action,
      });
    if (!remoteExists) {
      const visibility = resolveConfig().defaultRepoVisibility;
      try {
        await authorized("repository-create", (attempt) =>
          attempt.runOutwardChild(() =>
            gh.createRepo(realHandle, federationRepoName(), visibility, POD_REPO_DESCRIPTION),
          ),
        );
      } catch (err) {
        return {
          ...base,
          status: "pod-create-deferred",
          provisionalHandle,
          realHandle,
          // firewall-C1 fix-pass — drop the raw error text; keep "GitHub" (service).
          message:
            "Lyt couldn't set up your pod on GitHub yet. " +
            "Nothing was changed — your pod stays on this machine. Re-run `lyt sync` to retry.",
        };
      }
      podRepoCreated = true;
      try {
        await authorized("repository-push", (attempt) =>
          attempt.runOutwardChild(() =>
            gh.setRepoTopics(realHandle, federationRepoName(), POD_TOPICS),
          ),
        );
      } catch (err) {
        warnings.push(
          `Your pod is set up online, but Lyt couldn't finish labeling it (this is harmless).`,
        );
      }
    }

    // 7. The pod repo exists now → reconcile (auto-adopt the real handle).
    // Identity flips to gh-cli ONLY at this point, so a deferred create above
    // keeps the pod re-connectable.
    // (a) Remap federation_state PRESERVING the fed_rid (no rid churn). Atomic.
    await remapFederationHandle(db, provisionalHandle, realHandle, nowIso);

    // (b) Rewrite identity (local cache + pod) as gh-verified. verified_at is
    // NOW (gh was just queried this run), not the provisional-mint time.
    const reconciledIdentity: CachedIdentity = {
      provider: "github",
      handle: realHandle,
      verifiedAtMs: Date.parse(nowIso),
      source: IDENTITY_SOURCE_GH,
    };
    try {
      writeIdentityCache(reconciledIdentity);
      writePodIdentity(reconciledIdentity, podDir);
    } catch (err) {
      warnings.push(`Lyt couldn't finish updating your pod's author details (this is harmless).`);
    }

    // (c) Re-derive pod.yon under the real handle (so @FEDERATION handle= is
    // correct before the pod is committed + pushed by the publish pass).
    await regeneratePodManifestNonFatal(db, { handle: realHandle, nowIso });

    // (d) Wire `origin` on the local pod (LOCAL git config write). Never
    // clobber an existing origin — set-url if present (a re-run after a
    // prior provisional remote), else add.
    const originUrl = resolveRemoteUrl(realHandle, federationRepoName());
    const hasOrigin = await git(["remote", "get-url", "origin"], {
      cwd: podDir,
      allowFailure: true,
    });
    if (hasOrigin.code === 0) {
      await authorized("repository-push", () =>
        git(["remote", "set-url", "origin", originUrl], { cwd: podDir, allowFailure: true }),
      );
    } else {
      await authorized("repository-push", () =>
        git(["remote", "add", "origin", originUrl], { cwd: podDir, allowFailure: true }),
      );
    }

    const note =
      provisionalHandle === realHandle
        ? `Connected your pod to GitHub as ${realHandle}.`
        : `Connected your pod to GitHub — adopted your real handle ${realHandle} (was provisional ${provisionalHandle}).`;
    return {
      ...base,
      status: "reconciled",
      provisionalHandle,
      realHandle,
      podRepoCreated,
      message: note,
    };
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}

// Phase C amendment-5 + C-1 — does the EXISTING remote have a committed
// `pod.yon` at all? A present pod.yon (raw !== null) is a GENUINE remote pod (→
// the two-pods collision that warrants the guard), even if it declares ZERO
// vaults yet (C-1 (b) — a real-but-vault-less pod must NOT be mistaken for an
// empty repo). Reads the remote `pod.yon` WITHOUT cloning.
//
// FAIL-SAFE by construction — every uncertain outcome resolves to `true` (has
// content → guard/defer), so we NEVER let an unverified remote skip the guard
// and slide into the destructive rename-aside dance:
//  - no probe method on the client → assume content.
//  - probe throws (auth / network / 5xx) → assume content.
// The ONLY `false` (empty/partial → eligible to just push, subject to the
// caller's unrelated-history check): the remote has NO pod.yon (404 → null).
async function probeRemoteHasContent(
  gh: FederationGhClient,
  realHandle: string,
  warnings: string[],
): Promise<boolean> {
  if (gh.fetchRemotePodManifest === undefined) return true;
  let raw: string | null;
  try {
    raw = await gh.fetchRemotePodManifest(realHandle, federationRepoName());
  } catch {
    warnings.push(
      `Lyt couldn't fully check your existing online pod — treating it as active to keep your notes safe.`,
    );
    return true;
  }
  // C-1 (b) — a COMMITTED pod.yon (raw !== null) is a REAL remote pod, even if it
  // declares ZERO vaults yet. Keying "has content" on `doc.vaults.length > 0`
  // wrongly routed a real-but-vault-less remote to the empty-push reconcile
  // (identity-flip-then-strand). Key on presence instead: any pod.yon → guard;
  // only its genuine ABSENCE (404 → null) is the empty / partial pre-created repo
  // that may reconcile (subject to the unrelated-history check in the caller).
  return raw !== null;
}

// Phase C (C-1) — does the remote repo carry UNRELATED history (≥1 commit) that
// would make the caller's publish push non-ff? Used only on the "remote exists,
// no pod.yon" fall-through to tell a truly-empty pre-created repo (safe to push
// into) from a README-initialized one (unrelated history → guard). FAIL-SAFE: a
// throwing probe resolves to `true` (→ guard), never the identity-flip path. An
// ABSENT method (alternate/older client) → `false` (assume empty), preserving
// the legitimate empty-pre-created-repo reconcile for clients without the probe;
// the real gh client always implements it, so production gets the full guard.
async function probeRemoteHasUnrelatedHistory(
  gh: FederationGhClient,
  realHandle: string,
  warnings: string[],
): Promise<boolean> {
  if (gh.remoteHasCommits === undefined) return false;
  try {
    return await gh.remoteHasCommits(realHandle, federationRepoName());
  } catch {
    warnings.push(
      `Lyt couldn't fully check your existing online repo — treating it as active to keep your notes safe.`,
    );
    return true;
  }
}

// Helper for the sync command: does the local pod need connecting? Cheap
// (identity-cache read; no gh call) so `lyt sync` can decide whether to run the
// connect self-heal before the publish pass. True when a single pod exists AND
// its identity is provisional.
export async function podNeedsConnect(registryDb?: Client): Promise<boolean> {
  const ownDb = registryDb === undefined;
  const db = registryDb ?? (await openRegistry());
  try {
    const states = await listFederationStates(db);
    if (states.length !== 1) return false;
    const podDir = getFederationRepoDir(states[0]!.handle);
    const current = readCurrentIdentity(podDir);
    // No identity at all on a forged pod is treated as needs-connect (a fresh
    // local pod that somehow lost its identity.yon); an explicit gh identity is
    // connected.
    if (current === null) return (await readFederationState(db, states[0]!.handle)) !== null;
    return isProvisionalIdentity(current);
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}
