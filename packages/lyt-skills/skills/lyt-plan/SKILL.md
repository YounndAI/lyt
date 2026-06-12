---
name: lyt-plan
description: >
  Write a pre-action plan as a Lyt Figment. Trigger when the user runs /lyt-plan, or says "plan this", "write a plan", "design before coding", "let's plan first". Wraps `lyt pattern run work-management plan` under the hood. Writes to <vault>/Projects/<project>/work/<date>-plan-<slug>.md with frontmatter (date, slug, project, owner).
visibility: public
lyt-version: 0.2.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: true
---

# /lyt-plan

Capture a pre-action plan as a structured Work-Management artifact in a Lyt vault. Plans answer: what are you about to do, why, how, and what does success look like.

## When to invoke

When the user runs `/lyt-plan`, or says something like:

- "let's plan this out"
- "design before coding"
- "what's the plan"
- "write a plan for X"

## Phase 1 — Resolve vault + project + slug

1. **Vault resolution:** `--vault <name>` arg → `$LYT_ACTIVE_VAULT` env → cwd-based detection via `lyt vault info --by-path <cwd>` → default `<handle>/main`.
2. **Project:** `--project <name>` arg → infer from current directory name → ask the user.
3. **Slug:** ask the user, or generate from the plan's title (lowercase kebab-case, ≤7 words).

## Phase 2 — Run the verb

Invoke the CLI:

```
lyt pattern run work-management plan --vault <vault> --project <project> --slug <slug>
```

The CLI fills frontmatter (`date`, `slug`, `project`, `owner`) and writes to the resolved path: `<vault>/Projects/<project>/work/<date>-plan-<slug>.md`.

If the file already exists, the CLI returns `ALREADY-EXISTS` and the path; do not overwrite. Append a `-2` slug or pick a different slug.

## Phase 3 — Fill in the body

After the file is created, edit it to fill in:

- **Goal** — one-paragraph statement of intent
- **Background** — context, references, prior decisions
- **Approach** — steps, sequence, who/what does each
- **Risks + open questions**
- **Success criteria**
- **Estimate**

Use Obsidian-flavored markdown. Use `[[wikilinks]]` to cross-reference prior plans, results, or thoughts.

## Companion skills

- `/lyt-progress` — mid-session status update on this plan
- `/lyt-result` — post-action outcome closing this plan
- `/lyt-retro` — deliberate retrospective after the plan executes
