---
name: lyt-progress
description: >
  Write a mid-session progress update as a Lyt Figment. Trigger when the user runs /lyt-progress, or says "write a progress update", "log where we are", "status update", "I'm blocked". Wraps `lyt pattern run work-management progress`. Writes to <vault>/Projects/<project>/work/<date>-progress-<slug>.md.
visibility: public
lyt-version: 0.2.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: true
---

# /lyt-progress

Capture mid-session status — where we are, what's done, what's in flight, blockers, next steps. Superseded by `/lyt-result` at session end.

## When to invoke

- `/lyt-progress` slash trigger
- "where are we"
- "log progress" / "checkpoint" / "status update"
- when a session has been running >2hr OR has hit a blocker

## Phase 1 — Resolve target

Same chain as `/lyt-plan`: `--vault` arg → `$LYT_ACTIVE_VAULT` → cwd detect → `<handle>/main` default. Project + slug similarly resolved.

## Phase 2 — Run the verb

```
lyt pattern run work-management progress --vault <vault> --project <project> --slug <slug>
```

## Phase 3 — Fill the body

Sections to fill:

- **Where we are** — one-paragraph state of play
- **What's done** — bullets
- **What's in flight** — bullets
- **Blockers** — bullets
- **Next steps** — bullets

If this progress closes a plan, set `parent_plan:` frontmatter to the wikilink of the plan.

## Companion skills

- `/lyt-plan` — pre-action design (parent)
- `/lyt-result` — post-action outcome (closes this progress)
