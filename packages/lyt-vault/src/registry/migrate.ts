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

import type { Client } from "@libsql/client";

import { MIGRATIONS, type Migration } from "./migrations.js";

// SEE ALSO: src/registry/vault-db-migrations.ts (per-vault equivalent). The
// two runners share an algorithm + helper; keep them in lock-step until a
// generalised shared runner is introduced (plan Open Q1).
export async function migrate(db: Client): Promise<readonly Migration[]> {
  await db.execute(`
 CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 applied_at TEXT NOT NULL
 );
  `);

  const applied = await db.execute("SELECT version FROM schema_migrations ORDER BY version ASC");
  const appliedVersions = new Set(applied.rows.map((r) => Number(r["version"])));

  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
    (a, b) => a.version - b.version,
  );

  for (const m of pending) {
    const statements = splitSqlStatements(m.sql);
    for (const stmt of statements) {
      await db.execute(stmt);
    }
    await db.execute({
      sql: "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      args: [m.version, m.name, new Date().toISOString()],
    });
  }

  return pending;
}

// Tokenising SQL statement splitter (DO NOT SKIP #11 fold). Respects:
// - line comments: `-- ... \n`
// - block comments: `/* ... */` (non-nesting per SQLite spec)
// - single-quoted strings: `'...'` with `''` doubled-quote escape
// - double-quoted identifiers: `"..."` with `""` doubled-quote escape
// Splits only on `;` outside any of the above. Empty / whitespace-only
// statements are filtered. Exported for the migrate-splitter test suite.
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = i + 1 < n ? sql[i + 1] : "";
    if (ch === "-" && next === "-") {
      // line comment to end-of-line
      buf += ch + next;
      i += 2;
      while (i < n && sql[i] !== "\n") {
        buf += sql[i];
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      // block comment to */
      buf += ch + next;
      i += 2;
      while (i < n) {
        if (sql[i] === "*" && i + 1 < n && sql[i + 1] === "/") {
          buf += "*/";
          i += 2;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }
    if (ch === "'") {
      // single-quoted string with '' doubled escape
      buf += ch;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (i + 1 < n && sql[i + 1] === "'") {
            buf += "''";
            i += 2;
            continue;
          }
          buf += "'";
          i++;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }
    if (ch === '"') {
      // double-quoted identifier with "" doubled escape
      buf += ch;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (i + 1 < n && sql[i + 1] === '"') {
            buf += '""';
            i += 2;
            continue;
          }
          buf += '"';
          i++;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }
    if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) out.push(trimmed);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}
