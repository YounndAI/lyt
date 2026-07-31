# Getting started with Lyt

Five minutes from a fresh machine to a working vault.

## 0. Prerequisites

- **Node.js ≥ 20.9** and **npm ≥ 10**.
- **Git ≥ 2.40**.
- **GitHub CLI (`gh`) ≥ 2.50**, authenticated via `gh auth login`. Optional, but
  required for sync, push, sharing, and any GitHub-touching operation.

## 1. Install Lyt

```bash
npm install -g @younndai/lyt
```

The untagged install follows the tested `latest` channel. To evaluate a preview
candidate, use `@younndai/lyt@alpha`. Keep channel changes explicit with
`lyt update --channel alpha|latest`.

## 2. Bootstrap with the wizard

```bash
lyt init
```

`lyt init` is the canonical bootstrap. It verifies prerequisites and existing
GitHub authentication, installs the Lyt skills and agent manual, probes for an
existing pod (cross-machine adopt-detect), and creates or adopts one local
pod/mesh/main-vault checkpoint. It never publishes or creates demo content. Run
`lyt init --wizard --dry-run` to preview every step without writing (`--dry-run`
is valid only in combination with `--wizard`).

## 3. Or create a vault by hand

```bash
lyt vault init alex/main --description "Alex's master vault"
```

This scaffolds `~/lyt/vaults/alex/main/` with:

- `.lyt/vault.yon` — vault identity + edges (committed)
- `.lyt/memscope.yon` — access policy (committed)
- `.lyt/mesh-context.md` — auto-regenerated mesh context (committed)
- `.obsidian/` — optional Obsidian config, created only with `--template obsidian-default`
- `.lyt/lyt-overview.md` — your identity page (transcludes mesh-context)
- `.lyt/agents.md` — instructions for AI agents driving Lyt in this vault
- `notes/welcome.md` — optional starter Figment (suppress with `--no-starter-figment`)
- `.gitignore`, `README.md`

A `git init` runs by default; `--no-git` skips it. Creation automatically makes
one local checkpoint containing only its exact planned files; `--commit-initial`
is retained as a compatibility flag.

`lyt vault init alex/main` is **create-if-missing**: it creates the `alex` mesh
if it doesn't exist, then the vault. A bare `lyt vault init notes` lands in your
`personal` mesh. Re-running `init` on a vault that already exists stops and tells
you (it never silently re-scaffolds).

Destination choice is separate from the mesh name. Use `--target
github:user/<owner>` or `--target github:org/<owner>` for an explicit online
destination, or `--local` for local-only. With no flag, automatic mode uses the
authenticated GitHub owner when it can be observed; otherwise it keeps the new
mesh local and recommends going online for safety and redundancy. Creation
itself never publishes: Receipt V1 reports terminal status, destination,
checkpoint/mutation evidence, and exact next-sync evidence. Inspect policy
source afterward through read-only vault/mesh info.

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
