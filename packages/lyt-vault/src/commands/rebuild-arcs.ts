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

import { ArcPositionCollisionError, rebuildArcsFlow } from "../flows/rebuild-arcs.js";

interface RebuildArcsCliOpts {
  vault?: string;
  json?: boolean;
}

// v1.D.2a — `lyt vault rebuild-arcs`.
//
// Manual entry point for the position-ordered narrative arcs index.
// Walks the vault's notes, harvests arc membership from both
// frontmatter `arcs:` fields and embedded YON @ARC/@ARC_MEMBER records
// in markdown bodies, resolves positions (manual wins; frontmatter
// auto-assigned skipping reserved slots), and writes
// `.lyt/indexes/arcs.yon` (YON SoT). Commit 2 (v1.D.2b) wires the
// libSQL cache half via `upsertArcsCache` invoked from inside the
// flow.
//
// default: this verb stays alongside the v1.D.2c automator
// wrapper (`lyt automator run arc-builder --run-now`) so the
// underlying flow has an evidence-of-life path independent of the
// automator runtime + so handlers can rebuild arcs synchronously when
// triaging.
//
// No `--threshold` flag (arcs are explicit declarations, not clustered
// — unlike lanes which gate on tag frequency).
//
// Lock 0.3 deterministic --json mode mirrors `lyt vault
// rebuild-lanes`. Position collisions surface as structured JSON
// errors (`{ error: 'position-collision', arc, position,
// conflicting_figments }`) per the ratified default.
export function buildRebuildArcsCommand(): Command {
  return new Command("rebuild-arcs")
    .description(
      "v1.D.2a: rebuild the position-ordered narrative arcs index from notes/**/*.md. Detects arc membership via frontmatter `arcs:` field AND embedded `@ARC` / `@ARC_MEMBER` records in markdown bodies. Writes `.lyt/indexes/arcs.yon` (YON SoT per Lock 0.2). Pair with `lyt sync` (post-pull arcs-cache upsert) or with `lyt automator run arc-builder --run-now` (v1.D.2c scheduled wrapper).",
    )
    .requiredOption("--vault <name>", "Vault name (must be registered)")
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (opts: RebuildArcsCliOpts) => {
      try {
        const result = await rebuildArcsFlow({
          ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Rebuilt arcs for '${result.vaultName}' at ${result.arcsYonPath}\n` +
            `  ${result.arcsWritten} arc(s); ${result.membersWritten} member(s); ${result.durationMs}ms.` +
            (result.warnings.length > 0
              ? `\n  warnings: ${result.warnings.length}\n    - ${result.warnings.join("\n    - ")}`
              : ""),
        );
      } catch (err) {
        if (err instanceof ArcPositionCollisionError) {
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.error(
              JSON.stringify(
                {
                  error: "position-collision",
                  arc: err.arc,
                  position: err.position,
                  conflicting_figments: err.conflictingFigments,
                },
                null,
                2,
              ),
            );
          } else {
            // eslint-disable-next-line no-console
            console.error(
              `lyt vault rebuild-arcs: position collision in ${err.arc} at position=${err.position}; ` +
                `conflicting figments: ${err.conflictingFigments.join(" vs ")}.`,
            );
          }
          process.exitCode = 1;
          return;
        }
        // eslint-disable-next-line no-console
        console.error(
          `lyt vault rebuild-arcs: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 2;
      }
    });
}
