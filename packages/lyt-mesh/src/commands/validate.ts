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

import { validateFlow, type ValidateFinding, type ValidateOutcome } from "../flows/validate.js";

export function buildValidateCommand(): Command {
  const cmd = new Command("validate");
  cmd
    .description(
      "Check the mesh for dangling parent_vault FKs and tombstoned parents. Pure registry read; no network.",
    )
    .option("--json", "Emit machine-readable JSON")
    .option("--strict", "Exit non-zero when any findings are reported (CI-friendly)")
    .action(async (opts: { json?: boolean; strict?: boolean }) => {
      const outcome = await validateFlow();
      if (opts.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(outcome.findings, null, 2));
      } else {
        // eslint-disable-next-line no-console
        console.log(formatValidateTable(outcome));
      }
      if (opts.strict && outcome.findings.length > 0) {
        process.exitCode = 1;
      }
    });
  return cmd;
}

function formatValidateTable(outcome: ValidateOutcome): string {
  if (outcome.findings.length === 0) {
    return `(no issues found — ${outcome.totalVaults} vault(s), ${outcome.totalEdges} edge(s))`;
  }
  const headers = ["SOURCE", "EDGE", "TARGET", "ISSUE"];
  const rows = outcome.findings.map((f) => [
    f.sourceVaultName,
    f.declaredEdge,
    f.targetVaultRid,
    formatIssue(f),
  ]);
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

function formatIssue(f: ValidateFinding): string {
  switch (f.status) {
    case "dangling":
      return "dangling (target not in registry)";
    case "tombstoned-target":
      return "target is tombstoned";
  }
}
