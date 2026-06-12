# `lyt sync` (forward-doc)

**Phase 8 ships the actual `lyt sync` verb.** This topic forward-documents the
design so users can prepare. The Phase 8 release will update this topic's
framing from "WILL do" to present-tense.

## What `lyt sync` will do

`lyt sync` walks the registered active vaults and reconciles each with its
remote in a parallel-safe order:

```bash
lyt sync                              # all registered active vaults
lyt sync <vault>                      # one vault
lyt sync --watch                      # daemon mode (chokidar)
lyt sync --check                      # status only; no writes
lyt sync --dry-run                    # show planned commits + pushes
lyt sync stop                         # stop the watcher
```

Per-vault sequence:

1. `git fetch` (check remote ahead).
2. Local ahead → `git push`.
3. Remote ahead → `git pull --rebase` (fail loud on conflict).
4. Both diverged → rebase, then push.
5. Dirty working tree → `git add` (explicit paths only, never `-A`) +
   `git commit -m "lyt sync: <timestamp>"` + push.

## `lyt sync --watch`

Daemon variant. Uses `chokidar` for file watching. Debounces commits at 30s
after last change per vault, and incrementally reconciles the FTS search
cache on each `notes/**` change. Event-driven — no periodic pull. Pushes
after each debounced commit.

## Conflicts

v1 ships fail-loud. The MemLedger-arbitration design lands with Bridge.
Resolve conflicts with normal Git tooling (`git pull --rebase`, manual edit,
`git rebase --continue`).

## `.lyt/mesh-context.md` conflicts

Because `.lyt/mesh-context.md` is committed AND auto-regenerated, concurrent
edge mutations on different machines can produce a Git conflict on this file.
The content is deterministic given the current edge state, so the resolution
recipe is:

```bash
git checkout --theirs .lyt/mesh-context.md
lyt vault regen-context <name>
git add .lyt/mesh-context.md
git rebase --continue
```

(Or pick `--ours` then regen — both lead to the same content.)

## Freeze / snapshot (Phase 8)

`lyt vault freeze <name>` and `lyt vault snapshot <name>` ship alongside
`lyt sync` to give a safety net for delicate ops. See the Phase 8 brief when
it lands.
