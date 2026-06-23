<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-ondark.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" />
    <img alt="Lyt" src="https://raw.githubusercontent.com/YounndAI/lyt/main/assets/lyt-icon-onlight.png" width="80" />
  </picture>
</p>

<p align="center">
  <strong>@younndai/lyt-mesh</strong><br />
  The mesh layer — weave markdown vaults into shared knowledge meshes across people and organizations.<br />
  <em>Part of the Lyt™ toolchain — federated markdown vaults you own, made legible to AI.</em>
</p>

<p align="center">
  <a href="https://linkyourthink.com">Website</a> · <a href="https://github.com/YounndAI/lyt">Repository</a> · <a href="./LICENSE">Apache 2.0</a> · <a href="https://github.com/YounndAI/lyt/blob/main/TRADEMARK.md">Trademark Policy</a> · <a href="https://github.com/YounndAI/lyt/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![npm](https://img.shields.io/npm/v/@younndai/lyt-mesh/alpha)](https://www.npmjs.com/package/@younndai/lyt-mesh)
[![license](https://img.shields.io/npm/l/@younndai/lyt-mesh)](./LICENSE)
[![status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/YounndAI/lyt#status)

> ⚠️ **Public alpha — under active testing.** Lyt works and we use it daily, but surfaces change between releases and docs are still growing. Install only via the `alpha` dist-tag. Your vaults are plain markdown in plain git repos — your data is never locked in, and Lyt never phones home.

## What is this?

`@younndai/lyt-mesh` is the **mesh layer** of [Lyt™](https://github.com/YounndAI/lyt) — the operations that span multiple markdown vaults. A **mesh** is a named group of vaults with declared edges between them: your personal vaults, a team's shared vaults, an organization's knowledge base, or a public mesh anyone can subscribe to. Where [`@younndai/lyt-vault`](https://www.npmjs.com/package/@younndai/lyt-vault) owns the single-vault primitive, this package owns the graph: cloning a whole owner's vault set onto a new machine, subscribing to vaults from other meshes, validating the declared topology, and rolling up activity across edges.

Meshes connect the way email does — independent vaults that interoperate, publishers never see subscribers, and there is no central server. Everything stays markdown-in-Git, so a mesh is just a set of git repos with a machine-readable shape an AI agent can traverse: subscribe to a public knowledge mesh and your agent reads its content directly, ranked alongside your own notes.

You usually do not install this package directly — install [`@younndai/lyt`](https://www.npmjs.com/package/@younndai/lyt) for the unified `lyt` binary.

## Install (standalone)

```bash
npm install -g @younndai/lyt-mesh@alpha
```

This exposes a `lyt-mesh` binary; the meta package surfaces the same builders as `lyt mesh ...`.

## Top verbs

```bash
lyt mesh status                          # graph view of all registered vaults
lyt mesh list [--json]                   # every mesh on this machine
lyt mesh info <mesh> [--remote]          # one mesh's members + metadata (local or via gh)

lyt mesh subscribe --vault <mesh>/<vault> --from-mesh <mesh>
                                         # clone-on-subscribe a vault from another mesh;
                                         # subscribed content joins mesh-scoped search

lyt mesh clone-all [--source <name>] [--dry-run]
                                         # idempotent clone-or-pull of every configured
                                         # vault source — stand up a machine in one verb

lyt mesh validate                        # parses every vault.yon; reports broken edges,
                                         # tombstone collisions, and missing parents

lyt mesh add-edge --parent <a> --child <b>   # declare a rollup edge between vaults
lyt mesh rebuild-rollup <mesh>               # recompute cross-vault activity rollups
```

## Key features

- **Multi-vault, multi-owner** — a mesh owns its home vaults and references vaults from other meshes; participation is cheap and asymmetric (publishers don't see subscribers — privacy by design).
- **One-verb machine setup** — `mesh clone-all` reconstructs an owner's entire vault set on fresh hardware.
- **Topology you can verify** — `mesh validate` checks the declared graph against reality; `doctor`/`repair` self-heal drift.
- **Agent-traversable** — the mesh shape lives in `.lyt/mesh.yon`, structured YON any AI agent reads directly.

## Programmatic use

```ts
import { buildMeshSubcommand } from "@younndai/lyt-mesh";
```

## The Lyt toolchain

| Package | Role |
| --- | --- |
| [`@younndai/lyt`](https://github.com/YounndAI/lyt/tree/main/packages/lyt) | The unified `lyt` CLI (meta package) |
| [`@younndai/lyt-vault`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-vault) | The vault primitive |
| [`@younndai/lyt-mesh`](https://github.com/YounndAI/lyt/tree/main/packages/lyt-mesh) | **This package** — the mesh layer |
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
