# Lyt settings — env vars, config paths

## Environment variables

| Var                       | Default        | Purpose                                                                                                                                                               |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LYT_HOME`                | `~/lyt`        | Override where Lyt stores `registry.db`, `known-paths.txt`, `vaults/`. Must have a `lyt`-shaped basename (`lyt`, `.lyt`, `lyt-*`); else the destructive verbs refuse. |
| `LYT_TOMBSTONE_THRESHOLD` | `3`            | Consecutive failed `verify` runs before a `missing` row auto-promotes to `tombstoned`.                                                                                |
| `LYT_ACTIVE_VAULT`        | _(unset)_      | Hint to harness skills for which vault to default to.                                                                                                                 |
| `EDITOR`                  | _(OS default)_ | Used by `lyt vault open` when no app handler is configured.                                                                                                           |

## Filesystem paths

| Path                           | Owner | Purpose                                                                                                                        |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| `~/lyt/registry.db`            | Lyt   | libSQL registry of every vault on this machine (per-machine, not per-user).                                                    |
| `~/lyt/known-paths.txt`        | Lyt   | Sidecar list of out-of-tree vault paths (anything outside `~/lyt/vaults/`).                                                    |
| `~/lyt/vaults/<name>/`         | Lyt   | Default vault location. `lyt registry reset --yes` only operates on this directory.                                            |
| `<repo>/.claude/settings.json` | user  | Optional Claude Code permissions config — pre-allow `gh repo edit`, `git push origin main`, etc. to reduce permission prompts. |

## Recommended `.claude/settings.json` for this repo

If you drive Lyt with Claude Code, pre-allow the operations the CLI emits:

```json
{
  "permissions": {
    "allow": [
      "Bash(rm -f ~/lyt/registry.db)",
      "Bash(rm -f ~/lyt/known-paths.txt)",
      "Bash(rm -rf ~/lyt/vaults/*)",
      "Bash(git push origin main)"
    ]
  }
}
```

The paths are all `~/lyt/`-shaped and the push targets the lyt repo's main —
both safe to allowlist project-wide.

## Per-vault `.lyt/`

| File                                              | Committed? | Purpose                                                                                  |
| ------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `.lyt/vault.yon`                                  | yes        | Vault identity + mesh edges                                                              |
| `.lyt/memscope.yon`                               | yes        | Access policy                                                                            |
| `.lyt/mesh-context.md`                            | yes        | Auto-regenerated mesh context (transcluded in `lyt-overview.md`)                         |
| `.lyt/ledgers/audit.yon`                          | yes        | Audit ledger source of truth — committed                                                 |
| `.lyt/ledgers/provenance.yon`                     | yes        | Provenance ledger source of truth — committed                                            |
| `.lyt/indexes/lyt.db`                             | no         | libSQL cache for `vault_state` + `automator_runs` + `automator_run_events` (rebuildable) |
| `.lyt/indexes/audit.db`                           | no         | libSQL cache for `audit_log` (rebuildable from `.lyt/ledgers/audit.yon`)                 |
| `.lyt/indexes/provenance.db`                      | no         | libSQL cache for `provenance` (rebuildable from `.lyt/ledgers/provenance.yon`)           |
| `.lyt/indexes/*.db-shm` / `.lyt/indexes/*.db-wal` | no         | libSQL WAL artifacts                                                                     |
| `.lyt/outbox.db`                                  | no         | Queued offline writes                                                                    |

The vault's `.gitignore` excludes the regenerable `.lyt/indexes/` caches. The
`.lyt/ledgers/` subdir is explicitly un-ignored so the YON ledger source-of-truth
files commit cleanly.

## Environment variables

A few environment variables tune per-machine behavior:

| Variable                    | Effect                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `LYT_HOME`                  | Override the default `~/lyt/` root (registry, vaults, caches).               |
| `LYT_EMBEDDINGS`            | `0` disables semantic search; `1` forces it on.                              |
| `LYT_EMBEDDINGS_CACHE_DIR`  | Override where the semantic-search model caches (default `~/lyt/.embeddings-cache/`). |
| `LYT_TOMBSTONE_THRESHOLD`   | Consecutive failed `verify` runs before a missing vault is tombstoned (default 3). |
