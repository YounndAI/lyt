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
  connectPodFlow,
  podNeedsConnect,
  reconcilePublishFlow,
  syncPodLedgerFlow,
  withSpinner,
  type ConnectPodResult,
  type ReconcilePublishResult,
  type SyncPodLedgerResult,
} from "@younndai/lyt-vault";

import { syncCheckFlow, type VaultCheckReport } from "../flows/sync-check.js";
import { syncFlow, type VaultSyncReport } from "../flows/sync.js";
import { syncWatchFlow } from "../flows/sync-watch.js";

export function buildSyncCommand(): Command {
  const cmd = new Command("sync");
  cmd
    .description(
      "Sync registered active vaults with their remotes (commit + push + pull --rebase). Use --watch for a foreground daemon, --check for read-only freshness reporting.",
    )
    .option("--check", "Report per-vault freshness without writing. Pairs with --json or --quiet.")
    .option("--json", "With --check, emit JSON instead of human-readable output.")
    .option("--quiet", "With --check, emit nothing; exit code only (0 clean, 1 needs-sync).")
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
      "Skip the federation publish pass (regen pod.yon + create-missing repos + push pod). Local sync only.",
    )
    .option(
      "--message <msg>",
      "Override the per-vault commit message (e.g. an agent-supplied semantic summary). When omitted, a deterministic metadata-driven message is built from git status + figment titles (no LLM).",
    )
    .action(async (opts: SyncCliOpts) => {
      if (opts.check === true && opts.watch === true) {
        // eslint-disable-next-line no-console
        console.error("lyt sync: --check and --watch are mutually exclusive.");
        process.exit(1);
      }
      if (opts.check === true) {
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
        }
        printCheckHuman(result.reports, result.summary);
        process.exit(result.exitCode);
      }
      if (opts.watch === true) {
        const handle = await syncWatchFlow({
          commitDebounceMs: numericOpt(opts.commitDebounce),
          resolveMeshContext: opts.resolveMeshContext === true,
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
      const syncArgs = {
        resolveMeshContext: opts.resolveMeshContext === true,
        ...(opts.message !== undefined ? { message: opts.message } : {}),
      };
      const result =
        opts.json !== true && opts.quiet !== true
          ? await withSpinner("", () => syncFlow(syncArgs), { op: "sync" })
          : await syncFlow(syncArgs);
      printSyncHuman(result.reports);
      // Arc §10.4 friction-capture nudge — silent in JSON/quiet modes
      // (handler-shaped only). Hints are derived in syncFlow; the command
      // owns the emission policy so machine-readable callers stay clean.
      if (opts.json !== true && opts.quiet !== true && result.frictionHints.length > 0) {
        for (const hint of result.frictionHints) {
          // eslint-disable-next-line no-console
          console.error(`  > ${hint.message}`);
        }
      }

      // Brief D (D.3) — `lyt sync` SELF-HEALS to connect a local-first
      // pod (no separate `lyt connect` verb). When the pod is provisional
      // (local-only), reconcile it to the real gh handle (guide auth → resolve →
      // remap-state → create pod repo + wire remote) BEFORE the publish pass.
      // The D.3-GUARD surfaces an existing-remote collision as an HIL (adopt
      // default) and DOES NOT blind-push (nothing overwritten). gh-unauthed and
      // the guard both DEFER publish (not a failure — a clear next step).
      let connectDeferredPublish = false;
      if (opts.publish !== false && (await podNeedsConnect())) {
        const connect = await connectPodFlow({
          confirmAdoptExistingRemote: async ({ existingRemote }) => {
            // Non-TTY → default adopt (the safe, non-destructive choice).
            if (process.stdin.isTTY !== true) return true;
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              const ans = (
                await rl.question(
                  `\nYou already have a pod on GitHub (${existingRemote}). Adopt it? ` +
                    `Your local notes are preserved on disk (nothing is overwritten). [Y/n]: `,
                )
              )
                .trim()
                .toLowerCase();
              return ans === "" || ans === "y" || ans === "yes";
            } finally {
              rl.close();
            }
          },
        });
        if (opts.json !== true && opts.quiet !== true) {
          printConnectHuman(connect);
        }
        // reconciled → fall through to publish the now-connected pod. Any other
        // status (gh-unauthed, guard-existing-remote, no-pod, invalid handle)
        // defers the outward publish this run — no clobber, clear next step.
        if (connect.status !== "reconciled") connectDeferredPublish = true;
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
      if (opts.publish !== false && !connectDeferredPublish) {
        podLedger = await syncPodLedgerFlow({ push: true });
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
      if (opts.publish !== false && !connectDeferredPublish) {
        publish = await reconcilePublishFlow({ push: true });
        if (opts.json !== true && opts.quiet !== true) {
          printPublishHuman(publish);
        }
      }

      const syncOk = result.ok;
      const publishOk = publish === undefined || publish.skipped || publish.ok;
      const podLedgerOk =
        podLedger === undefined ||
        podLedger.status === "skipped" ||
        podLedger.status === "synced";
      process.exit(syncOk && publishOk && podLedgerOk ? 0 : 1);
    });
  return cmd;
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
}

function numericOpt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function printSyncHuman(reports: readonly VaultSyncReport[]): void {
  if (reports.length === 0) {
    // eslint-disable-next-line no-console
    console.log("lyt sync: no vaults found in registry.");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`lyt sync: ${reports.length} vault(s) processed`);
  for (const r of reports) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.status.padEnd(20)} ${r.name}: ${r.message}`);
  }
}

// Brief D (D.3) — surface the connect self-heal outcome. "not-needed"/"no-pod"
// are silent (a normal `lyt sync` on a connected pod must stay quiet). Other
// statuses carry an actionable handler message.
function printConnectHuman(c: ConnectPodResult): void {
  if (c.status === "not-needed" || c.status === "no-pod") return;
  // eslint-disable-next-line no-console
  console.log(`lyt sync (connect): ${c.message}`);
  for (const w of c.warnings) {
    // eslint-disable-next-line no-console
    console.error(`  > ${w}`);
  }
}

function printPublishHuman(p: ReconcilePublishResult): void {
  if (p.skipped) {
    if (p.reason !== "no-single-pod" && p.reason !== "no-federation-state") {
      // eslint-disable-next-line no-console
      console.log(`lyt sync (publish): skipped — ${p.reason ?? "no pod"}`);
    }
    return;
  }
  const pushedVaults = p.vaultOutcomes.filter((o) => o.pushed).length;
  // eslint-disable-next-line no-console
  console.log(
    `lyt sync (publish): ${pushedVaults}/${p.vaultOutcomes.length} vault(s) pushed · pod ${p.podPushed ? "pushed" : "not pushed"}`,
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
function printPodLedgerHuman(p: SyncPodLedgerResult): void {
  if (p.status === "skipped") {
    if (p.reason !== "no-single-pod" && p.reason !== "no-federation-state") {
      // eslint-disable-next-line no-console
      console.log(`lyt sync (ledger): skipped — ${p.reason ?? "no pod"}`);
    }
    return;
  }
  const parts: string[] = [];
  if (p.pulled) parts.push("pulled");
  if (p.committed) parts.push("committed");
  if (p.pushed) parts.push("pushed");
  if (p.reconstituted) parts.push(`reconstituted ${p.subscriptionsReconstituted} sub(s)`);
  const detail = parts.length > 0 ? parts.join(" · ") : "up to date";
  // eslint-disable-next-line no-console
  console.log(`lyt sync (ledger): ${p.status} — ${detail}`);
  for (const w of p.warnings) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ ${w}`);
  }
}

function printCheckHuman(
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
  const needsSync = summary.dirty + summary.ahead + summary.behind + summary.diverged;
  const summaryLine =
    needsSync > 0
      ? `${needsSync} vault(s) need sync (${summary.dirty} dirty, ${summary.ahead} ahead, ${summary.behind} behind, ${summary.diverged} diverged)`
      : "All vaults clean";
  // eslint-disable-next-line no-console
  console.log(`lyt sync --check: ${summaryLine}`);
  if (summary.frozen > 0 || summary.noUpstream > 0 || summary.skippedNonActive > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${summary.frozen} frozen · ${summary.noUpstream} no-upstream · ${summary.skippedNonActive} non-active`,
    );
  }
  for (const r of reports) {
    const extras: string[] = [];
    if (r.frozen && r.remaining) extras.push(`(${r.remaining} left)`);
    if (
      r.status.startsWith("ahead-") ||
      r.status.startsWith("behind-") ||
      r.status === "diverged"
    ) {
      extras.push(`ahead=${r.ahead} behind=${r.behind}`);
    }
    if (r.status === "dirty") extras.push(`${r.dirtyCount} change(s)`);
    // eslint-disable-next-line no-console
    console.log(
      ` ${r.status.padEnd(14)} ${r.name}${extras.length > 0 ? " " + extras.join(" ") : ""}`,
    );
  }
}
