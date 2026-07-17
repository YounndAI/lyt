# `lyt help skills` — Lyt harness skills

> Skills are agent-facing wrappers around `lyt pattern run`. They ship in `@younndai/lyt-skills` and install into the user's agent harness (Claude Code: `~/.claude/skills/`; Codex: `~/.codex/skills/`; agents-compatible harnesses: `~/.agents/skills/`). Each skill is a directory with a `SKILL.md` frontmatter file the harness loads on startup.

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

## Inspecting and installing skills

```bash
lyt skills list
lyt skills list --runtime codex --json

lyt skills install
lyt skills install lyt-capture lyt-search --runtime codex
lyt skills install --runtime all --copy --force --json
```

`lyt skills list` reports the bundled skills and their state in each requested runtime. `lyt skills install` with no names installs all bundled skills; pass one or more exact names to install only that selection. An unknown name exits nonzero and prints the valid names.

Both commands accept `--runtime claude|codex|agents|all` (default: `all`) and `--json`. Install also accepts:

- `--copy` — recursively copy each skill instead of creating a link.
- `--force` — replace a divergent existing symlink. It does not authorize deleting user directories.

Without `--copy`, install creates a symlink (a directory junction on Windows) from the harness skill directory to the bundled skill. If the operating system refuses link creation with a permissions error, Lyt falls back to a copy. An existing pristine Lyt copy is replaced safely; a different directory is renamed to `<skill>.local-<timestamp>` before installation so its contents are preserved.

Exit behavior is stable and independent of human or JSON output:

- `0` — successful install/list, including already-linked, copy-fallback, safe replacement, or collision rename-aside results.
- `1` — command-line validation failure, including an invalid runtime or unknown skill name.
- `2` — a divergent symlink was left untouched; rerun install with `--force` to replace it.
- `4` — the target exists but is neither a directory nor a symlink, so Lyt refuses to touch it.

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

## Vault targeting conventions

Each skill documents its own target-resolution chain. For capture, the chain is:

1. `--vault <name-or-path>` explicit argument
2. `$LYT_ACTIVE_VAULT` environment variable
3. `<pod-root>/vaults/<handle>/main/` — resolving `<handle>` from `identity.yon` / `pod.yon`, never hardcoding it
4. ask the user which vault to target

Skills never fabricate a vault from cwd or write to a random directory. If `.lyt/vault.yon` is missing at the resolved path, the skill aborts.

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
