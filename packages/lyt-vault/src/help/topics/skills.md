# `lyt help skills` — Lyt harness skills

> Skills are agent-facing wrappers around `lyt pattern run`. They live in `@younndai/lyt-skills@0.2.0` and install into the user's agent harness (Claude Code: `~/.claude/skills/`; Codex: `~/.codex/skills/`). Each skill is a directory with a `SKILL.md` frontmatter file the harness loads on startup.

---

## The 10 default skills

| Skill           | Pattern + verb wrapped         | What it does                                |
| --------------- | ------------------------------ | ------------------------------------------- |
| `/lyt-plan`     | work-management + plan         | Pre-action design Figment                   |
| `/lyt-progress` | work-management + progress     | Mid-session status update                   |
| `/lyt-result`   | work-management + result       | Post-action outcome (the default catch-all) |
| `/lyt-retro`    | work-management + retro        | Deliberate retrospective                    |
| `/lyt-insight`  | work-management + insight      | Distilled project-specific lesson           |
| `/lyt-handoff`  | work-management + handoff      | Inter-session brief                         |
| `/lyt-decision` | decision-log + decision        | Locked decision with rationale              |
| `/lyt-capture`  | knowledge-capture + capture    | Save a Figment to `<vault>/notes/`          |
| `/lyt-recall`   | knowledge-capture + recall     | Search a vault by keyword                   |
| `/lyt-pattern`  | meta — manages `lyt pattern *` | Direct verb invocation + pattern management |

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
user: /lyt-plan
  │
  ▼ harness loads ~/.claude/skills/lyt-plan/SKILL.md
  │
  ▼ skill resolves vault (--vault arg → $LYT_ACTIVE_VAULT → cwd detect → default)
  │
  ▼ skill resolves project + slug (args, then user prompts)
  │
  ▼ skill calls CLI:
      lyt pattern run work-management plan --vault <v> --project <p> --slug <s>
  │
  ▼ CLI loads ~/lyt/patterns/work-management/templates/plan.md
  │
  ▼ CLI substitutes <date>, <slug>, <project>, <owner>, <title>, ...
  │
  ▼ CLI resolves path-glob: <vault>/Projects/<project>/work/<date>-plan-<slug>.md
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

- The 10 default skills ship with names `lyt-*` to avoid colliding with user-installed skills.
- A user installing a pattern whose verb name matches a built-in (e.g., a second pattern's `plan` verb) will have the second skill auto-generated as `/lyt-<pattern-id>-plan` to avoid clobbering `/lyt-plan`.

See also: `lyt help patterns` for the verb infrastructure these skills wrap.
