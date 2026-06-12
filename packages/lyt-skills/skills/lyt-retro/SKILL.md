---
name: lyt-retro
description: >
  Write a deliberate retrospective on a session, sprint, or completed plan. Trigger when the user runs /lyt-retro, or says "retro this", "what did we learn", "lessons from this sprint", "post-mortem". Wraps `lyt pattern run work-management retro`. Writes to <vault>/Projects/<project>/work/<date>-retro-<slug>.md.
visibility: public
lyt-version: 0.2.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: true
---

# /lyt-retro

Capture a deliberate retrospective. What worked. What didn't. What we'd change next time. Distinct from `/lyt-result` (which records WHAT shipped); a retro records WHY it went the way it did.

## When to invoke

- `/lyt-retro` slash trigger
- "let's retro this"
- end of a sprint, arc, project, or contentious decision
- after a meaningful handoff (often required by the handoff-execute protocol)

## Phase 1 — Resolve target

Same chain as `/lyt-plan`. Slug usually matches the artifact being retro'd (e.g., `phase-7-session-2-bulk-init-patterns-skills-retro`).

If retro'ing a specific session/sprint/handoff, set `retro-of:` frontmatter to its wikilink.

## Phase 2 — Run the verb

```
lyt pattern run work-management retro --vault <vault> --project <project> --slug <slug>
```

## Phase 3 — Fill the body

Sections to fill:

- **What worked** — bullets, specific
- **What didn't** — bullets, specific (no euphemisms)
- **What we'd change next time** — bullets, actionable
- **Lessons (durable enough to keep)** — if any rise to insight-level, promote

## Promotion

A retro's durable lessons promote either to:

- `<date>-insight-<slug>.md` in the same `work/` folder (project-specific)
- `Nuggets/<subject>/<date>-nugget-<slug>.md` at vault root (project-agnostic)

## Companion skills

- `/lyt-result` — what shipped (this retro reflects on)
- `/lyt-insight` — durable lessons promoted from this retro
