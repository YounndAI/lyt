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

import { DEFAULT_LANE_THRESHOLD, rebuildLanesFlow } from "../flows/rebuild-lanes.js";

interface RebuildLanesCliOpts {
  vault?: string;
  threshold?: string;
  json?: boolean;
}

// v1.D.1a — `lyt vault rebuild-lanes`.
//
// Manual entry point for the tag-frequency lanes index. Walks the vault's
// notes, clusters by tag frequency (each tag with ≥threshold member notes
// becomes a lane), writes `.lyt/indexes/lanes.yon` (YON SoT) + upserts the
// cache rows in lyt.db (v1.D.1b wires the cache half).
//
// OD-3 default: this verb stays alongside the v1.D.1c automator wrapper
// (`lyt automator run lane-builder --run-now`) so the underlying flow has
// an evidence-of-life path independent of the automator runtime + so
// handlers can rebuild lanes synchronously when triaging.
//
// Lock 0.3 deterministic --json mode mirrors `lyt vault rebuild-index`.
export function buildRebuildLanesCommand(): Command {
  return new Command("rebuild-lanes")
    .description(
      "v1.D.1a: rebuild the tag-frequency lanes index from notes/**/*.md frontmatter tags. Writes `.lyt/indexes/lanes.yon` (YON SoT per Lock 0.2) — each tag with ≥threshold member notes becomes a @LANE record + @LANE_MEMBER rows. Pair with `lyt sync` (post-pull lanes-cache upsert) or with `lyt automator run lane-builder --run-now` (v1.D.1c scheduled wrapper).",
    )
    .requiredOption("--vault <name>", "Vault name (must be registered)")
    .option(
      "--threshold <int>",
      `Minimum note count per tag to form a lane (default ${DEFAULT_LANE_THRESHOLD})`,
    )
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (opts: RebuildLanesCliOpts) => {
      let threshold: number | undefined;
      if (opts.threshold !== undefined) {
        const parsed = Number.parseInt(opts.threshold, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          // eslint-disable-next-line no-console
          console.error(
            `lyt vault rebuild-lanes: --threshold must be a positive integer; got '${opts.threshold}'.`,
          );
          process.exitCode = 2;
          return;
        }
        threshold = parsed;
      }
      const result = await rebuildLanesFlow({
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `Rebuilt lanes for '${result.vaultName}' at ${result.lanesYonPath}\n` +
          `  ${result.lanesWritten} lane(s); ${result.membersWritten} member(s); threshold=${result.threshold}; ${result.durationMs}ms.`,
      );
    });
}
