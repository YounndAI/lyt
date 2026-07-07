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

// `lyt vault reconcile <name> [--apply]` — Phase D (0.10.0 frontmatter lane, SC7).
//
// Makes a vault's DISK and its search INDEX agree, across two drift axes:
//   1. missing-frontmatter — figments on disk that violate the 8-field contract
//      (a raw agent/hand-dropped note, `testus/cats.md`). Heal = backfill.
//   2. present-but-unindexed — figments on disk the FTS index does not carry (a
//      raw `.md` copied in that never went through capture/reindex → search
//      misses it). Heal = reindex.
//
// DEFAULT is detect-only (report the two drift sets, mutate nothing). `--apply`
// heals: it runs the metadata-filler automator (fills missing frontmatter) THEN
// reindexes the vault (indexes the present-but-unindexed AND re-indexes the freshly
// backfilled figments), then RE-SCANS so the output reflects verified post-heal
// reality, not an assumption. Backfill-before-reindex ordering is load-bearing: a
// raw figment is filled first so the index row it gets carries real frontmatter.
//
// KNOWN LIMITATION — topic-enrich reads a possibly-STALE index (Phase E release review
// FIX 5, DEFERRED). The metadata-filler's Phase-E topic enrichment reads the vault's
// EXISTING topic labels from the search index (listDistinctTopics over figment_meta)
// to classify against. Because backfill runs BEFORE the post-backfill reindex, that
// read sees the index as it stood at reconcile START — so on a HYBRID vault whose
// index is stale (topics authored on disk but not yet indexed), classify may miss
// some current labels and leave a topic blank that a fresh index would have assigned.
// This is a genuine tension with the load-bearing backfill-before-reindex ordering
// (which exists so the backfilled FRONTMATTER lands in the index): naively adding a
// reindex BEFORE the enrich-read would risk the Phase-D detect/heal contract this
// path was cold-reviewed against (a review finding), so it is NOT forced here. It is a
// narrow-impact gap: it affects ONLY hybrid-vault topic freshness, and topic-on-
// import (pure cold import) is descoped anyway (tags enrich index-free; topic
// seeding is a fast-follow). Fix candidate for the fast-follow: a pre-enrich reindex
// of just the present-but-unindexed set, or reading topics from disk rather than the
// index. Tags are UNAFFECTED (model-free, index-free).
//
// Lives in the meta CLI because the heal runs an automator (lyt-runner). Attached
// to the lyt-vault `vault` parent in cli.ts. The DETECT scan itself lives in
// lyt-vault (reconcileVaultScan) — pure + runner-free. C13: NOT `lyt repair`.

import { Command } from "commander";

import { reconcileVaultScan, reindexFlow, type ReconcileScan } from "@younndai/lyt-vault";

import { runAutomator } from "../automator-run.js";

interface ReconcileCliOpts {
  apply?: boolean;
  push?: boolean;
  json?: boolean;
}

function driftCount(scan: ReconcileScan): number {
  return scan.missingFrontmatter.length + scan.unindexed.length;
}

export function buildReconcileCommand(): Command {
  return new Command("reconcile")
    .description(
      "Detect (and with --apply, heal) drift between a vault's markdown on disk and its search index: figments with missing frontmatter (→ backfilled) and figments not yet indexed (→ reindexed). Detect-only by default. NOT `lyt repair`.",
    )
    .argument("<name>", "Vault name to reconcile (must be registered)")
    .option("--apply", "Heal the detected drift (backfill missing frontmatter, then reindex)")
    .option("--push", "With --apply, also git-commit + push the backfilled frontmatter (default: local only)")
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (name: string, opts: ReconcileCliOpts) => {
      const before = await reconcileVaultScan(name);

      let healed: { backfilled: boolean; reindexed: boolean } | undefined;
      let after: ReconcileScan | undefined;

      if (opts.apply === true && driftCount(before) > 0) {
        // 1. Backfill missing frontmatter FIRST (only when there is any) so the
        //    subsequent reindex picks up real frontmatter, not a raw body. Default
        //    noPush (local commit only) — honors the pod push-gate; --push opts in.
        // (release review/a review finding). NOTE (a review finding, tracked #1): the filler has
        //    no writable/subscriber gate — a whole-vault write can land on a
        //    subscribed vault's local clone; --push-off caps the blast radius local.
        let backfilled = false;
        if (before.missingFrontmatter.length > 0) {
          let fill;
          try {
            fill = await runAutomator({
              automator: "metadata-filler",
              vault: name,
              ...(opts.push !== true ? { noPush: true } : {}),
            });
          } catch (err) {
            emit(
              opts,
              before,
              healed,
              after,
              `backfill errored: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exit(1);
          }
          if (!fill.ok) {
            emit(opts, before, healed, after, `backfill failed: ${fill.errorSummary ?? "unknown"}`);
            process.exit(1);
          }
          backfilled = true;
        }
        // 2. Reindex the vault — indexes present-but-unindexed figments AND
        //    re-indexes the freshly backfilled ones (single content-tier rebuild).
        await reindexFlow({ scope: "vault", target: name });
        healed = { backfilled, reindexed: true };
        // 3. Re-scan so the reported result is verified post-heal reality.
        after = await reconcileVaultScan(name);
      }

      emit(opts, before, healed, after, null);
    });
}

function emit(
  opts: ReconcileCliOpts,
  before: ReconcileScan,
  healed: { backfilled: boolean; reindexed: boolean } | undefined,
  after: ReconcileScan | undefined,
  errorNote: string | null,
): void {
  const final = after ?? before;
  const payload = {
    vault: { name: before.vaultName, path: before.vaultPath },
    applied: healed !== undefined,
    index_present: before.indexPresent,
    target_version: before.targetVersion,
    before: {
      scanned: before.scanned,
      missing_frontmatter: before.missingFrontmatter.length,
      unindexed: before.unindexed.length,
      version_behind: before.behind.length,
      missing_frontmatter_samples: before.missingFrontmatter.slice(0, 20),
      unindexed_samples: before.unindexed.slice(0, 20),
      version_behind_samples: before.behind.slice(0, 20),
    },
    ...(healed !== undefined
      ? {
          healed,
          after: {
            missing_frontmatter: final.missingFrontmatter.length,
            unindexed: final.unindexed.length,
          },
        }
      : {}),
    ...(errorNote !== null ? { error: errorNote } : {}),
  };

  if (opts.json === true) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push(`reconcile ${before.vaultName} (${before.scanned} figment(s) on disk):`);
  lines.push(
    `  missing frontmatter: ${before.missingFrontmatter.length}` +
      (before.missingFrontmatter.length > 0
        ? ` — ${before.missingFrontmatter
            .slice(0, 10)
            .map((i) => i.relPath)
            .join(", ")}${before.missingFrontmatter.length > 10 ? " …" : ""}`
        : ""),
  );
  lines.push(
    `  not indexed:         ${before.unindexed.length}` +
      (before.indexPresent ? "" : " (index not built yet)") +
      (before.unindexed.length > 0
        ? ` — ${before.unindexed.slice(0, 10).join(", ")}${before.unindexed.length > 10 ? " …" : ""}`
        : ""),
  );
  // Read-only migration axis: Figments behind the contract version. Empty at v1
  // (nothing is behind the baseline); the write-apply heal rides Phase A, so this
  // is surfaced but NOT counted in driftCount (which gates the backfill/reindex).
  if (before.behind.length > 0) {
    lines.push(
      `  behind contract v${before.targetVersion}: ${before.behind.length}` +
        ` — ${before.behind
          .slice(0, 10)
          .map((c) => c.relPath)
          .join(", ")}${before.behind.length > 10 ? " …" : ""}`,
    );
  }

  if (healed !== undefined && after !== undefined) {
    lines.push(
      `  → healed: ${healed.backfilled ? "backfilled frontmatter, " : ""}reindexed. ` +
        `Now: ${after.missingFrontmatter.length} missing frontmatter, ${after.unindexed.length} unindexed.`,
    );
  } else if (driftCount(before) > 0) {
    lines.push(
      `  → run \`lyt vault reconcile '${before.vaultName}' --apply\` to backfill + reindex.`,
    );
  } else {
    lines.push("  → disk and index are in sync (nothing to do).");
  }
  if (errorNote !== null) lines.push(`  ✗ ${errorNote}`);

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}
