# Ledgers — per-vault audit + provenance YON spines (v1.A.2)

A **ledger** is a chronologically-ordered, append-only YON file inside a vault
that records what happened, who did it, and what produced the result. v1.A.2
ships two ledgers per vault — **audit** and **provenance** — each backed by a
libSQL cache for fast queries. Per Lock 0.2, the YON file is the source of
truth; the `.db` is the regenerable cache.

> Run `lyt help housekeep` for the monthly rotation flow that keeps ledger
> files small.

## What gets recorded

| Ledger       | Records                                      | Shape                                                                                  | Use it for                                            |
| ------------ | -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `audit`      | `@AUDIT` records — handler / agent intent    | who-did-what (vault.created, vault.renamed, automator.dispatched, friction.noted, ...) | handler-readable history; cross-machine audit windows |
| `provenance` | `@STAMP` records — tool execution provenance | which automator + which version + which inputs produced this output                    | tracing what code wrote a Figment; replay analysis    |

Each record carries a `ts:ts=<ISO>` timestamp; both ledgers stay strictly
append-only — Lyt never rewrites history.

## On-disk layout

```text
<vault>/
├── .lyt/
│   ├── ledgers/                     ← YON SoT (Lock 0.2; committed)
│   │   ├── audit.yon                ← current-month audit ledger (open)
│   │   ├── audit/                   ← rotated month archives
│   │   │   ├── 2026-04.yon
│   │   │   └── 2026-05.yon
│   │   ├── provenance.yon           ← current-month provenance ledger (open)
│   │   └── provenance/              ← rotated month archives
│   │       └── 2026-04.yon
│   └── indexes/                     ← libSQL caches (regenerable; gitignored)
│       ├── lyt.db                   ← figment index
│       ├── audit.db                 ← audit_log cache over audit.yon
│       └── provenance.db            ← provenance cache over provenance.yon
└── notes/
```

The current-month file at `<vault>/.lyt/ledgers/<name>.yon` is the open
write target. On the first day of each UTC month, `lyt housekeep` rotates it
to `<vault>/.lyt/ledgers/<name>/YYYY-MM.yon` and creates a fresh empty
current-month file. Past months are immutable.

## The two record shapes

```text
# @AUDIT — handler/agent intent (audit.yon)
@AUDIT id="audit:<uuidv7>"
  | ts:ts=2026-05-31T10:23:14Z
  | actor="user:alex"
  | action="vault.renamed"
  | target_kind="vault"
  | target_id="vault:<uuidv7>"
  | summary="alex/journal → alex/diary"

# @STAMP — tool execution provenance (provenance.yon)
@STAMP id="stamp:<uuidv7>"
  | ts:ts=2026-05-31T10:23:15Z
  | src="commands/rename"
  | actor="cli:lyt"
  | run_id="run:<uuidv7>"
  | target_kind="vault"
  | target_id="vault:<uuidv7>"
```

`@AUDIT` is for **intent** ("the handler asked for rename X→Y"). `@STAMP` is for
**execution** ("the rename code path actually ran, here is the run id"). A
handler-shareable export combines both via `lyt audit export`.

## Reading from the ledger

Use the structured CLIs — they walk both the current file and archived
months transparently:

```bash
lyt audit export --since 2026-05-01 [--vault <name>] [--output path.md]
lyt provenance trace <file|rid> [--vault <name>] [--json]
```

Both verbs prefer the `.db` cache when fresh, but fall back to walking the YON
SoT (`walkLedger`) when the cache is missing or empty (e.g., after a fresh
clone before the first `lyt sync`). Lock 0.2 holds: the YON is enough.

## Rebuilding the cache

If `audit.db` or `provenance.db` drifts out of sync, drop + re-derive from YON:

```bash
lyt vault rebuild-index --ledger audit       # rebuild only audit.db
lyt vault rebuild-index --ledger provenance  # rebuild only provenance.db
lyt vault rebuild-index                       # rebuild every cache from SoT
```

The `--ledger <name>` form is non-destructive (surgically truncates one cache
table); the unscoped form is destructive (drops all `.db` files + recreates
schemas). Both re-walk YON SoT and re-insert via idempotent natural-key probe.

## Doctor checks (v1.B.5)

`lyt doctor` includes a fast sanity probe:

- `ledgers.yon-db-pairs` — per active vault, verifies the current-month
  `audit.yon` + `provenance.yon` have matching `audit.db` + `provenance.db`
  caches. If a YON file is present but the DB is missing (or vice versa) →
  `warn` with remediation `lyt vault rebuild-index <name>`.

The check is intentionally cheap (most-recent month only). Cross-month
integrity (every archived `<name>/YYYY-MM.yon` exactly matches the cached
rows) is a slower probe deferred to a later phase.

## Monthly rotation — `lyt housekeep`

```bash
lyt housekeep              # rotate every vault × every known ledger
lyt housekeep --dry-run    # report what would change; no writes
lyt housekeep --rotate-now # force rotation regardless of month boundary
```

Run `lyt help housekeep` for the full algorithm.

## See also

- `lyt help housekeep` — the monthly rotation flow.
- `lyt help registry` — how the `.lyt/indexes/` caches relate to the SoTs.
- `lyt help settings` — what's committed vs gitignored under `.lyt/`.
- The `yai.lyt` YON domain spec — `@AUDIT` + `@STAMP` schemas.
