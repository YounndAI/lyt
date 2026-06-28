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

// feat/keyphrase-boost — `upsertKeyphrasesCache` full-walk keyphrase cache
// refresh. Walks `<vault>/notes/**/*.md`, derives each figment's title + body,
// extracts the deterministic top-K keyphrase token set (util/keyphrase-extract),
// and reflects it into lyt.db's `keyphrases` table.
//
// Posture (Lock 0.2): the markdown file on disk is the SoT; the keyphrases
// table is a regenerable cache. There is NO intermediate YON SoT — same as the
// FTS cache (the figments ARE the source). The upsert truncates before
// re-inserting so deletions on disk propagate. Idempotent + deterministic: a
// second call on the same vault state produces the identical row set (no
// Date.now / random anywhere in the extractor).
//
// Mirrors upsert-fts-cache.ts: same walk (frontmatter strip, code-fence strip,
// wikilink strip — REUSED via extractFtsBody so the keyphrase body is exactly
// the searchable prose the FTS indexes, no drift), same scaffold-note exclusion,
// same open-once seam.
//
// Open-once seam (v1.A.5 CR-B1): optional `lytDb?: Client`; when supplied the
// caller owns lifecycle; when omitted the flow opens + closes its own.

import { readFileSync } from "node:fs";

import type { Client } from "@libsql/client";

import { closeVaultDb, openLytDb } from "../registry/vault-db.js";
import { deleteAllKeyphrases, replaceKeyphrasesForFigment } from "../registry/keyphrases-repo.js";
import {
  extractFtsBody,
  stripFrontmatter,
  toVaultRelPosix,
  walkVaultFigmentFiles,
} from "./upsert-fts-cache.js";
import { DEFAULT_KEYPHRASE_TOP_K, extractKeyphraseTokens } from "../util/keyphrase-extract.js";

export interface UpsertKeyphrasesCacheResult {
  vaultPath: string;
  // True when the vault had at least one note and the cache was refreshed.
  // False when the `notes/` directory is missing or empty — caller treats as a
  // no-op (mirrors UpsertFtsCacheResult.ran).
  ran: boolean;
  figmentsProcessed: number;
  keyphraseRowsUpserted: number;
  durationMs: number;
}

export interface UpsertKeyphrasesCacheOpts {
  // Open-once seam (v1.A.5 CR-B1 pattern).
  lytDb?: Client;
  // Top-K override (test seam); defaults to DEFAULT_KEYPHRASE_TOP_K (10), the
  // proven prototype value.
  topK?: number;
}

export async function upsertKeyphrasesCache(
  vaultPath: string,
  opts: UpsertKeyphrasesCacheOpts = {},
): Promise<UpsertKeyphrasesCacheResult> {
  const startedAt = Date.now();
  const topK = opts.topK ?? DEFAULT_KEYPHRASE_TOP_K;
  const noteFiles = walkVaultFigmentFiles(vaultPath);
  if (noteFiles.length === 0) {
    return {
      vaultPath,
      ran: false,
      figmentsProcessed: 0,
      keyphraseRowsUpserted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const callerSupplied = opts.lytDb !== undefined;
  const db = opts.lytDb ?? (await openLytDb(vaultPath));
  let figmentsProcessed = 0;
  let keyphraseRowsUpserted = 0;
  try {
    // Truncate first so the cache reflects the SoT verbatim (drops figments
    // removed on disk between rebuilds).
    await deleteAllKeyphrases(db);

    for (const abs of noteFiles) {
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const relPath = toVaultRelPosix(abs, vaultPath);
      const title = deriveTitle(content, relPath);
      // REUSE the FTS body pipeline (frontmatter + code fences + wikilinks
      // stripped, tags folded) so the keyphrase corpus is exactly the searchable
      // prose — the boost can only reinforce terms the FTS body actually carries.
      const { body } = extractFtsBody(content);
      const terms = extractKeyphraseTokens(title, body, topK);
      await replaceKeyphrasesForFigment(db, relPath, terms);
      figmentsProcessed += 1;
      keyphraseRowsUpserted += terms.length;
    }
  } finally {
    if (!callerSupplied) await closeVaultDb(db);
  }

  return {
    vaultPath,
    ran: true,
    figmentsProcessed,
    keyphraseRowsUpserted,
    durationMs: Date.now() - startedAt,
  };
}

// Title resolution — verbatim from the prototype: frontmatter `title:` if
// present, else the first H1 heading, else the file basename (sans .md). Title
// tokens get the big aboutness boost inside the extractor, so deriving it the
// same way the prototype did is load-bearing for reproducing the lift.
export function deriveTitle(raw: string, relPath: string): string {
  const fmTitle = frontmatterTitle(raw);
  if (fmTitle !== null) return fmTitle;
  // First H1 anywhere in the body (after frontmatter).
  const body = stripFrontmatter(raw);
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "");
}

function frontmatterTitle(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) {
      first = i;
      break;
    }
  }
  if (first === -1 || lines[first] !== "---") return null;
  for (let i = first + 1; i < lines.length; i++) {
    if (lines[i] === "---") return null; // reached end of frontmatter, no title
    const m = lines[i]!.match(/^title\s*:\s*(.+)$/i);
    if (m) {
      const v = m[1]!.replace(/^["']|["']$/g, "").trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}
