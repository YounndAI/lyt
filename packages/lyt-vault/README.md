<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-ondark.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" />
    <img alt="Lyt" src="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" width="80" />
  </picture>
</p>

<p align="center">
  <strong>@younndai/lyt-vault</strong><br />
  The vault primitive — local-first markdown vaults with capture, full-text search, and a regenerable index, built for AI agents.<br />
  <em>Part of the Lyt™ toolchain — federated markdown vaults you own, made legible to AI.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> · <a href="https://github.com/YounndAI/lyt">Repository</a> · <a href="./LICENSE">Apache 2.0</a> · <a href="https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md">Trademark Policy</a> · <a href="https://github.com/YounndAI/lyt/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![npm](https://img.shields.io/npm/v/@younndai/lyt-vault/alpha)](https://www.npmjs.com/package/@younndai/lyt-vault)
[![license](https://img.shields.io/npm/l/@younndai/lyt-vault)](./LICENSE)
[![status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/YounndAI/lyt#status)

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but surfaces change between releases and docs are still growing. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in, and Lyt never phones home.

## What is this?

`@younndai/lyt-vault` is the **vault primitive** of [Lyt™](https://github.com/YounndAI/lyt) — the package that turns a folder of plain markdown notes into a **local-first, Git-native knowledge vault** with structured metadata, fast full-text search, and an AI-readable declaration file. A Lyt vault is markdown-in-Git: your notes stay plain `.md` files in a plain git repo, a `.lyt/` area carries the [YON](https://yon.younndai.com)-structured vault declaration and a regenerable libSQL index, and an `.obsidian/` scaffold makes the vault open cleanly in any markdown editor.

Lyt is **AI-first by design** — a vault is as legible to an AI agent as it is to you. Capture a note and an agent can find it by full-text search seconds later; every vault speaks YON, so agents read structure directly instead of scraping prose. This package implements the verbs that create, adopt, inspect, search, and maintain individual vaults — plus the shared `help`, `doctor`, and `pattern` command groups.

You usually do not install this package directly — install [`@younndai/lyt`](https://www.npmjs.com/package/@younndai/lyt) for the unified `lyt` binary.

## Install (standalone)

```bash
npm install -g @younndai/lyt-vault@alpha
```

This exposes a `lyt` binary scoped to the vault, help, doctor, and pattern verb groups.

## Top verbs

```bash
# Create or adopt a vault
lyt vault init <mesh>/<vault>      # create-if-missing: makes the mesh if absent,
                                   #   stops if the vault exists (--mesh, --push-to)
lyt vault adopt <path>             # bring an existing markdown folder under Lyt
lyt vault list [--json]            # every registered vault (computed {mesh}/{vault} names)
lyt vault info <name> [--json]     # status, mesh, writability, origin coordinate
lyt alias <name> <target>          # pod-local name → vault rid (survives rename + move)

# Capture and find knowledge
lyt capture "<text>"               # save a Figment (markdown note) with frontmatter
lyt search "<query>" [--vault <name>] [--mesh <m>] [--no-semantic] [--json]
                                   # tiered search (arcs → lanes → FTS5 → edges)
                                   #   + optional on-device semantic fusion
lyt reindex [--all|--mesh <m>|--vault <name>]
                                   # rebuild the libSQL search caches from the markdown SoT

# Your Pod (the per-user view across every mesh you participate in)
lyt federation init [--public|--private]   # forge {handle}/lyt-pod + the pod.yon manifest
lyt federation list [--json]               # cached pod manifest, deterministic ordering

# Identity, machine roles, provenance
lyt identity show|refresh          # GitHub-authoritative identity, cached locally
lyt machine status [--json]        # roles (client / automator-runner / …) + region
lyt provenance trace <file|rid>    # follow the @STAMP provenance chain

# Health and help
lyt doctor [--json|--full]         # git/gh/node/npm checks, registry integrity, self-heal hints
lyt help [<topic>]                 # getting-started, mesh, agents, patterns, troubleshooting…
lyt pattern list|run|fork|…        # the bundled pattern runtime (4 default patterns)
```

The full v1 verb set also includes `vault clone|forget|disconnect|delete|add-edge|verify|regen-context`, the registry verbs, audit export, and friction tracking. Run `lyt help commands` for the complete list.

## Search

`lyt search` runs a tiered cascade — arc membership, lane membership, full-text (FTS5/BM25), then one-hop mesh edges — each tier carrying a confidence score, ranked into one list. On top of that, an **optional on-device semantic layer** surfaces notes keyword matching misses (different words, same meaning): a one-time local embedding model (`bge-small-en-v1.5`, CPU-only via [fastembed](https://www.npmjs.com/package/fastembed)) whose results are fused into the cascade under a confidence gate.

- Semantic search is **on by default when the model is available**, and degrades silently to the lexical cascade when it isn't — no error, no cloud call, byte-identical to `--no-semantic`.
- The one-time local model download is **handler-gated**: `lyt reindex` on an interactive terminal prompts before fetching; non-interactive / scripted / MCP runs never auto-download. The model caches under `~/lyt/.embeddings-cache/`, never inside a vault.
- Embeddings run **locally on CPU** — there is no remote inference and `fastembed` is an `optionalDependency`, so install succeeds even where its native runtime can't build.
- Turn fusion off with `lyt search --no-semantic`, or disable it globally via `LYT_EMBEDDINGS=0`.

## Key features

- **Markdown is the source of truth.** The libSQL index is a regenerable cache — delete it and `lyt reindex` restores it from your notes. No black-box database ever owns your knowledge.
- **Search agents can use** — `lyt search --json` returns ranked, structured hits with vault, path, snippet, tier, and confidence; the same search backs the agent-harness skills and the MCP server.
- **YON-structured declarations** — `.lyt/vault.yon` is the machine-readable source of truth for the vault's mesh shape; any AI agent reads it directly.
- **Self-healing** — corrupt index files are quarantined and rebuilt; `lyt doctor` and `lyt repair` diagnose and fix registry drift.
- **Never phones home** — zero passive telemetry; every network operation is user-initiated and inspectable.

## Programmatic use

```ts
import {
  buildVaultSubcommand,
  buildRegistrySubcommand,
  buildHelpCommand,
  buildDoctorCommand,
  buildPatternCommand,
} from "@younndai/lyt-vault";
```

The [`@younndai/lyt`](https://www.npmjs.com/package/@younndai/lyt) meta package composes these factories; you can do the same in custom CLI builds.

## The Lyt toolchain

| Package | Role |
| --- | --- |
| [`@younndai/lyt`](https://github.com/YounndAI/lyt/tree/main/packages/lyt) | The unified `lyt` CLI (meta package) |
| [`@younndai/lyt-vault`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-vault) | **This package** — the vault primitive |
| [`@younndai/lyt-mesh`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mesh) | The mesh layer — multi-vault operations |
| [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) | Agent-harness skills (Claude Code, Codex, agents) |
| [`@younndai/lyt-mcp`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mcp) | The MCP server |
| [`@younndai/lyt-runner`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-runner) | The YON automation runner |
| [`@younndai/lyt-llm`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-llm) | The LLM gateway |

---

## About YounndAI

**YounndAI™ — You and AI, unified.** (pronounced *"yoon-dye"*)

A philosophy of intelligence: building with intention, so humans and machines
think together without losing what makes either whole.

## License & Attribution

Apache-2.0. © 2026 MARLINK TRADING SRL (YounndAI). See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

"LYT", "Lyt", and "YounndAI" are trademarks of MARLINK TRADING SRL — see [`TRADEMARK.md`](https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md).

Created by [Alexandru Mareș](https://allemaar.com).

Website: [linkyourthink.com](https://linkyourthink.com)

<p align="center"><em>Structure before scale. Harmony above all.</em></p>

---

|               |                                                         |
| ------------- | ------------------------------------------------------- |
| **Project**   | [Lyt — Link Your Think](https://linkyourthink.com)      |
| **Author**    | [Alexandru Mareș](https://allemaar.com)                 |
| **Company**   | [MARLINK TRADING SRL](https://younndai.com) · YounndAI™ |
| **License**   | [Apache 2.0](./LICENSE) — © 2026 MARLINK TRADING SRL    |
| **Trademark** | [YounndAI™ Trademark Guidelines](https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md) |
