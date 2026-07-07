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

// Increment 1 · Phase A.2 — per-verb Receipt verification (SC-A4).
//
// `apply()`'s `Receipt.verified` must reflect REAL post-state, not the verb's
// own say-so — a forced mismatch flips it to `false`. Verification is per-verb
// (there is no one true check): `capture` = the figment bytes are on disk AND
// its row is in the figment index; `sync` = the actual push result (built in
// A.4). This module carries the reusable read-back helpers + a small `Receipt`
// builder. It reuses `assert-committed.ts`'s read-back PATTERN (re-open the
// authoritative store, assert the predicate, downgrade on mismatch) and adds
// the two capture-specific asserts the existing DB-row asserts don't cover.

import { statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { Client } from "@libsql/client";

import { closeVaultDb, openLytDb } from "../registry/vault-db.js";
import type { Receipt, SyncHorizon } from "./operation.js";

/**
 * The outcome of one read-back assertion. `verified:false` never throws — the
 * caller downgrades the Receipt (SC-A4's "reported success without effect"
 * guard), it does not crash the op.
 */
export interface VerifyResult {
  verified: boolean;
  /** A machine/log reason when unverified (never surfaced raw to the human). */
  reason: string | null;
}

const OK: VerifyResult = { verified: true, reason: null };

/**
 * Capture verification, half 1: the figment bytes are actually on disk. `relPath`
 * is vault-relative POSIX (the same key the index uses); resolved against
 * `vaultPath`. When `minBytes` is given, an empty/truncated file is a mismatch
 * (a zero-byte write is a "reported success without effect"). An absolute path
 * is rejected — capture always writes inside the vault.
 */
export function assertFileBytes(
  vaultPath: string,
  relPath: string,
  opts: { minBytes?: number } = {},
): VerifyResult {
  if (isAbsolute(relPath)) {
    return { verified: false, reason: "file-path-not-vault-relative" };
  }
  const abs = join(vaultPath, relPath);
  // Containment: reject a relative path that `..`-escapes the vault. isAbsolute
  // alone does NOT catch `../../x` (release review R3); this helper's docstring
  // promises "inside the vault", so enforce it — a Phase-B/MCP caller may feed a
  // less-trusted relPath.
  const rel = relative(vaultPath, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { verified: false, reason: "file-path-escapes-vault" };
  }
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { verified: false, reason: "file-missing" };
    size = st.size;
  } catch {
    return { verified: false, reason: "file-missing" };
  }
  const min = opts.minBytes ?? 1;
  if (size < min) return { verified: false, reason: "file-empty-or-truncated" };
  return OK;
}

/**
 * Capture verification, half 2: the figment's row is present in the vault's FTS
 * index (`figment_fts.figment_rid` == the vault-relative path — see fts-repo.ts).
 * This is the check `assert-committed.ts` never had (it asserts registry rows,
 * not a figment write). Opens the vault content DB itself unless a caller threads
 * one through (`opts.lytDb`, the open-once seam) — the caller owns that db's
 * lifecycle; a self-opened db is always closed.
 *
 * A not-indexed figment is NOT data loss — capture-index defers indexing on
 * failure (the markdown is always on disk first). So an unverified index row
 * means "saved, index deferred", which the Receipt reflects honestly rather than
 * claiming a clean verified success.
 */
export async function assertFigmentIndexed(
  vaultPath: string,
  relPath: string,
  opts: { lytDb?: Client } = {},
): Promise<VerifyResult> {
  const callerSupplied = opts.lytDb !== undefined;
  const db = opts.lytDb ?? (await openLytDb(vaultPath));
  try {
    // figment_rid is a vault-relative POSIX key (fts-repo.ts). Normalize native
    // (Windows backslash) separators so a `path.join`-built relPath matches the
    // stored key exactly and doesn't spuriously report `figment-not-indexed`
    // on a figment that IS indexed (release review R2 — one-directional false-neg).
    const posixRel = relPath.split("\\").join("/");
    const rs = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM figment_fts WHERE figment_rid = ?",
      args: [posixRel],
    });
    const n = Number(rs.rows[0]?.["n"] ?? 0);
    return n >= 1 ? OK : { verified: false, reason: "figment-not-indexed" };
  } catch (err) {
    return { verified: false, reason: `index-read-failed (${err instanceof Error ? err.message : String(err)})` };
  } finally {
    if (!callerSupplied) await closeVaultDb(db);
  }
}

/**
 * AND-combine several per-verb assertions into one verdict. Verified only when
 * every part is; the first failing reason is carried (for the log). Used by an
 * Operation's `apply()` to compute `Receipt.verified` from its verb-specific
 * checks (e.g. capture = `assertFileBytes` AND `assertFigmentIndexed`).
 */
export function combineVerifications(parts: VerifyResult[]): VerifyResult {
  for (const p of parts) {
    if (!p.verified) return p;
  }
  return OK;
}

/** Assemble a `Receipt` (from operation.ts) — a thin, single-shape constructor. */
export function makeReceipt(args: {
  applied: boolean;
  verified: boolean;
  logline: string;
  horizon: SyncHorizon;
  envelope?: Record<string, unknown>;
}): Receipt {
  return {
    applied: args.applied,
    verified: args.verified,
    logline: args.logline,
    horizon: args.horizon,
    ...(args.envelope !== undefined ? { envelope: args.envelope } : {}),
  };
}
