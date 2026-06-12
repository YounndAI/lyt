# Lyt — full command surface

Lyt is a federated markdown-vault mesh. Every vault is a Git repo plus a small
`.lyt/` directory of metadata; the mesh is the graph of declared edges between
vaults.

## Vault lifecycle

- `lyt vault init <name>` — scaffold a fresh vault under `~/lyt/vaults/<name>`.
  Supports `--description`, `--ask-description`, `--topic <name>` (repeatable),
  `--no-starter-figment`, `--path <dir>`, `--parent <rid>`, `--tier-hint`,
  `--template empty|obsidian-default`, `--no-git`, `--commit-initial`.
- `lyt vault adopt <path>` — upgrade an existing Obsidian vault to Lyt-aware
  (adds `.lyt/`, never edits existing markdown).
- `lyt vault join <path>` — register an already-Lyt-aware vault on this machine
  (typical after `git clone`).
- `lyt vault clone <url>` — `git clone` + `lyt vault join` in one step.
- `lyt vault list [--no-tombstones] [--json]` — show every registered vault. A
  `★` prefixes roots (vaults with no `parent_vault` edge).
- `lyt vault info <name>` — vault metadata: path, edges, memscope, status.
- `lyt vault open <name>` — launch the configured editor with this vault.
- `lyt vault forget <name> [--tombstone]` — remove from registry; files untouched.
- `lyt vault disconnect <name>` — stop syncing; local copy preserved.
- `lyt vault delete <name> [--no-tombstone]` — wipe `.lyt/` derived state;
  `.md` files untouched.
- `lyt vault verify [--json]` — walk registry, stat each path, flag missing
  rows (auto-promotes to tombstone after N consecutive verifies fail).
- `lyt vault reconnect <name> --path <new>` — heal a missing or disconnected
  vault by repointing the registry row.
- `lyt vault add-edge <name> --peer <rid> --edge share_with|parent` — declare
  a mesh edge from this vault to a peer. Triggers `regen-context`.
- **Splitting a vault is unsupported** — a fresh-history `lyt vault split` verb
  is coming. Do not improvise a git-level workaround: git history retains
  removed content, so an ad-hoc split can leak notes you meant to leave behind.
- `lyt vault regen-context <name>` — rewrite `.lyt/mesh-context.md` from the
  current edge state. Idempotent — safe to re-run.
- `lyt vault sync-metadata --vault|--vaults [--apply] [--no-confirm] [--audit-log <file>]`
  — push vault.yon metadata (description + topics) to GitHub. Dry-run is the
  default; `--apply` is required to write. See `lyt help metadata`.

## Registry

- `lyt registry rebuild` — re-scan known paths to rebuild `~/lyt/registry.db`.
- `lyt registry reset --yes` — destructive. Wipes `~/lyt/registry.db`,
  `~/lyt/known-paths.txt`, and every directory under `~/lyt/vaults/`. Refuses
  paths that are not lyt-shaped.

## Help

- `lyt help` — verb-group overview.
- `lyt help <topic>` — markdown topic rendered to terminal.
- `lyt help --markdown <topic>` — raw markdown (pipe into Obsidian).

## Forward-doc verbs

`lyt sync`, `lyt doctor` ship across Phase 7 and Phase 8. See `lyt help sync`
and `lyt help troubleshooting`.
