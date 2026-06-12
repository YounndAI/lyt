---
name: lyt-recall
description: >
  Search a Lyt vault by keyword. Trigger when the user runs /lyt-recall <query>, or asks "what did I write about X", "find my notes on X", "recall X from my vault", "search my vault for X", or similar phrasing. Returns matching Figments with relative path, title, and 2-line snippet around each match. Wraps `lyt pattern run knowledge-capture recall` for the report artifact (optional). Companion to lyt-capture.
visibility: public
lyt-version: 0.2.0
capabilities: [search]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-recall

Search a Lyt vault by keyword. A Lyt vault is a folder of markdown Figments under `<vault>/notes/` (and elsewhere). v1 search is filesystem grep; libSQL FTS5 + vector ranking lands in a later phase.

## When to invoke

When the user runs `/lyt-recall <query>`, or says something like:

- "what did I write about <topic>"
- "find my notes on <topic>"
- "recall <topic> from my vault"
- "search my vault for <topic>"
- "have I captured anything about <topic>"

If the user asks a question that depends on prior captured knowledge, invoke this skill proactively — don't fabricate; check the vault first.

## Phase 1 — Resolve the target vault

Same resolution chain as `/lyt-capture`:

1. `--vault <path>` arg
2. `$LYT_ACTIVE_VAULT` env var
3. cwd-based detection via `lyt vault info --by-path <cwd>`
4. `~/lyt/vaults/<handle>/main/` default

If the resolved path is missing or has no `.lyt/vault.yon`, tell the user and stop — don't grep random directories.

## Phase 2 — Search

1. **Run the Grep tool** with:

- `pattern`: the user's query (case-insensitive by default)
- `path`: the resolved vault path
- `glob`: `**/*.md`
- `output_mode`: `content`
- `-i`: `true`
- `-n`: `true`
- `-C`: `2` (two lines of context around each match)
- `head_limit`: 30

2. **If zero matches**, broaden the query:

- Split into individual terms (whitespace-separated).
- Run separate grep calls, one per term.
- Union the results.
- If still zero, tell the user: _"No Figments in `<vault>` match `<query>`. Try a broader term or different phrasing."_ Then stop.

## Phase 3 — Present results

For each unique matching file (deduplicate by path), surface:

- **Path** — relative to the vault root (e.g., `notes/2026-05-24-q4-planning.md`)
- **Title** — read the file's frontmatter `title:` if present; otherwise the filename slug
- **Snippet** — the matched line plus 1 line of context above/below

Cap at the first 10 distinct files. If there are more, mention the count and offer to narrow the query.

Format example:

> **Found 3 matches in `~/lyt/vaults/<handle>/main/`:**
>
> 1. **notes/2026-05-24-q4-planning.md** — "Q4 planning"
>    > ...the auth rewrite is a P0 for Q4...
> 2. **notes/2026-05-23-auth-decisions.md** — "Auth rewrite decisions"
>    > ...moving to OAuth, deprecating session tokens by EOQ...

## Optional: persist the recall report as a Figment

If the user wants the recall results saved (e.g., for inclusion in a `/lyt-plan` or `/lyt-result`), run:

```
lyt pattern run knowledge-capture recall --vault <vault> --slug <query-as-slug>
```

That writes a recall-report Figment at `<vault>/notes/recall-<date>-<slug>.md` with frontmatter capturing the query. The body is then filled in with the match list.

## Rules

- **Never open or modify files** beyond the optional recall-report write.
- **Stay inside the resolved vault.** Don't grep the user's filesystem at large.
- **Don't fabricate hits.** If the grep returns nothing, say so.
- **Don't paraphrase across Figments.** Each match shown is the literal vault content; the user gets the raw recall, not a synthesis.
- libSQL FTS5 / vector / cross-vault search are deferred to a later phase. v1 is grep.

## Companion skill

To add new content to the vault, use `/lyt-capture`.
