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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { readFederationState, upsertFederationState } from "../../registry/federation-state.js";
import {
  federationRepoFullName,
  federationRepoName,
  getFederationRepoDir,
  getFederationRoot,
  getFederationYonPath,
} from "../../util/federation-paths.js";
import {
  realFederationGhClient,
  type FederationGhClient,
  type FederationRepoVisibility,
} from "../../util/gh-federation.js";
import { recordInitFailure } from "../../util/failure-log.js";
import { getHandleFromIdentity, isValidGhHandle } from "../../util/identity.js";
import {
  migrateIdentityCache,
  readIdentityCache,
  readPodIdentity,
  resolvePodIdentity,
  writeIdentityCache,
  writePodIdentity,
  type CachedIdentity,
} from "../../util/identity-cache.js";
import { POD_REPO_DESCRIPTION, POD_TOPICS } from "../../scaffold/github-defaults.js";
import { hexToUuid7Bytes, newUuidv7Bytes, uuid7BytesToHex } from "../../util/uuid7.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import { renderFederationYon } from "../../yon/federation-write.js";

// `lyt federation init` — provisions or adopts {handle}/lyt-pod (D26 repo
// name; CLI verb-group + internal "federation" term unchanged per Option B).
//
// Branches (per plan §3 first verb):
// A. Fresh — no remote, no local cache → create remote, init local,
// scaffold pod.yon, commit + (optionally) push.
// B. Adopt — remote pre-exists, no local cache → clone, register
// federation_state row (idempotent across machines).
// C. Cached — local cache present + federation_state row → noop except
// stamp last_synced_at; fed.yon NOT rewritten.
//
// Default visibility: `--private` per DQ-7a-extended (Alex 2026-05-29).
// `--public` is explicit opt-in.
//
// Network gating: `pushToRemote` defaults to true (matches handler intent
// "publish my federation repo"). Set to false in tests + when handler wants
// local-only state until they're ready. Brief says local commits OK; remote
// push gated on Alex confirmation for the CODE repo — federation pushes are
// the handler's own GH content so happen freely once they invoke the verb.

export type FederationInitBranch = "fresh" | "adopted" | "cached";

export interface FederationInitOptions {
  handle?: string | undefined; // overrides identity lookup when set
  visibility?: FederationRepoVisibility | undefined; // default "private"
  pushToRemote?: boolean | undefined; // default true (false in tests)
  createRemoteIfMissing?: boolean | undefined; // default true
  // D34 (OD-LOCALFIRST, 2026-06-04) — LOCAL-ONLY pod forge: a no-gh `lyt init`
  // (or the local-only choice). Skips the `gh api` remote probe entirely (which
  // would throw ENOENT with no gh on PATH) AND skips remote-create + remote-add:
  // the pod is a real git repo with the provisional handle but NO `origin`.
  // Connect (`lyt sync` self-heal) creates the gh repo + wires the remote under
  // the REAL handle. federation_state + pod.yon + identity.yon are still written
  // (the registry knows the pod), so connect can find + reconcile it.
  localOnly?: boolean | undefined;
  description?: string | undefined;
  // Injectable seams (tests pass fakes; real CLI uses defaults).
  ghClient?: FederationGhClient | undefined;
  identityProvider?: (() => string) | undefined;
  now?: (() => Date) | undefined;
  // v1.A.1 fold (DO NOT SKIP #4): open-once registry seam. When provided,
  // the flow uses the caller's already-open libSQL client instead of
  // opening/closing its own. Saves the close-wait on Windows (~200ms) when
  // a parent self-heal probe already has a handle. Caller owns close().
  db?: Client | undefined;
}

export interface FederationInitResult {
  handle: string;
  fedRidHex: string;
  branch: FederationInitBranch;
  visibility: FederationRepoVisibility;
  localPath: string;
  federationYonPath: string;
  remoteFullName: string;
  remoteCreated: boolean;
  pushed: boolean;
  statusVoice: string; // the "Forging Your Pod…" message emitted
}

export async function federationInitFlow(
  opts: FederationInitOptions = {},
): Promise<FederationInitResult> {
  const ghClient = opts.ghClient ?? realFederationGhClient;
  const identityProvider = opts.identityProvider ?? defaultIdentityProvider;
  const visibility: FederationRepoVisibility = opts.visibility ?? "private";
  const localOnly = opts.localOnly ?? false;
  // localOnly never pushes (no remote exists) regardless of the push flag.
  const push = localOnly ? false : (opts.pushToRemote ?? true);
  const createRemote = opts.createRemoteIfMissing ?? true;
  const now = opts.now ?? (() => new Date());

  // Brief F (P4) — migrate a legacy `~/lyt/identity.yon` machine cache to
  // `~/lyt/machine.yon` BEFORE resolvePodIdentity reads it (so the resolver
  // sees the migrated cache, not a stale legacy file). Idempotent + safe (the
  // cache is re-derivable); no-op when there is nothing to migrate.
  migrateIdentityCache();

  // Brief B (a review finding) — route handle resolution through resolvePodIdentity so the
  // precedence pod > local > gh is HONORED at a real production call site (the
  // init-redesign retro flagged resolvePodIdentity as having zero call sites).
  // The pod dir is flat + handle-independent (getFederationRoot), so it can be
  // probed before the handle is known. On a re-run where the pod already carries
  // identity.yon, the pod handle wins (two machines with divergent local caches
  // converge on the pod's handle); on first fresh run the pod is absent → falls
  // through local cache → gh-derive, identical to the prior behavior.
  let handle = opts.handle;
  if (handle === undefined || handle.length === 0) {
    const resolved = resolvePodIdentity({
      podRepoDir: getFederationRoot(),
      deriveHandle: identityProvider,
    });
    handle = resolved?.handle ?? identityProvider();
  }
  if (handle.length === 0) {
    throw new Error("Could not resolve a GitHub handle for federation init.");
  }
  // release review fix-pass (D34) — defense-in-depth: refuse an invalid handle
  // BEFORE it reaches `git config user.name <handle>` / `git remote add
  // https://github.com/<handle>/…` / `gh repo create`. identity.yon is a
  // hand-editable recovery SoT (source=local|provisional), so a poisoned handle
  // could otherwise reach a spawn. Mirrors the guards in vault-publish.ts,
  // recover-pod.ts, connect.ts, and the wizard probe. (getFederationRepoDir
  // slugifies the PATH safely, but the spawn argv uses the raw handle.)
  if (!isValidGhHandle(handle)) {
    throw new Error(
      `federation init: refusing to forge a pod under an invalid GitHub handle ${JSON.stringify(handle)}.`,
    );
  }

  const localDir = getFederationRepoDir(handle);
  const fedYonPath = getFederationYonPath(handle);
  const remoteFullName = federationRepoFullName(handle);

  // v1.A.1 fold (DO NOT SKIP #4): if the caller already has the registry
  // open (e.g. flows/init.ts self-heal probe), reuse it. Otherwise open
  // our own and close in finally. `ownDb=true` flags ownership for the
  // close-in-finally semantics.
  const ownDb = opts.db === undefined;
  const db = opts.db ?? (await openRegistry());
  try {
    const existingState = await readFederationState(db, handle);
    const localExists = existsSync(localDir);

    // Branch C — cached: nothing to do beyond a freshness stamp.
    // Release review Angle A: read the authoritative visibility back from
    // pod.yon. The flow's `visibility` local defaults to "private"
    // when the caller omits the flag; using it in the cached return value
    // would mis-report a federation that was forged with --public on a
    // prior run. Fall through to flow-default only if the cache file is
    // unparseable.
    if (existingState !== null && localExists) {
      let cachedVisibility: FederationRepoVisibility = visibility;
      if (existsSync(fedYonPath)) {
        try {
          cachedVisibility = parseFederationYon(readFileSync(fedYonPath, "utf8")).federation
            .visibility;
        } catch {
          // Unparseable pod.yon — surface what the caller asked for
          // (or the flow default). A rebuild verb will heal it cleanly.
        }
      }
      // Brief B (R5) — self-heal: a pod forged before identity write-back
      // existed reaches this cached branch on every re-init, so heal the missing
      // identity.yon here. Disk-present is what B.1's exit asserts; the next sync
      // commits it.
      ensurePodIdentityWriteback(localDir, handle, now().getTime());
      const stamped = await upsertFederationState(db, {
        handle,
        fedRidBytes: existingState.fedRidBytes,
        lastSyncedAt: now().toISOString(),
      });
      return {
        handle,
        fedRidHex: stamped.fedRidHex,
        branch: "cached",
        visibility: cachedVisibility,
        localPath: localDir,
        federationYonPath: fedYonPath,
        remoteFullName,
        remoteCreated: false,
        pushed: false,
        statusVoice: "",
      };
    }

    let branch: FederationInitBranch;
    let remoteCreated = false;

    if (localOnly) {
      // D34 (OD-LOCALFIRST) — no gh: never probe or create the remote (a `gh api`
      // probe throws ENOENT with no gh on PATH). The pod is a fresh LOCAL git
      // repo with the provisional handle; initLocalNoRemote wires NO `origin`
      // (the remote is created + set at connect under the real handle).
      branch = "fresh";
      if (!localExists) {
        mkdirSync(dirname(localDir), { recursive: true });
        await ghClient.initLocalNoRemote(handle, localDir);
      }
    } else {
      // Probe remote — drives Branch A (fresh) vs Branch B (adopt).
      const remoteExists = await ghClient.repoExists(handle, federationRepoName());

      if (!remoteExists) {
        if (!createRemote) {
          throw new Error(
            `federation init: remote ${remoteFullName} does not exist and createRemoteIfMissing=false.`,
          );
        }
        // D26: pod-repo description locked to the exact handler string; topics
        // applied in a follow-up `gh repo edit --add-topic` (gh repo create
        // cannot set topics). Topic failure is non-fatal — the repo exists and
        // federation_state is still written below.
        const description = opts.description ?? POD_REPO_DESCRIPTION;
        await ghClient.createRepo(handle, federationRepoName(), visibility, description);
        remoteCreated = true;
        branch = "fresh";
        try {
          await ghClient.setRepoTopics(handle, federationRepoName(), POD_TOPICS);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`federation init: setting pod-repo topics failed non-fatally — ${msg}`);
        }
      } else {
        branch = "adopted";
      }

      // Materialise locally if missing.
      if (!localExists) {
        mkdirSync(dirname(localDir), { recursive: true });
        if (branch === "fresh") {
          await ghClient.initLocalFromFresh(handle, federationRepoName(), localDir);
        } else {
          await ghClient.cloneExisting(handle, federationRepoName(), localDir);
        }
      }
    }

    // Generate (or preserve) the federation rid. Stable per global UUIDv7
    // directive — once written, never changes.
    //
    // BRIEF E / OD-E3 — on a WIPED-machine adopt the local registry has no
    // federation_state row, so the `?? newUuidv7Bytes()` fallback would mint a
    // NEW fedRid even though the just-cloned pod.yon carries the pod's ORIGINAL
    // one — the "silently fork the pod identity" failure that remapFederationHandle
    // (the connect flow) already guards against, here on the adopt-from-wipe path
    // it never covered. Recover the fedRid from the cloned manifest first; mint
    // only for a genuinely fresh pod (no manifest to recover from). Fires only on
    // the adopt branch with no local row — a fresh pod still mints.
    let fedRidBytes = existingState?.fedRidBytes;
    if (fedRidBytes === undefined && branch === "adopted" && existsSync(fedYonPath)) {
      try {
        fedRidBytes = hexToUuid7Bytes(
          parseFederationYon(readFileSync(fedYonPath, "utf8")).federation.fedRidHex,
        );
      } catch {
        // Unparseable / ridless cloned manifest — fall through to a fresh mint.
      }
    }
    fedRidBytes ??= newUuidv7Bytes();
    const fedRidHex = uuid7BytesToHex(fedRidBytes);

    const createdAt = now().toISOString();
    // D31: init writes a SKELETON manifest (empty meshes/vaults) to BOOTSTRAP the
    // file on a FRESH / local forge; the lifecycle regen hook (regenerate.ts,
    // called at the end of init/adopt AFTER the vault + mesh rows land in the
    // registry) populates it. Done this way because init sequencing forges the
    // pod BEFORE the first vault is registered.
    //
    // BRIEF E (the "lost-your-laptop" fix) — on ADOPT the pod was just CLONED and
    // its pod.yon is the user's OWN authoritative manifest, carrying the
    // @FED_VAULT records that adoptAndPrimeFlow's recovery loop
    // (recoverVaultsFromPodManifest) reads to clone + re-register every vault with
    // its ORIGINAL rid. Overwriting it with an empty skeleton HERE is the bug:
    // recovery then reads 0 vaults and scaffolds an empty personal/main, stranding
    // the real vaults on the remote while reporting "ready". So PRESERVE an
    // existing cloned manifest on the adopt branch; only bootstrap-write when there
    // is genuinely no manifest to preserve (fresh / local forge, or an adopted pod
    // whose remote lacked one). The end-of-flow regen re-derives pod.yon from the
    // registry once the recovered vaults are registered, so the derived-manifest
    // invariant (Brief A) still holds on every branch.
    const podYonAlreadyCloned = branch === "adopted" && existsSync(fedYonPath);
    if (!podYonAlreadyCloned) {
      const yon = renderFederationYon({
        federation: {
          fedRidHex,
          handle,
          visibility,
          createdAt,
        },
        meshes: [],
        vaults: [],
        lastSyncedAt: createdAt,
      });
      mkdirSync(dirname(fedYonPath), { recursive: true });
      writeFileSync(fedYonPath, yon, "utf8");
    }

    // W2.3 (OD-3) — persist / recover identity through the pod repo (the
    // durable recovery SoT). On a freshly FORGED pod, write the machine's
    // identity into the repo (`identity.yon`, committed alongside
    // pod.yon) so a future clone can recover it. On ADOPT (clone),
    // recover identity from the pod IFF the local cache is missing — a machine
    // with an existing local identity is RESPECTED, not overwritten (precedence
    // pod > local > gh; "existing identity respected" per the spec). Non-fatal:
    // identity persistence never aborts federation init.
    try {
      if (branch === "adopted") {
        // Recover identity FROM the pod when local is absent (precedence pod >
        // local > gh; an existing local identity is RESPECTED, not overwritten).
        const podIdentity = readPodIdentity(localDir);
        if (podIdentity !== null && readIdentityCache() === null) {
          writeIdentityCache(podIdentity);
        }
      }
      // Brief B (R5) — on BOTH fresh and adopt, ensure the pod carries
      // identity.yon (write if missing). On fresh this is the initial write;
      // on adopt it heals a pod that was cloned without one. This commit
      // (below) then captures it.
      ensurePodIdentityWriteback(localDir, handle, now().getTime());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`federation init: identity persistence failed non-fatally — ${msg}`);
    }

    // Commit + optionally push. `--allow-empty` on the gh client handles
    // re-runs (idempotent), but on fresh init this commit will have content.
    // D26: repo-name segment routes through remoteFullName (lyt-pod) — the
    // CLI verb-group stays `federation` (Option B: internal term untouched).
    const commitMessage = localOnly
      ? `chore(federation): forge ${remoteFullName} (local-only — connect with \`lyt sync\`)`
      : remoteCreated
        ? `chore(federation): forge ${remoteFullName}`
        : `chore(federation): refresh ${remoteFullName}`;
    let pushed = false;
    try {
      await ghClient.commitAndOptionallyPush(localDir, commitMessage, push);
      pushed = push;
    } catch (err) {
      // Don't swallow — the handler needs to know push failed. But preserve
      // the local-state write (federation_state row written below) so
      // subsequent re-runs can recover.
      const msg = err instanceof Error ? err.message : String(err);
      recordInitFailure({
        site: "network-probe",
        step: "federation:init:commitAndOptionallyPush",
        summary: `federation init commit/push failed: ${msg}`,
        context: { handle, remote: remoteFullName, branch, pushAttempted: String(push) },
      });
      // eslint-disable-next-line no-console
      console.error(`federation init: commit/push failed — ${msg}`);
    }

    await upsertFederationState(db, {
      handle,
      fedRidBytes,
      lastSyncedAt: createdAt,
    });

    return {
      handle,
      fedRidHex,
      branch,
      visibility,
      localPath: localDir,
      federationYonPath: fedYonPath,
      remoteFullName,
      remoteCreated,
      pushed,
      statusVoice: "", // command layer emits the voice; flow returns silent
    };
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}

function defaultIdentityProvider(): string {
  return getHandleFromIdentity();
}

// Brief B (R5) — ensure the pod repo carries `identity.yon` (the durable
// recovery SoT). Idempotent + self-healing: writes it whenever absent,
// regardless of init branch, so a pod forged before the write-back existed (the
// live dogfood: `~/lyt/pod/identity.yon` missing) — or via a path that skipped
// it — is healed on the next init. Prefers the existing local cache (so the
// handle/verified_at are real) and falls back to a synthesized pod-writeback
// record. Never aborts init (non-fatal).
//
// Brief F (P3) — when the pod identity ALREADY exists, this used to return
// early, which is the drift SOURCE: the machine cache re-stamps `verified_at`
// on every gh-derive while the pod copy stays frozen at its first write, so the
// two lag forever even though the handle is identical (the §7 finding). Now,
// when the existing pod handle EQUALS the resolved handle, re-stamp the pod copy
// to the machine cache's fresher `verified_at` so it stops lagging — killing the
// drift at its source. A pod handle that DIFFERS is a genuine conflict (two
// machines / a handle change) — left for `lyt doctor [--apply]` to reconcile;
// the self-heal never silently overwrites a divergent handle.
function ensurePodIdentityWriteback(podDir: string, handle: string, nowMs: number): void {
  try {
    const existing = readPodIdentity(podDir);
    if (existing !== null) {
      // Re-stamp ONLY when the handle matches the resolved one (drift is purely
      // cosmetic verified_at lag); never touch a divergent-handle pod here.
      if (existing.handle === handle) {
        const local = readIdentityCache();
        const fresher = Math.max(existing.verifiedAtMs, local?.verifiedAtMs ?? 0);
        if (fresher > existing.verifiedAtMs) {
          writePodIdentity({ ...existing, verifiedAtMs: fresher }, podDir);
        }
      }
      return;
    }
    const local = readIdentityCache();
    const identity: CachedIdentity = local ?? {
      provider: "github",
      handle,
      verifiedAtMs: nowMs,
      source: "pod-writeback",
    };
    writePodIdentity(identity, podDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`federation init: pod identity write-back failed non-fatally — ${msg}`);
  }
}
