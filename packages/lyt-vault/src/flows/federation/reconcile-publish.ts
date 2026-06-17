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

import { existsSync, readFileSync } from "node:fs";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../../registry/client.js";
import { listFederationStates, readFederationState } from "../../registry/federation-state.js";
import { listVaults, type VaultRow } from "../../registry/repo.js";
import { deriveWriteGate, hasSubscriptionSignal } from "../writability.js";
import type { GhExecutor } from "../../util/gh-discover.js";
import { resolveConfig } from "../../util/config.js";
import {
  getFederationRepoDir,
  getFederationYonPath,
  vaultRepoName,
} from "../../util/federation-paths.js";
import {
  realFederationGhClient,
  type FederationGhClient,
  type FederationRepoVisibility,
} from "../../util/gh-federation.js";
import { runGit as defaultRunGit } from "../../util/git-run.js";
import { isPermissionDeniedPush } from "../../util/push-classify.js";
import { isValidGhHandle } from "../../util/identity.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import { regeneratePodManifestNonFatal } from "./regenerate.js";
import {
  closeOutbox,
  countOutbox,
  enqueueOutbox,
  listOutbox,
  markOutboxDone,
  markOutboxFailed,
  openOutbox,
} from "./outbox.js";
import { commitPodRepo, materializeVaultPublishable, type GitRunner } from "./vault-publish.js";

// Brief B (B.2) — the ONE reconcile/publish engine.
//
// regen pod.yon → enqueue every outward op in the outbox → DRAIN: for each
// vault create-the-repo-if-missing + pull-rebase-if-behind + push; then commit
// + push the pod repo. Each op is removed from the outbox only on success, so
// a mid-sync interruption leaves a resumable outbox (NOT a half-publish), and a
// re-run completes it. Init (B.1, push held) and this engine (push) share the
// same per-vault + pod-commit atoms (vault-publish.ts), so they can never
// diverge.
//
// DELTA (documented in retro): the brief says "extend sync.ts" (lyt-mesh). The
// engine lives in lyt-vault — where its dependencies are (registry, materialize
// atoms, regen, outbox) — and the lyt-mesh `lyt sync` command is extended to
// call it (a thin command-layer wiring, no logic duplication).

export type VaultPublishStatus =
  | "published"
  | "pulled-then-published"
  | "conflict"
  | "failed"
  | "skipped";

export interface VaultPublishOutcome {
  vaultName: string;
  repoName: string;
  status: VaultPublishStatus;
  repoCreated: boolean;
  pushed: boolean;
  message: string;
  // hardening pass (Cohort-1 fix-pass) — true when the failure is TERMINAL (a re-run can
  // never succeed): a permission-denied push. The drain loop marks a terminal
  // failure's outbox item DONE (not failed-and-retained) so it never counts
  // toward `outboxRemaining` → the "re-run to finish (resumable)" message does
  // NOT fire for an op that can never complete. Absent/false → the legacy
  // resumable-retry posture (transient: network blip, rebase-needed, etc.).
  terminal?: boolean;
}

// hardening pass / C1 — the permission-denied TERMINAL classifier now lives in ONE place
// (util/push-classify.ts), imported above. A terminal failure (genuine
// permission/auth co-signal) will fail identically on every re-run, so it must
// not be advertised as resumable, and its raw `fatal: unable to access …`
// stderr must not leak — the user gets one actionable line. A bare 403
// (secondary rate-limit) or a bare SSH "access rights" connection failure is
// NON-terminal (retry-safe) — the prior over-match permanently dropped those
// retryable ops from the capless outbox.

export interface ReconcilePublishArgs {
  handle?: string | undefined;
  // Outbound publish. Default true (this is the publish engine). false is a
  // dry/local pass that materializes locally without outward effects.
  push?: boolean | undefined;
  // gh repo create-if-missing. Defaults to the push value (publish creates).
  createRemoteIfMissing?: boolean | undefined;
  // pull-rebase before push (bidirectional). Default true. On a conflict
  // the rebase is ABORTED (no data overwrite) and the vault is reported
  // `conflict` (surface-and-halt) — the locked posture.
  pull?: boolean | undefined;
  ghClient?: FederationGhClient | undefined;
  runGit?: GitRunner | undefined;
  registryDb?: Client | undefined; // open-once seam
  outboxPath?: string | undefined; // test seam
  nowIso?: string | undefined;
  // 0.9.3 — injectable gh executor for the read-only publish-exclude
  // verdict (deriveWriteGate). Distinct from `ghClient` (the federation gh used
  // for repo create/push); this is the writability probe's executor. Defaults
  // to the real `gh` CLI; tests inject a fake to exercise the foreign-mesh
  // subscription exclusion deterministically.
  writabilityGh?: GhExecutor | undefined;
}

export interface ReconcilePublishResult {
  skipped: boolean;
  reason?: string;
  handle?: string;
  vaultOutcomes: VaultPublishOutcome[];
  podCommitted: boolean;
  podPushed: boolean;
  // >0 means the outbox still holds undrained/failed ops — the round-trip is
  // RESUMABLE: re-run `lyt sync` to finish. 0 == fully published.
  outboxRemaining: number;
  warnings: string[];
  // true when the outbox fully drained AND no vault hit a conflict.
  ok: boolean;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function reconcilePublishFlow(
  args: ReconcilePublishArgs = {},
): Promise<ReconcilePublishResult> {
  const push = args.push ?? true;
  const createRemote = args.createRemoteIfMissing ?? push;
  const pull = args.pull ?? true;
  const gh = args.ghClient ?? realFederationGhClient;
  const git = args.runGit ?? defaultRunGit;
  const nowIso = args.nowIso ?? new Date().toISOString();
  const defaultVisibility = resolveConfig().defaultRepoVisibility;
  const warnings: string[] = [];

  const empty: ReconcilePublishResult = {
    skipped: true,
    vaultOutcomes: [],
    podCommitted: false,
    podPushed: false,
    outboxRemaining: 0,
    warnings,
    ok: true,
  };

  const ownDb = args.registryDb === undefined;
  const db = args.registryDb ?? (await openRegistry());
  try {
    // Resolve the pod handle from the registry (no gh call on the common path).
    let handle = args.handle;
    if (handle === undefined || handle.length === 0) {
      const states = await listFederationStates(db);
      if (states.length !== 1) return { ...empty, reason: "no-single-pod" };
      handle = states[0]!.handle;
    }
    if ((await readFederationState(db, handle)) === null) {
      return { ...empty, reason: "no-federation-state" };
    }

    // release review / a review finding — refuse the whole outward round-trip if the
    // resolved handle isn't a valid GitHub username (a poisoned cloned-pod
    // identity.yon could seed one). Defense-in-depth at the engine entry, above
    // the per-vault atom guard.
    if (push && !isValidGhHandle(handle)) {
      return { ...empty, reason: "invalid-handle" };
    }

    // Regenerate pod.yon from the registry so the manifest reflects the actual
    // pod before we commit + push it.
    await regeneratePodManifestNonFatal(db, { handle, nowIso });

    // 0.9.3 — EXCLUDE read-only subscriptions from the publish
    // work-set, keyed on the LIVE writability verdict (deriveWriteGate), not the
    // static role. The pre-fix engine enqueued a `publish-vault` op for EVERY
    // non-tombstoned vault, push-attempted a subscribed vault the user can't
    // push to, the push failed → `outboxRemaining > 0` → "N publish op(s)
    // pending … resumable" on EVERY run, a permanent jam. The prior fix
    // keyed on `isPureSubscriberVault`, which a subscribe-to-a-foreign-mesh vault
    // does NOT satisfy (it gets a local `home` role), so the cohort's
    // younndai/lyt-docs was NOT excluded and the jam persisted. Now an
    // OWN vault (no subscription signal) is always included with NO gh probe; a
    // subscription is excluded unless its live verdict is writable:true (a
    // granted-write subscription stays publishable — brief §1). We never enqueue
    // an op for an excluded vault, so it can never jam the outbox.
    const allActive = (await listVaults(db)).filter((v) => v.status !== "tombstoned");
    const vaults: VaultRow[] = [];
    // Track the names EXCLUDED as read-only so a persisted
    // `publish-vault:<subscriber>` outbox row (seeded by a pre-fix run) resolves
    // to a correct warning ("now a read-only subscriber") instead of the
    // misleading "unregistered vault" — the vault IS registered, just no longer
    // in the publish work-set. This is the hardening pass drain path for already-stuck ops.
    const excludedSubscribers = new Set<string>();
    // 0.9.4 (dup-repo guard) — a vault carrying a subscription signal is FOREIGN:
    // it was cloned from another pod (its `origin` points at the upstream owner).
    // A granted-write subscription (S6 cross-identity write) is NOT blocked by
    // deriveWriteGate (its live verdict is writable:true) so it STAYS in the
    // publish work-set to push content back to its REAL origin — but it must
    // NEVER get a `gh repo create` under the SUBSCRIBER's own handle. The pre-fix
    // engine called publishOneVault with the pod-wide `createRemote=true` for
    // every work-set vault → materialize created a brand-new
    // `{subscriber-handle}/lyt-vault-…` duplicate of the foreign repo (the live
    // repro: a subscriber handle materializing duplicates of the upstream owner's
    // lyt-vault repos). Track the subscription signal here so the drain loop can
    // force createRemote=false for these vaults — repo-create set = HOME vaults
    // ONLY (the locked fix). Push still targets the existing `origin`, so a
    // granted-write subscription's content sync is unaffected.
    const foreignVaultNames = new Set<string>();
    for (const v of allActive) {
      const gate = await deriveWriteGate(
        v,
        db,
        args.writabilityGh !== undefined ? { gh: args.writabilityGh } : {},
      );
      if (gate.blocked) {
        warnings.push(`skipped read-only subscribed vault '${v.name}' (pull-only; no push)`);
        excludedSubscribers.add(v.name);
        continue;
      }
      // Not blocked, but if it's a subscription (a granted-write one), it's still
      // foreign — exclude it from repo-create even though it stays in the work-set.
      if (await hasSubscriptionSignal(db, v.rid)) {
        foreignVaultNames.add(v.name);
      }
      vaults.push(v);
    }
    const vaultByName = new Map<string, VaultRow>(vaults.map((v) => [v.name, v]));
    const podDir = getFederationRepoDir(handle);

    // release review — the per-vault visibility lives in pod.yon (the
    // registry has no visibility column). Read the JUST-regenerated manifest so
    // the gh-repo-create for a consciously-public vault actually creates it
    // public, instead of the pod-wide config default. Falls back to the default
    // for any vault absent from the manifest.
    const visByName = new Map<string, FederationRepoVisibility>();
    try {
      const podYonPath = getFederationYonPath(handle);
      if (existsSync(podYonPath)) {
        for (const v of parseFederationYon(readFileSync(podYonPath, "utf8")).vaults) {
          visByName.set(v.vaultName, v.visibility);
        }
      }
    } catch {
      // Unparseable manifest → every vault falls back to the default below.
    }

    const outbox = await openOutbox(
      args.outboxPath !== undefined ? { path: args.outboxPath } : undefined,
    );
    const vaultOutcomes: VaultPublishOutcome[] = [];
    let podCommitted = false;
    let podPushed = false;

    try {
      // Enqueue the full publish work-set (idempotent — re-enqueueing an
      // in-flight item from a prior interrupted run is a no-op).
      for (const v of vaults) {
        await enqueueOutbox(outbox, "publish-vault", v.name, nowIso);
      }
      await enqueueOutbox(outbox, "publish-pod", "pod", nowIso);

      // DRAIN. Vaults first, pod last (the pod manifest references the vault
      // repos; push the vaults before advertising them in the pushed pod.yon).
      const pending = await listOutbox(outbox);
      const vaultItems = pending.filter((p) => p.op === "publish-vault");
      const podItems = pending.filter((p) => p.op === "publish-pod");

      for (const item of vaultItems) {
        const vault = vaultByName.get(item.target);
        if (vault === undefined) {
          // Stale outbox row — drop it. release review: log the drop so a
          // vanished publish is auditable, not silent.
          // Minor (Cohort-1 fix-pass release review) — distinguish the two reasons:
          // a row that resolves to a now-EXCLUDED pure subscriber is REGISTERED
          // (just read-only, no longer published), not "unregistered". Convergence
          // path: a pre-fix `publish-vault:<subscriber>` row is cleared here.
          if (excludedSubscribers.has(item.target)) {
            warnings.push(
              `cleared stale publish op for now read-only subscribed vault '${item.target}' (no longer published)`,
            );
          } else {
            warnings.push(`dropped stale outbox item for unregistered vault '${item.target}'`);
          }
          await markOutboxDone(outbox, "publish-vault", item.target);
          continue;
        }
        const outcome = await publishOneVault(vault, {
          handle,
          // dup-repo guard — never create a repo under the subscriber's handle
          // for a FOREIGN (subscribed) vault; its repo already lives under the
          // upstream owner (its `origin`). repo-create set = HOME vaults only.
          createRemote: createRemote && !foreignVaultNames.has(vault.name),
          push,
          pull,
          // release review — per-vault visibility from pod.yon (not the
          // pod-wide default), so a consciously-public vault is created public.
          visibility: visByName.get(vault.name) ?? defaultVisibility,
          gh,
          git,
        });
        vaultOutcomes.push(outcome);
        if (
          outcome.status === "published" ||
          outcome.status === "pulled-then-published" ||
          outcome.status === "skipped" ||
          // a TERMINAL failure (permission-denied push) can never
          // succeed on a re-run; clear it from the outbox so it does NOT keep
          // `outboxRemaining > 0` alive and mislabel the round-trip "resumable".
          // It still surfaces as a `failed` outcome (the user sees the
          // actionable line + the run reports not-ok), just not as a pending op.
          outcome.terminal === true
        ) {
          await markOutboxDone(outbox, "publish-vault", item.target);
          if (outcome.terminal === true) {
            warnings.push(`${item.target}: ${outcome.message}`);
          }
        } else {
          await markOutboxFailed(outbox, "publish-vault", item.target, outcome.message, nowIso);
          warnings.push(`${item.target}: ${outcome.status} — ${outcome.message}`);
        }
      }

      // release review + C2 (Cohort-1 fix-pass release review) — do NOT push the
      // pod manifest while a vault it advertises had its CONTENT PUSH FAIL this
      // run: a pushed pod.yon would point a recovering reader at a repo whose
      // content was never pushed (`materializeVaultPublishable` created the gh
      // repo with push:false, then step 3's content push failed → an EMPTY/stale
      // remote repo). Commit the pod locally (so the working tree stays clean)
      // but HOLD its push + keep the outbox item, so a later run pushes the pod
      // once the vault's content lands. This preserves the manifest↔remote
      // contract the recovery loop depends on.
      //
      // C2 FIX (release review): the prior `vaultProblem` EXCLUDED terminal
      // failures (`o.terminal !== true`), so a permission-denied vault whose
      // repo was created-but-never-content-pushed still let the pod publish —
      // advertising an EMPTY repo (exactly C1's now-non-terminal class would
      // also have hit this). A content-unpushed vault (terminal OR not) now
      // HOLDS the pod. The run already reports ok=false on a terminal failure
      // and the user has been told to act (fix access, or forget/unsubscribe the
      // vault — which drops its stale outbox row and frees the pod next run), so
      // holding the pod is the safe posture: never advertise a vault whose
      // content didn't land. A "skipped"/"published" vault never blocks the pod.
      const contentUnpushed = (o: VaultPublishOutcome): boolean =>
        o.status === "conflict" ||
        o.status === "failed" ||
        // Defensive: a non-failed outcome that created a remote repo this run
        // but never pushed its content (should not occur on the push path, but
        // if a future outcome shape leaves repoCreated && !pushed, the pod must
        // still not advertise it).
        (o.repoCreated && !o.pushed && push);
      const vaultProblem = vaultOutcomes.some(contentUnpushed);
      if (podItems.length > 0) {
        try {
          const pushPod = push && !vaultProblem;
          const podCommit = await commitPodRepo(podDir, "chore(lyt): publish pod manifest", {
            push: pushPod,
            runGit: git,
          });
          podCommitted = podCommit.committed;
          podPushed = podCommit.pushed;
          if (vaultProblem) {
            // Pod push deferred until the unpushed-content vaults publish (the
            // user resolves access / a transient clears / they forget the vault).
            await markOutboxFailed(
              outbox,
              "publish-pod",
              "pod",
              "deferred: a referenced vault's content is unpushed (conflict/failed) this run",
              nowIso,
            );
            warnings.push("pod: push deferred until all vaults publish (re-run `lyt sync`)");
          } else if (!push || podPushed) {
            // push-held (local materialize) or push-succeeded → item cleared.
            await markOutboxDone(outbox, "publish-pod", "pod");
          } else {
            const reason = podCommit.warnings.join("; ") || "pod push did not complete";
            await markOutboxFailed(outbox, "publish-pod", "pod", reason, nowIso);
            warnings.push(`pod: ${reason}`);
          }
          warnings.push(...podCommit.warnings);
        } catch (err) {
          await markOutboxFailed(outbox, "publish-pod", "pod", errMsg(err), nowIso);
          warnings.push(`pod: ${errMsg(err)}`);
        }
      }

      const outboxRemaining = await countOutbox(outbox);
      const anyConflict = vaultOutcomes.some((o) => o.status === "conflict");
      // a terminal failure is cleared from the outbox (not resumable),
      // but the run is still NOT ok: the user must act (it surfaced an
      // actionable `failed` outcome). Fold it into `ok` explicitly so a
      // terminal permission-denied doesn't read as a clean publish.
      const anyTerminalFailure = vaultOutcomes.some(
        (o) => o.status === "failed" && o.terminal === true,
      );
      return {
        skipped: false,
        handle,
        vaultOutcomes,
        podCommitted,
        podPushed,
        outboxRemaining,
        warnings,
        ok: outboxRemaining === 0 && !anyConflict && !anyTerminalFailure,
      };
    } finally {
      await closeOutbox(outbox);
    }
  } finally {
    if (ownDb) await closeRegistry(db);
  }
}

interface PublishOneVaultOpts {
  handle: string;
  createRemote: boolean;
  push: boolean;
  pull: boolean;
  visibility: ReturnType<typeof resolveConfig>["defaultRepoVisibility"];
  gh: FederationGhClient;
  git: GitRunner;
}

// Per-vault publish: ensure repo+local (create gh repo if missing, no push yet)
// → pull-rebase if behind (conflict → abort, surface-and-halt) → push.
async function publishOneVault(
  vault: VaultRow,
  opts: PublishOneVaultOpts,
): Promise<VaultPublishOutcome> {
  const repoName = vaultRepoName(vault.name);
  const base: VaultPublishOutcome = {
    vaultName: vault.name,
    repoName,
    status: "published",
    repoCreated: false,
    pushed: false,
    message: "",
  };

  // 1. Ensure git + initial commit + gh repo (if createRemote) + remote URL.
  // push:false here — the push is staged below so it can be preceded by a
  // pull-rebase.
  const mat = await materializeVaultPublishable(vault, {
    handle: opts.handle,
    createRemoteIfMissing: opts.createRemote,
    push: false,
    visibility: opts.visibility,
    ghClient: opts.gh,
    runGit: opts.git,
  });
  if (mat.skipped) {
    return { ...base, status: "skipped", message: mat.skippedReason ?? "skipped" };
  }
  base.repoCreated = mat.repoCreated;
  if (!opts.push) {
    return { ...base, status: "published", message: "local materialize (push held)" };
  }

  const cwd = vault.path;
  let pulled = false;

  // 2. pull-rebase if there is an upstream and we are behind. On a
  // conflict, ABORT (no data overwrite) and surface — the locked posture.
  if (opts.pull) {
    const hasUpstream = await opts.git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd, allowFailure: true },
    );
    if (hasUpstream.code === 0) {
      await opts.git(["fetch", "--quiet"], { cwd, allowFailure: true });
      const ab = await opts.git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
        cwd,
        allowFailure: true,
      });
      // release review — fail SAFE: an unreadable rev-list (code != 0) is
      // treated as possibly-behind (→ attempt pull-rebase) rather than
      // assume-not-behind-and-push. 's "never overwrite remote" must not be
      // defeated by a transient parse/exit error defaulting to the unsafe push.
      const behind = ab.code === 0 ? Number(ab.stdout.trim().split(/\s+/)[1] ?? 0) || 0 : 1;
      if (behind > 0) {
        const rebased = await opts.git(["pull", "--rebase", "--quiet"], {
          cwd,
          allowFailure: true,
        });
        if (rebased.code !== 0) {
          await opts.git(["rebase", "--abort"], { cwd, allowFailure: true });
          return {
            ...base,
            status: "conflict",
            message:
              "rebase conflict pulling remote changes — resolve with git, then re-run `lyt sync` (no data was overwritten)",
          };
        }
        pulled = true;
      }
    }
  }

  // 3. Push.
  const pushed = await opts.git(["push", "-u", "origin", "main"], { cwd, allowFailure: true });
  if (pushed.code === 0) {
    return {
      ...base,
      status: pulled ? "pulled-then-published" : "published",
      pushed: true,
      message: pulled ? "rebased remote changes + pushed" : "pushed",
    };
  }
  // a permission-denied push is TERMINAL: surface ONE actionable line
  // (suppress the raw `fatal: unable to access …` stderr) and flag terminal so
  // the drain loop does not retain it as a resumable outbox op.
  if (isPermissionDeniedPush(pushed.stderr)) {
    return {
      ...base,
      status: "failed",
      terminal: true,
      message:
        `push denied — you don't have push access to ${repoName}. ` +
        `If this is a vault you subscribed to, it's read-only (pull-only); capture into a home vault instead. ` +
        `If it's your own repo, check 'gh auth status' and your remote URL.`,
    };
  }
  return {
    ...base,
    status: "failed",
    message: `push failed: ${pushed.stderr.trim().slice(0, 200)}`,
  };
}
