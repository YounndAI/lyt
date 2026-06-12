<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-ondark.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" />
    <img alt="Lyt" src="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" width="80" />
  </picture>
</p>

<p align="center">
  <strong>@younndai/lyt-runner</strong><br />
  The YON automation runner — declarative automators and directives that operate your vaults, deterministically.<br />
  <em>Part of the Lyt™ toolchain — federated markdown vaults you own, made legible to AI.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> · <a href="https://github.com/YounndAI/lyt">Repository</a> · <a href="./LICENSE">Apache 2.0</a> · <a href="https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md">Trademark Policy</a> · <a href="https://github.com/YounndAI/lyt/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![npm](https://img.shields.io/npm/v/@younndai/lyt-runner/alpha)](https://www.npmjs.com/package/@younndai/lyt-runner)
[![license](https://img.shields.io/npm/l/@younndai/lyt-runner)](./LICENSE)
[![status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/YounndAI/lyt#status)

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but surfaces change between releases and docs are still growing. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in, and Lyt never phones home.

## What is this?

`@younndai/lyt-runner` is the **automation runner** of [Lyt™](https://github.com/YounndAI/lyt) — the engine that executes declarative [YON](https://yon.younndai.com) automations over your markdown vaults. An **automator** is a YON document living inside a vault (`.lyt/automators/*.yon`) that declares *what should happen* — fill missing metadata, build lanes, run a sync flow — and this package turns that declaration into governed, deterministic execution.

It is a thin, focused layer on [`@younndai/yon-runner`](https://www.npmjs.com/package/@younndai/yon-runner): it loads the **yai.lyt expander**, which transforms `@AUTOMATOR` + `@DIRECTIVE` records into core YON (`@AGENT` + `@STEP` + ops) before execution, and registers the vault-aware operation set — `std:vault.*`, `std:mesh.*`, and `std:lease.*` ops — so automations can read, write, and sync vaults under the same permission semantics as every other Lyt surface. Because automations are YON documents in the vault, they are versioned with your knowledge, reviewable in any diff, and legible to AI agents — an agent can read, propose, or refine an automator the same way it reads a note.

You usually do not install this package directly — install [`@younndai/lyt`](https://www.npmjs.com/package/@younndai/lyt); the runner is wired in transitively.

## Install (standalone)

```bash
npm install -g @younndai/lyt-runner@alpha
```

## How it fits

```text
.lyt/automators/metadata-filler.yon        # the declaration (lives in YOUR vault, in git)
        │
        ▼
yai.lyt expander                           # @AUTOMATOR + @DIRECTIVE → core YON (@AGENT/@STEP/ops)
        │
        ▼
@younndai/yon-runner                       # deterministic execution engine
        │
        ▼
std:vault.* · std:mesh.* · std:lease.* ops # governed vault operations (+ std:llm.* via lyt-llm)
```

Every new vault ships with default automators (for example a metadata filler), and the run history is recorded per vault — auditable, replayable, no hidden side effects.

## Key features

- **Declarative, in-vault automation** — automators are YON files in your vault: versioned in git, reviewed in diffs, owned by you.
- **Deterministic execution** — declarations expand to explicit steps and ops; no opaque "AI did something" runs.
- **Governed operations** — vault/mesh writes from an automation pass the same writability gates as human and agent writes.
- **LLM steps when you want them** — pairs with [`@younndai/lyt-llm`](https://www.npmjs.com/package/@younndai/lyt-llm) to register `std:llm.*` ops with per-run cost budgets.

## Programmatic use

```ts
import { run } from "@younndai/lyt-runner";
```

## The Lyt toolchain

| Package | Role |
| --- | --- |
| [`@younndai/lyt`](https://github.com/YounndAI/lyt/tree/main/packages/lyt) | The unified `lyt` CLI (meta package) |
| [`@younndai/lyt-vault`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-vault) | The vault primitive |
| [`@younndai/lyt-mesh`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mesh) | The mesh layer — multi-vault operations |
| [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) | Agent-harness skills (Claude Code, Codex, agents) |
| [`@younndai/lyt-mcp`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mcp) | The MCP server |
| [`@younndai/lyt-runner`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-runner) | **This package** — the YON automation runner |
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
