---
name: lyt-pattern
description: >
  Manage Lyt patterns from the agent harness — list/install/uninstall/link/unlink/fork/verbs/run via the `lyt pattern *` CLI verb set. Trigger when the user runs /lyt-pattern, or says "list my patterns", "install a pattern", "link this pattern into my vault", "fork this pattern", "run a pattern verb directly". Meta-skill: every other /lyt-* skill calls `lyt pattern run` under the hood; this skill exposes the full management surface.
visibility: public
lyt-version: 0.2.0
capabilities: [manage]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-pattern

Manage Lyt patterns: install, link/unlink, fork for customization, list available verbs, and run verbs directly.

## When to invoke

- `/lyt-pattern list` — show installed patterns
- `/lyt-pattern verbs <name>` — show a pattern's verbs
- `/lyt-pattern install --from <local-dir>` — install a custom pattern
- `/lyt-pattern link <name> --vault <v>` — symlink into a vault
- `/lyt-pattern fork <name> --as <new>` — customize without modifying the master
- `/lyt-pattern run <pattern> <verb> ...` — direct verb invocation (the other /lyt-\* skills are thin wrappers; this is the escape hatch)

## When NOT to invoke

For the common write-a-Figment-of-type-X flow, use the dedicated skill:

- `/lyt-plan`, `/lyt-progress`, `/lyt-result`, `/lyt-retro`, `/lyt-insight`, `/lyt-handoff` (work-management)
- `/lyt-capture`, `/lyt-recall` (knowledge-capture)
- `/lyt-decision` (decision-log)

Use `/lyt-pattern` for pattern management itself OR for verbs that don't yet have a dedicated skill wrapper (e.g., `project-lifecycle/project-init`, `project-lifecycle/checkpoint`, `decision-log/rationale`).

## The verb surface

```bash
lyt pattern list [--vault <name>] [--json]
lyt pattern install --from <local-dir> [--as <name>] [--force]
lyt pattern uninstall <name> [--force]
lyt pattern link <name> --vault <vault-name>
lyt pattern unlink <name> --vault <vault-name>
lyt pattern fork <source> --as <name>
lyt pattern verbs <name> [--json]
lyt pattern run <pattern> <verb> --vault <v> [--project <p>] [--slug <s>] [--vars k=v...]
```

## Symlink + fork mechanics

Patterns live at `~/lyt/patterns/<name>/` (per-machine, per-user, like the registry). `pattern link` creates `<vault>/Patterns/<name>` as a junction symlink to the master. Symlinks are gitignored from vault repos — `lyt vault adopt` and `lyt vault join` auto-rebuild them per-machine.

To customize without touching the master, use `pattern fork`:

```bash
lyt pattern fork work-management --as wm-custom
# edit ~/lyt/patterns/wm-custom/
lyt pattern unlink work-management --vault <v>
lyt pattern link wm-custom --vault <v>
```

## Version migration (v1 caveat)

Newer pattern versions replace the master at `~/lyt/patterns/<name>/`. Files already written from the old template are NOT migrated; the new template only affects NEW writes. (A `lyt pattern migrate` verb is post-v1.)

## Verb-name conflicts

If two installed patterns both declare a `plan` verb, address via explicit qualification: `lyt pattern run work-management plan` (not just `lyt pattern run plan`). Skills wrap by pattern convention: `/lyt-plan` ties to work-management; a second pattern with `plan` would generate as `/lyt-<pattern2-id>-plan`.

## Companion skills

All `/lyt-*` skills above are pattern-verb wrappers that this meta-skill manages.
