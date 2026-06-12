<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-ondark.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" />
    <img alt="Lyt" src="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" width="80" />
  </picture>
</p>

<p align="center">
  <strong>@younndai/lyt-skills</strong><br />
  Agent-harness skills — let Claude Code, Codex, and any agent runtime drive your markdown vaults as first-class operators.<br />
  <em>Part of the Lyt™ toolchain — federated markdown vaults you own, made legible to AI.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> · <a href="https://github.com/YounndAI/lyt">Repository</a> · <a href="./LICENSE">Apache 2.0</a> · <a href="https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md">Trademark Policy</a> · <a href="https://github.com/YounndAI/lyt/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![npm](https://img.shields.io/npm/v/@younndai/lyt-skills/alpha)](https://www.npmjs.com/package/@younndai/lyt-skills)
[![license](https://img.shields.io/npm/l/@younndai/lyt-skills)](./LICENSE)
[![status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/YounndAI/lyt#status)

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but surfaces change between releases and docs are still growing. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in, and Lyt never phones home.

## What is this?

`@younndai/lyt-skills` is where [Lyt™](https://github.com/YounndAI/lyt)'s **AI-first** design becomes tangible: fifteen harness skills that let AI agents — Claude Code, Codex, and generic agent runtimes — drive your markdown vaults as **first-class operators**. Install once and your agent can capture notes, search your pod, record decisions, write plans, retros, and handoffs, explore meshes, and sync vaults — through the same governed operation set you use, under the same permission semantics. This is the "install once, every agent runtime knows Lyt" layer.

Most skills wrap a pattern verb from the `lyt pattern run` runtime, so structured knowledge work (plans, results, decisions, captures) shows up as first-class agent skills inside any vault; the read/orient skills (`/lyt-pod`, `/lyt-search`, `/lyt-primer-context`, `/lyt-mesh-explore`, `/lyt-sync`) wrap the corresponding CLI verbs directly. Pairs with [`@younndai/lyt-vault`](https://www.npmjs.com/package/@younndai/lyt-vault), which ships the four default patterns the skills resolve against.

## Install

```bash
npm install -g @younndai/lyt@alpha   # the meta package bundles lyt-skills
lyt skills install                   # links the 15 SKILL.md files into your harness(es)
```

Tri-runtime: the installer detects Claude Code, Codex, and generic agent runtimes, and installs per-runtime (symlink by default, `--copy` for regular directories).

## The 15 skills

| Skill                 | Wraps                                              | Use it when                                                  |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `/lyt-capture`        | knowledge-capture + capture                        | Saving a Figment (markdown note) into a vault.               |
| `/lyt-recall`         | knowledge-capture + recall                         | Keyword search across a single vault.                        |
| `/lyt-search`         | `lyt search` (tiered cascade)                      | Ranked search across the whole pod, a mesh, or a vault.      |
| `/lyt-pod`            | `lyt mesh list` + `lyt vault list`                 | Enumerating every mesh + vault on the machine.               |
| `/lyt-mesh-explore`   | `lyt mesh info`                                    | Drilling into one mesh's members and metadata.               |
| `/lyt-primer-context` | `lyt primer` + `lyt vault info`                    | Priming an agent with vault/mesh/pod context.                |
| `/lyt-sync`           | gated git pull/commit/push                         | Syncing a vault with its remote under the writable gate.     |
| `/lyt-plan`           | work-management + plan                             | Drafting a multi-phase plan before implementation.           |
| `/lyt-progress`       | work-management + progress                         | Mid-session progress update or blocker write-up.             |
| `/lyt-result`         | work-management + result                           | Session-end result with per-clause acceptance.               |
| `/lyt-retro`          | work-management + retro                            | Post-implementation retrospective.                           |
| `/lyt-insight`        | work-management + insight                          | Promoting a result into a durable insight.                   |
| `/lyt-handoff`        | work-management + handoff                          | Writing the next session's handoff brief.                    |
| `/lyt-decision`       | decision-log + decision                            | Recording a decision + rationale pair.                       |
| `/lyt-pattern`        | meta-skill over `lyt pattern *`                    | Listing, installing, linking patterns from an agent context. |

Each skill autodetects the active vault + project via `lyt vault info --by-path`, the `LYT_ACTIVE_VAULT` env var, or an explicit `--vault` flag, then calls `lyt pattern run <pattern> <verb>` to write the file at the resolved path.

## The capture contract

`/lyt-capture` enforces an 8-field frontmatter contract on every captured Figment:

| Field                                  | Source                                           | Default  |
| -------------------------------------- | ------------------------------------------------ | -------- |
| `title`, `created`, `modified`, `tags` | Auto-filled by the skill                         | —        |
| `purpose`                              | Handler-prompted (1 line — what the note is for) | required |
| `topic`                                | Handler-prompted (semantic category)             | required |
| `mesh-visibility`                      | Handler-overridable                              | `local`  |
| `weight`                               | Handler-overridable (1–5)                        | `3`      |

A `meta:` escape-hatch blob accepts free-form fields without schema churn. The result: every note an agent saves is structured, searchable, and legible to the next agent that reads it.

## Patterns vs skills

- A **pattern** is data: a `pattern.yon` descriptor + a `templates/` folder of markdown templates with frontmatter. Patterns live at `~/lyt/patterns/`.
- A **skill** is a thin SKILL.md adapter an agent harness loads; it calls the pattern runtime.

Fork any default pattern (`lyt pattern fork work-management --as wm-custom`) without modifying the master. See `lyt help patterns` and `lyt help skills`.

## The Lyt toolchain

| Package | Role |
| --- | --- |
| [`@younndai/lyt`](https://github.com/YounndAI/lyt/tree/main/packages/lyt) | The unified `lyt` CLI (meta package) |
| [`@younndai/lyt-vault`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-vault) | The vault primitive |
| [`@younndai/lyt-mesh`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mesh) | The mesh layer — multi-vault operations |
| [`@younndai/lyt-skills`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-skills) | **This package** — agent-harness skills |
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
