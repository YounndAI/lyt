# `lyt help skills` — Lyt harness skills

> Skills are agent-facing wrappers around `lyt pattern run`. They live in `@younndai/lyt-skills@0.2.0` and install into the user's agent harness (Claude Code: `~/.claude/skills/`; Codex: `~/.codex/skills/`). Each skill is a directory with a `SKILL.md` frontmatter file the harness loads on startup.

---

## The 11 default skills

| Skill                 | Wraps                          | What it does                                |
| --------------------- | ------------------------------ | ------------------------------------------- |
| `/lyt-capture`        | knowledge-capture + capture    | Save a Figment to `<vault>/notes/`          |
| `/lyt-recall`         | `lyt search --vault`           | Ranked search within a single vault         |
| `/lyt-search`         | `lyt search`                   | Ranked search across the pod / mesh / vault |
| `/lyt-pod`            | `lyt mesh list` + `vault list` | Enumerate every mesh + vault                |
| `/lyt-mesh-explore`   | `lyt mesh info`                | Drill into one mesh's members + metadata    |
| `/lyt-alias`          | `lyt alias`                    | Manage pod-local vault aliases (name → rid) |
| `/lyt-primer-context` | `lyt primer` + `vault info`    | Prime an agent with vault/mesh/pod context  |
| `/lyt-sync`           | gated git pull/commit/push     | Sync a vault under the writable gate        |
| `/lyt-adopt`          | `lyt vault adopt`              | Bring an existing Obsidian vault into pod   |
| `/lyt-update`         | `lyt outdated` + `lyt update`  | Check for + install a newer Lyt release     |
| `/lyt-pattern`        | meta — manages `lyt pattern *` | Direct verb invocation + pattern management |

> Lyt bundles only the `knowledge-capture` pattern (behind `/lyt-capture` + `/lyt-recall`). Opinionated workflow patterns (planning, handoffs, decision logs, project lifecycles) are intentionally not shipped — install your own with `lyt pattern install --from <dir>` and invoke their verbs via `/lyt-pattern run <pattern> <verb>`.

---

## Installing skills into your harness

```bash
npm install -g @younndai/lyt-skills
lyt-skills install
```

The installer detects harness presence (Claude Code / Codex) and copies bundled SKILL.md directories into the appropriate `~/.<harness>/skills/` location. Pass `--harness claude-code` or `--harness codex` to override the auto-detect. Pass `--force` to overwrite existing skill files.

After install, the harness picks up new skills on next session start.

---

## How a skill invocation flows

```
user: /lyt-capture
  │
  ▼ harness loads ~/.claude/skills/lyt-capture/SKILL.md
  │
  ▼ skill resolves vault (--vault arg → $LYT_ACTIVE_VAULT → cwd detect → default)
  │
  ▼ skill resolves purpose + topic + slug (args, then user prompts)
  │
  ▼ skill calls CLI:
      lyt pattern run knowledge-capture capture --vault <v> --slug <s>
  │
  ▼ CLI loads ~/lyt/patterns/knowledge-capture/templates/capture.md
  │
  ▼ CLI substitutes <date>, <slug>, <owner>, <title>, ...
  │
  ▼ CLI resolves path-glob: <vault>/notes/<date>-<slug>.md
  │
  ▼ CLI writes the file
  │
  ▼ skill confirms to user; user opens the file in Obsidian to fill body
```

---

## Auto-detection conventions

Skills auto-resolve their target vault from this chain:

1. `--vault <name>` explicit argument
2. `$LYT_ACTIVE_VAULT` environment variable (or `$LYT_DEFAULT_VAULT`)
3. `lyt vault info --by-path <cwd>` — if cwd is inside a registered vault
4. `~/lyt/vaults/alex/main/` — the convention's default master vault for the user

If no vault resolves, the skill stops and asks the user to pass `--vault` explicitly or set the env var. Skills NEVER write to a random directory; if `.lyt/vault.yon` is missing at the resolved path, the skill aborts.

---

## Writing a custom skill

A custom skill is a directory at `~/.claude/skills/my-skill/` (or `~/.codex/skills/...`) containing a `SKILL.md` with this frontmatter shape:

```yaml
---
name: my-skill
description: >
  Short trigger description. When does this skill fire? What does it do?
visibility: public
---
# /my-skill

Body content — the harness reads this on invocation. Cite which `lyt pattern run`
verb the skill wraps (if any), and the user-facing flow.
```

The harness reads `name` to register the slash command, `description` to compute relevance, and the body as the skill's instructions to the agent.

---

## Conflicts + priority

If two skills declare the same `name`, the harness's behavior depends on its lookup order (Claude Code: alphabetical by directory name). For Lyt-specific patterns:

- The 11 default skills ship with names `lyt-*` to avoid colliding with user-installed skills.
- A user installing a pattern whose verb name matches a built-in (e.g., a second pattern's `capture` verb) will have the second skill auto-generated as `/lyt-<pattern-id>-capture` to avoid clobbering `/lyt-capture`.

See also: `lyt help patterns` for the verb infrastructure these skills wrap.
