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

// LedgerRegistry — single source-of-truth for the Lyt ledger family.
//
// v1.A.3 (CR-3 / ALT3-ALT6) consolidation: the prior layout duplicated
// the "what ledgers does Lyt support?" answer across at least four
// places — vault-db.ts (3 explicit openers), housekeep.ts (KNOWN_LEDGERS
// hardcoded list), stamp-on-write.ts (per-call openProvenanceDb +
// openAuditDb), and help/topics/housekeep.md (documented list). This
// module centralises that knowledge. Consumers read from LEDGER_REGISTRY
// + getLedgerKind() / LEDGER_NAMES instead of re-deriving.
//
// Adding a new ledger kind is exactly two edits:
// 1. Add a migrate fn in `vault-db-migrations.ts` for its table.
// 2. Append an entry to `LEDGER_REGISTRY` below.
// All downstream surface (open/close, housekeep rotation, hook chain,
// help-topic list) follows automatically.
//
// What is NOT registered here:
// - lyt.db itself (vault_state / child_pull_state / automator_runs /
// automator_run_events / machine_leases) — those tables don't shadow
// YON ledger files; lyt.db is the per-vault transactional state DB,
// not a regenerable YON-derived cache.
// - friction.yon (planned post-v1.5 per DQ-new-3) — when it ships,
// append an entry here and the surface follows.

import type { Client } from "@libsql/client";

import { migrateAuditDb, migrateProvenanceDb } from "./vault-db-migrations.js";

export type LedgerKindName = "audit" | "provenance";

export interface LedgerKind {
  // Short identifier carried in CLI args (--ledger <name>), file paths
  // (`<vault>/.lyt/ledgers/<name>.yon`), and audit messages.
  readonly name: LedgerKindName;
  // YON record tag emitted on append (without leading `@`).
  readonly recordType: string;
  // libSQL cache table name in the per-ledger DB.
  readonly tableName: string;
  // Filename for the per-ledger DB under `<vault>/.lyt/indexes/`.
  readonly dbFile: string;
  // Migration function invoked on fresh open of the per-ledger DB.
  // Carries the table DDL for `tableName`.
  readonly migrate: (db: Client) => Promise<unknown>;
}

// The source-of-truth. Order matters: open / init / close iterations use
// this order; deterministic across machines.
export const LEDGER_REGISTRY: ReadonlyArray<LedgerKind> = [
  {
    name: "audit",
    recordType: "AUDIT",
    tableName: "audit_log",
    dbFile: "audit.db",
    migrate: migrateAuditDb,
  },
  {
    name: "provenance",
    recordType: "PROVENANCE",
    tableName: "provenance",
    dbFile: "provenance.db",
    migrate: migrateProvenanceDb,
  },
] as const;

// Convenience alias of the registry's name list — used by housekeep
// (KNOWN_LEDGERS), rebuild-index (--ledger arg validation), CLI help.
export const LEDGER_NAMES: ReadonlyArray<LedgerKindName> = LEDGER_REGISTRY.map((k) => k.name);

// Lookup with a guided error on unknown name — used by every consumer
// that takes a `--ledger <name>` arg or a stored name string.
export function getLedgerKind(name: string): LedgerKind {
  const found = LEDGER_REGISTRY.find((k) => k.name === name);
  if (found === undefined) {
    throw new Error(`Unknown ledger kind '${name}'. Known: ${LEDGER_NAMES.join(", ")}.`);
  }
  return found;
}
