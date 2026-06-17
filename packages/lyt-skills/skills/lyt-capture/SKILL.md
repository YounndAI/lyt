---
name: lyt-capture
description: >
  Capture a Figment (a markdown note) into a Lyt vault under the 8-field frontmatter contract. Trigger when the user runs /lyt-capture, or says "save this", "capture this", "add to my vault", "remember this in Lyt", or similar phrasing on content they want kept in their Lyt vault. Writes an Obsidian-flavored markdown file under <vault>/notes/ with frontmatter (title, created, modified, tags, purpose, topic, mesh-visibility, weight, meta) per yai.lyt v1 (arc §3). Wraps `lyt pattern run knowledge-capture capture` under the hood. Companion to lyt-recall.
visibility: public
lyt-version: 0.2.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: true
---

# /lyt-capture

Capture a Figment into a Lyt vault under the v1 8-field frontmatter contract. A Figment is a single markdown file with frontmatter that the user can read in Obsidian, link to via `[[wikilinks]]`, and later find via `/lyt-recall`.

Under the hood this skill calls `lyt pattern run knowledge-capture capture` — but the harness convention is to fill in the Figment body inline rather than invoke the CLI verb directly, because the user usually has specific content they want captured (not a template stub).

## When to invoke

When the user runs `/lyt-capture`, or says something like:

- "save this to my vault"
- "capture this"
- "add this to Lyt"
- "remember this"
- "put this in my notes"

If the user pastes content and only says "save it," interpret as `/lyt-capture` on the pasted content.

## Phase 1 — Resolve the target vault

Follow this chain, in order, and stop at the first success:

1. **`--vault <path>` argument** — if the user passed one in the invocation, use it as-is (resolve to absolute path if relative).
2. **`$LYT_ACTIVE_VAULT` environment variable** — if set, use it.
3. **`~/lyt/vaults/<handle>/main/`** — the default convention per the unified `{handle}/{repo}` naming (Windows: `%USERPROFILE%\lyt\vaults\<handle>\main`). Resolve `<handle>` from the pod identity (`identity.yon` / `pod.yon`); never hardcode it.

Do **not** guess from cwd. If `--vault` / env var / home convention all miss, ask the user which vault to target — fabricating a path from cwd would silently capture into the wrong vault.

If the resolved path **does not exist or is not a Lyt vault** (no `.lyt/vault.yon` inside), do **not** create files in it. Stop and tell the user:

> The target vault `<path>` doesn't exist (or isn't a Lyt vault — no `.lyt/vault.yon`). Create it with `lyt vault init <mesh>/<vault>` (create-if-missing — makes the mesh if absent; bare names land in `personal/`), or pass `--vault <existing-name-or-path>`.

A `--vault` argument may be a `{mesh}/{vault}` name, a bare leaf (resolved to a unique vault; the CLI errors and lists candidates on a collision), or a pod-local alias (`lyt alias <name> <target>`) — all resolve to the same vault. Resolve names via `lyt vault list --json` rather than guessing.

## Phase 2 — Build the Figment under the v1 8-field contract

Per yai.lyt v1 frontmatter contract (arc §3), every captured Figment carries 8 mandatory frontmatter fields plus a `meta:` escape hatch.

1. **Determine a title.** Use the user's explicit title if given. Otherwise infer a short noun-phrase (5–8 words) from the content. If unsure, ask.
2. **Compute the slug** — lowercase, kebab-case the title, strip non-`[a-z0-9-]` characters, max 60 chars.
3. **Compute the filename** — `notes/YYYY-MM-DD-<slug>.md` using today's date.
4. **If a file already exists at that path**, append `-2`, `-3`, etc. to the slug until the path is free. Never overwrite.
5. **Fill the 8 mandatory frontmatter fields:**

| Field             | Source                                | Notes                                                                                    |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `title`           | inferred / explicit                   | the title from step 1                                                                    |
| `created`         | auto                                  | ISO 8601 timestamp, e.g. `2026-05-28T20:36:42.880Z`                                      |
| `modified`        | auto                                  | same as `created` at capture time                                                        |
| `tags`            | inferred from content (optional list) | e.g. `[design, lyt]`                                                                     |
| `purpose`         | **PROMPT the user** if not inferrable | one-line author-stated purpose — "Why is this note worth keeping?"                       |
| `topic`           | **PROMPT the user** if not inferrable | semantic category — free-text or a tag the user already uses                             |
| `mesh-visibility` | default `local`                       | one of `local` / `parent` / `public` — ask only if user signals a non-default visibility |
| `weight`          | default `3`                           | int 1–5 importance signal — ask only if user signals a non-default weight                |

**Do NOT author-fill `links-out-of-vault`.** That field is reserved for the lyt scanner (block-B); it is intentionally absent at capture-write time. The contract is "scanner-filled, not author-filled."

The `meta:` blob is a free-form escape hatch (`{}` by default) — fill it only when the content carries a field the 8-field contract does not cover.

6. **Compose the file content** matching the `knowledge-capture/capture` pattern template:

```markdown
---
title: "<title>"
created: <ISO 8601 timestamp>
modified: <ISO 8601 timestamp>
tags: [<inferred tags, optional>]
purpose: "<one-line author-stated purpose>"
topic: "<semantic category>"
mesh-visibility: local
weight: 3
meta: {}
---

<body content — plain Obsidian-flavored markdown>
```

If the user provides explicit values for `mesh-visibility` (e.g. "share to parent") or `weight` (e.g. "important — weight 5"), apply them; otherwise use the defaults.

## Phase 3 — Write, index, confirm

1. Write the file using your `Write` tool.
2. **Index it so it's searchable immediately.** The figment you just wrote is on disk but NOT yet in the search/recall/primer caches — index it with:

```
lyt capture --index-only <relative-path-from-vault-root> --vault <vault>
```

e.g. `lyt capture --index-only notes/2026-06-10-my-note.md --vault personal/main`. This runs the same index-on-write path the CLI capture uses (FTS + lanes/arcs), so a subsequent `/lyt-recall` or `lyt search` hits with **no** manual `lyt reindex`. It is best-effort: if it reports `index deferred`, the figment is still saved and self-heals on the next search — do not block the capture or re-write the file.

3. Confirm to the user in one line:

> Captured to `<relative-path-from-vault-root>` in `<vault-path>`.

4. Do **not** run any git operations. Phase 8's sync watcher (when shipped) will handle commits.

## Rules

- **8-field contract is mandatory.** Every captured Figment carries all 8 mandatory fields. `purpose` and `topic` are author-supplied; if not inferrable from content, **prompt the user** rather than fabricating values.
- **`links-out-of-vault` is scanner-filled.** Never author-fill it. Its absence at capture-write is intentional.
- **`mesh-visibility` default = `local`; `weight` default = `3`.** Override only when the user signals a non-default.
- **User Figments are plain Obsidian-flavored markdown.** Wikilinks (`[[other-note]]`), tags (`#tag`), callouts, embeds — all fine. **Do NOT write YON inside user Figments.** YON is reserved for system files (`.lyt/vault.yon`, `.lyt/memscope.yon`, pattern.yon).
- **Never overwrite an existing Figment.** Always pick a fresh slug suffix.
- **Never touch files outside `<vault>/notes/`** unless the user explicitly says so.
- **Never run `git add`/`git commit`** — sync is a Phase 8 concern.
- If the user's content references other Figments by name, use `[[wikilinks]]` so Obsidian resolves them; don't expand them yourself.

## Direct CLI path (when no content yet)

If the user wants a quick capture without you authoring the body inline, run the top-level alias directly:

```
lyt capture "<the thought>" --vault <vault> --purpose <p> --topic <t>
```

This is a true alias for `lyt pattern run knowledge-capture capture` (same v1 8-field ceremony) and indexes on write, so the capture is immediately searchable. The `<text>` becomes the title (slug derived from it); the file lands at `<vault>/notes/<date>-<slug>.md`. `purpose` and `topic` are mandatory — pass them as flags (or `--vars purpose=<p> --vars topic=<t>`; the `--vars` flag is **repeatable single** key=value, NOT a comma-joined list), or the command prompts for them on a TTY. `mesh-visibility` and `weight` default to `local` / `3`.

## Companion skill

After capturing, the same content is findable via `/lyt-recall <keyword>`.
