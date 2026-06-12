# Troubleshooting

Common failure modes and how to recover.

## `gh` not authed

```
gh: not logged in
```

Run `gh auth login` and select GitHub.com → HTTPS → browser flow. `gh auth status`
confirms. `lyt doctor` reports this as a warning (not a hard fail) — Lyt is
usable offline; GH is only needed for sync / push / `sync-metadata`.

## libSQL `EBUSY` on Windows

When a Lyt verb fails with `EBUSY: resource busy or locked` against
`~/lyt/registry.db`, the registry is held by a previous process. Wait a
second and retry (Windows file-handle drain is async). If persistent, restart
the shell.

## `git push origin main` blocked by harness classifier

The Claude Code "Pushing directly to default branch bypasses PR review"
denial. Paste the `.claude/settings.json` from `lyt help settings` into the
repo root; the next push succeeds.

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

## Vault scaffolded before Phase 7A — missing priming files

Vaults created before Phase 7A landed do not have `lyt-overview.md` /
`.lyt/mesh-context.md` / `agents.md`. Recover with:

```bash
lyt vault sync-metadata --vault <name> --apply --no-confirm
```

`sync-metadata` regenerates `.lyt/mesh-context.md` and (re)writes `agents.md`
if the template version drifted. `lyt-overview.md` is user-owned and not
regenerated; write it by hand if you want one.

## `.lyt/mesh-context.md` merge conflict on `lyt sync` (Phase 8)

```bash
git checkout --theirs .lyt/mesh-context.md
lyt vault regen-context <name>
git add .lyt/mesh-context.md
git rebase --continue
```

Either side resolves identically because the file is deterministic from edge
state.

## `lyt registry reset --yes` refused

The verb's heuristic floor refuses paths whose basename is not `lyt`, `.lyt`,
or `lyt-*`. If you set `LYT_HOME=/some/other/path`, point it at a
lyt-shaped basename (`/some/other/lyt-home`). The floor is documented in
`packages/lyt-vault/src/util/paths.ts`.

## How do I split a vault into smaller vaults?

You don't, yet. Splitting is unsupported; a `lyt vault split` verb (fresh
history) is coming. Do not improvise with git: a cloned repo's history retains
everything you delete afterwards, so a hand-rolled split can leak the content
you meant to leave behind. Until the verb ships, start a new vault with
`lyt vault init` and move the notes you need.

## v1.0.0 daemon UX cliff (Phase 11 forward-doc)

`lyt agent run` will ship foreground-only in Phase 11. The daemon stops when
the terminal closes. Until the v1.1 background daemon ships:

- **Linux/macOS:** `nohup lyt agent run > ~/lyt/agent.log 2>&1 &`
- **macOS launchd:** ship a `.plist` (sample in `lyt help agents` when 11 lands).
- **Windows:** Task Scheduler trigger.

The next CLI command (`lyt sync`, `lyt vault verify`, `lyt mesh status`,
`lyt doctor`) reports the last-stop time, so a stopped agent is discovered on
the next interaction.
