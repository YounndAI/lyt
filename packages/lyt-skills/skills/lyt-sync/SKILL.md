---
name: lyt-sync
description: >
  Sync one exact registered Lyt vault through `lyt sync --vault <qualified-vault> --json`. Lyt owns local reconciliation, first private publication through a trusted mesh target, remote validation, and truthful outcomes. Trigger when the user runs /lyt-sync, or asks to sync, pull, push, or publish one vault. Genuine local/no-target, read-only, subscriber, and offline vaults remain non-publishing. Pairs with /lyt-capture.
visibility: public
skill-version: 1.0.0
requires-lyt: ">=0.20.0 <0.21.0"
contract-version: 1.0.0
lyt-version: 0.4.0
capabilities: [read, write]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-sync

Sync one exact vault through `lyt sync --vault <qualified-vault> --json`. Lyt owns repository creation, remote attachment, commits, pulls, pushes, validation, and truthful terminal status; never reproduce those boundaries with manual `gh` or raw Git commands.

## When to invoke

When the user runs `/lyt-sync`, or says something like:

- "sync this vault"
- "sync my notes"
- "pull and push"
- "push my changes"
- "sync `<vault-name>`"
- "/lyt-sync `<vault-name>`"

If the user says "save and sync" or "/lyt-capture then sync", run /lyt-capture first, then /lyt-sync on the destination vault.

**Pod-wide sync is explicit.** Only "sync everything" uses bare `lyt sync`. `lyt sync --check --vault <qualified-vault> --json` inspects exactly one vault with zero mutations. There is no `lyt sync --mesh` flag.

## Phase 1 — Resolve one exact vault

1. Use the Handler's explicit qualified `{mesh}/{vault}` address when supplied.
2. Otherwise resolve `$LYT_ACTIVE_VAULT`, then `lyt vault info --by-path <cwd> --json` when cwd is inside a registered vault.
3. If neither resolves exactly, ask. Never guess a path or bare name. Use the canonical qualified name returned by `lyt vault info ... --json`.

## Phase 2 — Check-only requests stop after one read-only command

When the Handler asks to inspect sync state rather than change it, run exactly:

```
lyt sync --check --vault <qualified-vault> --json
```

Consume its Receipt V1 and stop. Do not run a later sync, index rebuild, raw Git check, or sibling-vault inspection.

## Phase 3 — Apply the publication gate

Read `lyt vault info <qualified-vault> --json`. Local writes may proceed when `vault.localWritable` is true. Before an outward action, read `vault.publishable`; on `"unknown"`, run `lyt vault refresh <qualified-vault>` and re-read it. If it remains unknown, pause and ask. Lyt performs the final trusted-target, ownership, read-only, and origin checks.

If the Handler did not already request an outward sync, ask before continuing. Use `--no-publish` when the Handler wants local reconciliation only.

## Phase 4 — Invoke Lyt once

```
lyt sync --vault <qualified-vault> --json
```

Never replace this with raw `git` or `gh`. For an owned vault whose home mesh has a trusted target, Lyt may create the exact missing **private** repository, connect it, establish the first upstream, and publish only this vault. A genuine local/no-target vault remains local; subscriber/read-only vaults never publish.

## Phase 5 — Surface the result

- `published`, `already-online`: success.
- `local-only-no-push-target`, `skipped-readonly`, `publish-held`: no online action.
- `publish-deferred`, `origin-mismatch`, `sync-incomplete`: failure; preserve the non-zero exit status and surface the message.
- Conflicts: halt and ask the Handler to resolve them; never auto-resolve.

Rules: touch only the resolved vault; preserve the structured outcome; never infer success from quiet output; never work around Lyt's refusal to delete, forget, or abandon a mesh main vault. Vaults are editor-neutral by default; Obsidian is an explicit `lyt vault init --template obsidian-default` opt-in.

## Companion skills

- **/lyt-capture** — write a Figment into a vault. /lyt-sync is the natural follow-up when the captured vault has push access.
- **/lyt-recall** — search the vault. Read-only; no sync interaction.
