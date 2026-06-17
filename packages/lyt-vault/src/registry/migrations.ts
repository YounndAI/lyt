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

export const MIGRATIONS: readonly Migration[] = [migration001Init, migration002Aliases];
