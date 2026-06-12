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

import { copyFileSync, existsSync, mkdirSync, renameSync, truncateSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createClient, type Client } from "@libsql/client";

import { LEDGER_REGISTRY, getLedgerKind, type LedgerKindName } from "./ledger-registry.js";
import { migrateLytDb } from "./vault-db-migrations.js";

// v1.A.2c per-vault DB SPLIT (Lock 0.2 layout pivot):
// <vault>/.lyt/indexes/lyt.db — vault_state + child_pull_state +
// automator_runs + automator_run_events
// <vault>/.lyt/indexes/audit.db — audit_log (cache over audit.yon SoT)
// <vault>/.lyt/indexes/provenance.db — provenance (cache over provenance.yon SoT)
//
// All three live under `.lyt/indexes/` (gitignored per scaffold's
// `getVaultGitignore()`) and are independently regenerable from the YON SoT
// via `lyt vault rebuild-index [--ledger <name>]`. Pre-release clean-slate:
// no migration from the single-DB layout (per [[feedback_prerelease_clean_slate]]
// — `lyt registry reset --yes` is the forward path for stale dev vaults).
//
// v1.A.3 (CR-3 / ALT3) consolidation: ledger DB opener+path helpers are
// derived from LEDGER_REGISTRY (./ledger-registry.ts) — adding a new
// ledger kind requires no edit to this file. The `lyt.db` opener stays
// explicit since lyt.db is the transactional state DB, not a
// regenerable YON-derived ledger cache.

export function getLytDbPath(vaultPath: string): string {
  return join(vaultPath, ".lyt", "indexes", "lyt.db");
}

// Registry-driven ledger DB path helper. Pass a known LedgerKindName
// (e.g. "audit" | "provenance") and the per-ledger filename (audit.db
// etc.) flows from LEDGER_REGISTRY.
export function getLedgerDbPath(vaultPath: string, kindName: LedgerKindName): string {
  return join(vaultPath, ".lyt", "indexes", getLedgerKind(kindName).dbFile);
}

// Back-compat path helpers — public surface preserved for existing
// callers (tests, audit-export, provenance-trace, rebuild-index).
export function getAuditDbPath(vaultPath: string): string {
  return getLedgerDbPath(vaultPath, "audit");
}

export function getProvenanceDbPath(vaultPath: string): string {
  return getLedgerDbPath(vaultPath, "provenance");
}

// Shared opener primitive: PRAGMA foreign_keys=ON + journal_mode=DELETE +
// migrate-or-throw-and-close lifecycle. Each per-vault DB gets its own
// migrator (independent `schema_migrations` row).
async function openSplitDb(
  dbPath: string,
  migrate: (db: Client) => Promise<unknown>,
): Promise<Client> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await db.execute("PRAGMA foreign_keys = ON");
    await db.execute("PRAGMA journal_mode=DELETE");
    await migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export async function openLytDb(vaultPath: string): Promise<Client> {
  return openSplitDb(getLytDbPath(vaultPath), migrateLytDb);
}

// Registry-driven ledger DB opener. Replaces the explicit
// openAuditDb / openProvenanceDb pair (still exported below as
// back-compat wrappers for caller surface stability).
export async function openLedgerDb(vaultPath: string, kindName: LedgerKindName): Promise<Client> {
  const kind = getLedgerKind(kindName);
  return openSplitDb(getLedgerDbPath(vaultPath, kindName), kind.migrate);
}

export async function openAuditDb(vaultPath: string): Promise<Client> {
  return openLedgerDb(vaultPath, "audit");
}

export async function openProvenanceDb(vaultPath: string): Promise<Client> {
  return openLedgerDb(vaultPath, "provenance");
}

// Shared closer: same Windows file-lock guard as A.1's closeVaultDb. Used
// by all three openers' callers symmetrically.
export async function closeVaultDb(db: Client): Promise<void> {
  db.close();
  if (process.platform === "win32") {
    // 200ms (was 50ms in A.1) — under heavily concurrent test load the
    // 50ms wait wasn't enough for the OS to release the file handle before
    // `rmStrict`/`renameRetry` would EBUSY on the same path. Trades a small
    // amount of CLI latency (one wait per close) for stable test runs +
    // safer back-to-back close→rm sequences in production flows.
    //
    // SEE ALSO: flows/reconcile-figment-write.ts RECONCILE_RETRY_* budget
    // (the reciprocal forward-reference). That budget bounds RETRIES on a
    // busy/locked DB mid-write; this guard waits for the OS to RELEASE a
    // handle post-close. Different lifecycle points, intentionally
    // independent values — if either changes, re-evaluate both
    // (coupled-constant discipline).
    await new Promise((r) => setTimeout(r, 200));
  } else {
    await new Promise((r) => setImmediate(r));
  }
}

// Per-DB init helpers. `initVaultDbs` is the bundle used at vault
// creation/registration time (init / adopt / join / clone / mesh-init /
// mesh-join). The individual initers exist for surgical fixtures + tests.
export async function initLytDb(vaultPath: string): Promise<void> {
  const db = await openLytDb(vaultPath);
  await closeVaultDb(db);
}

// Registry-driven per-ledger init.
export async function initLedgerDb(vaultPath: string, kindName: LedgerKindName): Promise<void> {
  const db = await openLedgerDb(vaultPath, kindName);
  await closeVaultDb(db);
}

export async function initAuditDb(vaultPath: string): Promise<void> {
  return initLedgerDb(vaultPath, "audit");
}

export async function initProvenanceDb(vaultPath: string): Promise<void> {
  return initLedgerDb(vaultPath, "provenance");
}

// Track C Wave 3 F15 — corrupted-index self-heal. A corrupted lyt.db was an
// in-product dead-end: search died, doctor was blind, repair found nothing,
// and reindex itself choked at open (migrations run inside openLytDb, so
// SQLITE_NOTADB throws before any rebuild can start). lyt.db under
// `.lyt/indexes/` is explicitly derived, gitignored, rebuildable state —
// quarantine-and-recreate is always safe. Probe-open the DB; on a
// not-a-database error, rename the corrupt file aside (audit trail, never
// silent-delete) and recreate a fresh migrated schema so the caller's
// rebuild proceeds. Any other error rethrows untouched.
export interface LytDbHealResult {
  healed: boolean;
  quarantinedTo: string | null;
}

export async function healLytDbIfCorrupt(
  vaultPath: string,
  nowIso?: string,
): Promise<LytDbHealResult> {
  const dbPath = getLytDbPath(vaultPath);
  if (!existsSync(dbPath)) return { healed: false, quarantinedTo: null };
  try {
    const db = await openLytDb(vaultPath);
    await closeVaultDb(db);
    return { healed: false, quarantinedTo: null };
  } catch (err) {
    if (!isCorruptDatabaseError(err)) throw err;
    // Strip path separators too (release review i1): nowIso only ever comes
    // from internal callers today, but the function is exported — a
    // separator in the stamp must not relocate the quarantine file.
    const stamp = (nowIso ?? new Date().toISOString()).replace(/[:.\\/]/g, "-");
    const quarantinePath = `${dbPath}.corrupt-${stamp}`;
    // Preferred: rename the corrupt file aside (keeps the inode for
    // forensics and frees the name). On win32 the libsql native client can
    // hold the file handle long after close() — ~8.1s observed for the
    // NOTADB shape, and effectively UNBOUNDED for a failed-mid-migration
    // SQLITE_CORRUPT probe (same-process leak; no retry budget can outwait
    // it — release review follow-through). So when the rename budget
    // exhausts on lock errors, fall back to COPY + TRUNCATE-IN-PLACE:
    // SQLite opens with shared read/write, so both operations succeed
    // against a held handle, and a zero-byte file is a valid fresh-db seed
    // for the migrate below.
    const renamed = await renameWithRetry(dbPath, quarantinePath);
    if (!renamed) {
      copyFileSync(dbPath, quarantinePath);
    }
    // release review — move the journal siblings WITH the corrupt db:
    // journal_mode=DELETE pairs a hot `-journal` by filename, so a stale
    // journal left beside the freshly recreated lyt.db is eligible for
    // rollback-replay INTO the new db on next open; and the quarantined
    // file keeps its journal for forensics. Best-effort (rename, then
    // unlink as fallback — a stale journal beside a fresh db is worse
    // than a lost one).
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sibling = `${dbPath}${suffix}`;
      if (existsSync(sibling)) {
        try {
          renameSync(sibling, `${quarantinePath}${suffix}`);
        } catch {
          try {
            unlinkSync(sibling);
          } catch {
            // locked sibling — surfaces on the next heal
          }
        }
      }
    }
    if (!renamed) {
      truncateSync(dbPath, 0);
    }
    await initLytDb(vaultPath);
    return { healed: true, quarantinedTo: quarantinePath };
  }
}

// Classify "this file is not a usable database" errors worth quarantining.
// Covers both libSQL shapes observed empirically (release review):
// - SQLITE_NOTADB "file is not a database" — garbage bytes / wrong magic
// - SQLITE_CORRUPT "database disk image is malformed" — torn write / truncation
// Both hit the heal's premise equally: lyt.db is derived, gitignored,
// rebuildable state, so quarantine-and-recreate is always safe. Anything
// else (directory at the path, permissions, ...) rethrows untouched.
// Exported since the hardening fix-pass: this classifier is the SINGLE seed for
// every corrupt-db touchpoint (search/recall/primer/rollup/automator surface
// CorruptLytDbError; capture warns; sync/doctor/repair probe) — do not
// duplicate the message-shape list at call sites.
export function isCorruptDatabaseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("file is not a database") ||
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("database disk image is malformed")
  );
}

// hardening cluster (hardening fix-pass, 2026-06-10) — the F15 remedy pattern
// one level out: a corrupt per-vault lyt.db must never surface as a raw
// libsql error. The matrix-spec'd read verbs (search/recall, primer, rollup,
// the automator runner) route their opens through openLytDbActionable so the
// user/agent gets the remedy verb instead of internal db jargon. (Residual:
// automator-log/status and `vault list` rollup aggregation still open raw —
// registered as hardening pass in MATRIX-FINDINGS.md.) The CLI layers surface thrown
// flow errors as `lyt: <message>` with a NON-ZERO exit (search/reindex map to
// exit 2; the global cli.ts catch exits 1) — AI-actionable error doctrine.
//
// NOTE (release review): the wrapped message deliberately embeds the underlying
// SQLITE_* token, so isCorruptDatabaseError still classifies a RE-THROWN
// CorruptLytDbError as corrupt — keep the `(underlying: ...)` suffix.
export class CorruptLytDbError extends Error {
  readonly errorCode = "corrupt-lyt-db";
  readonly vaultRef: string;
  constructor(vaultRef: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(
      `The search index for vault '${vaultRef}' (.lyt/indexes/lyt.db) is corrupt and could not be opened. ` +
        `It is derived, rebuildable state — run 'lyt reindex --vault '${vaultRef}'' to quarantine the corrupt file and rebuild it from the vault's markdown. ` +
        `(underlying: ${causeMsg})`,
    );
    this.name = "CorruptLytDbError";
    this.vaultRef = vaultRef;
  }
}

// Chokepoint opener for read verbs: identical to openLytDb, but a corrupt-db
// open failure throws CorruptLytDbError (remedy named) instead of the raw
// libsql error. Verbs that HEAL (reindex via rebuildVaultFlow) keep calling
// openLytDb/healLytDbIfCorrupt directly — healing must see the raw shape.
export async function openLytDbActionable(vaultPath: string, vaultRef?: string): Promise<Client> {
  try {
    return await openLytDb(vaultPath);
  } catch (err) {
    if (isCorruptDatabaseError(err)) {
      throw new CorruptLytDbError(vaultRef ?? vaultPath, err);
    }
    throw err;
  }
}

// Detect-only probe: is the
// vault's lyt.db present-but-corrupt? READ-ONLY by design: opens the raw
// client (no migrations — diagnose verbs must not write; a frozen vault's
// contract forbids it) and runs `PRAGMA quick_check` as the integrity probe.
// Catches both fixture-modeled shapes (SQLITE_NOTADB garbage bytes at open;
// SQLITE_CORRUPT truncation) plus quick_check-detectable page damage. Never
// heals, never throws on the corrupt shape — non-corrupt errors rethrow
// untouched. A missing lyt.db is NOT corrupt (never-indexed vaults are
// healthy).
export async function isLytDbCorrupt(vaultPath: string): Promise<boolean> {
  const dbPath = getLytDbPath(vaultPath);
  if (!existsSync(dbPath)) return false;
  const db = createClient({ url: `file:${dbPath}` });
  try {
    const r = await db.execute("PRAGMA quick_check");
    const first = r.rows[0];
    const verdict = first === undefined ? "ok" : String(Object.values(first)[0] ?? "ok");
    return verdict.toLowerCase() !== "ok";
  } catch (err) {
    if (isCorruptDatabaseError(err)) return true;
    throw err;
  } finally {
    await closeVaultDb(db);
  }
}

// Returns true when the rename landed (or the source was already gone —
// another process quarantined it first, release review); false when the
// lock-retry budget exhausted (caller falls back to copy+truncate). Throws
// only on non-lock errors. Budget: 40 × 250ms = 10s on win32 — covers the
// ~8.1s observed post-close handle hold for the NOTADB shape (release review
// a review finding); the copy+truncate fallback covers everything beyond it, so the
// budget is a preference (rename keeps forensics), not a cliff.
async function renameWithRetry(from: string, to: string): Promise<boolean> {
  const attempts = process.platform === "win32" ? 40 : 5;
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw err;
      await sleep(250);
    }
  }
  return false;
}

// Bundle: create + migrate + close lyt.db + every ledger DB in the
// registry. Convenience for scaffold/fresh-clone flows that need every
// DB present at the new vault. Iterates LEDGER_REGISTRY so new ledger
// kinds appended there ship in fresh vaults automatically.
export async function initVaultDbs(vaultPath: string): Promise<void> {
  await initLytDb(vaultPath);
  for (const kind of LEDGER_REGISTRY) {
    await initLedgerDb(vaultPath, kind.name);
  }
}
