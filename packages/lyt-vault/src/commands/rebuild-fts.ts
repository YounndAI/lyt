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

import { rebuildFtsFlow } from "../flows/rebuild-fts.js";

interface RebuildFtsCliOpts {
  vault?: string;
  json?: boolean;
}

// v1.D.3a — `lyt vault rebuild-fts`.
//
// Manual entry point for the figment FTS5 cache. Walks
// `<vault>/notes/**/*.md`, strips frontmatter, and inserts each
// figment body into the `figment_fts` virtual table inside lyt.db.
//
// Unlike rebuild-lanes / rebuild-arcs, this verb does NOT write an
// intermediate YON SoT file — the markdown files on disk ARE the SoT
// and FTS5 holds the search-time cache directly over them. Lock 0.2
// is satisfied at the file-on-disk layer; the FTS5 table is fully
// regenerable from the same source any time.
//
// Lock 0.3 deterministic --json mode mirrors `lyt vault rebuild-arcs`
// + `lyt vault rebuild-lanes`. No --threshold flag (FTS5 indexes all
// non-empty bodies; there's no clustering to gate).
//
// No `--vault`-less mode in v1: cross-vault rebuild lives behind a
// future `lyt mesh rebuild-fts` per master-plan §v1.D.3+ (out of
// v1.D.3 scope).
export function buildRebuildFtsCommand(): Command {
  return new Command("rebuild-fts")
    .description(
      "Rebuild the figment FTS5 cache from notes/**/*.md. Strips YAML frontmatter and inserts each figment body into the lyt.db figment_fts virtual table (markdown files on disk are the SoT; FTS5 holds the regenerable search cache). Pair with `lyt sync` (post-pull fts upsert) or `lyt search` (the tiered cascade consumer).",
    )
    .requiredOption("--vault <name>", "Vault name (must be registered)")
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (opts: RebuildFtsCliOpts) => {
      try {
        const result = await rebuildFtsFlow({
          ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Rebuilt fts for '${result.vaultName}' at ${result.vaultPath}\n` +
            `  ${result.ftsDocsInserted} figment(s) indexed; ${result.durationMs}ms.` +
            (result.ran ? "" : "  (notes/ empty or absent — no-op.)"),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`lyt vault rebuild-fts: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}
