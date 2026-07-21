---
name: lyt-update
description: >
  Keep installed Lyt current on its configured alpha or latest channel. Trigger on /lyt-update, "is my Lyt up to date", "check for Lyt updates", "update Lyt", or "switch update channel". Uses `lyt outdated`, confirmation-gated `lyt update`, and the authoritative new-binary `lyt install reconcile`. Never substitutes raw npm or silently downgrades.
visibility: public
skill-version: 1.0.0
requires-lyt: ">=0.20.0 <0.21.0"
contract-version: 1.0.0
lyt-version: 0.11.0
capabilities: [read]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-update

Keep installed Lyt current on its configured `alpha` or `latest` channel. `lyt outdated --json` is read-only. `lyt update` changes the global install only after Handler confirmation, stages a sealed update operation, then launches the new binary to reconcile managed skills and manuals.

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

Consume the emitted channel, installed/candidate versions, stale/offline status, refusal code, and `next_action`. If no channel is configured, stop and ask the Handler to choose `alpha` or `latest`; never guess.

- `stale: true` → a newer version on the selected channel is available. Exit code is `1` (npm-`outdated` convention).
- `stale: false`, `offline: false` → up to date. Exit code `0`.
- `offline: true` → the npm registry could not be reached. **Not an error** — tell the handler the check couldn't run (offline / rate-limited) and stop; do not proceed to update.

The check forces a fresh probe (it does not rely on the throttled doctor/init cache).

## Phase 2 — Offer the update (only when stale)

If `stale` is true, surface the finding and OFFER to update — never update without an explicit go:

> Your Lyt is `<installed>` on `<channel>`; `<candidate>` is published. Want me to update?

On the handler's yes, run:

```
lyt update --yes --json
```

`lyt update` re-checks currency itself, then installs. Without `--yes` it prompts interactively; with `--yes` it proceeds (still refuses to run when _not_ stale). It streams npm's own output and sets a non-zero exit code on failure.

After replacement, consume the update result and automatic new-binary reconciliation Receipt. If it is incomplete, run only its emitted resume command; otherwise do not rerun reconciliation. Then run `lyt doctor --json` and start a fresh agent session before relying on refreshed managed guidance. Confirm the installed version and configured channel; never claim success from npm output alone.

## Rules

- **MUST NOT run `lyt update` without the handler's explicit go.** It mutates the global install. `lyt outdated` (Phase 1) is always safe to run unprompted.
- **MUST treat `offline: true` as informational, not a failure.** Report that the check couldn't reach the registry and stop; never retry-loop.
- **MUST NOT claim an update happened without confirming** — re-read `lyt --version` (or `lyt outdated`) after `lyt update`, per verify-don't-trust.
- **MUST NOT silently downgrade or switch channels.** Surface the refusal and corrective `next_action`.
- **MUST use Lyt CLI verbs, not raw npm.** A very old install is a troubleshooting case, not an invitation to invent an update procedure.

## Companion skills

- **/lyt-sync** — sync a vault's content. Unrelated to version currency, but the two are the common "keep everything current" pair.
- **/lyt-primer-context** — prime an agent; a good moment to also check currency on a fresh session.
