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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveSingleVault } from "../util/vault-resolve.js";

// block-B Commit 6 — `lyt automator list [--vault <name>] [--archetype <a>] [--json]`.
//
// Walks `<vault>/.lyt/automators/*.yon`, parses each file with a minimal
// hand-rolled @AUTOMATOR extractor (block-A precedent — no yon-parser
// runtime dep in lyt-vault per brief @SCOPE forbidden #7), filters by
// archetype if given, returns the records.
//
// The parser is intentionally narrow: it only extracts the fields the CLI
// surface displays (name, rid, archetype, version, runtime, schedule,
// transaction_mode, description). It does NOT validate the full @AUTOMATOR
// shape (32 fields / 9 mandatory) — that validation belongs in the yai.lyt
// schema gate (v1.A.3). For v1, an unparseable file surfaces as a parseError
// entry rather than failing the whole list.

export interface AutomatorListEntry {
  filePath: string;
  fileName: string;
  rid: string | null;
  name: string | null;
  archetype: string | null;
  version: string | null;
  runtime: string | null;
  schedule: string | null;
  transactionMode: string | null;
  description: string | null;
  parseError: string | null;
}

export interface AutomatorListArgs {
  vault?: string;
  archetype?: string;
  // Test seam — override the vault path so callers don't have to round-trip
  // through resolveSingleVault for unit tests that supply a temp vault.
  vaultPathOverride?: string;
}

export interface AutomatorListResult {
  vaultName: string;
  vaultPath: string;
  automators: AutomatorListEntry[];
}

export async function listAutomatorsFlow(
  args: AutomatorListArgs = {},
): Promise<AutomatorListResult> {
  let vaultName: string;
  let vaultPath: string;
  if (args.vaultPathOverride !== undefined) {
    vaultPath = args.vaultPathOverride;
    vaultName = args.vault ?? "(override)";
  } else {
    const vault = await resolveSingleVault(args.vault);
    vaultName = vault.name;
    vaultPath = vault.path;
  }

  const automatorsDir = join(vaultPath, ".lyt", "automators");
  if (!existsSync(automatorsDir)) {
    return { vaultName, vaultPath, automators: [] };
  }

  const stat = statSync(automatorsDir);
  if (!stat.isDirectory()) {
    return { vaultName, vaultPath, automators: [] };
  }

  const entries = readdirSync(automatorsDir).filter((n) => n.endsWith(".yon"));
  const automators: AutomatorListEntry[] = [];
  for (const fname of entries) {
    const fpath = join(automatorsDir, fname);
    try {
      const raw = readFileSync(fpath, "utf8");
      const parsed = parseAutomatorFields(raw);
      const entry: AutomatorListEntry = {
        filePath: fpath,
        fileName: fname,
        rid: parsed.rid,
        name: parsed.name,
        archetype: parsed.archetype,
        version: parsed.version,
        runtime: parsed.runtime,
        schedule: parsed.schedule,
        transactionMode: parsed.transactionMode,
        description: parsed.description,
        parseError: null,
      };
      if (args.archetype !== undefined && entry.archetype !== args.archetype) continue;
      automators.push(entry);
    } catch (err) {
      automators.push({
        filePath: fpath,
        fileName: fname,
        rid: null,
        name: null,
        archetype: null,
        version: null,
        runtime: null,
        schedule: null,
        transactionMode: null,
        description: null,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Stable alphabetical sort for deterministic JSON output.
  automators.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return { vaultName, vaultPath, automators };
}

interface AutomatorFields {
  rid: string | null;
  name: string | null;
  archetype: string | null;
  version: string | null;
  runtime: string | null;
  schedule: string | null;
  transactionMode: string | null;
  description: string | null;
}

// Hand-rolled minimal extractor. Looks for the first @AUTOMATOR top-level
// declaration in the file, joins continuation lines (indented 2-space per YON
// convention), then plucks `key=value` and `key:type=value` shapes.
function parseAutomatorFields(raw: string): AutomatorFields {
  const lines = raw.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("@AUTOMATOR")) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error("No @AUTOMATOR record found in file");
  }
  // Continuation lines start with spaces (typically 2). Stop at first
  // non-indented line OR at another top-level @ tag.
  const declLines: string[] = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.length === 0) continue;
    if (l.startsWith("@")) break;
    if (l[0] === " " || l[0] === "\t") {
      declLines.push(l.trim());
    } else {
      break;
    }
  }
  // Join with " | " conceptually then split on `|` to get field tokens.
  // YON field separator is `|` per spec.
  const joined = declLines.join(" ").replace(/^@AUTOMATOR\s*/, "");
  const fieldTokens = joined
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const fields: AutomatorFields = {
    rid: null,
    name: null,
    archetype: null,
    version: null,
    runtime: null,
    schedule: null,
    transactionMode: null,
    description: null,
  };

  for (const tok of fieldTokens) {
    const eqIdx = tok.indexOf("=");
    if (eqIdx === -1) continue;
    const lhs = tok.slice(0, eqIdx).trim();
    let rhs = tok.slice(eqIdx + 1).trim();
    // Strip optional :type modifier from key (rid, name=foo OR confidence:float=1.0)
    const colonIdx = lhs.indexOf(":");
    const key = colonIdx === -1 ? lhs : lhs.slice(0, colonIdx).trim();
    // Strip surrounding quotes from rhs if present.
    if (rhs.startsWith('"') && rhs.endsWith('"')) {
      rhs = rhs.slice(1, -1);
    }
    switch (key) {
      case "rid":
        fields.rid = rhs;
        break;
      case "name":
        fields.name = rhs;
        break;
      case "archetype":
        fields.archetype = rhs;
        break;
      case "version":
        fields.version = rhs;
        break;
      case "runtime":
        fields.runtime = rhs;
        break;
      case "schedule":
        fields.schedule = rhs;
        break;
      case "transaction_mode":
        fields.transactionMode = rhs;
        break;
      case "description":
        fields.description = rhs;
        break;
      default:
        break;
    }
  }
  return fields;
}
