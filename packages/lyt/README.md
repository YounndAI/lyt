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
  <em>Part of the Lyt (Link Your Think™) toolchain — federated markdown vaults you own, made legible to AI.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> · <a href="https://github.com/YounndAI/lyt">Repository</a> · <a href="./LICENSE">Apache 2.0</a> · <a href="https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md">Trademark Policy</a> · <a href="https://github.com/YounndAI/lyt/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![npm](https://img.shields.io/npm/v/@younndai/lyt/alpha)](https://www.npmjs.com/package/@younndai/lyt)
[![license](https://img.shields.io/npm/l/@younndai/lyt)](./LICENSE)
[![status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/YounndAI/lyt#status)

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but surfaces change between releases and docs are still growing. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in, and Lyt never phones home.

## What is this?

`@younndai/lyt` is the **meta package and unified CLI** for [Lyt](https://github.com/YounndAI/lyt) — _Link Your Think_: federated markdown vaults, the storage architecture for AI-native knowledge work. Lyt turns a folder of markdown notes into a Git-native vault that can join a **mesh** of other vaults across people and organizations — **mint vaults you own, weave meshes you share, forge Your Pod.**

Lyt is **AI-first by design**: an AI agent is a first-class operator of your knowledge, not a bolted-on feature. Every vault and mesh speaks [YON](https://yon.younndai.com) — structured records any agent reads directly — and the same operation set is exposed to humans via the CLI and to agents via harness skills and an MCP server. Lyt is the reference implementation of an AI-first approach we're working out in the open.

You keep the markdown. Lyt is the thin federation layer over it: each vault is one Git repo, the mesh is the graph of declared edges between vaults, and a small libSQL index sits beside the markdown for fast reads. It never asks you to move your notes into a database or a proprietary format, works with any markdown editor (Obsidian, VS Code, your terminal), and never phones home.

Installing this one package pulls in the whole core toolchain and ships the single `lyt` binary.

## Install

```bash
npm install -g @younndai/lyt@alpha
lyt init                       # interactive setup wizard
```

The `alpha` tag is the recommended channel while compatibility testing continues.

## Quick start

```bash
lyt init                       # create or adopt your first vault
lyt mesh init research --target github:org/YounndAI # name and owner are independent
lyt capture "an idea worth keeping"
lyt search "idea"              # full-text across your pod
lyt sync --vault personal/main # publish only this vault when ready
lyt sync --check --vault personal/main --json # exact one-vault, zero-mutation check
lyt mesh status                # the federation graph
lyt doctor                     # confirm your environment is healthy
```

AI agents drive the same surface through the harness skills in [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) and the MCP server in [`@younndai/lyt-mcp`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mcp).

## What you get

The `lyt` binary dispatches every verb group under one entry point — you never have to remember which package owns which verb:

```bash
lyt vault init alex/main       # vault primitive   (@younndai/lyt-vault)
lyt alias home alex/main       # pod-local name → vault rid (survives rename + move)
lyt mesh status                # federation layer  (@younndai/lyt-mesh)
lyt pattern list               # patterns + skills (@younndai/lyt-vault)
lyt mcp start                  # MCP server        (@younndai/lyt-mcp)
lyt doctor --json              # diagnostics       (@younndai/lyt-vault)
```

Addressing: the vault `rid` (UUIDv7) is identity; `{mesh}/{vault}` names, bare
leaves (unique-leaf, errors on collision), aliases, and `lyt:vault:` origin
coordinates all resolve to it. `lyt vault init <mesh>/<vault>` is
create-if-missing.

Creation is local-first and returns Receipt V1: terminal status, destination,
checkpoint/mutation evidence, and exact next-sync evidence. Policy source is
available afterward through read-only vault/mesh info. A new
vault snapshots its mesh destination unless explicitly overridden; no creation
command publishes silently.

## Metadata that stays correct

Every note carries an 8-field frontmatter contract — title, real dates, tags, a `topic`, and a `purpose` you write. Lyt keeps it correct at rest, sets it at capture, and heals legacy files — without ever touching your prose:

```bash
lyt capture "an idea" --dir projects/notes   # choose where it lands; sets a topic interactively
lyt vault backfill <name>                     # fill missing frontmatter on an existing vault, in place
lyt vault reconcile <name> --apply            # heal notes that are unindexed or missing metadata
lyt doctor                                    # count notes with missing or invalid frontmatter
```

Backfill fills titles, genuine created/modified dates (from git history), and keyword tags **with no model required** — on any vault, including one you just imported. `purpose` is left blank and flagged, never guessed; anything you authored is never overwritten. When a local embedding model is present, `topic:` is enriched too — capture _suggests_ one for you to confirm (never auto-selected), and backfill assigns a confident match from your vault's existing labels, leaving it blank when unsure. Topics are ranked against your vault's current on-disk labels and computed on-device — nothing is sent anywhere. Every machine-filled field is provenance-stamped, so it stays distinguishable from your own writing.

## The Lyt toolchain

Lyt is an open toolchain — `@younndai/lyt` composes these packages, and you can also depend on any of them directly:

| Package                                                                                 | Role                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`@younndai/lyt`](https://github.com/YounndAI/lyt/tree/main/packages/lyt)               | **This package** — the unified `lyt` CLI that aggregates every verb group      |
| [`@younndai/lyt-vault`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-vault)   | The vault primitive — init, adopt, capture, search, the libSQL index, patterns |
| [`@younndai/lyt-mesh`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mesh)     | The federation layer — meshes, edges, subscriptions, clone-all, sync           |
| [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) | Agent-harness skills — Claude Code, Codex, and generic agent runtimes          |
| [`@younndai/lyt-mcp`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mcp)       | The MCP server — exposes Lyt to any Model Context Protocol client              |
| [`@younndai/lyt-runner`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-runner) | The YON automation runner — patterns, automators, directive expansion          |
| [`@younndai/lyt-llm`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-llm)       | The LLM gateway — multi-source routing for AI-assisted vault operations        |

## Documentation

- **Getting started** — `lyt help getting-started` after install
- **Full README & guides** — [github.com/YounndAI/lyt](https://github.com/YounndAI/lyt#readme)
- **Changelog** — [CHANGELOG.md](https://github.com/YounndAI/lyt/blob/main/CHANGELOG.md)

---

## About YounndAI

**YounndAI™ — You and AI, unified.** (pronounced _"yoon-dye"_)

A philosophy of intelligence: building with intention, so humans and machines
think together without losing what makes either whole.

## License & Attribution

Apache-2.0. © 2026 MARLINK TRADING SRL (YounndAI). See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

"Lyt" and "YounndAI" are trademarks of MARLINK TRADING SRL — see [`TRADEMARK.md`](https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md).

Created by [Alexandru Mareș](https://allemaar.com).

Website: [linkyourthink.com](https://linkyourthink.com)

<p align="center"><em>Structure before scale. Harmony above all.</em></p>

---

|               |                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------- |
| **Project**   | [Lyt — Link Your Think](https://linkyourthink.com)                                       |
| **Author**    | [Alexandru Mareș](https://allemaar.com)                                                  |
| **Company**   | [MARLINK TRADING SRL](https://younndai.com) · YounndAI™                                  |
| **License**   | [Apache 2.0](./LICENSE) — © 2026 MARLINK TRADING SRL                                     |
| **Trademark** | [YounndAI™ Trademark Guidelines](https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md) |
