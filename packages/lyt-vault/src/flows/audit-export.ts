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

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { walkAllAuditShards } from "../registry/audit-write.js";
import { type VaultRow } from "../registry/repo.js";
import { closeVaultDb, openAuditDb } from "../registry/vault-db.js";
import { parseIsoDateStrict } from "../util/iso-date.js";
import { resolveVaults } from "../util/vault-resolve.js";

export interface AuditExportArgs {
  since: string;
  until?: string;
  vault?: string;
  output?: string;
  // For tests/scripts that want to anchor the default `.lyt/audit/<YYYY-MM>.md`
  // path without standing up a cwd vault.
  defaultOutputForVault?: (vaultPath: string, sinceISO: string) => string;
}

export interface AuditExportResult {
  rowsExported: number;
  outputPath: string;
  byteCount: number;
  windowStartISO: string;
  windowEndISO: string;
  vaultsScanned: string[];
  outputOutsideVault: boolean;
}

interface AuditRow {
  ts: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  result: string;
  details_json: string | null;
}

// Renders a window of per-vault audit_log rows to a handler-readable markdown
// file at `.lyt/audit/<YYYY-MM>.md` (or `--output <path>`). Per arc §8.4:
// cross-machine state distribution flows through markdown via git. Exported
// markdown is the deliberate handler-driven artifact — diff-friendly,
// readable in any editor, git-trackable.
//
// `lyt audit aggregate` (cross-vault merge, admin tooling) is deferred to
// block-D — only `export` ships in block-A.
export async function auditExportFlow(args: AuditExportArgs): Promise<AuditExportResult> {
  const windowStart = parseDate(args.since, "since");
  const windowEnd = args.until ? parseDate(args.until, "until") : new Date();
  if (windowEnd.getTime() < windowStart.getTime()) {
    throw new Error(
      `--until (${windowEnd.toISOString()}) is before --since (${windowStart.toISOString()})`,
    );
  }

  const vaults = await resolveVaults(args.vault);
  if (vaults.length === 0) {
    throw new Error(
      args.vault
        ? `No vault registered with name '${args.vault}'.`
        : "No vaults registered to export from. Run `lyt vault init <name>` first.",
    );
  }

  const allRows: { vaultName: string; row: AuditRow }[] = [];
  for (const v of vaults) {
    if (!existsSync(v.path)) continue;
    let cacheRows: AuditRow[] = [];
    let cacheReachable = true;
    try {
      const db = await openAuditDb(v.path);
      try {
        const r = await db.execute({
          sql:
            "SELECT ts, actor, action, target_type, target_id, result, details_json" +
            " FROM audit_log" +
            " WHERE ts >= ? AND ts <= ?" +
            " ORDER BY ts ASC",
          args: [windowStart.getTime(), windowEnd.getTime()],
        });
        cacheRows = r.rows.map((row) => ({
          ts: Number(row["ts"]),
          actor: String(row["actor"]),
          action: String(row["action"]),
          target_type: String(row["target_type"]),
          target_id: String(row["target_id"]),
          result: String(row["result"]),
          details_json: row["details_json"] == null ? null : String(row["details_json"]),
        }));
      } finally {
        await closeVaultDb(db);
      }
    } catch {
      cacheReachable = false;
    }
    // v1.A.2 Lock 0.2 — YON fallback. If the .db cache is empty OR
    // unreachable (fresh clone before first `lyt sync`), walk the YON
    // SoT and emit the same shape. The cache + YON cases are mutually
    // exclusive: if the cache returned rows, trust it (post-pull upsert
    // already reconciled).
    if (cacheReachable && cacheRows.length > 0) {
      for (const row of cacheRows) {
        allRows.push({ vaultName: v.name, row });
      }
      continue;
    }
    // Slice 2b: walk all per-writerId shards + legacy flat file.
    const yonRows = walkAllAuditShards(v.path);
    for (const r of yonRows) {
      if (r.recordType !== "AUDIT") continue;
      const tsRaw = r.fields.get("ts") ?? r.stampTs;
      if (!tsRaw) continue;
      const ts = Date.parse(tsRaw);
      if (!Number.isFinite(ts)) continue;
      if (ts < windowStart.getTime() || ts > windowEnd.getTime()) continue;
      allRows.push({
        vaultName: v.name,
        row: {
          ts,
          actor: r.fields.get("actor") ?? "system:lyt",
          action: r.fields.get("action") ?? "vault.access.lost",
          target_type: r.fields.get("target_type") ?? "vault",
          target_id: r.fields.get("target_id") ?? "",
          result: r.fields.get("result") ?? "success",
          details_json: r.fields.get("details_json") ?? null,
        },
      });
    }
    // Sort by ts ASC to match the .db ORDER BY semantics.
    allRows.sort((a, b) => a.row.ts - b.row.ts);
  }

  // Output path resolution
  const outputPath = resolveOutputPath(args, vaults, windowStart);
  // release review: warn (stderr) when --output resolves outside every
  // scanned vault. Matches the registry-reset.ts:105 isUnder pattern. The
  // verb still writes — explicit user intent (`--output /tmp/x.md`) is not
  // refused — but the audit trail now records when an export escapes its
  // origin vault.
  const outputOutsideVault = !vaults.some((v) => isUnder(outputPath, v.path));
  if (outputOutsideVault) {
    // eslint-disable-next-line no-console
    console.error(
      `lyt audit export: --output target ${outputPath} is outside every scanned vault (${vaults
        .map((v) => v.name)
        .join(
          ", ",
        )}). Writing anyway because --output is an explicit override; the file will not be visible to lyt verbs scoped by vault.`,
    );
  }
  mkdirSync(dirname(outputPath), { recursive: true });

  const markdown = renderMarkdown({
    rows: allRows,
    windowStart,
    windowEnd,
    vaults,
  });
  writeFileSync(outputPath, markdown, "utf8");

  const byteCount = statSync(outputPath).size;
  return {
    rowsExported: allRows.length,
    outputPath,
    byteCount,
    windowStartISO: windowStart.toISOString(),
    windowEndISO: windowEnd.toISOString(),
    vaultsScanned: vaults.map((v) => v.name),
    outputOutsideVault,
  };
}

function isUnder(target: string, root: string): boolean {
  const t = resolve(target);
  const r = resolve(root);
  if (t === r) return true;
  const sep = process.platform === "win32" ? "\\" : "/";
  return t.startsWith(r + sep) || t.startsWith(r + "/") || t.startsWith(r + "\\");
}

// release review: parseDate hardening. A.4.5 polish #4 + #7 + #8: relaxed
// to accept space separator (SQLite CURRENT_TIMESTAMP, Postgres
// timestamptz::text emit space), arbitrary fractional precision (Python
// datetime.isoformat() emits 6, Go time.RFC3339Nano emits 9), and TZ-safe
// overflow handling via Date.UTC parse + component compare (the prior
// re-render guard falsely rejected valid non-UTC inputs like
// `2026-05-01T20:00:00-10:00`). Strictness lives in `util/iso-date.ts`;
// this wrapper just surfaces flag-aware error messages.
export function parseDate(raw: string, flag: string): Date {
  try {
    return parseIsoDateStrict(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`--${flag} ${msg}`);
  }
}

function resolveOutputPath(
  args: AuditExportArgs,
  vaults: readonly VaultRow[],
  windowStart: Date,
): string {
  if (args.output && args.output.length > 0) {
    return isAbsolute(args.output) ? args.output : resolve(process.cwd(), args.output);
  }
  if (args.defaultOutputForVault) {
    return args.defaultOutputForVault(vaults[0]!.path, windowStart.toISOString());
  }
  // Default to .lyt/audit/<YYYY-MM>.md inside the first vault's path.
  const ym = `${windowStart.getUTCFullYear()}-${String(windowStart.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(vaults[0]!.path, ".lyt", "audit", `${ym}.md`);
}

interface RenderArgs {
  rows: { vaultName: string; row: AuditRow }[];
  windowStart: Date;
  windowEnd: Date;
  vaults: readonly VaultRow[];
}

// Markdown shape (handler-readable + diff-friendly):
//
// ---
// type: audit-export
// window_start: 2026-05-01T00:00:00.000Z
// window_end: 2026-05-28T00:00:00.000Z
// vaults_scanned: [alex/main]
// rows_exported: 12
// ---
//
// # Audit log — 2026-05-01 → 2026-05-28
//
// ## vault.* (3)
// - **2026-05-27T10:14:22Z** `vault.index.rebuilt` · actor=`system:lyt` · target=`vault:alex-main` · result=`ok`
// <details><summary>details</summary>
//
// ```json
// {...}
// ```
// </details>
// ...
//
// ## sync.friction.* (0)
// _No rows in this window._
//
// Plus a "Next steps" section reminding handlers to git-add + commit.
function renderMarkdown(args: RenderArgs): string {
  const grouped = new Map<string, typeof args.rows>();
  for (const r of args.rows) {
    const category = categoryOf(r.row.action);
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category)!.push(r);
  }

  const lines: string[] = [];
  // Frontmatter
  lines.push("---");
  lines.push("type: audit-export");
  lines.push(`window_start: ${args.windowStart.toISOString()}`);
  lines.push(`window_end: ${args.windowEnd.toISOString()}`);
  lines.push(`vaults_scanned: [${args.vaults.map((v) => v.name).join(", ")}]`);
  lines.push(`rows_exported: ${args.rows.length}`);
  lines.push("---");
  lines.push("");
  lines.push(
    `# Audit log — ${args.windowStart.toISOString().slice(0, 10)} → ${args.windowEnd.toISOString().slice(0, 10)}`,
  );
  lines.push("");
  if (args.rows.length === 0) {
    lines.push(
      "_No audit rows in this window. (Empty exports are a deliberate handler-shareable artifact — they prove a quiet window, not an error.)_",
    );
    lines.push("");
    return appendNextSteps(lines).join("\n");
  }

  // Sort category headings: known buckets first, alphabetical for the rest.
  const knownOrder = ["vault", "automator", "sync", "directive", "memscope", "system"];
  const cats = Array.from(grouped.keys()).sort((a, b) => {
    const ai = knownOrder.indexOf(a);
    const bi = knownOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const cat of cats) {
    const rows = grouped.get(cat)!;
    lines.push(`## ${cat}.* (${rows.length})`);
    lines.push("");
    for (const { vaultName, row } of rows) {
      const ts = new Date(row.ts).toISOString();
      // Callers pass a full rid (e.g. `vault:alex-main`) as target_id in
      // production (friction.ts, rebuild-index.ts both pass `vault.rid`).
      // Avoid `vault:vault:...` by detecting an already-prefixed id.
      const targetPrefix = `${row.target_type}:`;
      const targetRid = row.target_id.startsWith(targetPrefix)
        ? row.target_id
        : `${targetPrefix}${row.target_id}`;
      lines.push(
        `- **${ts}** \`${row.action}\` · actor=\`${row.actor}\` · target=\`${targetRid}\` · result=\`${row.result}\` · vault=\`${vaultName}\``,
      );
      if (row.details_json && row.details_json.length > 0 && row.details_json !== "null") {
        lines.push("  <details><summary>details</summary>");
        lines.push("");
        lines.push("  ```json");
        // Pretty-print if it's valid JSON; otherwise emit verbatim.
        let body = row.details_json;
        try {
          body = JSON.stringify(JSON.parse(row.details_json), null, 2);
        } catch {
          // already a non-JSON string — emit verbatim
        }
        for (const line of body.split(/\r?\n/)) lines.push(`  ${line}`);
        lines.push("  ```");
        lines.push("  </details>");
      }
    }
    lines.push("");
  }

  return appendNextSteps(lines).join("\n");
}

function appendNextSteps(lines: string[]): string[] {
  lines.push("---");
  lines.push("");
  lines.push("## Sharing this export");
  lines.push("");
  lines.push(
    "Per arc §8.4, audit exports become cross-machine artifacts through git. Stage + commit + push this file when you want collaborators (or other machines you own) to see the window:",
  );
  lines.push("");
  lines.push("```");
  lines.push("git add .lyt/audit/<this-file>.md");
  lines.push('git commit -m "audit: export window"');
  lines.push("```");
  lines.push("");
  return lines;
}

function categoryOf(action: string): string {
  const i = action.indexOf(".");
  if (i === -1) return action;
  return action.slice(0, i);
}
