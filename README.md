<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-ondark.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" />
    <img alt="Lyt" src="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" width="80" />
  </picture>
</p>

<p align="center">
  <strong>Lyt™ — Link Your Think</strong><br />
  Federated markdown vaults — the storage architecture for AI-native knowledge work, AI-first by design.<br />
  <em>You own the markdown. Lyt is the federation layer over it.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="LICENSE">Apache 2.0</a> ·
  <a href="TRADEMARK.md">Trademark Policy</a> ·
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <a href="#status"><img alt="status" src="https://img.shields.io/badge/status-public%20alpha-orange" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue" /></a>
  <a href="package.json"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D20.9-brightgreen" /></a>
</p>

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but it is alpha software: surfaces change between releases, documentation is still growing, and you may hit rough edges. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in. Found something? [Open an issue](https://github.com/YounndAI/lyt/issues) or see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## What is Lyt?

**Lyt** turns a folder of markdown notes into a Git-native vault that can join a mesh of other vaults across people and organizations — **mint vaults you own, weave meshes you share, forge Your Pod.** Each vault is one Git repo. The mesh is the graph of declared edges across vaults. A small libSQL index sits beside the markdown for fast `lyt vault list` / `lyt mesh status` reads and for search, and a YON declaration file (`.lyt/vault.yon`) is the source of truth for the mesh shape.

A vault's identity is its **`rid`** (a UUIDv7 minted on this machine); the human-readable `{mesh}/{vault}` name is *computed* from the vault's home mesh plus its leaf, so renaming or moving a vault updates the name automatically while the `rid` stays stable. Names, bare leaves, pod-local aliases, and `lyt:vault:<host>/<owner>/<repo>` origin coordinates all resolve to the `rid`.

Lyt is **AI-first by design**: an AI agent is a first-class operator of your knowledge, not a bolted-on feature. Every vault and mesh speaks [YON](https://yon.younndai.com) — structured records any agent reads directly — and the same operation set is exposed to you via the CLI and to agents via harness skills and an MCP server. Lyt is the reference implementation of the AI-first standard we're defining.

You keep the markdown. Lyt is the thin federation layer over it: it never asks you to move your notes into a database or a proprietary format, works with any markdown editor (Obsidian, VS Code, your terminal), and it never phones home. Lyt ships as npm packages, installs globally, and is driven by the `lyt` CLI — and by AI agents via the harness skills in [`@younndai/lyt-skills`](packages/lyt-skills/README.md).

## Status

**Public alpha — in active testing.** Lyt is being validated with a small alpha cohort right now. The CLI surface, file formats, and docs may change between alpha releases without deprecation cycles. There is no `latest` release yet — install with the `alpha` dist-tag (see below). Nothing phones home, and your notes stay plain markdown in plain git repos, so trying Lyt risks none of your data. Feedback is welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Install

```bash
npm install -g @younndai/lyt@alpha
```

This installs the unified `lyt` binary. You can also install from source:

```bash
git clone https://github.com/YounndAI/lyt && cd lyt && npm install && npm run build
```

## Quick start

```bash
npm install -g @younndai/lyt@alpha
lyt init                   # interactive setup wizard
```

The wizard detects and installs Node, the GitHub CLI, and your agent runtime (Claude Code or Codex); runs `gh auth login`; installs the Lyt skills and the agent manual; probes for an existing pod on your handle (cross-machine adopt-detect); creates your `personal` mesh and first vault; initialises your pod repo; and captures a welcome note.

Pass `--dry-run` to preview every phase without filesystem writes or spawn invocations.

## Manual walkthrough (without the wizard)

```bash
# 1. Initialize a vault. `{mesh}/{vault}` is create-if-missing: it makes the
#    `alex` mesh if absent, then the `main` vault.
lyt vault init alex/main \
    --description "Alex's master vault" \
    --topic personal

# 2. Capture and find knowledge.
lyt capture "an idea worth keeping"
lyt search "idea"          # ranked across your whole pod

# 3. On another machine, clone your configured vault sources.
lyt mesh clone-all

# 4. Open it in any markdown editor.
obsidian ~/lyt/vaults/alex/main
```

For a deeper tour, run `lyt help getting-started` after install.

## Search

`lyt search "<query>"` ranks results across your whole pod (or a single `--mesh` / `--vault`) through a tiered cascade — arc membership, lane membership, full-text (FTS5/BM25), then one-hop mesh edges — each tier carrying a confidence score.

On top of the lexical cascade, Lyt adds **optional on-device semantic search** to surface notes that keyword matching misses (different words, same meaning). It runs a small local embedding model (`bge-small-en-v1.5`, ~23 MB, CPU-only via [fastembed](https://www.npmjs.com/package/fastembed)) and fuses its results into the cascade under a confidence gate. Semantic search is **on by default when the model is available**, and degrades silently to the lexical cascade when it isn't — no errors, no cloud calls, nothing leaves your machine.

The one-time ~23 MB model download is **handler-gated**: on an interactive terminal, `lyt reindex` asks before fetching and shows progress; in non-interactive, scripted, or MCP contexts Lyt never auto-downloads and simply uses lexical search. Disable semantic fusion any time with `lyt search --no-semantic` or globally via `LYT_EMBEDDINGS=0`.

## Storage

Lyt vaults live under `~/lyt/vaults/` by default. To place a vault elsewhere — say on a separate drive — pass `--path /abs/path` to `lyt vault init`, or accept the wizard's first-vault placement prompt. The `LYT_HOME` environment variable shifts the default root globally. Precedence: `--path` (per-vault absolute override) > wizard placement prompt > `LYT_HOME` (default-root only; never overrides an explicit `--path`).

## CLI surface

```text
lyt init                             # interactive bootstrap wizard
lyt capture "<text>"                 lyt search "<query>" [--vault|--mesh|--all]
lyt primer --scope vault|mesh|federation
lyt reindex [--all|--mesh <m>|--vault <v>]

lyt vault init|adopt|join|clone|move|rename|forget|disconnect|delete|list|info
lyt vault add-edge|refresh|verify|sync-metadata|regen-context|snapshot|freeze
lyt vault share|unshare|access|invites|abandon
lyt alias <name> <target> [--list|--remove]

lyt mesh init|join|list|info|subscribe|add-edge|validate|adopt|rebuild-registry
lyt mesh status|clone-all|rebuild-rollup
lyt federation init|list|rebuild     lyt discover     lyt repair [--dry-run|--apply]
lyt identity|machine|provenance|audit|housekeep

lyt pattern list|install|uninstall|link|unlink|fork|verbs|run
lyt skills install                   lyt agent-manual --install
lyt help [<topic>] [--markdown]      lyt doctor [--json|--full]   lyt mcp start
```

Run `lyt help` for the full verb-group view, `lyt help <topic>` for any of the topic docs, and `lyt doctor` to confirm your environment is healthy.

## Packages

| Package | Purpose |
|---|---|
| [`@younndai/lyt`](packages/lyt/README.md) | Meta package — pulls in the others and ships the unified `lyt` binary. |
| [`@younndai/lyt-vault`](packages/lyt-vault/README.md) | Vault primitive: `init`, `adopt`, `capture`, `search`, the libSQL index, `help`, `doctor`, `pattern`, the priming-file scaffold. |
| [`@younndai/lyt-mesh`](packages/lyt-mesh/README.md) | Mesh layer: `mesh status`, `clone-all`, `subscribe`, `validate`, `init`/`join`. |
| [`@younndai/lyt-skills`](packages/lyt-skills/README.md) | Harness skills (Claude Code, Codex, MCP clients) wrapping the pattern runtime. |
| [`@younndai/lyt-mcp`](packages/lyt-mcp/README.md) | MCP server exposing the operation set as MCP tools for local agent use. |
| [`@younndai/lyt-runner`](packages/lyt-runner/README.md) | Automator runtime — the operation registry the CLI and skills dispatch against. |
| [`@younndai/lyt-llm`](packages/lyt-llm/README.md) | LLM gateway — multi-source routing behind a single surface. |

## License

This repository — every package above — is **Apache-2.0**. No quotas, ever. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Contributing

Contributions are welcome under a signed Contributor License Agreement. See [CONTRIBUTING.md](CONTRIBUTING.md) for the CLA and the contribution checklist, and [SECURITY.md](SECURITY.md) for vulnerability reporting.

---

## About YounndAI

**YounndAI™ — You and AI, unified.** (pronounced *"yoon-dye"*)

A philosophy of intelligence: building with intention, so humans and machines
think together without losing what makes either whole.

## License & Attribution

Apache-2.0. © 2026 MARLINK TRADING SRL (YounndAI). See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

"LYT", "Lyt", and "YounndAI" are trademarks of MARLINK TRADING SRL — see [`TRADEMARK.md`](TRADEMARK.md).

Created by [Alexandru Mareș](https://allemaar.com).

Website: [linkyourthink.com](https://linkyourthink.com)

<p align="center"><em>Structure before scale. Harmony above all.</em></p>

---

|               |                                                         |
| ------------- | ------------------------------------------------------- |
| **Project**   | [Lyt — Link Your Think](https://linkyourthink.com)      |
| **Author**    | [Alexandru Mareș](https://allemaar.com)                 |
| **Company**   | [MARLINK TRADING SRL](https://younndai.com) · YounndAI™ |
| **License**   | [Apache 2.0](LICENSE) — © 2026 MARLINK TRADING SRL      |
| **Trademark** | [YounndAI™ Trademark Guidelines](TRADEMARK.md)          |
