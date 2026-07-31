# Troubleshooting

Common failure modes and how to recover.

## `gh` not authed

```
gh: not logged in
```

Run `gh auth login` and select GitHub.com → HTTPS → browser flow. `gh auth status`
confirms. `lyt doctor` reports this as a warning (not a hard fail) — Lyt is
usable offline; GitHub is only needed for sync, push, sharing, and `sync-metadata`.

## libSQL `EBUSY` on Windows

When a Lyt verb fails with `EBUSY: resource busy or locked` against
`~/lyt/registry.db`, the registry is held by a previous process. Wait a
second and retry (Windows file-handle drain is async). If persistent, restart
the shell.

## `git push origin main` blocked by an agent-harness classifier

Some agent harnesses deny direct pushes to a default branch ("Pushing directly
to default branch bypasses PR review"). Paste the settings snippet from
`lyt help settings` into the repo root; the next push succeeds. Prefer
`lyt sync`, which commits named paths and pushes under the writable gate.

## Search returns nothing / "index cache is corrupt"

The libSQL search caches are derived state — safe to rebuild from your markdown:

```bash
lyt reindex --vault <name>     # one vault
lyt reindex --all              # the whole pod
```

A human `lyt search` self-heals: on zero results it reindexes any stale in-scope
vault (content edited outside Lyt) and re-queries before reporting "no matches".

## Meaning search did not run

Meaning search needs its one-time local embedding model. It is only downloaded
on an interactive terminal, with a prompt — run `lyt reindex` and accept. In
non-interactive, scripted, or MCP contexts Lyt never downloads it and reports
direct text matches only. When available, meaning-only candidates appear in a
separate labelled block, carry a similarity caveat, and have their own bounded
allowance (`--meaning-limit`, default 10). Disable meaning fusion entirely with
`LYT_EMBEDDINGS=0` or `lyt search --no-semantic`.

## Backfill or reconcile needs a receipt

Both verbs are read-only previews by default. Run the preview first, then apply
only those sealed candidates with its exact Receipt V1 identifier:

```bash
lyt vault backfill <name> --json
lyt vault backfill <name> --apply --receipt <id> --yes --json
```

The same rail applies to `lyt vault reconcile`. Receipts expire after 30 minutes,
are single-use, and refuse policy, scope, candidate, or file drift. Run a new
preview instead of bypassing a refusal. Use `lyt vault files <name>` to inspect
inclusion, index state, missing frontmatter, and pending cache removals without
mutation.

## Sync preserved a conflict or could not verify the push

A scoped conflict keeps both sides and returns one resumable next action. Resume
the same vault explicitly:

```bash
lyt sync --vault <qualified-vault> --resolve-conflict mine|online|both --json
```

Summary counts are vault counts: `dirtyVaultCount`, `aheadVaultCount`, and
`behindVaultCount`. Per-vault rows use file or commit counts:
`dirtyFileCount`, `aheadCommitCount`, and `behindCommitCount`. The old summary
fields `dirty`, `ahead`, and `behind` remain as a one-release compatibility projection;
per-vault compatibility fields remain `dirtyCount`, `ahead`, and `behind`. If a push succeeded but
live remote equality could not be confirmed, Lyt reports
`pushed-verification-pending` rather than claiming success or failure; run the
returned scoped check action when remote observation is available.

## `lyt vault verify` says my vault is `missing`

A `missing` row means the path no longer exists at the registered location
(drive unmounted, folder moved). Recover with:

```bash
lyt vault reconnect <name> --path /new/location
```

After 3 consecutive `verify` runs that still find the vault missing, Lyt
auto-promotes the row to `tombstoned` (terminal). Configure via
`LYT_TOMBSTONE_THRESHOLD`.

## `~/lyt/` permissions on Windows

Lyt expects `~/lyt/` to be writable. If `lyt doctor` reports
`~/lyt/ not writable`, check that no other process is holding files in it
and that the user has full control over `%USERPROFILE%\lyt\`.

## Missing priming files in an older vault

A vault missing `lyt-overview.md` / `.lyt/mesh-context.md` / `agents.md` (created
by an older Lyt) can be repaired with:

```bash
lyt vault sync-metadata --vault <name> --apply --no-confirm
```

This regenerates `.lyt/mesh-context.md` and re-writes `agents.md` if its template
drifted. `lyt-overview.md` is user-owned and not regenerated; write it by hand.

## Federation / mesh drift

If the pod won't sync, `lyt mesh info` fails, a vault's writability reads
`unknown`, or a mesh looks broken:

```bash
lyt doctor                     # diagnose
lyt repair --dry-run           # list findings
lyt repair --apply             # heal (idempotent)
```

An orphan vault needs a mesh: `lyt repair --target <vault> --apply --mesh <mesh>`.

## Editor-localization diagnosis

Supply the complete Handler-declared machine roster explicitly. Repeat
`--declared-machine` once per machine and supply zero or one receipt file for
each declared machine:

```bash
lyt doctor --target editor-localization:<qualified-vault> --emit-machine-receipt --declared-machine <id> --json > <machine-receipt.json>
lyt doctor --target editor-localization:<qualified-vault> --declared-machine <id> [--declared-machine <id> ...] [--machine-receipt <file> ...] --json
lyt repair --target editor-localization:<qualified-vault> --dry-run --plan-out <plan.json> --declared-machine <id> [--declared-machine <id> ...] [--machine-receipt <file> ...] --json
lyt repair --target editor-localization:<qualified-vault> --apply --plan <plan.json> --plan-digest <sha256> --declared-machine <id> [--declared-machine <id> ...] [--machine-receipt <file> ...] --json
```

An `observed` receipt reports a bounded editor-state digest and item count:

```json
{
  "machine_id": "workstation-a",
  "disposition": "observed",
  "digest": "<64 lowercase hex SHA-256 characters>",
  "count": 2,
  "observed_at": "2026-07-19T12:00:00.000Z"
}
```

An `absent` receipt is an explicit assertion that editor state is absent:

```json
{
  "machine_id": "workstation-b",
  "disposition": "absent",
  "absence_receipt_digest": "<64 lowercase hex SHA-256 characters>",
  "observed_at": "2026-07-19T12:00:00.000Z"
}
```

Receipts must contain exactly the shown fields. `count` is an integer from 0 to
1,000,000. `observed_at` must be canonical ISO-8601 UTC, no more than five
minutes old, and no more than 30 seconds in the future. A declared machine with
no fresh receipt remains in the plan as `unavailable`, which makes apply
unavailable. The scoped diagnostic reports that machine plus the exact local
receipt command; collect a fresh receipt and prepare a new plan.

Receipt emission reads only the exact local registered vault and editor tree. It
does not discover machines, contact a remote, sign evidence, or transport the
receipt. Prepare writes the immutable bounded plan to `--plan-out`, then emits
the same terminal Receipt V1 persisted in the operation log. An eligible prepare
is `no-op` with the plan path and digest in evidence. An unavailable/refused
prepare is a nonzero `refused` Receipt V1 with its exact corrective next action.
CLI-schema failures before target resolution emit one bounded refusal and do not
dispatch the general doctor/repair path.

Plans and Receipt V1 records seal only canonical per-machine
state/digest/count summaries. They never include receipt paths, editor content,
or receipt timestamps. This Handler-declared evidence is not cryptographic
authentication and does not claim complete machine discovery.
Replaying a completed plan reobserves the target and requires the same fresh,
explicit roster receipts. Target or receipt drift is refused and requires a new
prepare; a matching replay is a zero-mutation `replayed` Receipt V1.

## `.lyt/mesh-context.md` merge conflict on `lyt sync`

```bash
git checkout --theirs .lyt/mesh-context.md
lyt vault regen-context <name>
git add .lyt/mesh-context.md
git rebase --continue
```

Either side resolves identically because the file is deterministic from edge
state. Or pass `lyt sync --resolve-mesh-context` to apply this automatically.

## `lyt registry reset --yes` refused

The verb refuses paths whose basename is not `lyt`, `.lyt`, or `lyt-*`. If you set
`LYT_HOME=/some/other/path`, point it at a lyt-shaped basename
(`/some/other/lyt-home`).

## How do I split a vault into smaller vaults?

You don't, yet. Splitting is unsupported; a `lyt vault split` verb (fresh
history) is planned. Do not improvise with git: a cloned repo's history retains
everything you delete afterwards, so a hand-rolled split can leak the content
you meant to leave behind. Until the verb ships, start a new vault with
`lyt vault init` and move only the notes you need.
