# Getting started with Lyt

Five minutes from a fresh machine to a working vault.

## 0. Prerequisites

- **Node.js ≥ 20.9** and **npm ≥ 10**.
- **Git ≥ 2.40**.
- **GitHub CLI (`gh`) ≥ 2.50**, authenticated via `gh auth login`. Optional, but
  required for `lyt vault sync-metadata` and any GitHub-touching operation.

## 1. Install Lyt

Today (pre-publish), Lyt is installed from the repo:

```bash
git clone https://github.com/YounndAI/lyt
cd lyt
npm install
npx turbo run build
# Use packages/lyt-vault/dist/cli.js as `lyt` during dev.
```

After Phase 8 ships the npm publish:

```bash
npm install -g @younndai/lyt
```

## 2. Create your first vault

```bash
lyt vault init alex/main --description "Alex's master vault"
```

This scaffolds `~/lyt/vaults/alex/main/` with:

- `.lyt/vault.yon` — vault identity + edges (committed)
- `.lyt/memscope.yon` — access policy (committed)
- `.lyt/mesh-context.md` — auto-regenerated mesh context (committed)
- `.obsidian/` — Obsidian config (committed)
- `lyt-overview.md` — your identity page (user-owned; transcludes mesh-context)
- `agents.md` — instructions for AI agents driving Lyt in this vault
- `notes/index.md` — optional starter Figment (suppress with `--no-starter-figment`)
- `.gitignore`, `README.md`

A `git init` runs by default; `--no-git` skips it. `--commit-initial` makes a
single conventional commit with the scaffold files.

## 3. Open in Obsidian

```bash
lyt vault open alex/main
```

(Or open `~/lyt/vaults/alex/main` in Obsidian manually.)

## 4. Add a second vault and connect them

```bash
lyt vault init alex/personal --description "Personal subtree" --parent <rid-of-alex/main>
```

Edges already declared by `--parent` automatically regenerate the child's
`.lyt/mesh-context.md`.

For peer (sibling) edges:

```bash
lyt vault add-edge alex/personal --peer <rid-of-alex/business> --edge share_with
```

## 5. See the mesh

```bash
lyt vault list
lyt vault info alex/main
```

(`lyt mesh status` ships in `@younndai/lyt-mesh`; not bundled with the meta
package yet.)

## Next steps

- `lyt help metadata` — descriptions + GitHub topics + priming files.
- `lyt help mesh` — how the mesh is structured.
- `lyt help agents` — driving Lyt with AI agents.
