---
name: lyt-update
description: >
  Keep the installed Lyt current — check whether a newer version is published on the npm alpha channel and, if so, update it. Trigger when the user runs /lyt-update, or says "is my Lyt up to date", "check for lyt updates", "update lyt", "am I on the latest lyt", "upgrade lyt", or similar phrasing. Wraps the `lyt outdated` (read-only check) and `lyt update` (install, confirmation-gated) CLI verbs. Read-only by default; the install step changes the global npm install and always confirms first. Offline / unreachable-registry is reported, never an error. Pairs with /lyt-sync.
visibility: public
lyt-version: 0.11.0
capabilities: [read]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-update

Keep the installed Lyt current. `lyt outdated` reports whether a newer version is published (read-only); `lyt update` installs it, after confirming — it changes the user's **global** npm install, so it is never silent. An unreachable registry (offline / rate-limited) is reported plainly, never treated as an error.

## When to invoke

When the user runs `/lyt-update`, or says something like:

- "is my Lyt up to date" / "am I on the latest lyt"
- "check for lyt updates"
- "update lyt" / "upgrade lyt"

Also invoke **proactively** (offer, don't auto-run) when the handler hits behavior that smells version-related — a verb the docs describe but the CLI doesn't have, or a bug that a newer release may have fixed.

## Phase 1 — Check currency (read-only)

Run the check verb:

```
lyt outdated --json
```

Parse the JSON result: `{ installed, latest, stale, offline, fromCache, checkedAt }`.

- `stale: true` → a newer version (`latest`) is available. Exit code is `1` (npm-`outdated` convention).
- `stale: false`, `offline: false` → up to date. Exit code `0`.
- `offline: true` → the npm registry could not be reached. **Not an error** — tell the handler the check couldn't run (offline / rate-limited) and stop; do not proceed to update.

The check forces a fresh probe (it does not rely on the throttled doctor/init cache).

## Phase 2 — Offer the update (only when stale)

If `stale` is true, surface the finding and OFFER to update — never update without an explicit go:

> Your Lyt is `<installed>`; `<latest>` is published. Want me to update? (`lyt update` runs `npm i -g @younndai/lyt@alpha`.)

On the handler's yes, run:

```
lyt update --yes
```

`lyt update` re-checks currency itself, then installs. Without `--yes` it prompts interactively; with `--yes` it proceeds (still refuses to run when *not* stale). It streams npm's own output and sets a non-zero exit code on failure.

After a successful update, confirm with `lyt --version`.

## Rules

- **MUST NOT run `lyt update` without the handler's explicit go.** It mutates the global install. `lyt outdated` (Phase 1) is always safe to run unprompted.
- **MUST treat `offline: true` as informational, not a failure.** Report that the check couldn't reach the registry and stop; never retry-loop.
- **MUST NOT claim an update happened without confirming** — re-read `lyt --version` (or `lyt outdated`) after `lyt update`, per verify-don't-trust.
- **SHOULD prefer the CLI verbs over a raw `npm i -g`** so the confirmation gate + currency logic stay in one place; only fall back to the raw command if the verbs are unavailable (a very old install).

## Companion skills

- **/lyt-sync** — sync a vault's content. Unrelated to version currency, but the two are the common "keep everything current" pair.
- **/lyt-primer-context** — prime an agent; a good moment to also check currency on a fresh session.
