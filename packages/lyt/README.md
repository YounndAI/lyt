<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-ondark.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" />
    <img alt="Lyt" src="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" width="80" />
  </picture>
</p>

<p align="center">
  <strong>@younndai/lyt</strong><br />
  The unified Lyt CLI — federated markdown vaults, the storage architecture for AI-native knowledge work.<br />
  <em>Part of the Lyt™ toolchain — federated markdown vaults you own, made legible to AI.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> · <a href="https://github.com/YounndAI/lyt">Repository</a> · <a href="./LICENSE">Apache 2.0</a> · <a href="https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md">Trademark Policy</a> · <a href="https://github.com/YounndAI/lyt/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![npm](https://img.shields.io/npm/v/@younndai/lyt/alpha)](https://www.npmjs.com/package/@younndai/lyt)
[![license](https://img.shields.io/npm/l/@younndai/lyt)](./LICENSE)
[![status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/YounndAI/lyt#status)

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but surfaces change between releases and docs are still growing. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in, and Lyt never phones home.

## What is this?

`@younndai/lyt` is the **meta package and unified CLI** for [Lyt™](https://github.com/YounndAI/lyt) — *Link Your Think*: federated markdown vaults, the storage architecture for AI-native knowledge work. Lyt turns a folder of markdown notes into a Git-native vault that can join a **mesh** of other vaults across people and organizations — **mint vaults you own, weave meshes you share, forge Your Pod.**

Lyt is **AI-first by design**: an AI agent is a first-class operator of your knowledge, not a bolted-on feature. Every vault and mesh speaks [YON](https://yon.younndai.com) — structured records any agent reads directly — and the same operation set is exposed to humans via the CLI and to agents via harness skills and an MCP server. Lyt is the reference implementation of the AI-first standard we're defining.

You keep the markdown. Lyt is the thin federation layer over it: each vault is one Git repo, the mesh is the graph of declared edges between vaults, and a small libSQL index sits beside the markdown for fast reads. It never asks you to move your notes into a database or a proprietary format, works with any markdown editor (Obsidian, VS Code, your terminal), and never phones home.

Installing this one package pulls in the whole core toolchain and ships the single `lyt` binary.

## Install

```bash
npm install -g @younndai/lyt@alpha
lyt init                       # interactive setup wizard
```

There is no `latest` release yet — the `alpha` tag is required.

## Quick start

```bash
lyt init                       # create or adopt your first vault
lyt capture "an idea worth keeping"
lyt search "idea"              # full-text across your pod
lyt mesh status                # the federation graph
lyt doctor                     # confirm your environment is healthy
```

AI agents drive the same surface through the harness skills in [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) and the MCP server in [`@younndai/lyt-mcp`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mcp).

## What you get

The `lyt` binary dispatches every verb group under one entry point — you never have to remember which package owns which verb:

```bash
lyt vault init alex/main       # vault primitive   (@younndai/lyt-vault)
lyt mesh status                # federation layer  (@younndai/lyt-mesh)
lyt pattern list               # patterns + skills (@younndai/lyt-vault)
lyt mcp serve                  # MCP server        (@younndai/lyt-mcp)
lyt doctor --json              # diagnostics       (@younndai/lyt-vault)
```

## The Lyt toolchain

Lyt is an open toolchain — `@younndai/lyt` composes these packages, and you can also depend on any of them directly:

| Package | Role |
| --- | --- |
| [`@younndai/lyt`](https://github.com/YounndAI/lyt/tree/main/packages/lyt) | **This package** — the unified `lyt` CLI that aggregates every verb group |
| [`@younndai/lyt-vault`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-vault) | The vault primitive — init, adopt, capture, search, the libSQL index, patterns |
| [`@younndai/lyt-mesh`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mesh) | The federation layer — meshes, edges, subscriptions, clone-all, sync |
| [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) | Agent-harness skills — Claude Code, Codex, and generic agent runtimes |
| [`@younndai/lyt-mcp`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mcp) | The MCP server — exposes Lyt to any Model Context Protocol client |
| [`@younndai/lyt-runner`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-runner) | The YON automation runner — patterns, automators, directive expansion |
| [`@younndai/lyt-llm`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-llm) | The LLM gateway — multi-source routing for AI-assisted vault operations |

## Documentation

- **Getting started** — `lyt help getting-started` after install
- **Full README & guides** — [github.com/YounndAI/lyt](https://github.com/YounndAI/lyt#readme)
- **Changelog** — [CHANGELOG.md](https://github.com/YounndAI/lyt/blob/main/CHANGELOG.md)

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
| **Trademark** | [YounndAI™ Trademark Guidelines](https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md)        |
