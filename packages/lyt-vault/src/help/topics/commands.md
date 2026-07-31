# Lyt — full command surface

Lyt is a federated markdown-vault mesh. Every vault is a Git repo plus a small
`.lyt/` directory of metadata; the mesh is the graph of declared edges between
vaults. Run `lyt help <topic>` for any group below in depth.

## Top-level

- `lyt init` — interactive bootstrap wizard (environment setup, first vault,
  Your Pod, skills, agent manual). Add `--wizard --dry-run` to preview every step
  without writing (`--dry-run` is valid only with `--wizard`). See `lyt help getting-started`.
- `lyt capture "<text>"` — save a Figment under the 8-field frontmatter contract
  and index it immediately. Mandatory `purpose` + `topic`.
- `lyt search "<query>" [--vault <n>] [--mesh <m>] [--all] [--no-semantic] [--limit <n>] [--meaning-limit <n>] [--fields <key,...>] [--json]`
  — tiered-cascade search (arcs → lanes → FTS5 → edges) with independent
  direct and meaning allowances (defaults 20 + 10, maximum 30). Human and
  machine receipts keep the settled rank while separating direct text matches
  from metadata-only meaning candidates, which are similarity suggestions rather
  than confirmed matches. `--fields` requests bounded extra frontmatter keys.
  Default scope is the whole pod.
- `lyt primer --scope vault|mesh|federation [--target <name>] [--json]` — generate
  a deterministic agent-priming digest (top keywords, active arcs, recent activity).
- `lyt reindex [--all|--mesh <m>|--vault <n>]` — rebuild the libSQL search caches
  from the markdown source of truth. On an interactive terminal this is also where
  the optional one-time local semantic-search model is fetched (with a prompt first).
- `lyt sync [--vault <name>] [--check] [--watch] [--no-publish] [--resolve-conflict mine|online|both] [--json] [--message <msg>]` — reconcile
  every registered active vault with its remote (commit named paths, pull
  `--rebase`, push) under the writable gate, then publish Your Pod. `--check`
  reports freshness without writing. Normal scoped `--json` includes the
  scoped-publication receipt; `--no-publish` holds both scoped and pod-wide
  publication. See `lyt help sync`.
  Summary JSON uses `dirtyVaultCount`, `aheadVaultCount`, and
  `behindVaultCount`; each vault keeps `dirtyFileCount`, `aheadCommitCount`,
  and `behindCommitCount` explicit. The deprecated summary fields `dirty`, `ahead`,
  and `behind` remain as a one-release compatibility projection; per-vault compatibility
  fields remain `dirtyCount`, `ahead`, and `behind`. A push
  without conclusive live remote readback reports `pushed-verification-pending`.
  Resume a preserved conflict with the same scoped command plus
  `--resolve-conflict mine|online|both`.
- `lyt sync --check --vault <qualified-vault> --json` — inspect exactly one
  vault without filesystem, registry, index, Git, repository, or sibling-vault
  mutation.
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
- `lyt outdated [--channel alpha|latest] [--json]` — read-only channel currency
  check. It never changes the saved channel.
- `lyt update [--check] [--yes] [--channel alpha|latest] [--switch-channel]
[--allow-downgrade] [--resume <operation-id>] [--configure] [--json]` —
  confirmation-gated staged update. The replacement binary performs managed
  reconciliation and returns a Receipt/resume action.
- `lyt install reconcile [--apply] [--resume <operation-id>] [--json]` — inspect
  managed skills/manuals; read-only by default. `--apply` executes the exact
  plan. Update-owned sealing flags are internal resume coordinates, not normal
  user entrypoints.

## Vault lifecycle

- `lyt vault init <name>` — scaffold a fresh vault under `~/lyt/vaults/<name>`.
  Accepts `{mesh}/{vault}` (create-if-missing: creates the mesh if absent, the
  vault if absent, **stops if the vault exists**) or a bare name (→ `personal/`).
  Supports `--mesh <mesh>`, `--local`, `--target github:user|org/<owner>`, and
  legacy `--push-to <handle>` (explicit destination override; the mesh name is
  never treated as a GitHub owner), `--description`, `--ask-description`,
  `--topic <name>` (repeatable), `--no-starter-figment`, `--path <dir>`,
  `--parent <rid>`, `--tier-hint`, `--template empty|obsidian-default`,
  `--no-git`, `--commit-initial` (compatibility; exact local checkpoints are
  automatic), `--json` (machine-readable init result,
  including terminal status, destination/checkpoint/mutation evidence, and
  explicit next-sync evidence. `next_action` appears only when non-null; inspect
  destination source afterward with read-only vault/mesh info.
- `lyt vault adopt <path>` — upgrade an existing markdown vault to Lyt-aware
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
- `lyt vault files <name> [--path <subtree>] [--json]` — read-only inventory of
  Markdown inclusion, search-index state, frontmatter mutation candidates, and
  pending cache removals. A root `.lytignore` applies a versioned gitignore-style
  subset (`#`, `!`, `*`, `**`, `?`, `/`); malformed or conflicting policy refuses
  closed, and `.lyt`, `.obsidian`, and `.git` remain excluded regardless of policy.
- `lyt vault backfill <name> [--path <subtree>] [--dry-run] [--push] [--json]` —
  create a sealed, read-only preview of only the missing frontmatter fields that
  would be added; authored fields and body bytes are preserved. `--dry-run` is a
  deprecated compatibility alias for this default preview and emits a warning.
  `--push` during preview binds the receipt but also warns that nothing has changed.
  Apply the exact preview with
  `--apply --receipt <uuidv7>`; non-interactive apply also requires `--yes`.
- `lyt vault reconcile <name> [--path <subtree>] [--dry-run] [--push] [--json]` —
  create the same sealed preview while also detecting unindexed Markdown and stale
  FTS/dense cache rows. Apply with `--apply --receipt <uuidv7>`; non-interactive
  apply also requires `--yes`. Receipts expire after 30 minutes, are single-use,
  and refuse changed policy, scope, candidates, or file preimages. A failed apply
  reports whether it refused before writing or stopped after a partial mutation.
  A subtree receipt names its candidate scope separately from the vault-wide
  derived-cache rebuild. Machine-field provenance is recorded in the ledger.
  Direct `lyt automator run metadata-filler` is refused: broad writes use only this
  sealed preview/apply rail. Not `lyt repair` (repair
  stays registry/mesh-only). `--push` binds preview and apply to commit-and-push.
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
- `lyt mesh prune <name> --yes` — destructive. Retract and remove an EMPTY / ORPHAN mesh (no
  homed vaults) from the registry — the lingering empty rows a junction-safe pod
  cleanup leaves behind. No files or directories are touched. Refuses a mesh
  that still has homed vaults (naming them). For an owned mesh backed by a live
  `@FED_MESH` relationship, prune appends the durable retraction before removing
  the registry cache row, so rebuild does not resurrect it. A bucket mesh
  (`subscriptions/…`, `shared/…`) backed by a live subscription still requires
  its source relationship to be removed first. Pruning clears its `doctor`
  structural-invariant warn. Prune acts on your locally-synced view; run `lyt
sync` first for an authoritative decision (a peer's un-synced backing can
  otherwise resurrect a pruned mesh).
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
- `lyt machine alias <alias> [--json]` — set this machine's synchronized alias.
- `lyt federation alias [alias] [--json]` — inspect or update Your Pod's alias; its RID stays stable.
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
