---
name: lyt-decision
description: >
  Record a locked architectural or product decision as a Lyt Figment. Trigger when the user runs /lyt-decision, or says "lock this decision", "record the decision", "decide between options", "this is decided". Wraps `lyt pattern run decision-log decision`. Writes to <vault>/Projects/<project>/work/<date>-decision-<slug>.md.
visibility: public
lyt-version: 0.2.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: true
---

# /lyt-decision

Record a locked decision — the choice, the alternatives, the reasoning. Use when a decision is durable enough that future-you (or a future agent) will need to read it cold.

## When to invoke

- `/lyt-decision` slash trigger
- "lock this decision"
- "we decided X — record it"
- after a structured assessment or review lands a locked verdict
- before starting work whose direction depends on a non-obvious choice

## Phase 1 — Resolve target

Same chain as `/lyt-plan`. Slug describes the decision (e.g., `transclusion-priming-files`, `gh-prefix-soft`).

## Phase 2 — Run the verb

```
lyt pattern run decision-log decision --vault <vault> --project <project> --slug <slug>
```

## Phase 3 — Fill the body

Sections to fill:

- **The decision** — one sentence, imperative voice
- **Context** — what forced this decision
- **Alternatives considered** — A / B / C with one-line each
- **Why this option won** — one paragraph; reference rationale if long-form
- **Reversibility** — how hard to undo, what downstream work depends on this
- **Cross-references** — wikilinks to rationale file (if separate), related decisions

## Long-form reasoning

If the reasoning is too long for the decision file, write a separate `<date>-rationale-<slug>.md` via `lyt pattern run decision-log rationale --vault <v> --project <p> --slug <s>` and link from the decision file's `supports-decision:` (in the rationale) and `Cross-references` (in the decision).

## Companion skills

- `/lyt-insight` — for distilled lessons LEARNED from acting on decisions
- `/lyt-handoff` — handoffs often reference locked decisions
