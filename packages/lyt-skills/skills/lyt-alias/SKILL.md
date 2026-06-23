---
name: lyt-alias
description: >
  Manage pod-local vault aliases — bind a short handler-chosen name to a vault (alias → rid; survives rename + move), list the bindings, re-point one, or remove one. Trigger when the user runs /lyt-alias, or says "alias this vault as X", "give <vault> a short name", "what aliases do I have", "list my aliases", "rename my alias", "re-point alias X", "remove alias X", "drop the alias for X". Wraps `lyt alias <name> <target>` / `lyt alias --list` / `lyt alias --remove <name>` (all `--json`). Aliases are pod-local: synced across your own pod's machines, never to subscribers. Read-only on the target — works on a subscribed/read-only vault. Pairs with /lyt-pod and /lyt-search (which resolve `@alias` addresses).
visibility: public
lyt-version: 0.9.5
capabilities: [read, write]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-alias

Manage **pod-local aliases** — a short, handler-chosen name that resolves to a vault. An alias binds a name to the vault's **`rid` (its UUIDv7 identity)**, not to its `{mesh}/{vault}` display name, so the alias keeps working after the vault is renamed or moved between meshes. Aliases are a convenience layer over the one addressing chokepoint every `lyt` verb resolves through (`{mesh}/{vault}` → bare leaf → alias → origin coordinate).

This skill is pure prose around three existing CLI forms of one verb — it adds no new command and changes no `lyt-vault` code:

- `lyt alias <name> <target>` — **set / re-point** (bind, or rebind, `name` → the vault `target` resolves to)
- `lyt alias --list` (or bare `lyt alias`) — **list** every pod-local alias
- `lyt alias --remove <name>` — **remove** an alias

All three accept `--json` for a machine-readable emission. The CLI does the resolution and validation; this skill resolves the user's intent into the right form, runs it (preferring `--json`), and formats the result for the handler.

**Pod-local, never federated.** Aliases live in your local registry and sync across **your own pod's** machines — they are filtered out of the publish surface, so a subscriber never sees them. They are per-pod, individual naming. (Mechanically each set/remove appends a convergent `@ALIAS` record to this writer's own append-only shard, HLC-stamped, so re-point and remove converge correctly across your machines — but that is invisible at the skill surface.)

## When to invoke

When the user runs `/lyt-alias [...]`, or says something like:

- "alias `<vault>` as `<name>`" / "give `<mesh>/<vault>` the short name `<name>`" — _set_
- "what aliases do I have" / "list my aliases" / "show my pod-local names" — _list_
- "re-point `<name>` to `<other-vault>`" / "make `<name>` point at `<vault>` instead" — _re-point (same as set)_
- "remove the alias `<name>`" / "drop my `<name>` alias" / "unbind `<name>`" — _remove_

If the user wants to browse what vaults exist (to pick a target), prefer `/lyt-pod`. If they want to search content, prefer `/lyt-search`. This skill only manages the name→vault bindings.

## Phase 1 — Classify the intent

Pick the form from the user's wording:

1. **Set / re-point** — a `name` AND a `target` are present ("alias `ro` to `company/company-ro`"). Re-pointing is the same verb: running `lyt alias <name> <newtarget>` again supersedes the prior binding (the fold is a name-keyed register — no separate "rename" verb, no need to remove first).
2. **List** — no name given, or the user asks to see bindings.
3. **Remove** — the user wants a binding gone.

If the user names a target ambiguously, resolve it the way the CLI will (see Phase 2) rather than guessing.

## Phase 2 — Validate the inputs you control

The CLI enforces these and will error cleanly, but check first so you can ask instead of emitting a failed command:

- **Alias `name`** must be non-empty, contain **no `/`** (slash is reserved for `{mesh}/{vault}`), **no whitespace**, and **must not start with `@`**. The `@` is the chat-surface sigil — an address like `@ro` resolves to the alias `ro`; aliases are stored **raw** (sigil-free), so a leading `@` is rejected at the write boundary. If the user says "alias it as `@ro`", store `ro` and explain `@ro` is how they'll _reference_ it.
- **`target`** (for set) may be a `{mesh}/{vault}` qualified address, a **bare leaf** (unique vault name across meshes), or **another alias**. It is resolved through the addressing chokepoint; if it resolves to nothing the CLI raises `alias-target-not-found` (exit 2). Surface that to the user with `lyt vault list` as the next step — don't retry blindly.

## Phase 3 — Run the verb

Prefer `--json` so you parse a typed result rather than scraping prose.

```bash
# set / re-point
lyt alias <name> <target> --json        # → { alias, vaultRidHex, targetDisplayName }

# list
lyt alias --list --json                  # → { aliases: [{ alias, vaultRidHex, targetDisplayName }] }

# remove
lyt alias --remove <name> --json         # → { removed: <bool>, alias }
```

## Phase 4 — Present the result

- **Set / re-point:** confirm the binding, e.g. _"Aliased `ro` → `company/company-ro` (`vault:0a1b…`). Reference it anywhere as `@ro` or `ro`."_ If it was a re-point, say what it now points at.
- **List:** render one line per alias — `name → targetDisplayName (vault:<ridHex>)`. If `targetDisplayName` is **`(dangling — target removed)`**, flag it: the target vault is gone but the binding lingers — offer `lyt alias --remove <name>`. If there are none, say so and show the set form.
- **Remove:** confirm removal. If `removed` is `false` (no such alias), tell the user plainly — don't claim success.

## Notes on lifecycle

- **Aliases self-clean on vault teardown.** When a vault is removed via `lyt vault delete` / `lyt vault forget`, every pod-local alias pointing at it is **warned about and dropped** as part of that flow — you don't need to pre-remove aliases before deleting a vault. (`lyt vault disconnect` does _not_ drop aliases; it only flips a status flag.)
- **Re-point and remove converge across your pod's machines** by HLC-LWW — the newest set/remove wins per name. After a cross-machine change, a reconstitution (`lyt reindex` / the next sync-driven cache rebuild) refreshes the derived cache; the ledger is the source of truth.

## Rules

- **Never invent a target.** If the user's target doesn't resolve, surface the CLI's `alias-target-not-found` error and point them at `lyt vault list` — do not silently pick a different vault.
- **Strip the `@` sigil before storing.** Store `ro`, never `@ro`. Explain the `@` is for referencing.
- **Don't gate on vault writability.** Aliases are your own pod-local registry; you can alias a read-only or subscribed vault. `requires_writable_vault` is false by design.
- **Prefer `--json`** and report the typed fields; don't paraphrase a binding you didn't read back.
- **Removal/re-point is not destructive to the vault** — it only changes a local name binding. No handler-confirmation gate is required for alias set/list/remove (unlike `vault delete`/`forget`).

## Companion skills

- `/lyt-pod` — enumerate the vaults you might alias (and pick a target).
- `/lyt-search` — query across the pod; resolves `@alias` addresses.
- `/lyt-sync` — propagate alias changes across your pod's machines.
