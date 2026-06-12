---
name: lyt-insight
description: >
  Capture a distilled project-specific learning as a Lyt Figment. Trigger when the user runs /lyt-insight, or says "this is a project insight", "promote this lesson", "make this durable", "extract the lesson". Wraps `lyt pattern run work-management insight`. Writes to <vault>/Projects/<project>/work/<date>-insight-<slug>.md. For project-agnostic lessons use Nuggets instead.
visibility: public
lyt-version: 0.2.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: true
---

# /lyt-insight

Distilled learning specific to THIS project. Promotion target from a `result-` or `retro-` when the lesson earns durable value.

## When to invoke

- `/lyt-insight` slash trigger
- "this is a project insight"
- "promote this"
- "we keep learning this — write it down"

If the lesson is project-AGNOSTIC (applies to any future project), use `/lyt-capture` with a `Nuggets/<subject>/` target instead.

## Phase 1 — Resolve target

Same chain as `/lyt-plan`. If promoting from a result, prefer renaming the existing result file in place: `<date>-result-<slug>.md` → `<date>-insight-<slug>.md`, update `type:` in frontmatter, set `derived_from_session:`. No folder move; no wikilink rot.

If writing a fresh insight that doesn't promote from a specific result, run the verb to create a new file.

## Phase 2 — Run the verb (when creating fresh)

```
lyt pattern run work-management insight --vault <vault> --project <project> --slug <slug>
```

## Phase 3 — Fill the body

Sections to fill:

- **The insight** — state the lesson sharply, one paragraph
- **Why it matters** — where this changes future decisions
- **Evidence** — sessions, commits, decisions that support it
- **Edge cases / qualifiers** — when this does NOT apply
- **Related** — wikilinks to source results, decisions, plans

## Promotion to Nuggets

If after writing the insight you realize the lesson is project-agnostic, ALSO write a `Nuggets/<subject>/<date>-nugget-<slug>.md` at vault root. (Or: rename in place to the Nuggets folder if it's exclusively agnostic.) Two files are fine when the lesson is project-specific in flavor but applies elsewhere too.

## Companion skills

- `/lyt-result` — source of most insight promotions
- `/lyt-retro` — source of retro-derived insights
- `/lyt-decision` — for choices that warrant a separate decision artifact
