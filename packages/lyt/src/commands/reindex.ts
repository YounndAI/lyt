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

import {
  reindexFlow,
  withSpinner,
  startSpinner,
  isEmbeddingsInteractive,
  embeddingsPhaseLabel,
  formatDownloadProgress,
  formatEmbedProgress,
  buildReindexJson,
  type ReindexScope,
  type EmbeddingsBuildProgress,
  type PhaseSpinnerHandle,
} from "@younndai/lyt-vault";

interface ReindexCliOpts {
  all?: boolean;
  mesh?: string;
  vault?: string;
  threshold?: string;
  json?: boolean;
}

// Lane V Phase 0 (0.5 / CLI gaps C1+C2) — `lyt reindex`.
//
// Pod / mesh / vault-wide all-content-tier reindex. The umbrella over
// `lyt vault rebuild` (one vault, all tiers), which is itself the umbrella over
// the four `lyt vault rebuild-*` verbs. Top-level (like `lyt search` / `lyt
// primer`) because its default mental model is pod-wide, not single-vault.
// NOT `lyt vault rebuild-index` (a vault's destructive schema reset — C4).
export function buildReindexCommand(): Command {
  return new Command("reindex")
    .description(
      "Rebuild ALL content-tier caches (lanes + arcs + fts + rollup) across a scope: --all (whole pod), --mesh <name>, or --vault <name>. The pod/mesh-wide umbrella over `lyt vault rebuild`.",
    )
    .option("--all", "Reindex every registered vault in the pod")
    .option("--mesh <name>", "Reindex every vault in the named mesh")
    .option("--vault <name>", "Reindex a single named vault")
    .option("--threshold <n>", "Lane clustering threshold (default 2)")
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (opts: ReindexCliOpts) => {
      try {
        const scope = resolveScope(opts);
        const threshold =
          opts.threshold !== undefined ? Number.parseInt(opts.threshold, 10) : undefined;
        // C-1 — the build path may prompt + visibly fetch the one-time local model
        // ONLY from an interactive terminal: BOTH stdin AND stdout a real TTY,
        // AND not --json (a --json run is machine-consumed, so it must stay
        // non-interactive/no-fetch). stdin must be a TTY too — the prompt reads
        // process.stdin, so `lyt reindex < /dev/null` (redirected stdin, TTY
        // stdout) must NOT prompt nor fetch (release review Major fold).
        const embeddingsInteractive = isEmbeddingsInteractive({
          json: opts.json,
          stdinTTY: process.stdin.isTTY === true,
          stdoutTTY: process.stdout.isTTY === true,
        });
        // Phase E Unit 2 — drive the embeddings-build phase labels
        // (fetch → index → ready / offline-deferred / timed-out) + live
        // download/embed lines on the phase-spanning spinner. HUMAN STDOUT ONLY:
        // wired ONLY when embeddingsInteractive (a real interactive TTY, not
        // --json) — exactly the path that may prompt + visibly fetch. A --json
        // run / non-TTY leaves this undefined → byte-stable, no spinner.
        // (phaseSpinner is assigned below, before reindexFlow runs; the reporter
        // reads it lazily via the getter, so the binding is always set by call time.)
        let phaseSpinner: PhaseSpinnerHandle | undefined;
        const embeddingsProgress: EmbeddingsBuildProgress | undefined = embeddingsInteractive
          ? makeEmbeddingsProgress(() => phaseSpinner)
          : undefined;
        const reindexArgs = {
          scope: scope.scope,
          ...(scope.target !== undefined ? { target: scope.target } : {}),
          ...(threshold !== undefined && Number.isFinite(threshold) ? { threshold } : {}),
          ...(embeddingsInteractive ? { embeddingsInteractive: true } : {}),
          ...(embeddingsProgress !== undefined ? { embeddingsProgress } : {}),
        };
        // V-DX-1 — liveness spinner over the multi-vault reindex window.
        // --json stays spinner-free; non-TTY prints "Reindexing…" once.
        // Phase E — when the embeddings build can surface phase labels
        // (interactive TTY), use a phase-spanning startSpinner so the reporter
        // can re-label it (fetch/index/ready); otherwise keep the simple
        // withSpinner liveness wrap.
        let result;
        if (opts.json === true) {
          result = await reindexFlow(reindexArgs);
        } else if (embeddingsInteractive) {
          phaseSpinner = startSpinner();
          phaseSpinner.phase("reindex", scope.target ?? scope.scope);
          try {
            result = await reindexFlow(reindexArgs);
          } finally {
            phaseSpinner.stop();
          }
        } else {
          result = await withSpinner(scope.target ?? scope.scope, () => reindexFlow(reindexArgs), {
            op: "reindex",
          });
        }
        if (opts.json === true) {
          // Phase E Unit 3 — emit the VERSIONED envelope (schemaVersion +
          // model + index [+ nudge]) built by the shared builder, NOT the raw
          // flow result. The agent skill parses this exact shape via the shared
          // ReindexJsonSchema (single source → no drift). reindex runs no nudge
          // surface, so `nudge` is absent (optional).
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(buildReindexJson(result), null, 2));
          return;
        }
        if (result.vaultsReindexed === 0 && result.vaultsSkippedFrozen.length === 0) {
          // eslint-disable-next-line no-console
          console.log("reindex: no vaults in scope (nothing to do).");
          return;
        }
        const head = `Reindexed ${result.vaultsReindexed} vault(s) [${result.scope}${result.target !== null ? ` ${result.target}` : ""}] in ${result.durationMs}ms:`;
        const lines = [head];
        // hardening pass follow-through (release review): batch scopes skip
        // frozen vaults instead of aborting the sweep — say which, loudly.
        for (const s of result.vaultsSkippedFrozen) {
          lines.push(
            `  ❄ ${s.name}: skipped (frozen until ${s.frozenUntil ?? "<unknown>"}) — run 'lyt vault unfreeze ${s.name}' then re-run, or reindex it alone with --vault.`,
          );
        }
        for (const v of result.vaults) {
          lines.push(
            `  ${v.vaultName}: lanes ${v.lanes.lanesWritten} · arcs ${v.arcs.arcsWritten} · fts ${v.fts.ftsDocsInserted} · rollup ${v.rollup.rollupRowsWritten}`,
          );
          // F15 — say so loudly when a corrupt index was quarantined; the
          // rebuild above ran on a fresh schema and the old file is kept
          // beside it for inspection.
          if (v.indexQuarantinedTo !== null) {
            lines.push(
              `  ⚠ ${v.vaultName}: corrupt index quarantined → ${v.indexQuarantinedTo}; rebuilt fresh.`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join("\n"));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`lyt reindex: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}

// Phase E Unit 2 — build the embeddings-build progress reporter that
// re-labels the phase-spanning spinner with the honest fetch/index/ready labels
// + the live download/embed lines. Takes a getter for the spinner so it stays
// valid across the (later-assigned) handle. Human-stdout only — only constructed
// on the interactive path (the caller never wires it under --json/non-TTY).
function makeEmbeddingsProgress(
  getSpinner: () => PhaseSpinnerHandle | undefined,
): EmbeddingsBuildProgress {
  return {
    onPhase: (phase) => {
      getSpinner()?.phase("reindex", embeddingsPhaseLabel(phase));
    },
    onDownload: (bytesDone, totalBytes) => {
      getSpinner()?.phase("reindex", formatDownloadProgress(bytesDone, totalBytes));
    },
    onEmbed: (done, total) => {
      getSpinner()?.phase("reindex", formatEmbedProgress(done, total));
    },
  };
}

function resolveScope(opts: ReindexCliOpts): { scope: ReindexScope; target?: string } {
  const chosen: ReindexScope[] = [];
  if (opts.all === true) chosen.push("all");
  if (opts.mesh !== undefined) chosen.push("mesh");
  if (opts.vault !== undefined) chosen.push("vault");
  if (chosen.length === 0) {
    throw new Error("specify exactly one scope: --all, --mesh <name>, or --vault <name>.");
  }
  if (chosen.length > 1) {
    throw new Error(`specify exactly one scope; got ${chosen.join(" + ")}.`);
  }
  if (opts.all === true) return { scope: "all" };
  if (opts.mesh !== undefined) return { scope: "mesh", target: opts.mesh };
  return { scope: "vault", target: opts.vault! };
}
