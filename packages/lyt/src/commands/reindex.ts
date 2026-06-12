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

import { reindexFlow, withSpinner, type ReindexScope } from "@younndai/lyt-vault";

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
        const reindexArgs = {
          scope: scope.scope,
          ...(scope.target !== undefined ? { target: scope.target } : {}),
          ...(threshold !== undefined && Number.isFinite(threshold) ? { threshold } : {}),
        };
        // V-DX-1 — liveness spinner over the multi-vault reindex window.
        // --json stays spinner-free; non-TTY prints "Reindexing…" once.
        const result =
          opts.json !== true
            ? await withSpinner(scope.target ?? scope.scope, () => reindexFlow(reindexArgs), {
                op: "reindex",
              })
            : await reindexFlow(reindexArgs);
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
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
