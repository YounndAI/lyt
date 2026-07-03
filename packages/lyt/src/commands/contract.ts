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

// Phase B (frontmatter-contract lane, slice 1) — `lyt contract`.
//
// Surfaces the machine-readable frontmatter Source-of-Truth
// (FRONTMATTER_CONTRACT) so downstream slices (capture --dir, topic picker,
// MCP capture-tool schema, agent-manual generation) — and any agent — can read
// ONE canonical field list instead of re-hand-coding it. The descriptor lives in
// @younndai/lyt-vault (data-layer ownership per contract.ts); this is the
// CLI-surface adapter, mirroring the search/primer/reindex top-level pattern.
//
//   --json     → emit FRONTMATTER_CONTRACT verbatim as a versioned JSON envelope
//                (the drift test asserts this equals the descriptor).
//   --explain  → readable field table + the author-supplied / default / mandatory
//                rules (default human mode; --explain is accepted as an explicit
//                synonym).

import { Command } from "commander";

import {
  FRONTMATTER_CONTRACT,
  FRONTMATTER_CONTRACT_VERSION,
  DEFAULT_MESH_VISIBILITY,
  DEFAULT_WEIGHT,
  MANDATORY_FRONTMATTER_TOKENS,
  type FrontmatterContractField,
} from "@younndai/lyt-vault";

interface ContractCliOpts {
  json?: boolean;
  explain?: boolean;
}

/** The versioned JSON envelope emitted by `--json`. Stable machine surface. */
export interface FrontmatterContractJson {
  contractVersion: number;
  fields: readonly FrontmatterContractField[];
  mandatoryTokens: readonly string[];
  defaults: {
    "mesh-visibility": string;
    weight: string;
  };
}

/** Build the `--json` envelope from the SoT descriptor (no parallel data). */
export function buildContractJson(): FrontmatterContractJson {
  return {
    contractVersion: FRONTMATTER_CONTRACT_VERSION,
    fields: FRONTMATTER_CONTRACT,
    mandatoryTokens: MANDATORY_FRONTMATTER_TOKENS,
    defaults: {
      "mesh-visibility": DEFAULT_MESH_VISIBILITY,
      weight: DEFAULT_WEIGHT,
    },
  };
}

/** Render the human-readable field table + rules from the SoT descriptor. */
export function renderContractExplain(): string {
  const lines: string[] = [];
  lines.push(`yai.lyt frontmatter contract — v${FRONTMATTER_CONTRACT_VERSION}`);
  lines.push("The single Source-of-Truth for user Figment frontmatter (8 fields + meta).");
  lines.push("");

  // Column widths sized to content so the table stays aligned.
  const header = { name: "field", source: "source", def: "default", mand: "mandatory" };
  const nameW = Math.max(header.name.length, ...FRONTMATTER_CONTRACT.map((f) => f.name.length));
  const srcW = Math.max(header.source.length, ...FRONTMATTER_CONTRACT.map((f) => f.source.length));
  const defW = Math.max(
    header.def.length,
    ...FRONTMATTER_CONTRACT.map((f) => (f.defaultValue ?? "—").length),
  );
  const pad = (s: string, w: number): string => s.padEnd(w);

  lines.push(
    `  ${pad(header.name, nameW)}  ${pad(header.source, srcW)}  ${pad(header.def, defW)}  ${header.mand}`,
  );
  lines.push(`  ${"-".repeat(nameW)}  ${"-".repeat(srcW)}  ${"-".repeat(defW)}  ${"-".repeat(9)}`);
  for (const f of [...FRONTMATTER_CONTRACT].sort((a, b) => a.order - b.order)) {
    const def = f.defaultValue ?? "—";
    const mand = f.mandatory ? "yes" : "no";
    lines.push(`  ${pad(f.name, nameW)}  ${pad(f.source, srcW)}  ${pad(def, defW)}  ${mand}`);
  }

  lines.push("");
  lines.push("Descriptions:");
  for (const f of [...FRONTMATTER_CONTRACT].sort((a, b) => a.order - b.order)) {
    lines.push(`  ${f.name}: ${f.description}`);
  }

  lines.push("");
  lines.push("Rules:");
  const authorFields = FRONTMATTER_CONTRACT.filter((f) => f.source === "author").map((f) => f.name);
  lines.push(
    `  - Author-supplied (prompted if absent, no default): ${authorFields.join(", ")}.`,
  );
  lines.push(
    `  - Defaults: mesh-visibility → "${DEFAULT_MESH_VISIBILITY}", weight → "${DEFAULT_WEIGHT}".`,
  );
  lines.push(`  - Mandatory tokens (validated non-empty): ${MANDATORY_FRONTMATTER_TOKENS.join(", ")}.`);
  lines.push("  - meta is optional structural overflow for fields the 8 don't cover.");

  return lines.join("\n");
}

// Phase B (frontmatter-contract lane, slice 1) — `lyt contract`.
//
// Top-level (like search / primer / reindex) because the contract is ONE
// pod-global artifact, not a single-vault concept. Read-only; touches no vault.
export function buildContractCommand(): Command {
  return new Command("contract")
    .description(
      "Print the yai.lyt v1 figment frontmatter contract (the machine-readable Source-of-Truth). --json emits the FRONTMATTER_CONTRACT descriptor as a versioned envelope; --explain (default) prints a readable field table + the author-supplied / default / mandatory rules.",
    )
    .option("--json", "Emit the machine-readable FRONTMATTER_CONTRACT descriptor as JSON")
    .option("--explain", "Print the readable field table + rules (default human mode)")
    .action((opts: ContractCliOpts) => {
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(buildContractJson(), null, 2));
        return;
      }
      // Default + --explain both render the human table (--explain is an explicit
      // synonym for the default so `lyt contract --explain` reads intentionally).
      // eslint-disable-next-line no-console
      console.log(renderContractExplain());
    });
}
