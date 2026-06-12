<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-ondark.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" />
    <img alt="Lyt" src="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" width="80" />
  </picture>
</p>

<p align="center">
  <strong>@younndai/lyt-llm</strong><br />
  The LLM gateway — multi-provider routing for AI-assisted vault operations, with hard cost budgets, on your terms.<br />
  <em>Part of the Lyt™ toolchain — federated markdown vaults you own, made legible to AI.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> · <a href="https://github.com/YounndAI/lyt">Repository</a> · <a href="./LICENSE">Apache 2.0</a> · <a href="https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md">Trademark Policy</a> · <a href="https://github.com/YounndAI/lyt/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![npm](https://img.shields.io/npm/v/@younndai/lyt-llm/alpha)](https://www.npmjs.com/package/@younndai/lyt-llm)
[![license](https://img.shields.io/npm/l/@younndai/lyt-llm)](./LICENSE)
[![status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/YounndAI/lyt#status)

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but surfaces change between releases and docs are still growing. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in, and Lyt never phones home.

## What is this?

`@younndai/lyt-llm` is the **LLM gateway** of [Lyt™](https://github.com/YounndAI/lyt) — multi-source LLM routing for AI-assisted vault operations, designed around one principle: **you choose where intelligence runs.** Local model via Ollama, your own provider keys, your existing Claude Code / Codex subscription, or external providers through a relay — the gateway composes four adapters behind a single `createLlmGateway()` surface, and your knowledge only goes where you point it.

This keeps Lyt's **AI-first** posture honest on the model side too: automations that need an LLM step declare a *source preference*, not a hard-wired vendor, and a per-run **cost-budget hard-stop** guarantees a runaway automation can't burn through an API budget. No hidden defaults, no silent cloud calls — the gateway is configuration you can read.

You usually do not install this package directly — it is pulled in by [`@younndai/lyt`](https://www.npmjs.com/package/@younndai/lyt) and consumed by [`@younndai/lyt-runner`](https://www.npmjs.com/package/@younndai/lyt-runner).

## Install (standalone)

```bash
npm install -g @younndai/lyt-llm@alpha
```

## The four adapters

| Adapter | Routes to | Use when |
| --- | --- | --- |
| **harness** | Claude Code / Codex skill invocation | You already pay for an agent subscription — reuse it, no extra keys |
| **ollama** | OpenAI-compatible local HTTP at `localhost:11434` | Fully local inference — knowledge never leaves the machine |
| **byok** | Your own provider keys (Anthropic, OpenAI, …) | Direct provider access under your own account + billing |
| **ai-relay** | External providers via [`@younndai/ai-relay`](https://www.npmjs.com/package/@younndai/ai-relay) | Managed multi-provider routing |

Routing honours per-automator `source_preference` + `hard_constraints` — for example *"local only, never external"* is a declared, enforced constraint, not a hope.

## Cost control

- **Per-run hard-stop** — a run that exceeds its declared budget is stopped, not billed onward.
- **Monthly budget** — warn-level in v1.

## Programmatic use

```ts
import { createLlmGateway } from "@younndai/lyt-llm";
```

The gateway registers `std:llm.generate@v1`, `std:llm.stream@v1`, `std:llm.generate_object@v1`, and `std:llm.embed@v1` ops with [`@younndai/lyt-runner`](https://www.npmjs.com/package/@younndai/lyt-runner), so YON automators can declare LLM steps like any other governed operation.

## The Lyt toolchain

| Package | Role |
| --- | --- |
| [`@younndai/lyt`](https://github.com/YounndAI/lyt/tree/main/packages/lyt) | The unified `lyt` CLI (meta package) |
| [`@younndai/lyt-vault`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-vault) | The vault primitive |
| [`@younndai/lyt-mesh`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mesh) | The mesh layer — multi-vault operations |
| [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) | Agent-harness skills (Claude Code, Codex, agents) |
| [`@younndai/lyt-mcp`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mcp) | The MCP server |
| [`@younndai/lyt-runner`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-runner) | The YON automation runner |
| [`@younndai/lyt-llm`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-llm) | **This package** — the LLM gateway |

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
