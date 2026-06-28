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

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { closeVaultDb, openProvenanceDb } from "../registry/vault-db.js";
import { uuid7BytesToHex } from "../util/uuid7.js";
import { resolveSingleVault } from "../util/vault-resolve.js";

export type ProvenanceTargetType =
  | "note"
  | "vault"
  | "automator"
  | "directive"
  | "memscope"
  | "rollup"
  | "skill"
  | "machine"
  | "pattern";

export interface ProvenanceTraceArgs {
  target: string;
  vault?: string;
  // For tests: anchor file-target resolution to a tmp cwd.
  cwd?: string;
}

export interface ProvenanceEntry {
  idHex: string;
  targetType: ProvenanceTargetType;
  targetId: string;
  ts: number;
  src: string;
  method: string | null;
  confidence: number | null;
  hash: string | null;
  tokens: number | null;
  costUsd: number | null;
  model: string | null;
  approver: string | null;
  details: Record<string, unknown> | null;
}

export interface ProvenanceTraceResult {
  vaultName: string;
  targetType: ProvenanceTargetType;
  targetId: string;
  entries: ProvenanceEntry[];
  frontmatterLastProvenance: string | null;
  frontmatterMessage: string;
}

// Known rid prefixes per arc §10 + §11.2. Used by auto-detection in
// resolveTarget(): a string matching one of these prefixes AND the rid body
// regex below is treated as a rid; anything else with `/`, `\`, or `.md` is
// treated as a file path.
const KNOWN_RID_PREFIXES: ReadonlyArray<[string, ProvenanceTargetType]> = [
  ["vault:", "vault"],
  ["automator:", "automator"],
  ["directive:", "directive"],
  ["memscope:", "memscope"],
  ["rollup:", "rollup"],
  ["skill:", "skill"],
  ["machine:", "machine"],
  ["pattern:", "pattern"],
];

// release review: tighten rid body regex so Unix file paths like
// `./vault:foo.md` are not misclassified as rids. Real rids carry only
// lowercase alphanumerics + `.`, `_`, `/`, `-`; a Unix file with `:` in its
// basename will contain `.md`, `/`, or `\` and therefore lose the rid-shape
// race (path-shape wins because we check the file heuristic first when the
// body regex fails).
const RID_BODY_RE = /^[a-z0-9._/-]+$/;

// Renders the chronological chain of @STAMP records from per-vault provenance
// for a given target. The target is auto-detected as either a file path or a
// known rid. For markdown files, also reports the `last_provenance:`
// frontmatter slot (block-A returns a "no auto-injection yet" message
// gracefully; block-B's lyt-runner pre-write hook will populate it per arc §11.4).
export async function provenanceTraceFlow(
  args: ProvenanceTraceArgs,
): Promise<ProvenanceTraceResult> {
  const { targetType, targetId, isFile } = resolveTarget(args.target, args.cwd ?? process.cwd());
  const vault = await resolveSingleVault(args.vault);

  const db = await openProvenanceDb(vault.path);
  let entries: ProvenanceEntry[] = [];
  try {
    const r = await db.execute({
      sql:
        "SELECT id, target_type, target_id, ts, src, method, confidence, hash, tokens, cost_usd, model, approver, details_json" +
        " FROM provenance" +
        " WHERE target_type = ? AND target_id = ?" +
        " ORDER BY ts ASC",
      args: [targetType, targetId],
    });
    entries = r.rows.map((row) => rowToEntry(row));
  } finally {
    await closeVaultDb(db);
  }

  let frontmatterLastProvenance: string | null = null;
  let frontmatterMessage =
    "Provenance frontmatter inspection skipped (target is a rid, not a file).";
  if (isFile) {
    const fm = readFrontmatterLastProvenance(targetId);
    frontmatterLastProvenance = fm.value;
    frontmatterMessage = fm.message;
  }

  return {
    vaultName: vault.name,
    targetType,
    targetId,
    entries,
    frontmatterLastProvenance,
    frontmatterMessage,
  };
}

function rowToEntry(row: Record<string, unknown>): ProvenanceEntry {
  let details: Record<string, unknown> | null = null;
  const raw = row["details_json"] == null ? null : String(row["details_json"]);
  if (raw) {
    try {
      details = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      details = { _raw: raw };
    }
  }
  return {
    idHex: uuid7BytesToHex(row["id"] as Uint8Array | ArrayBuffer),
    targetType: String(row["target_type"]) as ProvenanceTargetType,
    targetId: String(row["target_id"]),
    ts: Number(row["ts"]),
    src: String(row["src"]),
    method: row["method"] == null ? null : String(row["method"]),
    confidence: row["confidence"] == null ? null : Number(row["confidence"]),
    hash: row["hash"] == null ? null : String(row["hash"]),
    tokens: row["tokens"] == null ? null : Number(row["tokens"]),
    costUsd: row["cost_usd"] == null ? null : Number(row["cost_usd"]),
    model: row["model"] == null ? null : String(row["model"]),
    approver: row["approver"] == null ? null : String(row["approver"]),
    details,
  };
}

interface ResolvedTarget {
  targetType: ProvenanceTargetType;
  targetId: string;
  isFile: boolean;
}

// Auto-detection (release review hardening): a string is treated as a rid
// only if it matches a known prefix AND the body satisfies the rid-body regex
// (lowercase alphanumerics + `.`, `_`, `/`, `-`). Otherwise — even if it
// starts with `vault:` — it falls through to the file-shape check, so a Unix
// file literally named `./vault:foo.md` classifies as a file. Per plan Open
// Q5 lock + release review.
function resolveTarget(raw: string, cwd: string): ResolvedTarget {
  for (const [prefix, kind] of KNOWN_RID_PREFIXES) {
    if (raw.startsWith(prefix)) {
      const body = raw.slice(prefix.length);
      if (RID_BODY_RE.test(body)) {
        return { targetType: kind, targetId: raw, isFile: false };
      }
      // Prefix matched but body has rid-illegal chars (e.g. uppercase, `:`,
      // whitespace). Fall through to the file-shape check.
      break;
    }
  }
  const isFileLike = raw.includes("/") || raw.includes("\\") || raw.endsWith(".md");
  if (!isFileLike) {
    throw new Error(
      `Cannot resolve provenance target ${JSON.stringify(raw)}: not a recognised rid (vault:|automator:|directive:|memscope:|rollup:|skill:|machine:|pattern: with body ${RID_BODY_RE.source}) and not a file path (no '/', '\\', or '.md' suffix).`,
    );
  }
  const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return { targetType: "note", targetId: absolute, isFile: true };
}

interface FrontmatterRead {
  value: string | null;
  message: string;
}

// Best-effort frontmatter scan for the `last_provenance:` slot. Block-A
// does not populate this field — block-B's lyt-runner pre-write hook
// (arc §11.4) will. Returns a value if found, plus a human-readable
// message that surfaces the "no auto-injection yet" state when missing.
function readFrontmatterLastProvenance(filePath: string): FrontmatterRead {
  if (!existsSync(filePath)) {
    return {
      value: null,
      message: `File not found at ${filePath}; provenance trace shows only DB rows.`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      value: null,
      message: `Could not read ${filePath} (${(err as Error).message}); provenance trace shows only DB rows.`,
    };
  }
  // Only inspect the leading YAML frontmatter block, if present.
  if (!raw.startsWith("---")) {
    return {
      value: null,
      message:
        "File has no YAML frontmatter — `last_provenance:` cannot be read. This slot is populated by the lyt-runner pre-write hook when available.",
    };
  }
  const closing = raw.indexOf("\n---", 3);
  if (closing === -1) {
    return {
      value: null,
      message: "File starts with `---` but no closing frontmatter delimiter found.",
    };
  }
  const fm = raw.slice(3, closing);
  const match = fm.match(/^\s*last_provenance:\s*(.+?)\s*$/m);
  if (!match || match[1] === "") {
    return {
      value: null,
      message:
        "`last_provenance:` not present in frontmatter. This slot is populated by the lyt-runner pre-write hook when available.",
    };
  }
  return {
    value: match[1]!.replace(/^['"]|['"]$/g, ""),
    message: "Read from frontmatter.",
  };
}
