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

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// v1.A.1b — `001-init` base migration. Pre-release clean-slate posture per
// project CLAUDE.md governed block-A/B schema work. Migration 002 (below)
// is additive: once 001 has been applied on a machine its body is frozen,
// so any post-001 table (e.g. vault_aliases) MUST land as a NEW version —
// the runner (migrate.ts) skips already-applied versions, so amending 001
// in place would never reach an existing DB.
//
// PRAGMA foreign_keys = ON is set at connection open in client.ts:21
// (block-A invariant). Table-creation order below is meshes BEFORE
// vaults so vaults.home_mesh_rid's FK reference resolves cleanly even
// under strict FK checking; mesh_vaults / mesh_edges / mesh_subscriptions
// come after both meshes and vaults exist.
const migration001Init: Migration = {
  version: 1,
  name: "init",
  sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meshes (
 rid BLOB PRIMARY KEY,
 name TEXT NOT NULL UNIQUE,
 push_target TEXT,
  push_kind       TEXT CHECK (push_kind IN ('handle', 'org')),
 main_vault_rid BLOB,
 created_at TEXT NOT NULL,
 FOREIGN KEY (main_vault_rid) REFERENCES vaults(rid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_meshes_name ON meshes(name);

CREATE TABLE IF NOT EXISTS vaults (
 rid BLOB PRIMARY KEY,
 name TEXT NOT NULL UNIQUE,
 path TEXT NOT NULL UNIQUE,
 memscope_rid BLOB,
 parent_vault BLOB,
 home_mesh_rid BLOB,
 tier_hint TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disconnected', 'missing', 'tombstoned', 'access_lost')),
 git_url TEXT,
 created_at TEXT,
 registered_at TEXT NOT NULL,
 last_verified_at TEXT,
 verify_fail_count INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY (parent_vault) REFERENCES vaults(rid) ON DELETE SET NULL,
 FOREIGN KEY (home_mesh_rid) REFERENCES meshes(rid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_vaults_name ON vaults(name);
CREATE INDEX IF NOT EXISTS idx_vaults_status ON vaults(status);
CREATE INDEX IF NOT EXISTS idx_vaults_home_mesh_rid ON vaults(home_mesh_rid);

CREATE TABLE IF NOT EXISTS mesh_vaults (
 mesh_rid BLOB NOT NULL,
 vault_rid BLOB NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('home', 'subscribed')),
 PRIMARY KEY (mesh_rid, vault_rid),
 FOREIGN KEY (mesh_rid) REFERENCES meshes(rid) ON DELETE CASCADE,
 FOREIGN KEY (vault_rid) REFERENCES vaults(rid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mesh_vaults_vault_rid ON mesh_vaults(vault_rid);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_vaults_home_per_vault
  ON mesh_vaults(vault_rid) WHERE role = 'home';

CREATE TABLE IF NOT EXISTS mesh_edges (
 ref_mesh_rid BLOB NOT NULL,
 ref_vault_rid BLOB NOT NULL,
 home_mesh_rid BLOB NOT NULL,
 home_vault_rid BLOB NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('parent')),
 PRIMARY KEY (ref_mesh_rid, ref_vault_rid, kind, home_vault_rid),
 FOREIGN KEY (ref_mesh_rid) REFERENCES meshes(rid) ON DELETE CASCADE,
 FOREIGN KEY (ref_vault_rid) REFERENCES vaults(rid) ON DELETE CASCADE,
 FOREIGN KEY (home_mesh_rid) REFERENCES meshes(rid) ON DELETE CASCADE,
 FOREIGN KEY (home_vault_rid) REFERENCES vaults(rid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mesh_edges_home_vault ON mesh_edges(home_vault_rid);
CREATE INDEX IF NOT EXISTS idx_mesh_edges_home_mesh ON mesh_edges(home_mesh_rid);

CREATE TABLE IF NOT EXISTS mesh_subscriptions (
 mesh_rid BLOB NOT NULL,
 external_vault_rid BLOB NOT NULL,
 external_mesh_rid BLOB NOT NULL,
 external_mesh_name TEXT NOT NULL,
 PRIMARY KEY (mesh_rid, external_vault_rid),
 FOREIGN KEY (mesh_rid) REFERENCES meshes(rid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mesh_subs_external_vault
 ON mesh_subscriptions(external_vault_rid);

CREATE TABLE IF NOT EXISTS vault_sources (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL UNIQUE,
 host TEXT NOT NULL,
 owner TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
 added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dogfooding_capture_metrics (
 id BLOB PRIMARY KEY,
 captured_at INTEGER NOT NULL,
 time_to_complete_ms INTEGER,
 field_values_json TEXT,
 llm_assist BOOLEAN,
 edited_post_capture BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS machine_state (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO machine_state (key, value, updated_at)
  VALUES ('roles', 'client,automator-runner,mesh-syncer', strftime('%s', 'now') * 1000);
INSERT OR IGNORE INTO machine_state (key, value, updated_at)
  VALUES ('region', '', strftime('%s', 'now') * 1000);

-- v1.A.0 per-machine federation-repo state cache. SoT lives in the
-- {handle}/lyt-pod GH repo (repo name) cloned to ~/lyt/pod/.
-- This table is a thin pointer so lyt init can probe whether the machine
-- already adopted the federation repo without a gh round-trip. handle is
-- TEXT PK because the GitHub handle IS the natural unique key (one
-- federation repo per handle). fed_rid is UUIDv7 per global standing
-- directive.
CREATE TABLE IF NOT EXISTS federation_state (
 handle TEXT PRIMARY KEY,
 fed_rid BLOB NOT NULL,
 last_synced_at TEXT NOT NULL
);

-- v1-block-B (2026-05-29) — per-machine automator lease ledger. Decision
-- locked at block-B kickoff (Open Decision #1, defaulted to recommended):
-- machine_leases lives in its own table rather than extending machine_state
-- because the row shape is fundamentally different — a lease carries a
-- TTL + automator_rid + vault_rid + state-machine status, whereas
-- machine_state is config-key shape. Splitting the tables keeps both
-- surfaces queryable cleanly.
--
-- Status state machine: 'active' → 'released' (clean) OR 'expired' (TTL
-- elapsed without explicit release; lyt-runner sweeps on every
-- acquireLease() call). The CHECK constraint guards the enum.
--
-- lease_id is BLOB UUIDv7 (16-byte). Per util/uuid7.ts:11 the embedded
-- libSQL driver does NOT expose a uuid7() SQL function, so callers MUST
-- supply lease_id via newUuidv7Bytes() — matching the meshes.rid /
-- vaults.rid pattern earlier in this migration.
--
-- FK on vault_rid: ON DELETE CASCADE — if a vault is forgotten/deleted
-- (status='tombstoned' + handler runs lyt vault delete), every lease
-- against it falls with the vault. No orphan-lease cleanup pass needed.
--
-- Indexes:
-- (vault_rid, automator_rid, status) — primary lookup pattern from
-- acquireLease() probe + lyt automator status verb. Covering for the
-- "is there an active lease for this (vault, automator) tuple?" query.
-- (expires_at) WHERE status='active' — partial index for the auto-expiry
-- sweep on every acquireLease() (lazy cleanup pattern).
CREATE TABLE IF NOT EXISTS machine_leases (
 lease_id BLOB PRIMARY KEY,
 automator_rid BLOB NOT NULL,
 vault_rid BLOB NOT NULL,
 machine_id TEXT NOT NULL,
 acquired_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
 released_at INTEGER,
 released_reason TEXT,
 FOREIGN KEY (vault_rid) REFERENCES vaults(rid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_machine_leases_lookup
 ON machine_leases(vault_rid, automator_rid, status);

CREATE INDEX IF NOT EXISTS idx_machine_leases_active_expires
  ON machine_leases(expires_at) WHERE status = 'active';
`,
};

// 0.9.4 (pod-local aliases) — additive migration 002. This table was
// originally appended into 001-init, but the runner skips already-applied
// versions, so on any pre-existing v1 DB the amended 001 never re-ran and
// vault_aliases was never created (every name resolution then crashed with
// `no such table: vault_aliases`). Splitting it into its own version makes
// the upgrade land on both fresh and existing-v1 databases.
//
// A handler-defined name → vault rid mapping that survives rename + move
// (it keys on the rid, not the name). Pod-local: synced across your OWN
// pod's machines, never to subscribers (enforced by the publish/sync
// surface, not the schema). alias is the PK (one target per alias name);
// the same vault rid may carry many aliases. ON DELETE CASCADE: forgetting
// or deleting a vault drops its aliases with it.
const migration002Aliases: Migration = {
  version: 2,
  name: "aliases",
  sql: `
CREATE TABLE IF NOT EXISTS vault_aliases (
  alias       TEXT PRIMARY KEY,
  vault_rid   BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (vault_rid) REFERENCES vaults(rid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vault_aliases_vault_rid ON vault_aliases(vault_rid);
`,
};

// federation-v2 Layer-1 IDENTITY (2026-06-18) — additive migration 003.
// Implements plan SC1 (Identity schema). The libSQL/SQLite engine has no
// `ALTER TABLE ... DROP CONSTRAINT`, so dropping the `name UNIQUE` on
// `vaults` and `meshes` requires the official SQLite *table-rebuild*
// procedure (https://sqlite.org/lang_altertable.html#otheralter, "Making
// Other Kinds Of Table Schema Changes" — the 12-step FK-off recipe).
//
// WHAT CHANGES (plan Phase A):
//  - `vaults.name`   UNIQUE  -> DROPPED (two same-named vaults from different
//                              origins must coexist — SC2).
//  - `vaults.path`   UNIQUE  -> KEPT (deep-dive 2026-06-18 revising
//                              owner-grouping makes path collisions
//                              impossible, so path-UNIQUE never bites and
//                              stays as a free corruption safety-net).
//  - `meshes.name`   UNIQUE  -> DROPPED (own-mesh no-duplicate guard moves to
//                              the app layer in a later phase).
//  - `vault_aliases.kind TEXT NOT NULL DEFAULT 'vault'` -> ADDED (typed-target
//                              seam AD-4; prerequisite for later alias work).
// Everything else on the rebuilt tables is preserved verbatim from 001:
// the `vaults.parent_vault` self-FK, the 5-value `status` CHECK
// ('active','disconnected','missing','tombstoned','access_lost'), both
// circular FKs (`meshes.main_vault_rid -> vaults.rid` and
// `vaults.home_mesh_rid -> meshes.rid`), all other columns, and the four
// indexes on the rebuilt tables (`idx_vaults_name`, `idx_vaults_status`,
// `idx_vaults_home_mesh_rid`, `idx_meshes_name`).
//
// CIRCULAR FK: `meshes` and `vaults` reference each other. Both tables are
// rebuilt under ONE `foreign_keys=OFF` window so the dependent tables
// (`mesh_vaults`, `mesh_edges`, `mesh_subscriptions`, `machine_leases`,
// `vault_aliases`) — whose FKs point at `vaults.rid` / `meshes.rid` — are
// re-pointed to the renamed tables by SQLite's RENAME child-FK fixup
// (requires sqlite_version() >= 3.25, true for the bundled libSQL engine).
//
// NOT recreated: `idx_mesh_vaults_home_per_vault` lives on `mesh_vaults`,
// which is NOT rebuilt by this migration, so its index survives untouched.
// Recreating it here would be wrong (the plan explicitly forbids it).
//
// RUNNER CONTRACT (migrate.ts): the runner has NO wrapping transaction — it
// splits this `sql` on top-level `;` and runs each statement individually
// (`migrate.ts:40-44`). So the migration self-manages the FK toggle + the
// explicit BEGIN/COMMIT. `PRAGMA foreign_keys` is a no-op inside a
// transaction, so the OFF/ON toggles MUST sit OUTSIDE the BEGIN..COMMIT
// (OFF before BEGIN, ON after COMMIT). The leading `DROP TABLE IF EXISTS
// *_new` makes the migration crash-retry re-runnable. `PRAGMA
// foreign_key_check` is ADVISORY under this runner (it discards result
// rows), so the post-migration FK-clean assertion lives in the test
// (migrations-003.test.ts), NOT here.
//
// NOVEL SUBSTRATE: this is the first migration to drive an FK-off
// table-rebuild through the split-statement runner — it carries the
// mandatory novel-substrate /release review (repo CLAUDE.md) of the literal SQL.
const migration003Identity: Migration = {
  version: 3,
  name: "identity",
  sql: `
-- Step 0: crash-retry re-runnability — clear any half-built scratch tables
-- from a prior aborted run before we begin.
DROP TABLE IF EXISTS vaults_new;
DROP TABLE IF EXISTS meshes_new;

-- Step 1: disable FK enforcement (OUTSIDE any transaction — PRAGMA is a
-- no-op inside one). Lets us drop/rename the circular-FK tables without the
-- dependents' FKs tripping mid-rebuild.
PRAGMA foreign_keys=OFF;

-- Step 2: one transaction wraps the whole rebuild.
BEGIN;

-- Step 3a: new meshes table — IDENTICAL to 001 EXCEPT name is no longer
-- UNIQUE.
CREATE TABLE meshes_new (
  rid BLOB PRIMARY KEY,
  name TEXT NOT NULL,
  push_target TEXT,
  push_kind TEXT CHECK (push_kind IN ('handle', 'org')),
  main_vault_rid BLOB,
  created_at TEXT NOT NULL,
  FOREIGN KEY (main_vault_rid) REFERENCES vaults(rid) ON DELETE SET NULL
);

-- Step 3b: new vaults table — IDENTICAL to 001 EXCEPT name is no longer
-- UNIQUE. path UNIQUE is KEPT; parent_vault self-FK kept; 5-value status
-- CHECK kept verbatim; both circular FKs kept.
CREATE TABLE vaults_new (
  rid BLOB PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  memscope_rid BLOB,
  parent_vault BLOB,
  home_mesh_rid BLOB,
  tier_hint TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disconnected', 'missing', 'tombstoned', 'access_lost')),
  git_url TEXT,
  created_at TEXT,
  registered_at TEXT NOT NULL,
  last_verified_at TEXT,
  verify_fail_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (parent_vault) REFERENCES vaults(rid) ON DELETE SET NULL,
  FOREIGN KEY (home_mesh_rid) REFERENCES meshes(rid) ON DELETE SET NULL
);

-- Step 4: copy data with EXPLICIT named column lists (never SELECT *) so a
-- future column add to the old table can't silently break the copy.
INSERT INTO vaults_new (
  rid, name, path, memscope_rid, parent_vault, home_mesh_rid, tier_hint,
  status, git_url, created_at, registered_at, last_verified_at, verify_fail_count
)
SELECT
  rid, name, path, memscope_rid, parent_vault, home_mesh_rid, tier_hint,
  status, git_url, created_at, registered_at, last_verified_at, verify_fail_count
FROM vaults;

INSERT INTO meshes_new (
  rid, name, push_target, push_kind, main_vault_rid, created_at
)
SELECT
  rid, name, push_target, push_kind, main_vault_rid, created_at
FROM meshes;

-- Step 5: drop the old tables.
DROP TABLE vaults;
DROP TABLE meshes;

-- Step 6: rename the rebuilt tables into place. SQLite re-points the child
-- FKs in mesh_vaults / mesh_edges / mesh_subscriptions / machine_leases /
-- vault_aliases to the renamed tables (sqlite_version >= 3.25).
ALTER TABLE vaults_new RENAME TO vaults;
ALTER TABLE meshes_new RENAME TO meshes;

-- Step 7: recreate ONLY the four indexes that lived on the rebuilt tables.
-- idx_mesh_vaults_home_per_vault is on mesh_vaults (NOT rebuilt) — left
-- untouched, deliberately NOT recreated here.
CREATE INDEX IF NOT EXISTS idx_vaults_name ON vaults(name);
CREATE INDEX IF NOT EXISTS idx_vaults_status ON vaults(status);
CREATE INDEX IF NOT EXISTS idx_vaults_home_mesh_rid ON vaults(home_mesh_rid);
CREATE INDEX IF NOT EXISTS idx_meshes_name ON meshes(name);

-- Step 8: add the typed-target seam column to vault_aliases (AD-4), crash-retry
-- re-runnable. The runner stamps a version ONLY after every statement runs, so a
-- crash AFTER this transaction's COMMIT but BEFORE the version-3 stamp replays
-- the whole migration on recovery. A bare ALTER TABLE ... ADD COLUMN kind is
-- NOT idempotent in SQLite/libSQL (no ADD COLUMN IF NOT EXISTS; re-running it
-- throws "duplicate column name: kind" and wedges recovery).
-- libSQL db.execute runs one statement and SQLite has no conditional DDL, so
-- the per-statement split-execute runner cannot branch on a PRAGMA table_info
-- probe. Instead we make the add idempotent via the SAME crash-retry-safe
-- table-rebuild idiom this migration already uses for vaults/meshes: bake kind
-- into a fresh table guarded by DROP TABLE IF EXISTS vault_aliases_new, copy
-- the surviving columns, drop+rename. Replaying it is a no-op-equivalent (it
-- rebuilds an already-correct shape) and never throws. Done inside the same FK-off
-- transaction; the alias→rid PK, the vault_rid FK (→ vaults ON DELETE CASCADE),
-- and idx_vault_aliases_vault_rid are preserved verbatim from 002.
DROP TABLE IF EXISTS vault_aliases_new;

CREATE TABLE vault_aliases_new (
  alias       TEXT PRIMARY KEY,
  vault_rid   BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'vault',
  FOREIGN KEY (vault_rid) REFERENCES vaults(rid) ON DELETE CASCADE
);

-- Copy with an EXPLICIT named column list (never SELECT *). On a FRESH run the
-- old vault_aliases has NO kind column, so only the three original columns are
-- carried and kind takes its DEFAULT 'vault'. On a crash-retry replay the old
-- table already HAS kind, but we still copy only the three originals so the
-- DEFAULT re-applies identically — the result is byte-identical either way.
INSERT INTO vault_aliases_new (alias, vault_rid, created_at)
SELECT alias, vault_rid, created_at FROM vault_aliases;

DROP TABLE vault_aliases;
ALTER TABLE vault_aliases_new RENAME TO vault_aliases;

CREATE INDEX IF NOT EXISTS idx_vault_aliases_vault_rid ON vault_aliases(vault_rid);

-- Step 9: commit the rebuild.
COMMIT;

-- Step 10: re-enable FK enforcement (OUTSIDE the transaction). The runner's
-- production open path (client.ts) also sets foreign_keys=ON per connection,
-- so this guards the in-migration connection.
PRAGMA foreign_keys=ON;
`,
};

// federation-v2 Layer-1 D1a (2026-06-19) — additive migration 004:
// names→rid INDEX infrastructure. This is INDEX infra for the resolver
// chokepoint (vault-addressing.resolveVault), NOT the later D1c
// `external_mesh_*` column-drop (that lands as its OWN later migration —
// version numbers are sequential and D1a precedes D1c, so the index migration
// takes 004 and the column-drop will take the next free version when that wave
// ships; the plan's "004" label for the drop is a label, not a version
// reservation).
//
// WHAT THIS ADDS (purely additive — no table rebuild, no data change):
//  - `vaults.leaf` — a VIRTUAL generated column = the bare leaf of `name`
//    (the substring after the last '/'). SQLite only permits adding a
//    *VIRTUAL* generated column via `ALTER TABLE ... ADD COLUMN` (a STORED one
//    requires a full table-rebuild — "cannot add a STORED column"); VIRTUAL is
//    additive and applies to pre-existing rows immediately. The leaf is the
//    multiplicity key: a bare-leaf resolve maps `leaf → {rids}`. Computing it as
//    a generated column keeps it ALWAYS in lock-step with `name` (no app-side
//    maintenance, no drift on rename/move — the engine recomputes on read). The
//    `idx_vaults_leaf` index below materializes it so leaf queries are indexed,
//    not table scans, despite VIRTUAL.
//
//    Leaf expression (verified empirically against the bundled libSQL engine
//    over `notes`, `personal/notes`, `a/b/c`, `subscriptions/acme/docs`,
//    `o/repo.git`, `aa/aXa`, … — byte-identical to TS `vaultLeaf`): for a
//    slash-free name the leaf IS the name; otherwise `rtrim(name, <all
//    non-slash chars of name>)` strips the trailing leaf back to the last '/',
//    and `replace(name, <that prefix>, '')` yields the leaf. `rtrim` strips a
//    SET of trailing chars; every leaf char is non-slash, so it peels the whole
//    leaf and halts at the last '/'.
//  - `idx_vaults_leaf` — index on the new leaf column. Backs the O(1)-ish
//    `leaf → {rids}` multiplicity query that replaces the resolver's per-row
//    O(N) scan for the bare-leaf never-tiebreak branch.
//  - `idx_vaults_git_url` — index on `git_url` for the cross-pod origin
//    coordinate lookup branch (was part of the same O(N) scan).
//
// PER-BRANCH TOMBSTONE SEMANTICS (the rail this must NOT defeat): the index is
// status-agnostic at the SCHEMA level (every vault, tombstoned or not, has a
// leaf row). The resolver's branch-specific tombstone filtering is preserved in
// the QUERY layer (vault-index-repo.ts): the leaf-multiplicity query filters
// `status != 'tombstoned'` (matching resolveVault step 5b), while the exact /
// path / coordinate branches do NOT filter status (matching steps 1/2/4). Doing
// the filtering in the query — not the schema — is what keeps the never-tiebreak
// rail intact: two live vaults sharing a leaf still BOTH appear in the
// multiplicity result, so the resolver still throws AmbiguousVaultLeafError
// rather than silently tiebreaking.
//
// RUNNER CONTRACT: the runner has no wrapping txn (migrate.ts split-execute) and
// skips already-applied versions, so 004 only ever runs once on a given DB. The
// ADD COLUMN is not `IF NOT EXISTS`-guardable in SQLite, but the per-version
// skip makes that safe (it never re-runs); the two indexes are `IF NOT EXISTS`
// for crash-retry safety. No FK toggle / table-rebuild needed — this is purely
// additive (no UNIQUE drop, no circular-FK table touched), unlike 003.
const migration004NamesIndex: Migration = {
  version: 4,
  name: "names-index",
  sql: `
ALTER TABLE vaults
  ADD COLUMN leaf TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN instr(name, '/') = 0 THEN name
      ELSE replace(name, rtrim(name, replace(name, '/', '')), '')
    END
  ) VIRTUAL;

CREATE INDEX IF NOT EXISTS idx_vaults_leaf ON vaults(leaf);

CREATE INDEX IF NOT EXISTS idx_vaults_git_url ON vaults(git_url);
`,
};

// federation-v2 Layer-1 D1c (2026-06-19) — additive migration 005:
// drop the `external_mesh_rid` + `external_mesh_name` columns from
// `mesh_subscriptions`. abolished foreign-mesh adoption, and
// moved the subscription SoT off `mesh.yon @MESH_SUBSCRIPTION` and onto the
// per-writer ledger shards reconstituted into this cache by
// `rebuildFederationCacheFlow`. The reconstitution homes every live
// subscription into a reserved OWNER-BUCKET mesh (`subscriptions`/`shared`),
// so the subscribed vault's foreign home-mesh identity (`external_mesh_*`) is
// no longer carried in the cache. The surviving cache shape is the composite
// PK (`mesh_rid`, `external_vault_rid`) + the single mesh_rid FK.
//
// VERSION NUMBERING: the plan text labels this migration "004"; that label is
// SUPERSEDED. Migration 004 was already taken by the D1a names→rid index
// (banked in W1). Versions are sequential and the runner skips already-applied
// versions, so this column-drop takes the next free version, 005.
//
// WHY A TABLE-REBUILD (not `ALTER TABLE ... DROP COLUMN`): the bundled libSQL
// engine does support `DROP COLUMN`, but `external_mesh_rid` / `external_mesh_name`
// are `NOT NULL` and participate in no index/constraint we keep — and we follow
// the official SQLite table-rebuild recipe to mirror migration 003's vetted,
// cold-reviewed FK-off pattern exactly (one proven path through this codebase's
// split-statement runner), rather than introduce a second, divergent schema-
// change idiom. mesh_subscriptions carries ONE outbound FK (`mesh_rid` →
// meshes(rid) ON DELETE CASCADE) and is referenced by NO other table, so the
// rebuild is self-contained: no circular-FK window is needed (unlike 003), but
// we still toggle `foreign_keys=OFF` around the DROP+RENAME so the brief window
// where the old table is dropped before the new one is renamed into place cannot
// trip the inbound-FK-free rebuild on any engine quirk. The composite PK +
// the `idx_mesh_subs_external_vault` index are recreated verbatim.
//
// NON-DESTRUCTIVE: existing rows are copied with an EXPLICIT column list
// (mesh_rid, external_vault_rid) — the two surviving columns — so every prior
// subscription row's identity (which mesh subscribes to which external vault)
// is preserved byte-for-byte; only the two abolished columns are dropped.
//
// RUNNER CONTRACT (migrate.ts): identical to 003 — the runner has NO wrapping
// transaction; it splits this `sql` on top-level `;` (splitSqlStatements) and
// runs each statement individually. So the migration self-manages the FK toggle
// + the explicit BEGIN/COMMIT. `PRAGMA foreign_keys` is a no-op inside a
// transaction, so the OFF/ON toggles MUST sit OUTSIDE the BEGIN..COMMIT (OFF
// before BEGIN, ON after COMMIT). The leading `DROP TABLE IF EXISTS
// mesh_subscriptions_new` makes the migration crash-retry re-runnable.
// `PRAGMA foreign_key_check` is ADVISORY under this runner (it discards result
// rows), so the post-migration FK-clean assertion lives in the test
// (migrations-005.test.ts), NOT here.
//
// NOVEL SUBSTRATE: this is the second migration to drive an FK-off table-
// rebuild through the split-statement runner; it carries the mandatory
// novel-substrate /release review (repo CLAUDE.md) of the literal SQL.
const migration005DropExternalMesh: Migration = {
  version: 5,
  name: "drop-external-mesh",
  sql: `
-- Step 0: crash-retry re-runnability — clear any half-built scratch table
-- from a prior aborted run before we begin.
DROP TABLE IF EXISTS mesh_subscriptions_new;

-- Step 1: disable FK enforcement (OUTSIDE any transaction — PRAGMA is a no-op
-- inside one). Lets us drop/rename mesh_subscriptions without its outbound FK
-- on mesh_rid (→ meshes) re-resolving mid-rebuild.
PRAGMA foreign_keys=OFF;

-- Step 2: one transaction wraps the whole rebuild.
BEGIN;

-- Step 3: new mesh_subscriptions table — IDENTICAL to 001 EXCEPT the two
-- abolished columns (external_mesh_rid, external_mesh_name) are gone. The
-- composite PK (mesh_rid, external_vault_rid) and the single mesh_rid FK
-- (→ meshes ON DELETE CASCADE) are preserved verbatim.
CREATE TABLE mesh_subscriptions_new (
  mesh_rid BLOB NOT NULL,
  external_vault_rid BLOB NOT NULL,
  PRIMARY KEY (mesh_rid, external_vault_rid),
  FOREIGN KEY (mesh_rid) REFERENCES meshes(rid) ON DELETE CASCADE
);

-- Step 4: copy data with an EXPLICIT named column list (never SELECT *) so a
-- future column add to the old table can't silently break the copy. Only the
-- two surviving columns are carried; the dropped columns are simply not
-- selected.
INSERT INTO mesh_subscriptions_new (mesh_rid, external_vault_rid)
SELECT mesh_rid, external_vault_rid FROM mesh_subscriptions;

-- Step 5: drop the old table.
DROP TABLE mesh_subscriptions;

-- Step 6: rename the rebuilt table into place.
ALTER TABLE mesh_subscriptions_new RENAME TO mesh_subscriptions;

-- Step 7: recreate the external-vault lookup index verbatim from 001.
CREATE INDEX IF NOT EXISTS idx_mesh_subs_external_vault
  ON mesh_subscriptions(external_vault_rid);

-- Step 8: commit the rebuild.
COMMIT;

-- Step 9: re-enable FK enforcement (OUTSIDE the transaction). The runner's
-- production open path (client.ts) also sets foreign_keys=ON per connection,
-- so this guards the in-migration connection.
PRAGMA foreign_keys=ON;
`,
};

// FU-1 — narrow the mesh_edges cache PRIMARY KEY from the 4-column
// (ref_mesh_rid, ref_vault_rid, kind, home_vault_rid) to the 3-column
// (ref_vault_rid, kind, home_vault_rid), matching the ledger OR-Set's narrowed
// 2-tuple identity (ref_vault, home_vault). ref_mesh_rid STAYS as a written/
// derived VALUE column (keepDiskShape — NO column drop, NO ledger data
// migration), but it is no longer part of the cache PK.
//
// CRITICAL — RECREATE EMPTY, NO INSERT...SELECT COPY. mesh_edges is a DERIVED
// full-replace cache (the per-writer mesh-edge ledger shards are the SoT;
// rebuildFederationCacheFlow DELETE+reINSERTs the whole table from the ledger
// fold). A populated pre-FU-1 cache CAN hold two physically distinct rows that
// share (ref_vault, home_vault) but differ in ref_mesh — exactly the collision
// the narrower PK forbids. Copying them forward would ABORT on the new PRIMARY
// KEY constraint. We instead recreate the table EMPTY: the next
// rebuildFederationCacheFlow repopulates it from the ledger with the DERIVED
// ref_mesh, collapsing the collision to one logical edge. This is
// non-destructive in the cache-semantics sense — the cache is regenerable from
// the ledger SoT, so dropping its rows loses nothing.
//
// Shell: the same FK-off non-destructive table-rebuild idiom as 003/005 (PRAGMA
// foreign_keys=OFF outside the txn; BEGIN; CREATE mesh_edges_new; DROP old;
// RENAME; recreate the two indexes; COMMIT; PRAGMA foreign_keys=ON). The new
// table keeps ref_mesh_rid BLOB NOT NULL + its FK to meshes, but the PRIMARY KEY
// drops ref_mesh: PRIMARY KEY (ref_vault_rid, kind, home_vault_rid).
const migration006MeshEdgePk: Migration = {
  version: 6,
  name: "mesh-edge-pk-2tuple",
  sql: `
-- Step 0: crash-retry re-runnability — clear any half-built scratch table from
-- a prior aborted run before we begin.
DROP TABLE IF EXISTS mesh_edges_new;

-- Step 1: disable FK enforcement (OUTSIDE any transaction — PRAGMA is a no-op
-- inside one). Lets us drop/rename mesh_edges without its four outbound FKs
-- (→ meshes / vaults) re-resolving mid-rebuild.
PRAGMA foreign_keys=OFF;

-- Step 2: one transaction wraps the whole rebuild.
BEGIN;

-- Step 3: new mesh_edges table — IDENTICAL to 001 EXCEPT the PRIMARY KEY drops
-- ref_mesh_rid (FU-1 2-tuple identity). ref_mesh_rid STAYS as a value column
-- (BLOB NOT NULL) and KEEPS its FK to meshes; all four FKs are preserved
-- verbatim. PRIMARY KEY is now (ref_vault_rid, kind, home_vault_rid).
CREATE TABLE mesh_edges_new (
  ref_mesh_rid BLOB NOT NULL,
  ref_vault_rid BLOB NOT NULL,
  home_mesh_rid BLOB NOT NULL,
  home_vault_rid BLOB NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('parent')),
  PRIMARY KEY (ref_vault_rid, kind, home_vault_rid),
  FOREIGN KEY (ref_mesh_rid) REFERENCES meshes(rid) ON DELETE CASCADE,
  FOREIGN KEY (ref_vault_rid) REFERENCES vaults(rid) ON DELETE CASCADE,
  FOREIGN KEY (home_mesh_rid) REFERENCES meshes(rid) ON DELETE CASCADE,
  FOREIGN KEY (home_vault_rid) REFERENCES vaults(rid) ON DELETE CASCADE
);

-- Step 4: RECREATE EMPTY — DELIBERATELY NO INSERT...SELECT copy. mesh_edges is a
-- derived full-replace cache (ledger = SoT). A populated pre-FU-1 cache may hold
-- two rows sharing (ref_vault, home_vault) but differing in ref_mesh — copying
-- them forward would ABORT on the narrower PK. The next rebuildFederationCacheFlow
-- repopulates the table from the ledger fold with the DERIVED ref_mesh. Nothing
-- is lost (the cache is regenerable from the ledger SoT).

-- Step 5: drop the old table.
DROP TABLE mesh_edges;

-- Step 6: rename the rebuilt table into place.
ALTER TABLE mesh_edges_new RENAME TO mesh_edges;

-- Step 7: recreate the two indexes verbatim from 001.
CREATE INDEX IF NOT EXISTS idx_mesh_edges_home_vault ON mesh_edges(home_vault_rid);
CREATE INDEX IF NOT EXISTS idx_mesh_edges_home_mesh ON mesh_edges(home_mesh_rid);

-- Step 8: commit the rebuild.
COMMIT;

-- Step 9: re-enable FK enforcement (OUTSIDE the transaction). The runner's
-- production open path (client.ts) also sets foreign_keys=ON per connection, so
-- this guards the in-migration connection.
PRAGMA foreign_keys=ON;
`,
};

// Phase D (2026-06-30) — additive migration 007: the pod-global
// embeddings discovery nudge-state. ONE singleton row (PK pinned to the
// constant 1) tracks whether/how often the user has been offered the one-time
// local-model setup, so the first-search nudge, the init offer, and the
// rebuild gate all consult ONE coherent state (the "idempotent offer surface").
//
// COLUMNS (per plan Phase D row + the `asked|declined|enabled` state shape):
//  - schema_version       — forward-compat marker for the row shape itself
//                           (distinct from schema_migrations.version; lets a
//                           future shape change reconcile a row in place).
//  - searches_since_ask   — searches counted since the last surfaced ask;
//                           cadence requires ≥1 before re-asking.
//  - last_ask_at          — ISO-8601 of the last surfaced ask (NULL = never
//                           asked); cadence requires ≥N days since.
//  - explicit_decline_count — count of EXPLICIT declines only (a skip / non-
//                           response is NOT counted); auto-quiet at 3.
//  - disabled             — the hard "never ask again" flag (1 = silent forever).
//
// WHY A DEDICATED TABLE (not machine_state key/value): the nudge state is a
// fixed-shape record (counters + a timestamp + a flag) with derived-state
// semantics, not a free-form config key — the same reasoning block-B used to
// split machine_leases out of machine_state. A singleton (PK = 1, CHECK id = 1)
// keeps it pod-global: exactly one row, no per-vault fan-out.
//
// COHERENT INIT (plan C10): the migration is pure SQL and CANNOT probe the
// filesystem for an existing model, so it seeds NO row here. The row is seeded
// LAZILY by the repo accessor (registry/nudge-state-repo.ts ensureNudgeState),
// which derives the coherent initial state from modelCachePresent() at first
// access: an existing-model pod initializes to the `enabled` state (no pending
// nudge, counters zero, never asked) — it is NEVER re-asked from zero on a
// 0.9.8→0.9.9 upgrade. Keeping the FS probe in TS (not SQL) is what makes the
// init policy a PURE, unit-testable function (nudge-state.ts coherentInitRow).
//
// RUNNER CONTRACT: purely additive (CREATE TABLE IF NOT EXISTS) — no FK toggle,
// no table-rebuild, no data mutation. The per-version skip in migrate.ts makes
// it run exactly once; IF NOT EXISTS keeps it crash-retry safe.
const migration007NudgeState: Migration = {
  version: 7,
  name: "embeddings-nudge-state",
  sql: `
CREATE TABLE IF NOT EXISTS embeddings_nudge_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version         INTEGER NOT NULL DEFAULT 1,
  searches_since_ask     INTEGER NOT NULL DEFAULT 0,
  last_ask_at            TEXT,
  explicit_decline_count INTEGER NOT NULL DEFAULT 0,
  disabled               INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);
`,
};

export const MIGRATIONS: readonly Migration[] = [
  migration001Init,
  migration002Aliases,
  migration003Identity,
  migration004NamesIndex,
  migration005DropExternalMesh,
  migration006MeshEdgePk,
  migration007NudgeState,
];
