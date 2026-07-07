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
export function printConnectHuman(c: ConnectPodResult): void {
  if (c.status === "not-needed" || c.status === "no-pod") return;
  // eslint-disable-next-line no-console
  console.log(`lyt sync (connect): ${c.message}`);
  for (const w of c.warnings) {
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
      const label = p.reason !== undefined ? (PUBLISH_SKIP_LABEL[p.reason] ?? "nothing to publish") : "nothing to publish";
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
      const label = p.reason !== undefined ? (LEDGER_SKIP_LABEL[p.reason] ?? "nothing to sync") : "nothing to sync";
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
};

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
  const needsSync = summary.dirty + summary.ahead + summary.behind + summary.diverged;
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
    if (r.status === "diverged") {
      const io: string[] = [];
      if (r.ahead > 0) io.push(`${r.ahead} to send`);
      if (r.behind > 0) io.push(`${r.behind} to receive`);
      if (io.length > 0) extras.push(io.join(" · "));
    }
    if (r.status === "dirty") extras.push(`${r.dirtyCount} change(s)`);
    // eslint-disable-next-line no-console
    console.log(
      // padEnd(17) fits the longest label ("to send & receive") so the vault-name
      // column stays aligned (release review R2).
      ` ${checkStatusLabel(r.status).padEnd(17)} ${r.name}${extras.length > 0 ? " " + extras.join(" ") : ""}`,
    );
  }
}
