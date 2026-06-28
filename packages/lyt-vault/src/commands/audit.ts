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

import { auditExportFlow } from "../flows/audit-export.js";

interface AuditExportCliOpts {
  since?: string;
  until?: string;
  vault?: string;
  output?: string;
  json?: boolean;
  quiet?: boolean;
}

export function buildAuditCommand(): Command {
  const audit = new Command("audit").description(
    "Audit-log tooling (export markdown windows; aggregate deferred to a future release).",
  );

  audit
    .command("export")
    .description(
      "Render a window of per-vault audit_log rows to a markdown file at .lyt/audit/<YYYY-MM>.md.",
    )
    .requiredOption("--since <date>", "Window start (YYYY-MM-DD or ISO-8601). Required.")
    .option("--until <date>", "Window end (default: now). YYYY-MM-DD or ISO-8601.")
    .option(
      "--vault <name>",
      "Vault to export from (default: every registered non-tombstoned vault).",
    )
    .option(
      "--output <path>",
      "Output file path (default: .lyt/audit/<YYYY-MM>.md in the resolved vault).",
    )
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .option("--quiet", "Suppress the git-add+commit guidance hint")
    .action(async (opts: AuditExportCliOpts) => {
      if (!opts.since) {
        throw new Error("`--since <date>` is required for `lyt audit export`.");
      }
      const result = await auditExportFlow({
        since: opts.since,
        ...(opts.until !== undefined ? { until: opts.until } : {}),
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        ...(opts.output !== undefined ? { output: opts.output } : {}),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `Exported ${result.rowsExported} audit row(s) to ${result.outputPath} (${result.byteCount} bytes).`,
      );
      if (opts.quiet !== true) {
        // eslint-disable-next-line no-console
        console.error(
          `\n  To share with other machines: git add ${result.outputPath} && git commit -m "audit: export ${result.windowStartISO.slice(0, 10)} → ${result.windowEndISO.slice(0, 10)}"`,
        );
      }
    });

  return audit;
}
