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

import { Command } from "commander";
import { createInterface } from "node:readline/promises";

import {
  adoptRemoteRenameAsideFlow,
  closeRegistry,
  commitPodRepo,
  connectPodFlow,
  deriveWriteGate,
  getHandleFromIdentity,
  getMeshByRid,
  housekeepFlow,
  getVaultByRid,
  listMeshes,
  listFederationStates,
  listVaults,
  loadDestinationPolicyContext,
  materializeVaultPublishable,
  normalizeGitHubRepoCoordinate,
  openRegistry,
  podNeedsConnect,
  reconcilePublishFlow,
  reconstructionExitCode,
  resolveCanonicalOwnedVaultDestination,
  resolveCanonicalOwnedVaultPublicationAuthority,
  resolveVault,
  syncPodLedgerFlow,
  withSpinner,
  type AdoptRemoteRenameAsideResult,
  type ConnectPodResult,
  type ReconcilePublishResult,
  type SyncPodLedgerResult,
  type MaterializeVaultResult,
  type EffectiveOwnedDestination,
} from "@younndai/lyt-vault";

import { syncCheckFlow, type VaultCheckReport } from "../flows/sync-check.js";
import {
  scopedSyncCheckFlow,
  type ScopedSyncCheckOutcome,
  type ScopedVaultCheckReport,
} from "../flows/scoped-sync-check.js";
import {
  syncFlow,
  type ConflictResolver,
  type VaultSyncReport,
  type VaultSyncStatus,
  type SyncOnlineVaultAuthority,
} from "../flows/sync.js";
import { syncWatchFlow } from "../flows/sync-watch.js";

// Injectable seam for the pod-wide federation flows (R7/S3 test seam). Defaults
// to the real imports; a test overrides them with spies to assert the forge
// scope guard actually GATES these call sites in the command action (a robust,
// isolate:false-safe alternative to module mocking). Injection changes NOTHING
// about the guard logic — the `federationPassAllowed && …` gates below are
// byte-identical; only which function object is invoked is swapped.
// Phase C — the handler's choice at the two-pods-with-content guard.
export type ConnectChoice = "adopt" | "decline" | "defer";

export interface SyncFederationDeps {
  syncFlow: typeof syncFlow;
  podNeedsConnect: typeof podNeedsConnect;
  connectPodFlow: typeof connectPodFlow;
  syncPodLedgerFlow: typeof syncPodLedgerFlow;
  reconcilePublishFlow: typeof reconcilePublishFlow;
  housekeepFlow?: typeof housekeepFlow;
  // Phase C — the rename-aside actionable path + its HIL chooser
  // (injectable so the 3-option menu is unit-testable without a live TTY).
  adoptRemoteRenameAsideFlow: typeof adoptRemoteRenameAsideFlow;
  chooseConnectAction: (existingRemote: string) => Promise<ConnectChoice>;
  materializeScopedVault?: typeof materializeScopedVaultAfterSync;
  scopedSyncCheck?: typeof scopedSyncCheckFlow;
}

export function buildSyncCommand(deps: Partial<SyncFederationDeps> = {}): Command {
  // Real flows by default; spies when a test injects them.
  const syncFlowFn = deps.syncFlow ?? syncFlow;
  const podNeedsConnectFn = deps.podNeedsConnect ?? podNeedsConnect;
  const connectPodFlowFn = deps.connectPodFlow ?? connectPodFlow;
  const syncPodLedgerFlowFn = deps.syncPodLedgerFlow ?? syncPodLedgerFlow;
  const reconcilePublishFlowFn = deps.reconcilePublishFlow ?? reconcilePublishFlow;
  const housekeepFlowFn = deps.housekeepFlow ?? housekeepFlow;
  const adoptRemoteRenameAsideFlowFn =
    deps.adoptRemoteRenameAsideFlow ?? adoptRemoteRenameAsideFlow;
  const chooseConnectActionFn = deps.chooseConnectAction ?? chooseConnectActionTty;
  const materializeScopedVaultFn = deps.materializeScopedVault ?? materializeScopedVaultAfterSync;
  const scopedSyncCheckFn = deps.scopedSyncCheck ?? scopedSyncCheckFlow;
  const cmd = new Command("sync");
  cmd
    .description(
      "Sync registered active vaults with their remotes (commit + push + pull --rebase). Use --watch for a foreground daemon, --check for read-only freshness reporting.",
    )
    .option("--check", "Report per-vault freshness without writing. Pairs with --json or --quiet.")
    .option("--json", "Emit machine-readable JSON for normal sync or --check.")
    .option("--quiet", "Emit nothing; preserve the truthful terminal exit code.")
    .option(
      "--watch",
      "Foreground daemon: watch registered active vaults; auto-commit + incremental FTS reconcile (event-driven).",
    )
    .option(
      "--resolve-mesh-context",
      "On .lyt/mesh-context.md conflict during pull, auto-checkout-theirs + regen-context + continue. Off by default (fail-loud preserved).",
    )
    .option("--commit-debounce <ms>", "Watch mode: debounce after last change (default 30000)")
    .option(
      "--no-publish",
      "Hold every outward publication action, including scoped first-publish and pod-wide publication. Local sync only.",
    )
    .option(
      "--message <msg>",
      "Override the per-vault commit message (e.g. an agent-supplied semantic summary). When omitted, a deterministic metadata-driven message is built from git status + figment titles (no LLM).",
    )
    .option(
      "--vault <name>",
      "Scope sync or --check to ONE registered vault (by name, mesh-qualified name, origin coordinate, unique leaf, or an @-sigil pod-local alias — a bare name is NOT resolved as an alias). Only that vault is inspected or synced, and pod-wide passes are skipped.",
    )
    .action(async (opts: SyncCliOpts) => {
      if (opts.check === true && opts.watch === true) {
        // eslint-disable-next-line no-console
        console.error("lyt sync: --check and --watch are mutually exclusive.");
        process.exit(1);
      }
      // Watch remains pod-wide. Scoped read-only inspection has its own closed
      // one-vault path below and never enters the default/pod-wide sync flow.
      if (opts.vault !== undefined && opts.watch === true) {
        // eslint-disable-next-line no-console
        console.error("lyt sync: --vault is not supported with --watch.");
        process.exit(1);
      }
      // R7/S3 — resolve the `--vault` argument to a registered vault through the
      // shared addressing chokepoint (resolveVault) BEFORE any sync work, so an
      // unknown or ambiguous name fails fast with a clear message (never a
      // silent all-vault sync). The canonical stored name feeds syncFlow's
      // `vaultNames` filter below.
      let scopedVaultIdentity: ScopedVaultIdentity | undefined;
      if (opts.vault !== undefined && opts.check !== true) {
        try {
          scopedVaultIdentity = await resolveScopedVaultIdentity(opts.vault);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
      if (opts.check === true) {
        if (opts.vault !== undefined) {
          const scoped = await scopedSyncCheckFn(opts.vault);
          if (opts.quiet === true) {
            process.exit(scoped.exitCode);
            return;
          }
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(scoped, null, 2));
            process.exit(scoped.exitCode);
            return;
          }
          printScopedCheckHuman(scoped);
          process.exit(scoped.exitCode);
          return;
        }
        const result = await syncCheckFlow();
        if (opts.quiet === true) {
          process.exit(result.exitCode);
        }
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              { reports: result.reports, summary: result.summary, exitCode: result.exitCode },
              null,
              2,
            ),
          );
          process.exit(result.exitCode);
          return;
        }
        printCheckHuman(result.reports, result.summary);
        process.exit(result.exitCode);
        return;
      }
      if (opts.watch === true) {
        const handle = await syncWatchFlow({
          commitDebounceMs: numericOpt(opts.commitDebounce),
          resolveMeshContext: opts.resolveMeshContext === true,
          networkMode: opts.publish === false ? "local-only" : "online",
          ...(opts.publish === false ? {} : { resolveOnlineAuthority: resolveSyncAuthority }),
          onTick: (report) => {
            const ts = new Date().toISOString();
            // eslint-disable-next-line no-console
            console.log(`[${ts}] ${report.name}: ${report.status} — ${report.message}`);
          },
        });
        // eslint-disable-next-line no-console
        console.log("lyt sync --watch: watching every registered active vault. Ctrl+C to stop.");
        process.on("SIGINT", () => {
          // eslint-disable-next-line no-console
          console.log("\nlyt sync --watch: SIGINT received, flushing in-flight changes...");
          void handle.stop().then(() => process.exit(0));
        });
        // Keep the process alive — watcher is persistent.
        return;
      }
      // V-DX-1 — liveness spinner over the local commit + pull --rebase
      // pre-push window (gh-federation already covers the outward publish push
      // in reconcilePublishFlow below, which runs after this resolves — no
      // nested spinner). --json/--quiet stay spinner-free; non-TTY prints
      // "Syncing…" once (zero escape codes).
      const syncAuthority =
        opts.publish === false
          ? {
              onlineAuthorityByVaultRid: {} as Record<string, SyncOnlineVaultAuthority>,
            }
          : await resolveSyncAuthority(
              scopedVaultIdentity === undefined ? undefined : [scopedVaultIdentity.ridHex],
            );
      const expectedScopedOrigin =
        scopedVaultIdentity === undefined
          ? undefined
          : syncAuthority.onlineAuthorityByVaultRid[scopedVaultIdentity.ridHex]?.expectedOrigin;
      const syncArgs = {
        resolveMeshContext: opts.resolveMeshContext === true,
        networkMode: opts.publish === false ? ("local-only" as const) : ("online" as const),
        enforceOnlineAuthority: true,
        // R7/S3 — scope the commit/push/pull loop to the single resolved vault.
        // syncFlow's existing `vaultNames` filter (flows/sync.ts) is REUSED here —
        // no parallel scoped-sync path.
        ...(scopedVaultIdentity !== undefined ? { vaultRids: [scopedVaultIdentity.ridHex] } : {}),
        ...(opts.message !== undefined ? { message: opts.message } : {}),
        // 0.12.0 Phase D · A1 — the concurrent-write conflict resolver: a plain
        // keep-mine/theirs/both choice on a TTY, the safe never-lose `both`
        // default when non-interactive (no TTY, or --json/--quiet).
        resolveConflict: makeConflictResolver(opts),
        onlineAuthorityByVaultRid: syncAuthority.onlineAuthorityByVaultRid,
      };
      const result =
        opts.json !== true && opts.quiet !== true
          ? await withSpinner("", () => syncFlowFn(syncArgs), { op: "sync" })
          : await syncFlowFn(syncArgs);
      let scopedPublish: ScopedPublishOutcome | undefined;
      if (scopedVaultIdentity !== undefined) {
        const scopedVaultName = scopedVaultIdentity.name;
        const report = result.reports.find(
          (candidate) => candidate.path === scopedVaultIdentity.path,
        );
        scopedPublish =
          opts.publish === false
            ? scopedPublishHeld(scopedVaultName)
            : report?.status === "origin-mismatch"
              ? scopedPublishOriginMismatch(scopedVaultName, report, expectedScopedOrigin)
              : await materializeScopedVaultFn({
                  vaultRid: scopedVaultIdentity.rid,
                  vaultName: scopedVaultName,
                  report,
                });
      }
      if (opts.json !== true && opts.quiet !== true) {
        printSyncHuman(result.reports);
        if (scopedPublish !== undefined) printScopedPublishHuman(scopedPublish);
      }
      // The friction-capture nudge is intentionally NOT surfaced to the human
      // in 0.11.0 (the reliability floor stays unopinionated — it does not push
      // a logging ritual). Hints are still derived on `result.frictionHints`
      // for programmatic/JSON callers; the `lyt friction` verb + `lyt help
      // friction` remain available for opt-in use. Re-emitting this nudge is an
      // Increment-2 "Reliable Team Use" item.

      // Brief D (D.3) — `lyt sync` SELF-HEALS to connect a local-first
      // pod (no separate `lyt connect` verb). When the pod is provisional
      // (local-only), reconcile it to the real gh handle (guide auth → resolve →
      // remap-state → create pod repo + wire remote) BEFORE the publish pass.
      // The D.3-GUARD surfaces an existing-remote collision as an HIL (adopt
      // default) and DOES NOT blind-push (nothing overwritten). gh-unauthed and
      // the guard both DEFER publish (not a failure — a clear next step).
      // === Forge scope guard (R7 / S3 · SC6) ==============================
      // DISTINCT from — and co-shipped with, NOT folded into — the
      // reconcile-into-ledger seam. A `--vault`-scoped `lyt sync` commits +
      // pushes ONLY the named vault (the syncFlow `vaultNames` filter above,
      // which targets that vault's own `origin`). The three pod-wide federation
      // passes below — connect-pod (creates the pod repo), the pod-ledger push,
      // and reconcile-publish (regen pod.yon + `gh repo create` for every
      // MISSING vault repo + push the pod) — each enumerate the ENTIRE pod, so
      // running them under a single-vault scope would FORGE repos for vaults
      // OTHER than the named one. This guard gates all three off whenever a
      // vault scope is active. It is kept as its own legible predicate (not
      // hidden inside any pass) so a reviewer can see the scope guard.
      const federationPassAllowed = isFederationPassAllowed({
        publishRequested: opts.publish !== false,
        vaultScoped: scopedVaultIdentity !== undefined,
      });

      let connectDeferredPublish = false;
      let connect: ConnectPodResult | undefined;
      let hardConnectFailure = false;
      let connectReconstructionExitCode = 0;
      if (federationPassAllowed && (await podNeedsConnectFn())) {
        connect = await connectPodFlowFn({});
        hardConnectFailure = isHardConnectFailure(connect);
        if (opts.json !== true && opts.quiet !== true) {
          // C-4(b) — suppress the passive guard message when the interactive
          // 3-option menu (TTY) is about to explain the same thing.
          printConnectHuman(connect, { suppressMessageForMenu: process.stdin.isTTY === true });
        }

        if (connect.status === "guard-existing-remote") {
          // Phase C (B4) — the two-pods case, and (per amendment-5) the
          // remote genuinely has a pod WITH CONTENT, so this is a real collision.
          // Offer the 3-option menu (handler-confirmed): back up & adopt / don't
          // connect / keep working locally. Non-TTY → the safe defer default —
          // NEVER a silent destructive rename-aside.
          const choice = await chooseConnectActionFn(connect.existingRemote ?? "your existing pod");
          if (choice === "adopt") {
            // Back up the whole LYT_HOME aside, L0-strip the backup's junctions,
            // adopt the remote fresh, hand off the merge to the import funnel.
            // connectPodFlow's registry is already closed (its own finally), so
            // the whole-home rename runs with no open DB handle under ~/lyt/.
            //
            // C-2 — defensive backstop. The dance's own guarded try restores the
            // backup on ANY post-rename failure (mkdir/adopt throw →
            // restoreFromBackup) and returns a result rather than throwing. Wrap
            // the call anyway so an UNEXPECTED throw can NEVER escape the command
            // and strand the home without a recovery pointer + the "your notes
            // are backed up" handoff.
            try {
              const dance = await adoptRemoteRenameAsideFlowFn({
                realHandle: connect.realHandle ?? "",
                existingRemote: connect.existingRemote ?? "",
              });
              if (opts.json !== true && opts.quiet !== true) {
                printRenameAsideHuman(dance);
              }
              // G1 parity (a review finding) — a fresh adopt that DROPPED vaults is an
              // INCOMPLETE reconstruction: exit nonzero with the bug(12)/state(11)
              // granularity so the connect path never reports clean success while
              // vaults are missing (mirrors the wizard `lyt init` path).
              if (dance.manifestDrops.length > 0) {
                connectReconstructionExitCode = reconstructionExitCode({
                  drops: dance.manifestDrops,
                });
                if (opts.json !== true && opts.quiet !== true) {
                  // eslint-disable-next-line no-console
                  console.error(
                    `lyt sync (connect): reconstruction INCOMPLETE — dropped ` +
                      `${dance.manifestDrops.length} vault(s): ` +
                      `${dance.manifestDrops.map((d) => d.vaultName).join(", ")}. ` +
                      `Re-run after resolving the cause.`,
                  );
                }
              }
            } catch {
              if (opts.json !== true && opts.quiet !== true) {
                // eslint-disable-next-line no-console
                console.error(
                  `lyt sync (connect): connecting to your existing pod hit an unexpected problem. ` +
                    `Your notes were NOT deleted — if your Lyt folder looks empty, a backup copy named ` +
                    `"<your-lyt-folder>-backup-…" sits right next to it. Run \`lyt doctor\` to check and put it back.`,
                );
              }
            }
            // A successful dance leaves the pod freshly adopted + connected (the
            // clone is already in sync); a restored/aborted dance left the local
            // pod as-is. Either way, skip THIS run's outward publish.
            connectDeferredPublish = true;
          } else if (choice === "decline") {
            // Hard fail-closed — do NOT connect; the local pod is untouched.
            if (opts.json !== true && opts.quiet !== true) {
              // eslint-disable-next-line no-console
              console.log(
                `lyt sync (connect): not connecting. Your local pod is untouched — nothing was uploaded or overwritten.`,
              );
            }
            connectDeferredPublish = true;
          } else {
            // defer — keep working locally, decide later (the shipped 3rd option).
            connectDeferredPublish = true;
          }
        } else if (connect.status !== "reconciled") {
          // reconciled → fall through to publish the now-connected pod. Any other
          // status (gh-unauthed, no-pod, invalid handle) defers the outward
          // publish this run — no clobber, clear next step.
          connectDeferredPublish = true;
        }
      }

      // Fed-v2 Layer-1 (Phase D1d) — the POD-REPO LEDGER sync leg. Pulls/commits/
      // pushes the per-writer subscription/alias SHARD ledger under
      // `<podRoot>/ledger/` (the git SoT for cross-machine convergence) and
      // reconstitutes the local registry cache from the union. Same
      // `--no-publish` gate (it's an outward pod-repo git op) and same
      // connect-deferral as the publish pass. Skipped cleanly when there's no
      // pod. Best-effort: a ledger-sync hiccup surfaces but does not flip the
      // overall exit code unless it errored hard.
      //
      // W4 staleness fix — this leg runs BEFORE the publish pass (was after).
      // Reconstitution here regenerates the registry cache (and pod.yon) from
      // the JUST-PULLED ledger union; running it first means the publish pass's
      // pod.yon regen → commit → push below reflects the pulled peer
      // subscriptions in the SAME `lyt sync`. With the old order, the publish
      // pass pushed a pod.yon derived from the PRE-pull registry, leaving it one
      // cycle stale whenever this leg pulled in a new peer subscription. The
      // ledger leg remains the SOLE committer of `ledger/`; the publish pass
      // remains the SOLE committer of `pod.yon` — disjoint pathspecs, just
      // reordered.
      let podLedger: SyncPodLedgerResult | undefined;
      if (federationPassAllowed && !connectDeferredPublish) {
        podLedger = await syncPodLedgerFlowFn({ push: true });
        const publishedMachineSnapshot = (podLedger as typeof podLedger & {
          publishedMachineSnapshot?: unknown;
        }).publishedMachineSnapshot;
        const verifyPublishedSnapshot = (podLedger as typeof podLedger & {
          revalidatePublishedMachineSnapshot?: () => Promise<boolean>;
        }).revalidatePublishedMachineSnapshot;
        if (podLedger.status === "synced" && publishedMachineSnapshot !== undefined && verifyPublishedSnapshot !== undefined) {
          const runPublishedGc = housekeepFlowFn as unknown as (args: {
            vaultRid?: string;
            ledger: "sync";
            publishedMachineSnapshot: unknown;
            verifyPublishedSnapshot: () => Promise<boolean>;
          }) => Promise<{ gc: Array<{ vaultName: string; outcome: string }> }>;
          const housekeeping = await runPublishedGc({
            ...(scopedVaultIdentity === undefined ? {} : { vaultRid: scopedVaultIdentity.ridHex }),
            ledger: "sync",
            publishedMachineSnapshot,
            verifyPublishedSnapshot,
          });
          const changedVaults = new Set(
            housekeeping.gc.filter((entry) => entry.outcome === "deleted").map((entry) => entry.vaultName),
          );
          for (const report of result.reports) {
            if (!changedVaults.has(report.name)) continue;
            report.pendingLytMutation = true;
            report.message += " Local Lyt housekeeping is pending publication on the next sync.";
          }
        }
        if (opts.json !== true && opts.quiet !== true) {
          printPodLedgerHuman(podLedger);
        }
      }

      // Brief B (B.2) — the federation publish/reconcile pass: regen pod.yon →
      // create-missing vault repos + push → commit + push the pod, all
      // resumable via outbox.db. Running `lyt sync` IS the consent for this
      // outward step (the handler explicitly invoked it). --no-publish skips it
      // (local sync only). Skipped cleanly when there's no pod. Runs AFTER the
      // pod-ledger leg above so its pod.yon regen sees the reconstituted cache
      // (W4 staleness fix — see the ledger-leg comment).
      let publish: ReconcilePublishResult | undefined;
      const podLedgerAllowsPublish = podLedgerAllowsOuterPublish(podLedger);
      if (federationPassAllowed && !connectDeferredPublish && podLedgerAllowsPublish) {
        publish = await reconcilePublishFlowFn({ push: true });
        if (opts.json !== true && opts.quiet !== true) {
          printPublishHuman(publish);
        }
      }

      const syncOk = result.ok;
      const publishOk = publish === undefined || publish.skipped || publish.ok;
      const podLedgerOk =
        podLedger === undefined || podLedger.status === "skipped" || podLedger.status === "synced";
      const scopedPublishOk = scopedPublish === undefined || scopedPublish.ok;
      const terminalOk =
        connectReconstructionExitCode === 0 &&
        !hardConnectFailure &&
        syncOk &&
        publishOk &&
        podLedgerOk &&
        scopedPublishOk;
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              ok: terminalOk,
              reports: result.reports,
              connect: connect ?? null,
              podLedger: podLedger ?? null,
              publish: publish ?? null,
              scopedPublish: scopedPublish ?? null,
            },
            null,
            2,
          ),
        );
      }
      process.exit(
        connectReconstructionExitCode !== 0 ? connectReconstructionExitCode : terminalOk ? 0 : 1,
      );
    });
  return cmd;
}

export function isHardConnectFailure(result: ConnectPodResult): boolean {
  const hardStatuses = new Set<string>([
    "invalid-real-handle",
    "identity-mismatch",
    "guard-noncanonical-origin",
    "guard-missing-origin-existing-remote",
    "origin-wire-blocked",
  ]);
  return hardStatuses.has(result.status);
}

export function podLedgerAllowsOuterPublish(podLedger: SyncPodLedgerResult | undefined): boolean {
  return (
    podLedger === undefined ||
    podLedger.status === "skipped" ||
    (podLedger.status === "synced" &&
      (!podLedger.committed ||
        (podLedger.proofCommitted &&
          podLedger.proofRecordCount === 2 &&
          podLedger.receiptPersisted)))
  );
}

export type ScopedPublishStatus =
  | "published"
  | "already-online"
  | "local-only-no-push-target"
  | "skipped-readonly"
  | "publish-held"
  | "publish-deferred"
  | "origin-mismatch"
  | "sync-incomplete";

export interface ScopedPublishOutcome {
  vaultName: string;
  status: ScopedPublishStatus;
  remoteAction: "none" | "targeted";
  visibility: "private";
  expectedRepo: string | null;
  materialized: MaterializeVaultResult | null;
  syncStatus: VaultSyncStatus | null;
  ok: boolean;
  message: string;
}

function scopedPublishHeld(vaultName: string): ScopedPublishOutcome {
  return {
    vaultName,
    status: "publish-held",
    remoteAction: "none",
    visibility: "private",
    expectedRepo: null,
    materialized: null,
    syncStatus: null,
    ok: true,
    message: "Saved locally; --no-publish held every online action.",
  };
}

function scopedPublishOriginMismatch(
  vaultName: string,
  report: VaultSyncReport,
  expectedRepo: string | undefined,
): ScopedPublishOutcome {
  return {
    vaultName,
    status: "origin-mismatch",
    remoteAction: "none",
    visibility: "private",
    expectedRepo: expectedRepo ?? null,
    materialized: null,
    syncStatus: report.status,
    ok: false,
    message: report.message,
  };
}

export async function materializeScopedVaultAfterSync(args: {
  vaultRid: Uint8Array;
  /** Initial display name only; never used for identity resolution. */
  vaultName: string;
  report: VaultSyncReport | undefined;
}): Promise<ScopedPublishOutcome> {
  const db = await openRegistry();
  try {
    const syncPodMetadata = async (): Promise<string[]> => {
      const warnings: string[] = [];
      const podLedger = await syncPodLedgerFlow({ registryDb: db });
      warnings.push(...podLedger.warnings);
      if (podLedger.status === "synced" && podLedger.podDir !== undefined) {
        const podHandle = getHandleFromIdentity();
        const podCommit = await commitPodRepo(
          podLedger.podDir,
          "chore(lyt): advertise scoped vault publication",
          {
            push: true,
            permissionActor: podHandle,
            permissionRepository: `${podHandle}/lyt-pod`,
          },
        );
        warnings.push(...podCommit.warnings);
      } else {
        warnings.push(
          `pod metadata sync ${podLedger.status}${podLedger.reason === undefined ? "" : `: ${podLedger.reason}`}`,
        );
      }
      return warnings;
    };
    const vault = await getVaultByRid(db, args.vaultRid);
    if (vault === null) {
      return {
        vaultName: args.vaultName,
        status: "skipped-readonly",
        remoteAction: "none",
        visibility: "private",
        expectedRepo: null,
        materialized: null,
        syncStatus: args.report?.status ?? null,
        ok: true,
        message:
          "This subscribed/read-only vault was saved locally only; no online action happened.",
      };
    }
    const writeGate = await deriveWriteGate(vault, db);
    const mesh = vault.homeMeshRid === null ? null : await getMeshByRid(db, vault.homeMeshRid);
    const policyContext = await loadDestinationPolicyContext(db);
    const authority = resolveCanonicalOwnedVaultPublicationAuthority(vault, mesh, policyContext);
    const destination =
      authority?.destination ?? resolveCanonicalOwnedVaultDestination(vault, mesh, policyContext);
    const eligibility = classifyScopedPublishEligibility({
      publishable: !writeGate.blocked,
      destination,
      legacyOriginHint: vault.gitUrl === null ? null : normalizeGitHubRepoCoordinate(vault.gitUrl),
      reportStatus: args.report?.status,
    });
    if (eligibility.status === "skipped-readonly") {
      return {
        vaultName: vault.name,
        status: "skipped-readonly",
        remoteAction: "none",
        visibility: "private",
        expectedRepo: null,
        materialized: null,
        syncStatus: args.report?.status ?? null,
        ok: true,
        message:
          "This subscribed/read-only vault was saved locally only; no online action happened.",
      };
    }
    if (eligibility.status === "local-only-no-push-target") {
      return {
        vaultName: vault.name,
        status: "local-only-no-push-target",
        remoteAction: "none",
        visibility: "private",
        expectedRepo: null,
        materialized: null,
        syncStatus: args.report?.status ?? null,
        ok: true,
        message:
          "Saved locally; the home mesh has no configured push target, so no online action happened.",
      };
    }
    const pushTarget = eligibility.pushTarget;
    if (destination.kind !== "github" || destination.repositoryName === null) {
      return {
        vaultName: vault.name,
        status: "local-only-no-push-target",
        remoteAction: "none",
        visibility: "private",
        expectedRepo: null,
        materialized: null,
        syncStatus: args.report?.status ?? null,
        ok: true,
        message: "Saved locally; this vault has no exact RID-bound repository policy.",
      };
    }
    const expectedRepo = `${destination.owner}/${destination.repositoryName}`;
    if (eligibility.status === "sync-incomplete") {
      return {
        vaultName: vault.name,
        status: "sync-incomplete",
        remoteAction: "none",
        visibility: "private",
        expectedRepo,
        materialized: null,
        syncStatus: eligibility.reportStatus,
        ok: false,
        message: `Scoped publication was not attempted because vault sync ended as ${eligibility.reportStatus ?? "missing-report"}.`,
      };
    }
    if (eligibility.status === "already-online") {
      return {
        vaultName: vault.name,
        status: "already-online",
        remoteAction: "none",
        visibility: "private",
        expectedRepo,
        materialized: null,
        syncStatus: args.report?.status ?? null,
        ok: true,
        message: "The online copy is already connected; only this vault was processed.",
      };
    }
    let materialized: MaterializeVaultResult;
    try {
      materialized = await materializeVaultPublishable(vault, {
        handle: getHandleFromIdentity(),
        repoOwner: pushTarget,
        repoName: destination.repositoryName,
        repoTargetKind: destination.kind === "github" ? destination.targetKind : undefined,
        repoOwnerAuthority: "effective-owned-destination",
        createRemoteIfMissing: true,
        push: true,
        setRemote: true,
        visibility: "private",
        registryDb: db,
      });
    } catch (err) {
      return {
        vaultName: vault.name,
        status: "publish-deferred",
        remoteAction: "targeted",
        visibility: "private",
        expectedRepo,
        materialized: null,
        syncStatus: args.report?.status ?? null,
        ok: false,
        message: `Saved locally, but the private online copy is still pending: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const published = materialized.pushed;
    const mismatch = materialized.skippedReason === "origin-mismatch";
    const metadataWarnings = published ? await syncPodMetadata() : [];
    materialized.warnings.push(...metadataWarnings);
    const metadataPending = metadataWarnings.length > 0;
    return {
      vaultName: vault.name,
      status: published ? "published" : mismatch ? "origin-mismatch" : "publish-deferred",
      remoteAction: published ? "targeted" : mismatch ? "none" : "targeted",
      visibility: "private",
      expectedRepo: published ? (materialized.remoteCoordinate ?? expectedRepo) : expectedRepo,
      materialized,
      syncStatus: args.report?.status ?? null,
      ok: published && !metadataPending,
      message: published
        ? metadataPending
          ? `Saved this vault to its private online copy, but its pod advertisement is pending: ${materialized.warnings.join("; ")}`
          : "Saved this vault to its private online copy and advertised it to your pod."
        : mismatch
          ? `Publication refused: ${materialized.warnings.join("; ")}`
          : `Saved locally, but the private online copy is still pending: ${materialized.warnings.join("; ") || materialized.skippedReason || "retry scoped sync"}`,
    };
  } finally {
    await closeRegistry(db);
  }
}

export type ScopedPublishEligibility =
  | { status: "publish-needed"; pushTarget: string }
  | { status: "already-online"; pushTarget: string }
  | { status: "sync-incomplete"; pushTarget: string; reportStatus: VaultSyncStatus | null }
  | { status: "local-only-no-push-target" }
  | { status: "skipped-readonly" };

export function classifyScopedPublishEligibility(args: {
  publishable: boolean;
  destination: EffectiveOwnedDestination;
  /** Existing origin evidence only; never authorizes creation or retargeting. */
  legacyOriginHint?: string | null;
  reportStatus: VaultSyncStatus | undefined;
}): ScopedPublishEligibility {
  if (!args.publishable) return { status: "skipped-readonly" };
  const exactRepository =
    args.destination.kind === "github" && args.destination.repositoryName !== null
      ? `${args.destination.owner}/${args.destination.repositoryName}`.toLowerCase()
      : null;
  if (
    exactRepository !== null &&
    args.legacyOriginHint?.toLowerCase() === exactRepository &&
    (args.reportStatus === "clean" ||
      args.reportStatus === "committed" ||
      args.reportStatus === "pushed" ||
      args.reportStatus === "pulled" ||
      args.reportStatus === "diverged-synced")
  ) {
    return { status: "already-online", pushTarget: exactRepository.split("/", 1)[0]! };
  }
  if (args.destination.kind !== "github" || args.destination.repositoryName === null) {
    return { status: "local-only-no-push-target" };
  }
  const pushTarget = args.destination.owner;
  switch (args.reportStatus) {
    case "no-upstream":
      return { status: "publish-needed", pushTarget };
    case "clean":
    case "committed":
    case "pushed":
    case "pulled":
    case "diverged-synced":
      return { status: "already-online", pushTarget };
    case undefined:
    case "conflict":
    case "skipped-frozen":
    case "skipped-readonly":
    case "skipped-tombstoned":
    case "skipped-disconnected":
    case "skipped-missing":
    case "not-git-repo":
    case "access-lost":
    case "origin-mismatch":
    case "error":
      return { status: "sync-incomplete", pushTarget, reportStatus: args.reportStatus ?? null };
  }
}

export function printScopedPublishHuman(outcome: ScopedPublishOutcome): void {
  // eslint-disable-next-line no-console
  console.log(`lyt sync (scoped): ${outcome.vaultName}: ${outcome.message}`);
  if (outcome.expectedRepo !== null) {
    // eslint-disable-next-line no-console
    console.log(`  private target: ${outcome.expectedRepo}`);
  }
}

interface SyncCliOpts {
  check?: boolean;
  json?: boolean;
  quiet?: boolean;
  watch?: boolean;
  resolveMeshContext?: boolean;
  commitDebounce?: string;
  // commander maps `--no-publish` → publish:false (default true/undefined).
  publish?: boolean;
  // Brief C (F2) — `--message <msg>` per-vault commit-message override.
  message?: string;
  // R7/S3 — `--vault <name>` scopes the sync to one registered vault.
  vault?: string;
}

// === Forge scope guard (R7 / S3 · SC6) ================================
// The DISTINCT, legible scope-guard predicate. Returns true only when the
// pod-wide federation/publish passes (connect-pod, pod-ledger push,
// reconcile-publish = regen pod.yon + create-missing vault repos + push pod)
// may run. It returns false whenever a single `--vault` scope is active — those
// passes enumerate the WHOLE pod and would forge repos for vaults OTHER than
// the named one — and also honours `--no-publish`. Kept as its own exported
// pure function (co-shipped with, NOT folded into, the reconcile seam) so the
// scope guard is independently testable and reviewer-visible (SC6).
export function isFederationPassAllowed(scope: {
  publishRequested: boolean;
  vaultScoped: boolean;
}): boolean {
  return scope.publishRequested && !scope.vaultScoped;
}

// R7/S3 — resolve a `--vault` argument to its canonical registered vault name
// through the shared addressing chokepoint (resolveVault: exact name →
// mesh-qualified display name → origin coordinate → unique bare leaf). An alias
// resolves ONLY via its `@`-sigil form (`@ro`); a BARE name is NOT looked up in
// the alias table (the alias namespace is disjoint from the name/leaf
// namespace). Throws AmbiguousVaultLeafError on a colliding bare leaf (never
// tiebreaks) and a plain Error when nothing matches — both surface to the CLI
// as a clear message + exit 1. Reuses the same resolver the rest of the verb
// fleet uses; no scoped-sync-specific name matching.
export interface ScopedVaultIdentity {
  rid: Uint8Array;
  ridHex: string;
  name: string;
  path: string;
}

export async function resolveScopedVaultIdentity(vault: string): Promise<ScopedVaultIdentity> {
  const db = await openRegistry();
  try {
    const resolved = await resolveVault(db, vault);
    if (resolved === null) {
      throw new Error(
        `lyt sync: no registered vault matches '${vault}'. Run \`lyt vault list\` to see your vaults.`,
      );
    }
    return {
      rid: resolved.rid,
      ridHex: resolved.ridHex,
      name: resolved.name,
      path: resolved.path,
    };
  } finally {
    await closeRegistry(db);
  }
}

export async function resolveScopedVaultName(vault: string): Promise<string> {
  return (await resolveScopedVaultIdentity(vault)).name;
}

async function resolveSyncAuthority(vaultRids?: readonly string[]): Promise<{
  onlineAuthorityByVaultRid: Record<string, SyncOnlineVaultAuthority>;
}> {
  const db = await openRegistry();
  try {
    const all = await listVaults(db);
    const meshes = await listMeshes(db);
    const context = await loadDestinationPolicyContext(db);
    const states = await listFederationStates(db);
    const actor = states.length === 1 ? states[0]!.handle : null;
    const resolved = all.flatMap((vault) => {
      if (vault.status !== "active" || vault.source !== "own") return [];
      const mesh =
        vault.homeMeshRid === null
          ? null
          : (meshes.find((candidate) => candidate.ridHex === vault.homeMeshRidHex) ?? null);
      const authority = resolveCanonicalOwnedVaultPublicationAuthority(vault, mesh, context);
      if (authority === null) return [];
      const repository = `${authority.destination.owner}/${authority.destination.repositoryName}`;
      return [{ vault, authority, repository }];
    });
    const assignments = new Map<string, typeof resolved>();
    for (const assignment of resolved) {
      const coordinate = `github.com/${assignment.repository}`.toLowerCase();
      const existing = assignments.get(coordinate);
      if (existing === undefined) assignments.set(coordinate, [assignment]);
      else existing.push(assignment);
    }
    const collisions = [...assignments.entries()]
      .filter(([, entries]) => entries.length > 1)
      .sort(([left], [right]) => left.localeCompare(right));
    if (collisions.length > 0) {
      const diagnostic = collisions
        .map(
          ([coordinate, entries]) =>
            `${coordinate} => ${entries
              .map(({ vault }) => `${vault.ridHex} (${vault.name})`)
              .sort()
              .join(", ")}`,
        )
        .join("; ");
      throw new Error(
        `lyt sync: publication coordinate collision; refusing online sync: ${diagnostic}`,
      );
    }
    const selected =
      vaultRids === undefined
        ? resolved
        : resolved.filter(({ vault }) => vaultRids.includes(vault.ridHex));
    const onlineAuthorityByVaultRid: Record<string, SyncOnlineVaultAuthority> = {};
    for (const { vault, authority, repository } of selected) {
      if (actor === null || context.podRid === null) continue;
      onlineAuthorityByVaultRid[vault.ridHex] = {
        expectedOrigin: repository,
        publication: {
          actor,
          target: `github:${authority.destination.targetKind}/${authority.destination.owner}`,
          repository,
          vaultRid: vault.rid,
          podRid: context.podRid,
          ...(context.podRoot === undefined ? {} : { podRoot: context.podRoot }),
          policy: authority,
        },
      };
    }
    return { onlineAuthorityByVaultRid };
  } finally {
    await closeRegistry(db);
  }
}

// 0.12.0 Phase D · A1 — build the concurrent-write conflict resolver the sync
// flow calls when a rebase conflict occurs. Interactive (a real TTY, human
// output) → prompt the plain keep-mine / keep-online / keep-both choice.
// Non-interactive (no TTY, or --json/--quiet where a prompt would corrupt the
// stream / hang a script) → the SAFE never-lose default `both` (nothing is
// overwritten; the user resolves later). Never surfaces a raw git marker.
export function makeConflictResolver(opts: SyncCliOpts): ConflictResolver {
  return async ({ vaultName, conflictPaths }) => {
    if (process.stdin.isTTY !== true || opts.json === true || opts.quiet === true) {
      return "both";
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const where = conflictPaths.length > 0 ? conflictPaths.join(", ") : "a note";
      const ans = (
        await rl.question(
          `\nYou and your online copy both changed ${where} in "${vaultName}" at the same time.\n` +
            `  [1] keep your version   [2] keep the online version   [3] keep both (default)\n` +
            `Which would you like to keep? [1/2/3]: `,
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "1" || ans === "mine") return "mine";
      if (ans === "2" || ans === "theirs" || ans === "online") return "theirs";
      return "both";
    } finally {
      rl.close();
    }
  };
}

function numericOpt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Exported for the firewall-C1 render-boundary test: it renders real syncFlow
// reports through THIS function and asserts the human output carries zero git/gh
// plumbing noun (the charter's non-technical contract, enforced at the boundary).
// firewall-C1 fix-pass (A.G light-review) — the per-vault status COLUMN is a
// human-facing display; the raw enum tokens (`no-upstream`, `not-git-repo`,
// `pushed`, `pulled`, …) contain git nouns, so they are mapped to plain labels for
// DISPLAY ONLY. The `status` FIELD on the report is unchanged — machine consumers
// (`lyt sync --check`, tests, JSON) still read the stable enum. Unknown/future
// statuses fall back to a generic label rather than leaking the raw token.
const SYNC_STATUS_LABEL: Record<string, string> = {
  clean: "up to date",
  committed: "saved",
  pushed: "saved online",
  pulled: "updated",
  "diverged-synced": "synced",
  conflict: "needs you",
  "skipped-frozen": "paused",
  "skipped-readonly": "read-only",
  "skipped-tombstoned": "removed",
  "skipped-disconnected": "disconnected",
  "skipped-missing": "missing",
  "no-upstream": "local only",
  "not-git-repo": "not set up",
  // 0.12.0 Phase D · A6 — the online copy is no longer reachable because access
  // was revoked (or the repo was deleted). Mirrors the `--check` label.
  "access-lost": "no access",
  error: "problem",
};

function syncStatusLabel(status: string): string {
  return SYNC_STATUS_LABEL[status] ?? "done";
}

export function printSyncHuman(reports: readonly VaultSyncReport[]): void {
  if (reports.length === 0) {
    // eslint-disable-next-line no-console
    console.log("lyt sync: no vaults found in registry.");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`lyt sync: ${reports.length} vault(s) processed`);
  for (const r of reports) {
    // eslint-disable-next-line no-console
    console.log(`  ${syncStatusLabel(r.status).padEnd(14)} ${r.name}: ${r.message}`);
  }
}

// Brief D (D.3) — surface the connect self-heal outcome. "not-needed"/"no-pod"
// are silent (a normal `lyt sync` on a connected pod must stay quiet). Other
// statuses carry an actionable handler message.
// Exported (with printPublishHuman / printPodLedgerHuman below) for the
// firewall-C1 render-boundary test — these three sub-renderers fire on the same
// `lyt sync` and must also carry zero git plumbing noun / raw stderr.
export function printConnectHuman(
  c: ConnectPodResult,
  opts: { suppressMessageForMenu?: boolean } = {},
): void {
  if (c.status === "not-needed" || c.status === "no-pod") return;
  // C-4(b) — on the interactive guard path the 3-option menu (chooseConnectActionTty)
  // is about to print its own full explanation, so the connect detector's PASSIVE
  // "combining isn't automated yet / keep working locally" message would read as a
  // self-contradiction right before the menu. Suppress ONLY that passive message,
  // ONLY for the guard status, ONLY when a menu will show (caller passes the TTY
  // signal). Every other status/path still prints; warnings always print.
  const suppress = opts.suppressMessageForMenu === true && c.status === "guard-existing-remote";
  if (!suppress) {
    // eslint-disable-next-line no-console
    console.log(`lyt sync (connect): ${c.message}`);
  }
  for (const w of c.warnings) {
    // eslint-disable-next-line no-console
    console.error(`  > ${w}`);
  }
}

// Phase C — the DEFAULT 3-option HIL chooser for the two-pods-with-
// content guard. Non-TTY → "defer" (the safe default; never a silent
// destructive rename-aside). On a TTY it presents the handler-confirmed menu:
// [1] back up & adopt / [2] don't connect / [3] keep working locally.
export async function chooseConnectActionTty(existingRemote: string): Promise<ConnectChoice> {
  if (process.stdin.isTTY !== true) return "defer";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-console
    console.log(
      `\nYou already have a pod on GitHub (${existingRemote}) with notes in it, and this computer also has a ` +
        `separate local pod. Lyt can back up this computer's Lyt folder, switch to your online pod, then help ` +
        `you import your backed-up notes.\n` +
        `  1) Back up my Lyt & adopt the online pod (recommended)\n` +
        `  2) Don't connect\n` +
        `  3) Keep working locally, decide later`,
    );
    const ans = (await rl.question("Choose [1/2/3] (default 3): ")).trim();
    if (ans === "1") return "adopt";
    if (ans === "2") return "decline";
    return "defer";
  } finally {
    rl.close();
  }
}

// Phase C — human summary after the rename-aside dance. Leads with the
// outcome + the handoff (import funnel), then surfaces any warnings.
export function printRenameAsideHuman(r: AdoptRemoteRenameAsideResult): void {
  if (r.handoffMessage.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`lyt sync (connect): ${r.handoffMessage}`);
  }
  if (r.status === "adopted" && r.backupPath !== null) {
    // eslint-disable-next-line no-console
    console.log(`  > Your previous notes are backed up at ${r.backupPath}`);
  }
  // C-4(a) — an `aborted` result carries NO handoffMessage (the block above is
  // skipped), so without this the abort was DEAD-SILENT after the user chose
  // "adopt". Surface `r.error` (backup-collision / validateLytHome-fail /
  // rename-EPERM) so the failure is never invisible. `aborted` = nothing was
  // moved (notes untouched); `restored` carries its own handoffMessage above.
  if (r.status === "aborted" && r.error !== undefined && r.error.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`  > ${r.error}`);
  }
  for (const w of r.warnings) {
    // eslint-disable-next-line no-console
    console.error(`  > ${w}`);
  }
}

export function printPublishHuman(p: ReconcilePublishResult): void {
  if (p.skipped) {
    // firewall-C1 fix-pass (A.G light-review M1) — map the machine reason token to a
    // plain label (same treatment as printPodLedgerHuman); unknown reasons fall back
    // to a generic label rather than leaking the raw token.
    const PUBLISH_SKIP_LABEL: Record<string, string> = {
      "invalid-handle": "your account name looks invalid — run `lyt doctor`",
    };
    if (p.reason !== "no-single-pod" && p.reason !== "no-federation-state") {
      const label =
        p.reason !== undefined
          ? (PUBLISH_SKIP_LABEL[p.reason] ?? "nothing to publish")
          : "nothing to publish";
      // eslint-disable-next-line no-console
      console.log(`lyt sync (publish): skipped — ${label}`);
    }
    return;
  }
  const savedVaults = p.vaultOutcomes.filter((o) => o.pushed).length;
  // firewall-C1 fix-pass — plain wording ("saved … online") instead of the
  // plumbing noun "pushed".
  // eslint-disable-next-line no-console
  console.log(
    `lyt sync (publish): saved ${savedVaults}/${p.vaultOutcomes.length} vault(s) online · pod ${p.podPushed ? "saved" : "not saved"}`,
  );
  for (const o of p.vaultOutcomes) {
    if (o.status === "published" || o.status === "pulled-then-published") continue;
    // eslint-disable-next-line no-console
    console.log(`  ${o.status.padEnd(14)} ${o.vaultName}: ${o.message}`);
  }
  if (p.outboxRemaining > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `  ⚠ ${p.outboxRemaining} publish op(s) pending in the outbox — re-run \`lyt sync\` to finish (resumable).`,
    );
  }
}

// Fed-v2 Layer-1 (Phase D1d) — pod-repo ledger sync summary line.
export function printPodLedgerHuman(p: SyncPodLedgerResult): void {
  if (p.status === "skipped") {
    // firewall-C1 fix-pass (A.G light-review M1) — map the machine reason token to
    // a plain label; a raw token like `pod-not-git-repo` would otherwise render
    // "git" to the human. Unknown reasons fall back to a generic label rather than
    // leaking the raw token (defense-in-depth for future reasons). no-single-pod /
    // no-federation-state stay silent (a normal solo pod).
    const LEDGER_SKIP_LABEL: Record<string, string> = {
      "pod-dir-missing": "your pod folder isn't on this machine",
      "pod-not-git-repo": "your pod isn't set up for syncing yet",
    };
    if (p.reason !== "no-single-pod" && p.reason !== "no-federation-state") {
      const label =
        p.reason !== undefined
          ? (LEDGER_SKIP_LABEL[p.reason] ?? "nothing to sync")
          : "nothing to sync";
      // eslint-disable-next-line no-console
      console.log(`lyt sync (ledger): skipped — ${label}`);
    }
    return;
  }
  // firewall-C1 fix-pass — plain wording (no "pulled"/"committed"/"pushed" nouns).
  const parts: string[] = [];
  if (p.pulled) parts.push("brought in updates");
  if (p.committed) parts.push("saved locally");
  if (p.pushed) parts.push("saved online");
  if (p.reconstituted) parts.push(`updated ${p.subscriptionsReconstituted} shared list(s)`);
  const detail = parts.length > 0 ? parts.join(" · ") : "up to date";
  // eslint-disable-next-line no-console
  console.log(`lyt sync (ledger): ${p.status} — ${detail}`);
  if (p.status === "error" || p.status === "conflict") {
    // eslint-disable-next-line no-console
    console.log(
      "  Next: run `lyt doctor`, then retry `lyt sync` after the reported issue is clear.",
    );
  }
  for (const w of p.warnings) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ ${w}`);
  }
}

// firewall-C1 completion (A.G integration release review R2, 2026-07-07) —
// printCheckHuman is the SIBLING renderer to printSyncHuman on the SAME `sync`
// verb (the `--check` read-only path). It printed the raw check-status enums
// (`no-upstream`, `ahead-N`, `behind-N`, `diverged`) straight to the human;
// `no-upstream` carries the banned "upstream" git noun (NO_GIT_NOUN denylist) and
// ahead/behind/diverged are git jargon. Same treatment as SYNC_STATUS_LABEL: map
// the enum to a plain DISPLAY label. The machine `status` FIELD + --check/--json
// programmatic output are UNCHANGED (they read the stable enum) — labels are
// display-only. Unknown/future statuses fall back to a generic label rather than
// leaking the raw token.
const CHECK_STATUS_LABEL: Record<string, string> = {
  clean: "up to date",
  dirty: "unsaved",
  // A2a fix — a subscriber that is BOTH dirty AND behind. Primary label is
  // "unsaved" (the actionable local state); the pending receive count is
  // surfaced in the per-vault extras (see printCheckHuman) so the "to receive"
  // signal survives instead of being erased by the bare "dirty" classification.
  "dirty-behind": "unsaved",
  frozen: "paused",
  diverged: "to send & receive",
  // "local only" mirrors the write-path SYNC_STATUS_LABEL exactly, so `lyt sync`
  // and `lyt sync --check` name the no-remote state identically (release review).
  "no-upstream": "local only",
  // Statuses set DIRECTLY by syncCheckFlow, bypassing classifyCheckStatus
  // (sync-check.ts:92/111/132): a non-active vault's raw VaultStatus
  // (disconnected/tombstoned/access_lost), plus `missing` and `not-git-repo`.
  // `not-git-repo` carries the banned "git" noun as a raw token, so it MUST have a
  // plain label here; the rest get honest labels mirroring the write path instead
  // of the vague generic fallback (release review/F3 + R3). Without these, the
  // firewall was one fallback-refactor away from leaking "git" on `--check`.
  "not-git-repo": "not set up",
  missing: "missing",
  disconnected: "disconnected",
  tombstoned: "removed",
  access_lost: "no access",
  "remote-different": "online changed",
  "remote-unknown": "online status unknown",
};

// A status that represents pending sync work (unsaved / to send / to receive).
// Used to count DISTINCT needs-sync vaults for the summary headline (a vault
// may span two summary categories, so summing counters would double-count).
function isNeedsSyncStatus(status: string): boolean {
  return (
    status === "dirty" ||
    status === "dirty-behind" ||
    status === "diverged" ||
    /^ahead-\d+$/.test(status) ||
    /^behind-\d+$/.test(status)
  );
}

function checkStatusLabel(status: string): string {
  // ahead-N / behind-N embed a count in the enum — map to plain "N to send" /
  // "N to receive". Static statuses fall through to the table. A genuinely
  // unrecognized (future) status renders "unknown" — noun-free and honest, never
  // the raw token (which could carry a git noun).
  const ahead = /^ahead-(\d+)$/.exec(status);
  if (ahead) return `${ahead[1]} to send`;
  const behind = /^behind-(\d+)$/.exec(status);
  if (behind) return `${behind[1]} to receive`;
  return CHECK_STATUS_LABEL[status] ?? "unknown";
}

// Exported for the check-render-boundary test (flows-sync-check-render-boundary):
// it renders synthetic VaultCheckReport states through THIS function and asserts
// the human output carries zero git/gh plumbing noun — the charter's
// non-technical contract, enforced at the boundary the human reads.
export function printCheckHuman(
  reports: readonly VaultCheckReport[],
  summary: {
    clean: number;
    dirty: number;
    ahead: number;
    behind: number;
    diverged: number;
    frozen: number;
    noUpstream: number;
    skippedNonActive: number;
  },
): void {
  if (reports.length === 0) {
    // eslint-disable-next-line no-console
    console.log("lyt sync --check: no vaults found in registry.");
    return;
  }
  // Count DISTINCT vaults that need sync from the reports themselves — a single
  // vault can now span two summary categories (A2a's `dirty-behind` is counted
  // under both `dirty` and `behind`), so summing the category counters would
  // double-count it. For every pre-A2a status this distinct count equals the
  // former category sum (each vault landed in exactly one category), so the
  // headline number is unchanged for all existing states.
  const needsSync = reports.filter((r) => isNeedsSyncStatus(r.status)).length;
  // firewall-C1 completion — plain wording ("unsaved / to send / to receive")
  // instead of the git jargon "dirty / ahead / behind / diverged".
  const summaryLine =
    needsSync > 0
      ? `${needsSync} vault(s) need sync (${summary.dirty} unsaved, ${summary.ahead} to send, ${summary.behind} to receive, ${summary.diverged} to send & receive)`
      : "All vaults up to date";
  // eslint-disable-next-line no-console
  console.log(`lyt sync --check: ${summaryLine}`);
  if (summary.frozen > 0 || summary.noUpstream > 0 || summary.skippedNonActive > 0) {
    // firewall-C1 completion — "local only" replaces the raw "no-upstream" token
    // (the banned "upstream" noun) and matches the write-path label; "paused"
    // mirrors the per-vault label.
    // eslint-disable-next-line no-console
    console.log(
      `  ${summary.frozen} paused · ${summary.noUpstream} local only · ${summary.skippedNonActive} non-active`,
    );
  }
  for (const r of reports) {
    const extras: string[] = [];
    if (r.frozen && r.remaining) extras.push(`(${r.remaining} left)`);
    // firewall-C1 completion — diverged's plain label ("to send & receive") carries
    // no counts, so surface the split here. ahead-/behind- labels already embed
    // their own count (checkStatusLabel), so they need no extra. Reworded from the
    // raw `ahead=/behind=` git-plumbing form.
    // A2a fix — `dirty-behind` (dirty AND updates to receive) surfaces BOTH the
    // pending receive/send split AND the unsaved change count, so the "to
    // receive" signal is no longer erased by the bare "dirty" label.
    if (r.status === "diverged" || r.status === "dirty-behind") {
      const io: string[] = [];
      if (r.ahead > 0) io.push(`${r.ahead} to send`);
      if (r.behind > 0) io.push(`${r.behind} to receive`);
      if (io.length > 0) extras.push(io.join(" · "));
    }
    if (r.status === "dirty" || r.status === "dirty-behind")
      extras.push(`${r.dirtyCount} change(s)`);
    // eslint-disable-next-line no-console
    console.log(
      // padEnd(17) fits the longest label ("to send & receive") so the vault-name
      // column stays aligned (release review R2).
      ` ${checkStatusLabel(r.status).padEnd(17)} ${r.name}${extras.length > 0 ? " " + extras.join(" ") : ""}`,
    );
  }
}

export function printScopedCheckHuman(outcome: ScopedSyncCheckOutcome): void {
  if (outcome.kind === "refused") {
    // eslint-disable-next-line no-console
    console.error(`lyt sync --check: ${outcome.refusal.summary}`);
    // eslint-disable-next-line no-console
    console.error(`  ${outcome.refusal.nextAction}`);
    return;
  }
  const checked: ScopedVaultCheckReport = outcome.reports[0];
  const extras: string[] = [];
  if (checked.frozen && checked.remaining !== null) extras.push(`(${checked.remaining} left)`);
  if (checked.ahead !== null && checked.ahead > 0) extras.push(`${checked.ahead} to send`);
  if (checked.behind !== null && checked.behind > 0) extras.push(`${checked.behind} to receive`);
  if (checked.dirtyCount !== null && checked.dirtyCount > 0) {
    extras.push(`${checked.dirtyCount} change(s)`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `lyt sync --check: ${checkStatusLabel(checked.status)} — ${checked.name}` +
      (extras.length === 0 ? "" : ` (${extras.join(" · ")})`),
  );
}
