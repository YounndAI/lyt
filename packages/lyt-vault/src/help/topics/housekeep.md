# lyt housekeep

Month-boundary rotation for per-vault YON ledger files (audit + provenance).
Part of the v1.A.2 Lock 0.2 surface — YON is the source of truth, libSQL is
the regenerable cache.

## Usage

```
lyt housekeep [--vault <name>] [--ledger <name>] [--rotate-now] [--dry-run] [--json]
```

Default scope: every active vault in the registry × every known ledger.
The known-ledger list is registry-driven: it reads from
`packages/lyt-vault/src/registry/ledger-registry.ts:LEDGER_REGISTRY`
(`LEDGER_NAMES` since v1.A.3). The current registry ships `audit` +
`provenance`. Friction stays libSQL-only this phase (deferred to v1.5
per the master plan DQ-new-3); appending it to `LEDGER_REGISTRY` post-v1.5
brings housekeep along automatically.

## Rotation algorithm

For each (vault, ledger) pair:

1. Read `<vault>/.lyt/ledgers/<name>.yon`'s `@META key=month` header (or fall
   back to the first `@STAMP ts:ts=...` value's month).
2. Compare that month to the current UTC month.
3. If different (or `--rotate-now` is set), rename the current file to
   `<vault>/.lyt/ledgers/<name>/YYYY-MM.yon` and create a fresh empty
   current-month file carrying:

- `@DOC ver=2.0 ...` header
- `@META key=ledger_name | value=<name>`
- `@META key=month | value=<new-YYYY-MM>`
- `@ROTATION from_month="<old>" | to_month="<new>" | archived_path="..."` +
  its `@STAMP src="flows/housekeep" | ...`

The rotation is atomic via `rename(2)` — a crash mid-rotation leaves either
the prior file in place or the archived path, never a half-rotated state.

## Flags

| Flag              | What it does                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--vault <name>`  | Restrict to one vault by name (default: every active vault).                                                          |
| `--ledger <name>` | Restrict to one ledger (default: every known ledger).                                                                 |
| `--rotate-now`    | Force rotation regardless of the month-boundary check. Useful for manual archive cuts or test deterministic captures. |
| `--dry-run`       | Report what would change without mutating any file. Outcome reads `would-rotate` or `would-rotate-now`.               |
| `--json`          | Lock 0.3 deterministic JSON shape: `{ rotations, dryRun, scannedVaults, scannedLedgers }`.                            |

## Outcomes

Each rotation report carries an `outcome` field:

- `rotated` — file renamed to archive, fresh current created.
- `skipped-same-month` — file already at the current UTC month; no change.
- `skipped-empty` — ledger file exists but has zero bytes (no rotation
  possible until content lands).
- `skipped-no-header` — file has content but neither a `@META key=month`
  header nor a parseable `@STAMP ts` — cannot decide the archive month
  without `--rotate-now` forcing the current month.
- `skipped-missing` — no current-month file exists yet (nothing to rotate).
- `would-rotate` / `would-rotate-now` — dry-run report; nothing mutated.

## When to run

`lyt housekeep` is idempotent. Cron it monthly (`0 3 1 * *` — 03:00 UTC on
the 1st), or just let it pile up — the rotation runs whenever it next runs
and the archived file is correctly month-tagged regardless of when it was
moved.

## Why monthly rotation

A monolithic `audit.yon` grows unboundedly. Monthly archives keep the
working file small (≤30 days of records), make `lyt sync` pulls cheap
(modifications land in the current file only), and make `lyt audit export
--since 2026-04-01` cheaply read just the relevant archive(s) via
`walkLedger` without re-scanning the full history.

## Related

- `lyt vault rebuild-index --ledger <name>` — drop + re-populate the .db
  cache from YON SoT after a rotation or fresh clone.
- `lyt audit export` — emits markdown windows; transparently falls back to
  walking YON SoT when the .db cache is empty (fresh clone before first
  `lyt sync`).
