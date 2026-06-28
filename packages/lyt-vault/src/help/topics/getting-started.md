# Getting started with Lyt

Five minutes from a fresh machine to a working vault.

## 0. Prerequisites

- **Node.js ≥ 20.9** and **npm ≥ 10**.
- **Git ≥ 2.40**.
- **GitHub CLI (`gh`) ≥ 2.50**, authenticated via `gh auth login`. Optional, but
  required for sync, push, sharing, and any GitHub-touching operation.

## 1. Install Lyt

```bash
npm install -g @younndai/lyt@alpha
```

There is no `latest` release yet — the `alpha` dist-tag is required.

## 2. Bootstrap with the wizard

```bash
lyt init
```

`lyt init` is the canonical bootstrap. It detects your environment, runs
`gh auth login` if needed, installs the Lyt skills and agent manual, probes
GitHub for an existing pod on your handle (cross-machine adopt-detect), creates
your `personal` mesh and first vault, forges Your Pod (`{handle}/lyt-pod`), and
captures a welcome note. Pass `--dry-run` to preview every step without writing.

## 3. Or create a vault by hand

```bash
lyt vault init alex/main --description "Alex's master vault"
```

This scaffolds `~/lyt/vaults/alex/main/` with:

- `.lyt/vault.yon` — vault identity + edges (committed)
- `.lyt/memscope.yon` — access policy (committed)
- `.lyt/mesh-context.md` — auto-regenerated mesh context (committed)
- `.obsidian/` — Obsidian config (committed)
- `.lyt/lyt-overview.md` — your identity page (transcludes mesh-context)
- `.lyt/agents.md` — instructions for AI agents driving Lyt in this vault
- `notes/index.md` — optional starter Figment (suppress with `--no-starter-figment`)
- `.gitignore`, `README.md`

A `git init` runs by default; `--no-git` skips it. `--commit-initial` makes a
single conventional commit with the scaffold files.

`lyt vault init alex/main` is **create-if-missing**: it creates the `alex` mesh
if it doesn't exist, then the vault. A bare `lyt vault init notes` lands in your
`personal` mesh. Re-running `init` on a vault that already exists stops and tells
you (it never silently re-scaffolds).

A vault's identity is its `rid` (a UUIDv7); the `{mesh}/{vault}` name is computed
from its home mesh and leaf. Every verb can address the vault by `alex/main`, by
the bare leaf `main` (when unambiguous), or by an alias (`lyt alias home alex/main`).

## 4. Capture and find knowledge

```bash
lyt capture "an idea worth keeping"
lyt search "idea"            # ranked across your whole pod
```

`lyt search` cascades arc → lane → full-text → edge matches, ranked by
confidence, and (when the embedding model is present) fuses in on-device semantic
matches. See `lyt help commands` for scope flags.

## 5. Open in Obsidian

```bash
lyt vault open alex/main
```

(Or open `~/lyt/vaults/alex/main` in Obsidian — or any markdown editor — manually.)

## 6. See your pod

```bash
lyt vault list               # every registered vault (computed {mesh}/{vault} names)
lyt vault info alex/main      # status, mesh, writability, origin coordinate
lyt mesh status               # the federation graph
```

## Next steps

- `lyt help metadata` — descriptions + GitHub topics + priming files.
- `lyt help mesh` — how meshes are structured.
- `lyt help agents` — driving Lyt with AI agents.
- `lyt help commands` — the full command surface.
