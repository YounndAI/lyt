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

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { recordAudit, reinjectAuditRecord } from "../registry/audit-write.js";
import { reinjectProvenanceRecord } from "../registry/provenance-write.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import {
  closeVaultDb,
  getAuditDbPath,
  getLytDbPath,
  getProvenanceDbPath,
  openAuditDb,
  openLytDb,
  openProvenanceDb,
} from "../registry/vault-db.js";
import { AUDIT_ACTIONS } from "../registry/vault-db-migrations.js";
import {
  mapAuditYonToCacheArgs,
  mapProvenanceYonToCacheArgs,
} from "../registry/_helpers/ledger-yon-mapper.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { newUuidv7Bytes } from "../util/uuid7.js";
import { walkLedger } from "../yon/ledger-read.js";
import { KNOWN_LEDGERS, type LedgerName } from "./housekeep.js";

export interface RebuildIndexArgs {
  name: string;
  force?: boolean;
  // v1.A.2: when set, rebuild ONLY the named ledger's cache from YON
  // SoT (no full DB drop). Omit to do the full block-A behaviour (drop
  // sidecars + recreate schema + seed vault_state + audit row).
  ledger?: LedgerName;
}

export interface RebuildIndexResult {
  vaultName: string;
  vaultPath: string;
  droppedDbBytes: number;
  tablesCreated: number;
  recordsCached: number;
  durationMs: number;
  provenanceRowsDiscarded: number;
  auditRowsDiscarded: number;
  // v1.A.2: when --ledger was supplied, how many records were re-injected
  // from YON SoT. Null on full rebuild.
  ledgerReinjected?: number;
}

// v1.A.2c DB SPLIT: per-vault state now spread across three .db files in
// .lyt/indexes/. Full rebuild drops sidecars for all three.
const SPLIT_DB_BASES = ["lyt", "audit", "provenance"] as const;
const DB_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

const STUB_SCHEMA_VERSION = "v1.0-block-a";

// Re-derives the per-vault libSQL projection from the markdown YON source-of-
// truth in `.lyt/`. Per arc §8.5: libSQL is per-machine, .gitignore'd, and
// rebuildable. Fresh-machine clone scenario: git pull lands the .md/.yon
// files but no .lyt/indexes/*.db; this verb creates each per-ledger schema
// and seeds the initial vault_state row + a `vault.index.rebuilt` audit_log
// entry.
//
// block-A scope: schema + bundled-YON file counts only. block-B will populate
// the @AUTOMATOR / @DIRECTIVE / @MEMSCOPE caches with parsed content.
export async function rebuildVaultIndexFlow(args: RebuildIndexArgs): Promise<RebuildIndexResult> {
  const startedAt = Date.now();
  const db = await openRegistry();
  let vault: VaultRow | null;
  try {
    vault = await getVaultByName(db, args.name);
  } finally {
    await closeRegistry(db);
  }
  if (!vault) {
    throw new Error(`No vault registered with name '${args.name}'.`);
  }
  if (vault.status === "tombstoned") {
    throw new Error(`Vault '${args.name}' is tombstoned; cannot rebuild index.`);
  }
  if (!existsSync(vault.path)) {
    throw new Error(`Vault '${args.name}' path missing on disk: ${vault.path}`);
  }

  if (args.force !== true) {
    await enforceNotFrozen(vault.path, vault.name);
  }

  // v1.A.2 ledger-only rebuild path. Skips the full DB drop; surgically
  // truncates the ledger's table + re-injects from YON SoT.
  if (args.ledger !== undefined) {
    if (!KNOWN_LEDGERS.includes(args.ledger)) {
      throw new Error(`Unknown --ledger '${args.ledger}'. Known: ${KNOWN_LEDGERS.join(", ")}`);
    }
    return rebuildLedgerOnly(vault, args.ledger, startedAt);
  }

  // release review: rebuild-index drops the per-vault DB, and the markdown
  // YON source-of-truth does NOT carry provenance / audit rows (those live
  // ONLY in libSQL). On a vault with real block-B+ history, dropping is a
  // destructive operation. Pre-drop: count what would be lost; refuse without
  // --force when the row count is non-trivial. With --force, emit the counts
  // to stderr so the audit trail of the destruction is visible.
  const { provenanceRows, auditRowsHistoricalOnly } = await countHistoricalRows(vault.path);
  if ((provenanceRows > 0 || auditRowsHistoricalOnly > 0) && args.force !== true) {
    throw new Error(
      `rebuild-index would discard ${provenanceRows} provenance + ${auditRowsHistoricalOnly} audit rows from vault '${args.name}'. ` +
        "These rows live ONLY in libSQL (markdown YON does not carry them); rebuilding will lose them permanently. " +
        "Re-run with --force to confirm.",
    );
  }
  if (args.force === true && (provenanceRows > 0 || auditRowsHistoricalOnly > 0)) {
    // eslint-disable-next-line no-console
    console.error(
      `lyt vault rebuild-index: --force discarding ${provenanceRows} provenance + ${auditRowsHistoricalOnly} audit rows from vault '${args.name}'.`,
    );
  }

  const droppedDbBytes = dropSplitDbSidecars(vault.path);

  // openLytDb / openAuditDb / openProvenanceDb each run their respective
  // migrators (idempotent). Open all three so we can count tables across
  // every per-ledger cache + leave them present on disk (matches the
  // block-A "fresh clone → all caches there" semantic).
  const lytDb = await openLytDb(vault.path);
  const auditDb = await openAuditDb(vault.path);
  const provenanceDb = await openProvenanceDb(vault.path);

  let tablesCreated = 0;
  let recordsCached = 0;
  try {
    // Count tables across all three DBs to match the pre-split summary shape.
    const lytTablesQ = await lytDb.execute(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'",
    );
    const auditTablesQ = await auditDb.execute(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'",
    );
    const provenanceTablesQ = await provenanceDb.execute(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'",
    );
    tablesCreated =
      Number(lytTablesQ.rows[0]!["c"]) +
      Number(auditTablesQ.rows[0]!["c"]) +
      Number(provenanceTablesQ.rows[0]!["c"]);

    recordsCached = countBundledYon(vault.path);

    // Initial vault_state row — block-A snapshot. generation starts at 0;
    // block-B will bump on writes.
    await lytDb.execute({
      sql:
        "INSERT INTO vault_state (id, vault_name, generation, last_modified_at, schema_version)" +
        " VALUES (?, ?, ?, ?, ?)",
      args: [newUuidv7Bytes(), vault.name, 0, Date.now(), STUB_SCHEMA_VERSION],
    });

    // v1.A.2 Lock 0.2 — YON SoT first, .db cache second. recordAudit now
    // writes to audit.db (post-split).
    await recordAudit(vault.path, auditDb, {
      id: newUuidv7Bytes(),
      ts: Date.now(),
      actor: "system:lyt",
      action: AUDIT_ACTIONS.VAULT_INDEX_REBUILT,
      targetType: "vault",
      targetId: vault.ridHex,
      result: "success",
      details: {
        dropped_db_bytes: droppedDbBytes,
        tables_created: tablesCreated,
        records_cached: recordsCached,
        rebuild_outcome: "ok",
      },
      stampSrc: "flows/rebuild-index",
    });
  } finally {
    // Reverse-acquire close order.
    await closeVaultDb(provenanceDb);
    await closeVaultDb(auditDb);
    await closeVaultDb(lytDb);
  }

  return {
    vaultName: vault.name,
    vaultPath: vault.path,
    droppedDbBytes,
    tablesCreated,
    recordsCached,
    durationMs: Date.now() - startedAt,
    provenanceRowsDiscarded: provenanceRows,
    auditRowsDiscarded: auditRowsHistoricalOnly,
  };
}

// v1.A.2 — Ledger-only rebuild surgically truncates ONE table + re-injects
// from YON SoT. Skips the destructive full-DB drop. Idempotent
// (reinjectXxxRecord probes natural keys before insert). Post-split, the
// audit branch opens audit.db; the provenance branch opens provenance.db.
async function rebuildLedgerOnly(
  vault: VaultRow,
  ledger: LedgerName,
  startedAt: number,
): Promise<RebuildIndexResult> {
  let reinjected = 0;
  if (ledger === "audit") {
    const auditDb = await openAuditDb(vault.path);
    try {
      await auditDb.execute("DELETE FROM audit_log");
      const records = walkLedger(join(vault.path, ".lyt", "ledgers"), "audit");
      for (const r of records) {
        // rebuild defaults "vault.index.rebuilt" preserved verbatim.
        const fields = mapAuditYonToCacheArgs(r, "vault.index.rebuilt");
        if (fields === null) continue;
        const fresh = await reinjectAuditRecord(auditDb, fields);
        if (fresh) reinjected += 1;
      }
    } finally {
      await closeVaultDb(auditDb);
    }
  } else if (ledger === "provenance") {
    const provenanceDb = await openProvenanceDb(vault.path);
    try {
      await provenanceDb.execute("DELETE FROM provenance");
      const records = walkLedger(join(vault.path, ".lyt", "ledgers"), "provenance");
      for (const r of records) {
        const fields = mapProvenanceYonToCacheArgs(r);
        if (fields === null) continue;
        const fresh = await reinjectProvenanceRecord(provenanceDb, fields);
        if (fresh) reinjected += 1;
      }
    } finally {
      await closeVaultDb(provenanceDb);
    }
  }
  return {
    vaultName: vault.name,
    vaultPath: vault.path,
    droppedDbBytes: 0,
    tablesCreated: 0,
    recordsCached: 0,
    durationMs: Date.now() - startedAt,
    provenanceRowsDiscarded: 0,
    auditRowsDiscarded: 0,
    ledgerReinjected: reinjected,
  };
}

interface HistoricalRowCounts {
  provenanceRows: number;
  auditRowsHistoricalOnly: number;
}

// Counts the rows the pending drop is about to destroy. Skips the synthetic
// `vault.index.rebuilt` rows because those are own-emitted bookkeeping —
// counting them would scare handlers off every other rebuild. Post-split:
// audit_log lives in audit.db; provenance lives in provenance.db.
async function countHistoricalRows(vaultPath: string): Promise<HistoricalRowCounts> {
  let provenanceRows = 0;
  let auditRowsHistoricalOnly = 0;

  if (existsSync(getProvenanceDbPath(vaultPath))) {
    const provDb = await openProvenanceDb(vaultPath);
    try {
      const r = await provDb.execute("SELECT COUNT(*) AS c FROM provenance");
      provenanceRows = Number(r.rows[0]!["c"]);
    } finally {
      await closeVaultDb(provDb);
    }
  }

  if (existsSync(getAuditDbPath(vaultPath))) {
    const auditDb = await openAuditDb(vaultPath);
    try {
      const r = await auditDb.execute(
        "SELECT COUNT(*) AS c FROM audit_log WHERE action NOT LIKE 'vault.index.rebuilt'",
      );
      auditRowsHistoricalOnly = Number(r.rows[0]!["c"]);
    } finally {
      await closeVaultDb(auditDb);
    }
  }

  return { provenanceRows, auditRowsHistoricalOnly };
}

// Drops all three split DB files (lyt, audit, provenance) + their wal/shm
// sidecars under .lyt/indexes/. Returns total bytes freed.
function dropSplitDbSidecars(vaultPath: string): number {
  let bytes = 0;
  const indexesDir = join(vaultPath, ".lyt", "indexes");
  for (const base of SPLIT_DB_BASES) {
    for (const suffix of DB_SIDECAR_SUFFIXES) {
      const p = join(indexesDir, `${base}.db${suffix}`);
      if (!existsSync(p)) continue;
      try {
        bytes += statSync(p).size;
      } catch {
        // size best-effort
      }
      try {
        unlinkSync(p);
      } catch {
        // Windows: the OS may still hold the lock briefly. The opener
        // recreates the file regardless; a leftover sidecar is harmless
        // because CREATE TABLE IF NOT EXISTS is idempotent. Keep going.
      }
    }
  }
  // Defensive: also use the helper-derived paths (catches any layout
  // relocation in vault-db.ts).
  for (const derived of [
    getLytDbPath(vaultPath),
    getAuditDbPath(vaultPath),
    getProvenanceDbPath(vaultPath),
  ]) {
    if (existsSync(derived)) {
      try {
        bytes += statSync(derived).size;
        unlinkSync(derived);
      } catch {
        // see above
      }
    }
  }
  return bytes;
}

function countBundledYon(vaultPath: string): number {
  let count = 0;
  count += countYonInDir(join(vaultPath, ".lyt", "automators"));
  count += countYonInDir(join(vaultPath, ".lyt", "directives"));
  if (existsSync(join(vaultPath, ".lyt", "memscope.yon"))) count += 1;
  return count;
}

function countYonInDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".yon")).length;
  } catch {
    return 0;
  }
}
