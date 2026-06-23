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

export interface VaultDbMigration {
  version: number;
  name: string;
  sql: string;
}

// v1.A.2c per-vault DB SPLIT migrations.
//
// Each per-vault DB lives under `<vault>/.lyt/indexes/` and carries its own
// `schema_migrations` row independently. Three migration sets:
//
// lyt.db vault_state + child_pull_state + automator_runs +
// automator_run_events
// audit.db audit_log (cache over audit.yon SoT)
// provenance.db provenance (cache over provenance.yon SoT)
//
// All PKs are BLOB UUIDv7 per the global standing UUIDv7 directive + arc §10.
// libSQL's in-process driver does not ship the `uuid7()` SQL function — PKs
// are TS-supplied via `newUuidv7Bytes()` in util/uuid7.ts at INSERT time.

// ---------------------------------------------------------------------------
// lyt.db — runtime + automator state
// ---------------------------------------------------------------------------

const lytMigration001Init: VaultDbMigration = {
  version: 1,
  name: "init-lyt-db",
  sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_state (
 id BLOB PRIMARY KEY,
 vault_name TEXT NOT NULL,
 generation INTEGER NOT NULL,
 last_modified_at INTEGER NOT NULL,
 schema_version TEXT NOT NULL,
 rollup_summary_hash TEXT
);

CREATE TABLE IF NOT EXISTS child_pull_state (
 id BLOB PRIMARY KEY,
 parent_vault TEXT NOT NULL,
 child_vault TEXT NOT NULL,
 last_pulled_generation INTEGER NOT NULL,
 last_pulled_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automator_runs (
 id BLOB PRIMARY KEY,
 automator_name TEXT NOT NULL,
 vault_rid BLOB NOT NULL,
 started_at INTEGER NOT NULL,
 ended_at INTEGER,
 status TEXT NOT NULL,
 vault_writes_count INTEGER DEFAULT 0,
 llm_calls_count INTEGER DEFAULT 0,
 llm_cost_usd REAL DEFAULT 0,
 source_used TEXT,
 error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_automator_runs_vault_rid ON automator_runs(vault_rid);
CREATE INDEX IF NOT EXISTS idx_automator_runs_started_at ON automator_runs(started_at);

CREATE TABLE IF NOT EXISTS automator_run_events (
 id BLOB PRIMARY KEY,
 run_id BLOB NOT NULL,
 ts INTEGER NOT NULL,
 level TEXT NOT NULL,
 message TEXT NOT NULL,
 data_json TEXT,
 FOREIGN KEY (run_id) REFERENCES automator_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_automator_run_events_run_id ON automator_run_events(run_id);

CREATE TABLE IF NOT EXISTS lanes (
 rid BLOB PRIMARY KEY,
 name TEXT NOT NULL,
 source_keywords TEXT NOT NULL,
 mem_count INTEGER NOT NULL DEFAULT 0,
 last_built TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lane_members (
 lane_rid BLOB NOT NULL REFERENCES lanes(rid) ON DELETE CASCADE,
 figment_rid TEXT NOT NULL,
 PRIMARY KEY (lane_rid, figment_rid)
);

CREATE INDEX IF NOT EXISTS idx_lane_members_lane_rid ON lane_members(lane_rid);

CREATE TABLE IF NOT EXISTS arcs (
 rid BLOB PRIMARY KEY,
 name TEXT NOT NULL,
 category TEXT NOT NULL,
 last_touched TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arc_members (
 arc_rid BLOB NOT NULL REFERENCES arcs(rid) ON DELETE CASCADE,
 figment_rid TEXT NOT NULL,
 position INTEGER NOT NULL,
 PRIMARY KEY (arc_rid, position)
);

CREATE INDEX IF NOT EXISTS idx_arc_members_figment ON arc_members(figment_rid);

CREATE VIRTUAL TABLE IF NOT EXISTS figment_fts USING fts5(figment_rid UNINDEXED, body, tokenize='porter unicode61');
`,
};

// v1.E.2 — `rollup` cache table for transitive keyword rollup (per
// master-plan §v1.E.2:892-908 + federation-design §8.6). Composite PK
// (target_vault_rid, keyword, source_path) lets a single ancestor carry
// the same keyword from multiple descendants without collision; the
// source_path chain (e.g. "vault:<gc-hex>>vault:<c-hex>") encodes the
// transitive provenance. last_seen drives soft-tombstone detection at
// list time (rows older than ROLLUP_DISCONNECTED_DAYS surface via
// `lyt vault list --include-tombstones`). target_vault_rid + keyword
// are TEXT (hex-encoded vault rid prefix + raw keyword) so the libSQL
// shape stays uniform with the existing TEXT-based slug rids in lanes;
// future v2 can evolve to BLOB rid columns if the rollup row count
// outgrows the TEXT prefix encoding.
const lytMigration002Rollup: VaultDbMigration = {
  version: 2,
  name: "init-rollup-table",
  sql: `
CREATE TABLE IF NOT EXISTS rollup (
 target_vault_rid TEXT NOT NULL,
 keyword TEXT NOT NULL,
 weight REAL NOT NULL DEFAULT 1.0,
 last_seen TEXT NOT NULL,
 source_path TEXT NOT NULL,
 PRIMARY KEY (target_vault_rid, keyword, source_path)
);

CREATE INDEX IF NOT EXISTS idx_rollup_target ON rollup(target_vault_rid);
CREATE INDEX IF NOT EXISTS idx_rollup_last_seen ON rollup(last_seen);
`,
};

// Lane V Phase 0 (0.3) — `figment_edges` cache for parsed figment→figment
// links (currently `[[wikilink]]` / `![[embed]]` targets pulled OUT of the FTS
// body so a link target no longer FTS-matches as prose — Qmsg-2 link-bleed).
// Same Lock 0.2 posture: a derived cache over the markdown SoT, rebuilt by the
// same full-walk that refreshes figment_fts. The table is also the foundation
// the A5 graph-expansion arm traverses (experiment-harness plan Phase 1).
// source_rid — vault-relative POSIX path of the source figment (same key as
// figment_fts.figment_rid; TEXT, no UUIDv7 for notes in v1).
// target — link target text, sans #heading / ^block fragment.
// kind — 'wikilink' | 'embed' (extensible; default 'wikilink').
// Composite PK dedups repeated identical links; idx on target serves reverse
// (incoming-link) lookups for graph traversal.
const lytMigration003FigmentEdges: VaultDbMigration = {
  version: 3,
  name: "init-figment-edges",
  sql: `
CREATE TABLE IF NOT EXISTS figment_edges (
 source_rid TEXT NOT NULL,
 target TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'wikilink',
 PRIMARY KEY (source_rid, target, kind)
);

CREATE INDEX IF NOT EXISTS idx_figment_edges_target ON figment_edges(target);
`,
};

// Lane V Phase 0 (0.4) — `figment_meta` cache for per-figment TEMPORAL TRUTH
// (root tension R3). Stores each figment's FRONTMATTER authored time (created /
// modified), parsed at index time. Fixes V-F16 (primer "recent activity" empty
// because the event-ledger isn't an authored-time source) and V-F9 (keyword
// decay read lane BUILD-time, so a 25-day-old doc and a today doc decayed
// identically). Same Lock 0.2 posture: a derived cache over the markdown SoT,
// rebuilt by the same full-walk as figment_fts. Deliberately NOT the
// provenance ledger (that is an append-only EVENT log; figment authored-time is
// a figment fact, not an event — handler-ratified 2026-06-07).
// figment_rid — vault-relative POSIX path (same key as figment_fts).
// created_iso — frontmatter `created`, normalized ISO-8601, or NULL.
// modified_iso — frontmatter `modified` (falls back to created), or NULL.
// idx on modified_iso serves the primer's recent-activity window scan.
const lytMigration004FigmentMeta: VaultDbMigration = {
  version: 4,
  name: "init-figment-meta",
  sql: `
CREATE TABLE IF NOT EXISTS figment_meta (
 figment_rid TEXT PRIMARY KEY,
 created_iso TEXT,
 modified_iso TEXT
);

CREATE INDEX IF NOT EXISTS idx_figment_meta_modified ON figment_meta(modified_iso);
`,
};

// V-C-1 SC3 option-b (a review finding) — extend figment_meta with the figment's
// frontmatter `topic` (semantic category) + `tags`, so the primer can derive
// a "Top keywords" FALLBACK list when no lane formed (lanes need ≥2 figments
// sharing a tag; a single/untagged capture forms none, leaving keywords empty
// — the first-capture demo looked broken). ADDITIVE columns, NULL where the
// frontmatter lacks the field; figment_meta is a rebuildable cache (Lock 0.2),
// so existing pods back-fill on the next `lyt reindex` / rebuild / L3 self-heal
// (both write seams — the full-walk upsert-fts-cache.ts AND the per-figment
// reconcile-figment-write.ts — now parse + store these). `tags` is stored as a
// JSON array string (the single stable round-trip encoding; the reader
// JSON.parses exactly what the writer JSON.stringified). No back-fill DML here —
// ALTER ADD COLUMN is non-destructive; the cache repopulates by rebuild.
//
// Δ2 sequencing note (brief §Risks): the rev-17 Lane M freshness wave also
// extends figment_meta (per-vault staleness signal); this migration lands first
// and that brief reuses this add-column pattern (avoid two un-reconciled
// migrations to one table).
const lytMigration005FigmentMetaTopicTags: VaultDbMigration = {
  version: 5,
  name: "figment-meta-topic-tags",
  sql: `
ALTER TABLE figment_meta ADD COLUMN topic TEXT;
ALTER TABLE figment_meta ADD COLUMN tags TEXT;
`,
};

// feat/keyphrase-boost — `keyphrases` cache for the per-doc keyphrase-match
// rerank boost. A derived cache over the markdown SoT (Lock 0.2), rebuilt by
// the same full-walk cadence as lanes/arcs/fts via rebuildVaultFlow's
// `rebuild-keyphrases` step. One row per (figment, keyphrase token); the
// cascade loads the per-vault set and adds β·keyphraseMatch(query, doc) to the
// blended score before the final sort (proven β=0.2 → +53% oracle nDCG@5).
//
// PK choice (per the standing UUIDv7 directive — surface the reasoning): this
// is a NON-TEMPORAL per-doc-term LOOKUP table, identical in shape+intent to
// lane_members / figment_edges (composite TEXT PK), NOT a time-ordered record
// stream. So the PK is the natural composite (figment_rid, term) — a TEXT path
// key + TEXT token — NOT a synthetic UUIDv7. UUIDv7's value (time-sortable
// surrogate) buys nothing here; the composite is the identity and dedups
// repeated tokens for free. Mirrors the lane_members rationale verbatim.
//
// Collision-safety note (avoid the lanes slug-collision class): the key is the
// RAW lowercase token verbatim (the extractor's tokenizer output), NOT a
// further-derived slug. There is no second derivation step that could collapse
// two distinct keys into one, so the tag→slug collision class cannot recur
// here (a red-prove test pins this). figment_rid is the same vault-relative
// POSIX path key as figment_fts.figment_rid.
const lytMigration006Keyphrases: VaultDbMigration = {
  version: 6,
  name: "init-keyphrases",
  sql: `
CREATE TABLE IF NOT EXISTS keyphrases (
 figment_rid TEXT NOT NULL,
 term TEXT NOT NULL,
 PRIMARY KEY (figment_rid, term)
);

CREATE INDEX IF NOT EXISTS idx_keyphrases_figment ON keyphrases(figment_rid);
`,
};

// feat/microrag-semantic — `embeddings` cache for the OPTIONAL local dense
// retrieval arm (bge-small-en-v1.5, 384-dim). A derived cache over the markdown
// SoT (Lock 0.2), rebuilt by the same full-walk cadence as keyphrases via
// rebuildVaultFlow's `upsert-embeddings` step — but ONLY when embeddings are
// enabled AND the local model is available (ARC-D2: a base pod with no fastembed
// never builds this table; an empty table makes dense retrieval a clean no-op).
//
// The migration ALWAYS runs (so the schema is uniform across pods); it is the
// POPULATION that is gated. One row per figment: the raw little-endian Float32
// vector bytes (`vec`) + `dim` + a content hash (`body_hash`) so a per-write
// incremental path can skip unchanged docs (deferred — full-walk only for now).
//
// Storage choice (per the standing UUIDv7 directive — surface the reasoning):
// PK is the natural per-doc TEXT path (figment_rid), identical in shape+intent
// to keyphrases / figment_fts — a NON-TEMPORAL per-doc LOOKUP row, NOT a
// time-ordered stream, so a synthetic UUIDv7 buys nothing. The vector is a plain
// BLOB (named with the F32_BLOB convention for readers) of raw Float32 bytes:
// libSQL @0.15.15 ships no native vector ops, so cosine is brute-forced in JS
// over the loaded vectors (the proven prototype's approach) — this keeps the
// table portable across every libSQL build with no vector-extension dependency.
const lytMigration007Embeddings: VaultDbMigration = {
  version: 7,
  name: "init-embeddings",
  sql: `
CREATE TABLE IF NOT EXISTS embeddings (
 figment_rid TEXT NOT NULL PRIMARY KEY,
 dim INTEGER NOT NULL,
 body_hash TEXT NOT NULL,
 vec BLOB NOT NULL
);
`,
};

export const LYT_DB_MIGRATIONS: readonly VaultDbMigration[] = [
  lytMigration001Init,
  lytMigration002Rollup,
  lytMigration003FigmentEdges,
  lytMigration004FigmentMeta,
  lytMigration005FigmentMetaTopicTags,
  lytMigration006Keyphrases,
  lytMigration007Embeddings,
];

export const LYT_DB_TABLES = Object.freeze([
  "vault_state",
  "child_pull_state",
  "automator_runs",
  "automator_run_events",
  "lanes",
  "lane_members",
  "arcs",
  "arc_members",
  "figment_fts",
  "figment_fts_config",
  "figment_fts_content",
  "figment_fts_data",
  "figment_fts_docsize",
  "figment_fts_idx",
  "rollup",
  "figment_edges",
  "figment_meta",
  "keyphrases",
  "embeddings",
] as const);

// ---------------------------------------------------------------------------
// audit.db — cache over audit.yon SoT
// ---------------------------------------------------------------------------

const auditMigration001Init: VaultDbMigration = {
  version: 1,
  name: "init-audit-db",
  sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
 id BLOB PRIMARY KEY,
 ts INTEGER NOT NULL,
 actor TEXT NOT NULL,
 action TEXT NOT NULL,
 target_type TEXT NOT NULL,
 target_id TEXT NOT NULL,
 result TEXT NOT NULL,
 details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
`,
};

export const AUDIT_DB_MIGRATIONS: readonly VaultDbMigration[] = [auditMigration001Init];

export const AUDIT_DB_TABLES = Object.freeze(["audit_log"] as const);

// ---------------------------------------------------------------------------
// provenance.db — cache over provenance.yon SoT
// ---------------------------------------------------------------------------

const provenanceMigration001Init: VaultDbMigration = {
  version: 1,
  name: "init-provenance-db",
  sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance (
 id BLOB PRIMARY KEY,
 target_type TEXT NOT NULL,
 target_id TEXT NOT NULL,
 ts INTEGER NOT NULL,
 src TEXT NOT NULL,
 method TEXT,
 confidence REAL,
 hash TEXT,
 tokens INTEGER,
 cost_usd REAL,
 model TEXT,
 approver TEXT,
 details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_provenance_target ON provenance(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_provenance_ts ON provenance(ts);
`,
};

export const PROVENANCE_DB_MIGRATIONS: readonly VaultDbMigration[] = [provenanceMigration001Init];

export const PROVENANCE_DB_TABLES = Object.freeze(["provenance"] as const);

// ---------------------------------------------------------------------------
// Canonical audit_log.action enumeration (unchanged from A.1; lives here for
// the action-string SoT). Arc §8 (vault.* / automator.*) + arc §10.2
// (sync.friction.*).
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = Object.freeze({
  VAULT_ACCESS_LOST: "vault.access.lost",
  VAULT_INDEX_REBUILT: "vault.index.rebuilt",
  // v1.B.3 — `lyt vault rename` emits this action when a vault is
  // renamed in-place. details_json carries old_name + new_name +
  // mesh_rid_hex.
  VAULT_RENAMED: "vault.renamed",
  AUTOMATOR_RUN_COMPLETED: "automator.run.completed",
  AUTOMATOR_MEMSCOPE_DENIED: "automator.memscope.denied",
  AUTOMATOR_WRITE: "automator.write",
  SYNC_FRICTION_SYNC_FAILED: "sync.friction.sync.failed",
  SYNC_FRICTION_SYNC_CONFLICT: "sync.friction.sync.conflict",
  SYNC_FRICTION_PROPAGATION_GAP: "sync.friction.propagation.gap",
  SYNC_FRICTION_DISCOVERY_GAP: "sync.friction.discovery.gap",
  SYNC_FRICTION_FIX_SHIPPED: "sync.friction.fix.shipped",
} as const);

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const FRICTION_CATEGORIES = Object.freeze([
  "sync.failed",
  "sync.conflict",
  "propagation.gap",
  "discovery.gap",
] as const);

export type FrictionCategory = (typeof FRICTION_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Migrators — same algorithm per DB. Each owns its `schema_migrations` row.
// ---------------------------------------------------------------------------

async function runMigrations(
  db: Client,
  set: readonly VaultDbMigration[],
): Promise<readonly VaultDbMigration[]> {
  await db.execute(`
 CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 applied_at TEXT NOT NULL
 );
  `);

  const applied = await db.execute("SELECT version FROM schema_migrations ORDER BY version ASC");
  const appliedVersions = new Set(applied.rows.map((r) => Number(r["version"])));

  const pending = set
    .filter((m) => !appliedVersions.has(m.version))
    .sort((a, b) => a.version - b.version);

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

export async function migrateLytDb(db: Client): Promise<readonly VaultDbMigration[]> {
  return runMigrations(db, LYT_DB_MIGRATIONS);
}

export async function migrateAuditDb(db: Client): Promise<readonly VaultDbMigration[]> {
  return runMigrations(db, AUDIT_DB_MIGRATIONS);
}

export async function migrateProvenanceDb(db: Client): Promise<readonly VaultDbMigration[]> {
  return runMigrations(db, PROVENANCE_DB_MIGRATIONS);
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
