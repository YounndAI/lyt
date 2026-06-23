# `lyt sync` — reconcile vaults with their remotes

`lyt sync` walks every registered active vault and reconciles each with its
GitHub remote, then publishes Your Pod. Pushes are gated on the per-vault
writable verdict — read-only, subscriber, orphan, and no-remote vaults pull but
skip push.

```bash
lyt sync                              # commit + pull --rebase + push every active vault, then publish the pod
lyt sync --check                      # read-only: report per-vault freshness, no writes
lyt sync --check --json               # machine-readable freshness report
lyt sync --check --quiet              # exit code only (0 clean, 1 needs-sync)
lyt sync --watch                      # foreground daemon: watch + auto-commit + incremental search reindex
lyt sync --no-publish                 # local vault sync only; skip the pod publish pass
lyt sync --message "<summary>"        # override the inferred per-vault commit message
```

## Per-vault sequence

1. `git fetch` to check whether the remote is ahead.
2. Local ahead → `git push`.
3. Remote ahead → `git pull --rebase` (fail loud on conflict).
4. Both diverged → rebase, then push.
5. Dirty working tree → `git add` (explicit paths only, never `-A`) + commit +
   push.

The commit message is built deterministically from `git status` + figment titles
(no LLM). Pass `--message` to supply your own (e.g. an agent's semantic summary).

## `--watch`

Foreground daemon. Watches every registered active vault, debounces commits
(default 30s after the last change; `--commit-debounce <ms>`), and incrementally
reconciles the full-text search cache on each `notes/**` change. Event-driven —
no periodic pull. `Ctrl+C` flushes in-flight changes and stops.

## The pod publish pass

After the per-vault sync, `lyt sync` regenerates `pod.yon`, creates any missing
vault repos, and pushes Your Pod — running `lyt sync` is itself the consent for
this outward step. If your pod is still local-only, `lyt sync` self-heals the
connection to your GitHub handle first (adopting an existing pod repo
non-destructively on prompt). `--no-publish` skips the publish pass entirely.

## Conflicts

Conflicts fail loud — resolve them with normal Git tooling (`git pull --rebase`,
manual edit, `git rebase --continue`).

### `.lyt/mesh-context.md` conflicts

`.lyt/mesh-context.md` is committed *and* auto-regenerated, so concurrent edge
mutations on different machines can conflict on it. The content is deterministic
from the current edge state, so either side resolves identically:

```bash
git checkout --theirs .lyt/mesh-context.md
lyt vault regen-context <name>
git add .lyt/mesh-context.md
git rebase --continue
```

Or pass `--resolve-mesh-context` to have `lyt sync` apply this recipe
automatically (off by default to preserve fail-loud behavior).

## Safety net

`lyt vault snapshot` / `restore` / `freeze` / `unfreeze` give a recovery net for
delicate operations. A frozen vault is skipped by `lyt sync` until you unfreeze it.
