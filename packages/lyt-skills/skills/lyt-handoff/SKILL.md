---
name: lyt-handoff
description: >
  Write an inter-session handoff brief — what a fresh agent or human needs to pick up the work. Trigger when the user runs /lyt-handoff, or says "write a handoff", "brief the next session", "hand this off", "what does the next agent need". Wraps `lyt pattern run work-management handoff`. Writes to <vault>/Handoffs/<project>/<date>-<slug>.md.
visibility: public
lyt-version: 0.2.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: true
---

# /lyt-handoff

Write a handoff brief — a self-contained document a fresh agent (or person) can pick up cold to continue work. Distinct from `/lyt-result` (which is about THIS session); a handoff is forward-looking for the NEXT session.

## When to invoke

- `/lyt-handoff` slash trigger
- "write a handoff brief for the next agent"
- "I need to leave a brief"
- end of a multi-session arc when a fresh session needs to pick up

## Phase 1 — Resolve target

Same chain as `/lyt-plan`. Slug describes the work being handed off (e.g., `phase-7-session-3-npm-precheck-readmes`).

## Phase 2 — Run the verb

```
lyt pattern run work-management handoff --vault <vault> --project <project> --slug <slug>
```

The verb writes to `<vault>/Handoffs/<project>/<date>-<slug>.md` (not under `work/` — handoffs live at vault root in their own folder per Work-Management convention).

## Phase 3 — Fill the body

A good handoff has:

- **Acceptance sentence** — one paragraph that captures what "done" looks like
- **State snapshot (@CONTINUATION)** — current branch, last commit, modified files, in-flight artifacts, pushed/unpushed state, test count
- **Sources (@SOURCES.required + .optional)** — every file the next agent MUST read before drafting any plan
- **Resume command** — numbered steps the next agent should follow
- **Sign-off** — canonical retro path; structured @SESSION_REPORT format if applicable
- **Activation phrase** — the prompt to paste into the fresh session to resume the work

The frontmatter `acceptance` field is load-bearing: the executing agent walks its clauses to verify the work matches the brief.

## Companion skills

- a fresh agent session — consumes the brief written by this skill
- `/lyt-result` — what the prior session shipped (context for the handoff)
- `/lyt-retro` — usually written alongside or after the next-session retro
