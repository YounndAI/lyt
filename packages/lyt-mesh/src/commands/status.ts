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

import type { VaultRow } from "@younndai/lyt-vault";

import { statusFlow, type StatusOutcome } from "../flows/status.js";

export type StatusFormat = "text" | "dot" | "json";

export function buildStatusCommand(): Command {
  const cmd = new Command("status");
  cmd
    .description(
      "Render the local mesh graph: vault list grouped by parent_vault subtrees. Pure registry read; no network.",
    )
    .option("--format <format>", "Output format: text | dot | json", "text")
    .action(async (opts: { format?: string }) => {
      const fmt = (opts.format ?? "text") as StatusFormat;
      if (fmt !== "text" && fmt !== "dot" && fmt !== "json") {
        process.stderr.write(`Unknown --format '${opts.format}'. Use one of: text, dot, json.\n`);
        process.exitCode = 1;
        return;
      }
      const outcome = await statusFlow();
      if (fmt === "json") {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }
      if (fmt === "dot") {
        // eslint-disable-next-line no-console
        console.log(renderDot(outcome));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(renderText(outcome));
    });
  return cmd;
}

function renderText(outcome: StatusOutcome): string {
  if (outcome.vaults.length === 0) {
    return "(no vaults registered — run 'lyt vault init <name>' or 'lyt mesh clone-all')";
  }
  const byRidHex = new Map<string, VaultRow>(outcome.vaults.map((v) => [v.ridHex, v]));
  const lines: string[] = [];
  const headers = ["NAME", "RID", "STATUS", "TIER_HINT", "PARENT"];
  type Row = readonly [string, string, string, string, string];
  const rows: Row[] = [];

  for (const cluster of outcome.clusters) {
    for (let i = 0; i < cluster.members.length; i++) {
      const ridHex = cluster.members[i]!;
      const v = byRidHex.get(ridHex);
      if (!v) continue;
      const indent = i === 0 ? "" : "  ";
      const tomb = v.status === "tombstoned" ? " [tombstoned]" : "";
      rows.push([
        `${indent}${v.name}${tomb}`,
        v.ridHex,
        v.status,
        v.tierHint ?? "",
        v.parentVaultHex ?? "",
      ]);
    }
  }

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const formatLine = (cols: readonly string[]): string =>
    cols
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join(" ")
      .trimEnd();
  lines.push(formatLine(headers));
  lines.push(formatLine(headers.map((h) => "-".repeat(h.length))));
  for (const r of rows) lines.push(formatLine(r));
  return lines.join("\n");
}

function renderDot(outcome: StatusOutcome): string {
  const byRidHex = new Map<string, VaultRow>(outcome.vaults.map((v) => [v.ridHex, v]));
  const lines: string[] = [
    "digraph mesh {",
    " rankdir=LR;",
    ' node [shape=box, fontname="Helvetica"];',
  ];

  for (const cluster of outcome.clusters) {
    const root = byRidHex.get(cluster.rootRid);
    if (!root) continue;
    lines.push(`  subgraph cluster_${safeId(root.ridHex)} {`);
    lines.push(`    label=${quote(root.name)};`);
    for (const ridHex of cluster.members) {
      const v = byRidHex.get(ridHex);
      if (!v) continue;
      const style = v.status === "tombstoned" ? "dashed" : "solid";
      lines.push(
        `    ${safeId(v.ridHex)} [label=${quote(v.name)}, tooltip=${quote(v.ridHex)}, style=${style}];`,
      );
    }
    lines.push("  }");
  }

  // Parent_vault subtree edges (the only edge surface in v1.A.1b).
  for (const v of outcome.vaults) {
    if (v.parentVaultHex === null) continue;
    if (!byRidHex.has(v.parentVaultHex)) continue;
    lines.push(` ${safeId(v.parentVaultHex)} -> ${safeId(v.ridHex)} [label="parent_vault"];`);
  }

  lines.push("}");
  return lines.join("\n");
}

function safeId(ridHex: string): string {
  return `n_${ridHex.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
