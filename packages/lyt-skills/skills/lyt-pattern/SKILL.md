---
name: lyt-pattern
description: >
  Manage Lyt patterns from the agent harness — list/install/uninstall/link/unlink/fork/verbs/run via the `lyt pattern *` CLI verb set. Trigger when the user runs /lyt-pattern, or says "list my patterns", "install a pattern", "link this pattern into my vault", "fork this pattern", "run a pattern verb directly". This skill exposes the pattern management surface; other Lyt skills may call ordinary CLI verbs directly.
visibility: public
skill-version: 1.0.0
requires-lyt: ">=0.20.0 <0.21.0"
contract-version: 1.0.0
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

For the common write-a-Figment flow, use the dedicated skill:

- `/lyt-capture` (knowledge-capture) — save any Figment note (use `topic:` to categorize)
- `/lyt-recall`, `/lyt-search` — read/search the vault or pod

Use `/lyt-pattern` for pattern management itself OR for verbs that have no dedicated skill wrapper — i.e. verbs from patterns you install yourself (`lyt pattern install --from <dir>`). Lyt bundles only `knowledge-capture` (wrapped by `/lyt-capture` + `/lyt-recall`); opinionated workflow patterns are not shipped. Invoke any installed pattern's verb via `/lyt-pattern run <pattern> <verb>` (e.g. `/lyt-pattern run <your-pattern> <verb>`).

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

Patterns live at `~/lyt/patterns/<name>/` (per-machine, per-user, like the registry). `pattern link` creates `<vault>/.lyt/patterns/<name>` as a junction symlink to the master. Symlinks are gitignored from vault repos (via the `.lyt/patterns/` rule) — `lyt vault adopt` and `lyt vault join` auto-rebuild them per-machine.

To customize without touching the master, use `pattern fork`:

```bash
lyt pattern fork knowledge-capture --as kc-custom
# edit ~/lyt/patterns/kc-custom/
lyt pattern unlink knowledge-capture --vault <v>
lyt pattern link kc-custom --vault <v>
```

## Version migration (v1 caveat)

Newer pattern versions replace the master at `~/lyt/patterns/<name>/`. Files already written from the old template are NOT migrated; the new template only affects NEW writes. (A `lyt pattern migrate` verb is post-v1.)

## Verb-name conflicts

If two installed patterns both declare the same verb (e.g. a `note` verb), address via explicit qualification: `lyt pattern run <pattern-id> note` (not just `lyt pattern run note`). The pattern id is always the disambiguator — the qualified `lyt pattern run <pattern> <verb>` form never guesses.

## Companion skills

Only pattern-backed workflows are pattern-verb wrappers. Other `/lyt-*` skills call their supported CLI verbs directly.
