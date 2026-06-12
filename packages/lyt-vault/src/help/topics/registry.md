# lyt registry

The per-machine vault registry at `~/lyt/registry.db` (libSQL/SQLite). Lyt's
verbs read/write this DB to track every vault you have on this machine.

## Commands

- `lyt registry rebuild` — Walk `~/lyt/vaults/` + `~/lyt/known-paths.txt`,
  rediscover every vault from its `.lyt/vault.yon`, and rewrite the registry
  rows from disk.
- `lyt registry reset --yes` — Drop `~/lyt/` entirely (the registry DB, the
  federation cache, the identity cache). The vault directories themselves
  (`.lyt/vault.yon`, your notes) are untouched.

## Clean-slate posture (v1 pre-release)

Schema-shape drift requires `lyt registry reset --yes` + re-init since pre-release clean-slate posture is in effect through v1.

## v1.A.2 Lock 0.2 — YON-as-SoT for audit + provenance

As of v1.A.2 (Lock 0.2) + v1.A.2c (per-vault DB SPLIT), the per-vault
`audit_log` + `provenance` + `automator_runs` tables are libSQL **caches**
over YON sources of truth at `.lyt/ledgers/audit.yon` and
`.lyt/ledgers/provenance.yon`. The .db files live under `.lyt/indexes/`
(`.lyt/indexes/lyt.db` carries automator_runs / automator_run_events;
`.lyt/indexes/audit.db` carries audit_log; `.lyt/indexes/provenance.db`
carries provenance). All three are regenerable via
`lyt vault rebuild-index --ledger <name>` (per-ledger surgical rebuild)
or `lyt vault rebuild-index` (full drop+recreate). The YON ledger files
are committed; the `.lyt/indexes/*.db*` files are gitignored. Run
`lyt housekeep` monthly to rotate.
