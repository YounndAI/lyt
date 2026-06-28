# Vault metadata (description, GitHub topics, priming files)

Every Lyt vault carries metadata in `.lyt/vault.yon` that mirrors to GitHub:

- **Description** — `--description "<text>"` at `lyt vault init` (or
  `--ask-description` for an interactive prompt on TTY). Stored as `desc=...`
  on the `@VAULT` record.
- **Topics** — `--topic <name>` (repeatable). Stored as `@TAG key=topic |
value=<name>` records. **Lyt always merges in four brand topics** on every
  GitHub push: `lyt-vault`, `linkyourthink`, `lyt`, `younndai`.
- **Owner** — derived from `git config user.email` at scaffold time.

## GitHub-side formatting

`lyt vault sync-metadata` and the (eventual) `gh repo create` wrapper format
the GitHub `description` field as:

```
LYT Vault | <your description> | linkyourthink.com
```

Brand topics are auto-injected. If your vault declares custom topics, they
land alongside the brand topics.

## Priming files at scaffold

Every `lyt vault init` writes four files that together prime
both humans and AI agents on what the vault is:

| File                   | Owner        | Regenerated?                                 |
| ---------------------- | ------------ | -------------------------------------------- |
| `.lyt/lyt-overview.md` | user         | never                                        |
| `.lyt/mesh-context.md` | Lyt          | on edge mutation + `lyt vault regen-context` |
| `.lyt/agents.md`       | Lyt template | on template version bump                     |
| `notes/index.md`       | user         | never; suppressed by `--no-starter-figment`  |

`lyt-overview.md` ends with `![[.lyt/mesh-context]]` — an Obsidian
transclusion. Edits to `lyt-overview.md` are yours forever; the auto-content
flows in via the transclusion from the committed `.lyt/mesh-context.md`.

## Backfill existing repos

```bash
lyt vault sync-metadata --vaults "cats-*,dogs-*" --apply --no-confirm
```

Mandatory explicit scope. There is no `--all` flag. `--apply` writes to
GitHub; without it the verb is dry-run.

## Safety posture

- **Dry-run by default.** `--apply` is required to mutate.
- **Per-org admin guard.** `gh api /repos/<owner>/<name>` must report
  `permissions.admin = true` for that account. Non-admin repos are skipped
  with `reason: "not-admin"`.
- **`--apply` on non-TTY** requires `--no-confirm` so script invocations cannot
  silently mutate GitHub state.
- **Opt-in audit log** via `--audit-log <file>` — appends a JSON line per
  write: `{ timestamp, rid, owner, name, before, after }`.

## What `sync-metadata` writes per in-scope vault

1. Regenerates `.lyt/mesh-context.md` from current edge state (idempotent).
2. Bumps `agents.md` if the template version has drifted forward.
3. On `--apply`: pushes the formatted description + topics to GitHub via
   `gh repo edit`.
