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

import { addSource, listSources, removeSource, withRegistry } from "../source/repo.js";
import { parseScope, serializeScope, type VaultSourceRow } from "../source/types.js";

export function buildSourceCommand(): Command {
  const cmd = new Command("source");
  cmd.description("Manage VaultSource records (where Lyt looks for vaults to clone)");

  const add = new Command("add");
  add
    .description("Register a new vault source")
    .argument("<name>", "Soft label for this source (e.g. 'younndai', 'acme', 'personal')")
    .requiredOption("--host <host>", "Git host hostname (e.g. github.com)")
    .requiredOption("--owner <owner>", "Org or user under that host (e.g. younndai)")
    .option(
      "--scope <scope>",
      "Which repos count: 'all' | 'topic=<tag>' | 'repos=<a,b,c>'",
      "topic=lyt-vault",
    )
    .action(async (name: string, opts: { host: string; owner: string; scope: string }) => {
      const scope = parseScope(opts.scope);
      const row = await withRegistry((db) =>
        addSource(db, { name, host: opts.host, owner: opts.owner, scope }),
      );
      // eslint-disable-next-line no-console
      console.log(
        `Added source '${row.name}' (${row.host}/${row.owner}, scope=${serializeScope(row.scope)}).`,
      );
    });
  cmd.addCommand(add);

  const list = new Command("list");
  list
    .description("List configured vault sources")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts: { json?: boolean }) => {
      const sources = await withRegistry(listSources);
      if (opts.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              sources: sources.map((s) => ({ ...s, scope: serializeScope(s.scope) })),
            },
            null,
            2,
          ),
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(formatSourceTable(sources));
    });
  cmd.addCommand(list);

  const remove = new Command("remove");
  remove
    .description("Remove a configured vault source by name")
    .argument("<name>", "Source name")
    .action(async (name: string) => {
      const removed = await withRegistry((db) => removeSource(db, name));
      if (!removed) {
        // eslint-disable-next-line no-console
        console.log(`No source named '${name}'.`);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Removed source '${name}'.`);
    });
  cmd.addCommand(remove);

  return cmd;
}

function formatSourceTable(sources: readonly VaultSourceRow[]): string {
  if (sources.length === 0) {
    return "(no vault sources configured — run 'lyt mesh source add <name> --host <host> --owner <owner>')";
  }
  const headers = ["NAME", "HOST", "OWNER", "SCOPE", "ADDED"];
  const rows = sources.map((s) => [s.name, s.host, s.owner, serializeScope(s.scope), s.addedAt]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cols: readonly string[]): string =>
    cols
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join(" ")
      .trimEnd();
  return [line(headers), line(headers.map((h) => "-".repeat(h.length))), ...rows.map(line)].join(
    "\n",
  );
}
