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

## Semantic search isn't kicking in

Semantic search needs its one-time ~23 MB embedding model. It is only downloaded
on an interactive terminal, with a prompt — run `lyt reindex` and accept. In
non-interactive, scripted, or MCP contexts Lyt never downloads it and uses lexical
search. Disable semantic fusion entirely with `LYT_EMBEDDINGS=0` or
`lyt search --no-semantic`.

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
