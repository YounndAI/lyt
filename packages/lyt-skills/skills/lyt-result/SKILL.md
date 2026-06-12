---
name: lyt-result
description: >
  Write a post-action result as a Lyt Figment — the default catch-all at session end. Trigger when the user runs /lyt-result, or says "write a result", "what shipped", "wrap up the session", "log the outcome". Wraps `lyt pattern run work-management result`. Writes to <vault>/Projects/<project>/work/<date>-result-<slug>.md.
visibility: public
lyt-version: 0.2.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: true
---

# /lyt-result

Capture the post-action outcome — what was delivered, what changed, what didn't get done. The default catch-all artifact at the end of every meaningful session.

## When to invoke

- `/lyt-result` slash trigger
- session end: "wrap this up", "log the outcome"
- after a commit / push / deploy

## Phase 1 — Resolve target

Same chain as `/lyt-plan`. Slug usually matches the parent plan's slug (set `parent_plan` frontmatter wikilink).

## Phase 2 — Run the verb

```
lyt pattern run work-management result --vault <vault> --project <project> --slug <slug>
```

## Phase 3 — Fill the body

Sections to fill:

- **Outcome** — what got delivered. Reference commits if applicable (set `commits:` frontmatter array).
- **What changed** — files, behaviors, decisions
- **What didn't get done** — deferred / blocked / cut
- **Cross-references** — plan link, commits, follow-ups

## Promotion

If the result teaches something durable about THIS project, **rename in place** to `<date>-insight-<slug>.md` and update `type: insight` in frontmatter — no folder move, no link rot. If the lesson is project-agnostic, write a `Nuggets/<subject>/<date>-nugget-<slug>.md` instead.

## Companion skills

- `/lyt-plan` — pre-action design (parent of this result)
- `/lyt-insight` — promoted result with durable project lesson
- `/lyt-retro` — deliberate retrospective after a meaningful arc
