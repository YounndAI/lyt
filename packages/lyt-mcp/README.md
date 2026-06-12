<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-ondark.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" />
    <img alt="Lyt" src="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" width="80" />
  </picture>
</p>

<p align="center">
  <strong>@younndai/lyt-mcp</strong><br />
  The MCP server — your markdown vaults and meshes as Model Context Protocol tools, local and typed.<br />
  <em>Part of the Lyt™ toolchain — federated markdown vaults you own, made legible to AI.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> · <a href="https://github.com/YounndAI/lyt">Repository</a> · <a href="./LICENSE">Apache 2.0</a> · <a href="https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md">Trademark Policy</a> · <a href="https://github.com/YounndAI/lyt/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![npm](https://img.shields.io/npm/v/@younndai/lyt-mcp/alpha)](https://www.npmjs.com/package/@younndai/lyt-mcp)
[![license](https://img.shields.io/npm/l/@younndai/lyt-mcp)](./LICENSE)
[![status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/YounndAI/lyt#status)

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but surfaces change between releases and docs are still growing. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in, and Lyt never phones home.

## What is this?

`@younndai/lyt-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [Lyt™](https://github.com/YounndAI/lyt) vault and mesh operation set as **typed MCP tools**. Any MCP-compatible client — Claude Desktop, Claude Code, Codex, or your own agent runtime — can search, read, and operate your markdown vaults **locally**, over stdio, with no separate CLI subprocess per call and no cloud middleman. Your knowledge never leaves your machine; the agent comes to the data.

This is Lyt's **AI-first** contract made protocol-native: the same governed operations available as `lyt vault ...` / `lyt mesh ...` on the command line are surfaced as MCP tools with [Zod](https://zod.dev)-validated schemas, so agents get accurate parameter validation and structured errors instead of scraping CLI text. One operation set, three transports — CLI for you, MCP for your agents, harness skills for agent runtimes without MCP.

You usually do not install this package directly — install [`@younndai/lyt`](https://www.npmjs.com/package/@younndai/lyt) and run `lyt mcp serve`.

## Install (standalone)

```bash
npm install -g @younndai/lyt-mcp@alpha
lyt-mcp serve            # starts an MCP server over stdio
```

## Wiring into an MCP client

```jsonc
// claude_desktop_config.json (illustrative)
{
  "mcpServers": {
    "lyt": {
      "command": "lyt-mcp",
      "args": ["serve"],
    },
  },
}
```

Or, from inside Claude Code: `claude mcp add lyt --command lyt-mcp -- serve`.

## What it exposes

A stable MCP tool set covering the v1 vault + mesh + registry operations — list and inspect vaults, run tiered full-text search across your pod, read mesh topology, check writability verdicts. Tool schemas use Zod, so MCP clients validate inputs before they ever touch your vaults. The operation surface grows as new verbs land in [`@younndai/lyt-vault`](https://www.npmjs.com/package/@younndai/lyt-vault) and [`@younndai/lyt-mesh`](https://www.npmjs.com/package/@younndai/lyt-mesh).

Agent writes obey the same permission semantics as human writes: a vault that is read-only for you is read-only for your agent — the writability gate is enforced at the operation layer, not the UI.

## Programmatic use

```ts
import { buildMcpSubcommand } from "@younndai/lyt-mcp";
```

This factory is what the [`@younndai/lyt`](https://www.npmjs.com/package/@younndai/lyt) meta package composes into the unified `lyt` binary's `mcp` subcommand.

## The Lyt toolchain

| Package | Role |
| --- | --- |
| [`@younndai/lyt`](https://github.com/YounndAI/lyt/tree/main/packages/lyt) | The unified `lyt` CLI (meta package) |
| [`@younndai/lyt-vault`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-vault) | The vault primitive |
| [`@younndai/lyt-mesh`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mesh) | The mesh layer — multi-vault operations |
| [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) | Agent-harness skills (Claude Code, Codex, agents) |
| [`@younndai/lyt-mcp`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mcp) | **This package** — the MCP server |
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
