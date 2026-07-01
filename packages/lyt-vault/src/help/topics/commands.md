# Lyt — full command surface

Lyt is a federated markdown-vault mesh. Every vault is a Git repo plus a small
`.lyt/` directory of metadata; the mesh is the graph of declared edges between
vaults. Run `lyt help <topic>` for any group below in depth.

## Top-level

- `lyt init [--dry-run]` — interactive bootstrap wizard (environment setup,
  first vault, Your Pod, skills, agent manual). See `lyt help getting-started`.
- `lyt capture "<text>"` — save a Figment under the 8-field frontmatter contract
  and index it immediately. Mandatory `purpose` + `topic`.
- `lyt search "<query>" [--vault <n>] [--mesh <m>] [--all] [--no-semantic] [--limit <n>] [--json]`
  — tiered-cascade search (arcs → lanes → FTS5 → edges), confidence-ranked,
  with optional on-device semantic fusion. Default scope is the whole pod.
- `lyt primer --scope vault|mesh|federation [--target <name>] [--json]` — generate
  a deterministic agent-priming digest (top keywords, active arcs, recent activity).
- `lyt reindex [--all|--mesh <m>|--vault <n>]` — rebuild the libSQL search caches
  from the markdown source of truth. On an interactive terminal this is also where
  the optional one-time local semantic-search model is fetched (with a prompt first).
- `lyt sync [--check] [--watch] [--no-publish] [--message <msg>]` — reconcile
  every registered active vault with its remote (commit named paths, pull
  `--rebase`, push) under the writable gate, then publish Your Pod. `--check`
  reports freshness without writing. See `lyt help sync`.
- `lyt status [--json]` — publish-drift trust surface (per-vault + pod: unpushed /
  no-remote / clean). Distinct from `lyt mesh status` (the topology renderer).
- `lyt doctor [--json|--full]` — git/gh/node/npm checks, registry integrity,
  self-heal hints.
- `lyt repair [--dry-run|--apply] [--target <vault>] [--mesh <m>]` — fix federation
  drift (broken edges/subscriptions, mesh.yon parse errors, orphan vaults).
  `--dry-run` is the default; `--apply` writes.
- `lyt discover` — read-only walk of GitHub-accessible repos, clustering
  discovered Lyt vaults by mesh for adopt / skip.
- `lyt mcp start` — start the MCP server over stdio for AI agents.
- `lyt help [<topic>] [--markdown]` — verb-group overview or a rendered topic.

## Vault lifecycle

- `lyt vault init <name>` — scaffold a fresh vault under `~/lyt/vaults/<name>`.
  Accepts `{mesh}/{vault}` (create-if-missing: creates the mesh if absent, the
  vault if absent, **stops if the vault exists**) or a bare name (→ `personal/`).
  Supports `--mesh <mesh>`, `--push-to <handle>` (make an auto-created mesh a
  sharing mesh; default local-only), `--description`, `--ask-description`,
  `--topic <name>` (repeatable), `--no-starter-figment`, `--path <dir>`,
  `--parent <rid>`, `--tier-hint`, `--template empty|obsidian-default`,
  `--no-git`, `--commit-initial`.
- `lyt vault adopt <path>` — upgrade an existing Obsidian vault to Lyt-aware
  (adds `.lyt/`, never edits existing markdown).
- `lyt vault join <path>` — register an already-Lyt-aware vault on this machine
  (typical after `git clone`).
- `lyt vault clone <url> [--to-mesh <mesh>]` — `git clone` + `lyt vault join` in
  one step; `--to-mesh` assigns the clone to a mesh.
- `lyt vault list [--no-tombstones] [--json]` — show every registered vault. A
  `★` prefixes roots (vaults with no `parent_vault` edge).
- `lyt vault info <name> [--json]` — vault metadata: path, edges, memscope, status,
  computed `{mesh}/{vault}` display name, writability verdict, and origin coordinate.
- `lyt alias <name> <target>` — bind a pod-local name to a vault (alias → rid;
  survives rename + move). `--list`, `--remove <name>`. Pod-local: synced across
  your own pod, never to subscribers. Any verb taking a vault accepts the alias,
  a `{mesh}/{vault}`, or a bare leaf (unique-leaf resolution; errors on collision).
- `lyt vault open <name>` — launch the OS default app (Obsidian) on this vault.
- `lyt vault move <name> --to-mesh <mesh>` — move a vault to a different home mesh;
  its computed `{mesh}/{vault}` name follows automatically.
- `lyt vault rename <name> <new-leaf>` — rename a vault's leaf (the main vault of a
  mesh is immutable).
- `lyt vault forget <name> [--tombstone]` — remove from registry; files untouched.
- `lyt vault disconnect <name>` — stop syncing; local copy preserved.
- `lyt vault delete <name> [--no-tombstone]` — wipe `.lyt/` derived state;
  `.md` files and the GitHub repo untouched.
- `lyt vault abandon <name>` — anti-lock-in un-adopt: remove only Lyt's local
  adoption state. Your markdown and remote are left exactly as they were.
- `lyt vault verify [--json]` — walk registry, stat each path, flag missing
  rows (auto-promotes to tombstone after N consecutive verifies fail).
- `lyt vault reconnect <name> --path <new>` — heal a missing or disconnected
  vault by repointing the registry row.
- `lyt vault add-edge <name> --share-with <peer-rid> | --parent <peer-rid>` —
  declare a mesh edge from this vault to a peer. Triggers `regen-context`.
- `lyt vault regen-context <name>` — rewrite `.lyt/mesh-context.md` from the
  current edge state. Idempotent.
- `lyt vault rebuild-index <name>` — regenerate the libSQL caches for one vault
  from the markdown source of truth (`--ledger <name>` scopes to one ledger cache).
- `lyt vault sync-metadata --vault|--vaults [--apply] [--no-confirm] [--audit-log <file>]`
  — push vault.yon metadata (description + topics) to GitHub. Dry-run is the
  default; `--apply` is required to write. See `lyt help metadata`.
- `lyt vault snapshot|restore|freeze|unfreeze <name>` — recovery + safety net for
  delicate operations.

## Sharing

- `lyt vault share <name> --with <handle> --access read|write --yes` — grant a
  GitHub handle access (a repo-collaborator grant). Handler-confirmed.
- `lyt vault unshare <name> --with <handle> --yes` — revoke access.
- `lyt vault access <name> [--json]` — read the live collaborator state and
  reconcile it against Lyt's local view.
- `lyt vault invites [--accept <id> --yes]` — list (read-only) or accept a pending
  GitHub repository invitation.

## Mesh & federation

See `lyt help mesh` and `lyt help federation`. In brief:

- `lyt mesh init|join|list|info|subscribe|add-edge|validate|adopt|rebuild-registry`
- `lyt mesh status|clone-all|rebuild-rollup`
- `lyt federation init|list|rebuild` — Your Pod (`{handle}/lyt-pod`).

## Patterns, skills, automators

- `lyt pattern list|install|uninstall|link|unlink|fork|verbs|run` — see
  `lyt help patterns`.
- `lyt skills install` — link the bundled harness skills into Claude Code / Codex
  / generic agent runtimes. See `lyt help skills`.
- `lyt agent-manual --install` — install the Lyt agent manual into a runtime's
  global instructions.
- `lyt automator list|status|run` — run in-vault YON automators. See
  `lyt help automators`.

## Audit, provenance, machine

- `lyt audit export --since <date> [--vault <name>]` — handler-readable history.
- `lyt provenance trace <file|rid> [--json]` — follow the `@STAMP` chain.
- `lyt identity show|refresh` — GitHub-authoritative identity, cached locally.
- `lyt machine status [--json]` — this machine's roles + region.
- `lyt housekeep [--dry-run|--rotate-now]` — monthly ledger rotation. See
  `lyt help ledgers` and `lyt help housekeep`.

## Registry

- `lyt registry reset --yes` — destructive. Wipes `~/lyt/registry.db`,
  `~/lyt/known-paths.txt`, and every directory under `~/lyt/vaults/`. Refuses
  paths that are not lyt-shaped.

## Help

- `lyt help` — verb-group overview.
- `lyt help <topic>` — markdown topic rendered to terminal.
- `lyt help --markdown <topic>` — raw markdown (pipe into Obsidian).
