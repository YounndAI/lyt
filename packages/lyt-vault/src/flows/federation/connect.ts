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

// D34 (OD-LOCALFIRST, 2026-06-04) — the CONNECT self-heal.
//
// A no-gh `lyt init` produces a LOCAL pod under a PROVISIONAL handle (no gh
// repo, no remote). `lyt sync` self-heals to connect (OD-D1 — ONE verb, no
// `lyt connect`): guide gh-auth → resolve the REAL gh handle → reconcile
// provisional→real (remap federation_state PRESERVING the fed_rid, rewrite
// identity.yon source=gh, re-derive pod.yon, create the pod gh repo + wire the
// remote under the real handle) → then the caller's reconcile-publish pass does
// the outward push. OD-D2: when provisional ≠ real the real handle is
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
  // D.3-GUARD HIL — invoked when an existing remote pod collides with local
  // content. Returns true to ADOPT the remote (the default safe choice), false
  // to keep local. EITHER WAY connect does NOT blind-push (the merge is gap #5).
  // Omitted → default adopt (non-destructive: nothing is overwritten).
  confirmAdoptExistingRemote?:
    | ((info: { existingRemote: string; localHandle: string }) => Promise<boolean>)
    | undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
        message:
          "Your pod is local-only. To connect + back up to GitHub: run `gh auth login` " +
          "in another terminal, then re-run `lyt sync`.",
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
        message: `Couldn't read your GitHub handle (${errMsg(err)}). Run \`gh auth login\`, then re-run \`lyt sync\`.`,
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
      warnings.push(`existing-remote probe failed (offline/auth?): ${errMsg(err)}`);
    }
    if (remoteExists) {
      const existingRemote = federationRepoFullName(realHandle);
      const adopt = args.confirmAdoptExistingRemote
        ? await args.confirmAdoptExistingRemote({ existingRemote, localHandle: provisionalHandle })
        : true; // default: adopt the remote (non-destructive — local is preserved)
      return {
        ...base,
        status: "guard-existing-remote",
        provisionalHandle,
        realHandle,
        existingRemote,
        adoptRemoteChosen: adopt,
        message: adopt
          ? `You already have a pod on GitHub (${existingRemote}). Your local notes are preserved on disk — ` +
            `nothing was pushed or overwritten. Reconciling local notes into the existing pod is not yet automated ` +
            `(it needs the disk⇄remote merge); for now, keep working locally and the merge lane will land it safely.`
          : `Keeping your local pod as-is. An existing pod (${existingRemote}) is on GitHub but was NOT touched; ` +
            `nothing was pushed or overwritten.`,
      };
    }

    // 6. Create the pod gh repo FIRST (the GUARD above just confirmed it's
    // absent). release review fix-pass: a create FAILURE (offline/transient)
    // must NOT flip the identity to gh-cli — otherwise podNeedsConnect would
    // return false forever and the pod would be permanently "connected but
    // un-backed-up" with no retry. On failure we leave EVERYTHING provisional
    // (state + identity untouched) and return a deferred status so the next
    // `lyt sync` retries cleanly.
    const visibility = resolveConfig().defaultRepoVisibility;
    try {
      await gh.createRepo(realHandle, federationRepoName(), visibility, POD_REPO_DESCRIPTION);
    } catch (err) {
      return {
        ...base,
        status: "pod-create-deferred",
        provisionalHandle,
        realHandle,
        message:
          `Couldn't create your pod repo on GitHub yet (${errMsg(err)}). ` +
          "Nothing was changed — your pod stays local. Re-run `lyt sync` to retry.",
      };
    }
    let podRepoCreated = true;
    try {
      await gh.setRepoTopics(realHandle, federationRepoName(), POD_TOPICS);
    } catch (err) {
      warnings.push(`pod topic-set failed non-fatally: ${errMsg(err)}`);
    }

    // 7. The pod repo exists now → reconcile (OD-D2 auto-adopt the real handle).
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
      warnings.push(`identity rewrite failed non-fatally: ${errMsg(err)}`);
    }

    // (c) Re-derive pod.yon under the real handle (so @FEDERATION handle= is
    // correct before the pod is committed + pushed by the publish pass).
    await regeneratePodManifestNonFatal(db, { handle: realHandle, nowIso });

    // (d) Wire `origin` on the local pod (LOCAL git config write). Never
    // clobber an existing origin — set-url if present (a re-run after a
    // prior provisional remote), else add.
    const originUrl = `https://github.com/${realHandle}/${federationRepoName()}.git`;
    const hasOrigin = await git(["remote", "get-url", "origin"], {
      cwd: podDir,
      allowFailure: true,
    });
    if (hasOrigin.code === 0) {
      await git(["remote", "set-url", "origin", originUrl], { cwd: podDir, allowFailure: true });
    } else {
      await git(["remote", "add", "origin", originUrl], { cwd: podDir, allowFailure: true });
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
