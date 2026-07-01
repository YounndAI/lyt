---
name: lyt-search
description: >
  Search a Lyt pod (or a single mesh or vault) using the tiered-cascade engine — Tier 0 arcs (0.95) → Tier 1 lanes (0.90) → Tier 2 FTS5 (0.70) → Tier 3 edges (0.50) — with confidence ranking. Trigger when the user runs /lyt-search <query>, or says "search my pod for X", "find anything about X across my vaults", "search across all meshes for X", "what's in my pod about X", or similar phrasing on a query wider than a single vault. Wraps the `lyt search` CLI verb — federation scope by default; --vault / --mesh narrow scope; --limit caps results. Returns ranked Figments with vault, mesh, snippet, and confidence. Companion to lyt-recall (single-vault scope) for narrower local searches.
visibility: public
lyt-version: 0.5.0
capabilities: [search]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-search

Search a Lyt **pod** (default: every vault across every mesh) using the tiered-cascade engine. The skill is a thin LLM-driven wrapper around the `lyt search` CLI verb; the heavy lifting — arc/lane/FTS5/edge cascade, confidence scoring, deterministic JSON emission — already lives in the CLI. The skill resolves the user's intent (query string + scope), invokes the verb with `--json`, parses the stable, deterministically key-ordered output, and presents ranked results to the handler.

## When to invoke

When the user runs `/lyt-search <query>`, or says something like:

- "search my pod for <topic>"
- "search across all my vaults for <topic>"
- "find anything about <topic>"
- "what's in my pod about <topic>"
- "what did I write about <topic>" — _if the user's pod has multiple vaults_; for single-vault recall, prefer `/lyt-recall`
- "search the `<mesh-name>` mesh for <topic>"
- "search vault `<vault-name>` for <topic>"

If the user's question depends on prior captured knowledge across multiple vaults, invoke this skill proactively — don't fabricate; check the pod first.

**Disambiguator vs `/lyt-pod`.** A **content query with a topic** ("what's in my pod **about X**", "...about `<topic>`", "find anything on `<topic>`") → `/lyt-search` (this skill — queries figment content). A bare **inventory** request ("what's in my pod", "list my vaults", "what meshes do I have") → `/lyt-pod` (enumerates the pod's structure, no content query). The split is content-vs-structure: if the user names a subject they want found, this is the right skill; if they want a survey of what exists, route to `/lyt-pod`.

## Phase 1 — Determine scope from user signal

The CLI verb supports three mutually-exclusive scope flags; the default (no flag) is federation. Pick by the user's wording:

- **Default — federation (entire pod, every vault across every mesh).** No scope flag. Use when the user says "my pod", "all my vaults", "everywhere", "across all meshes", or omits scope entirely. Invocation: `lyt search "<query>" --json`.
- **Single mesh.** Use `--mesh <name>` when the user says "in mesh `<name>`", "across the `<name>` mesh", "in my `<name>` mesh". Invocation: `lyt search "<query>" --mesh <name> --json`.
- **Single vault.** Use `--vault <name>` when the user says "in vault `<name>`", "in my `<name>` vault". Invocation: `lyt search "<query>" --vault <name> --json`.

**Resolve names before passing them.** Don't guess at mesh/vault names — when the user names one:

1. Run `lyt vault list --json` (vaults) or `lyt mesh list --json` (meshes) first.
2. Match the user's term to the listed names (exact, then case-insensitive, then prefix).
3. **Reject any resolved name that begins with `-` or `--`** before passing it to `--vault <name>` / `--mesh <name>` — closes the flag-injection surface the same way lyt-sync does at its Phase 1 (the gh-flag-injection defense family). Vault names are user-controlled at vault-init time; a vault literally named `--evil` would otherwise smuggle a flag-shaped token into the verb's argv.
4. If no match (or the only match is `--`-leading), tell the user the available names and stop — do not invent a name.

Do **NOT** pass `--all` as an explicit flag — it's an alias for the default scope. Bare `lyt search` already searches federation; adding `--all` is redundant.

## Phase 2 — Invoke the CLI verb

Run the verb via the Bash tool (or your runtime's shell equivalent). **Pass the query as a single quoted argv argument; never shell-compose the command.** This matters because the user's query CAN contain shell metacharacters (backticks, `$()`, `;`, `&&`) — those MUST be conveyed as one argv element, not template-interpolated into a shell string.

```
# Shell-syntax (DOCUMENTATION ONLY — do NOT compose this as a string):
lyt search "<user-query>" --json [--vault <name> | --mesh <name>] [--limit <n>]

# Actual exec shape (argv array; cross-platform-safe):
spawnSync("lyt", ["search", userQuery, "--json", "--vault", vaultName]);
# or with no scope flag (federation default):
spawnSync("lyt", ["search", userQuery, "--json"]);
```

The Bash-tool variant: pass the argv array form to the tool's `args` field if the runtime exposes one; if the runtime only accepts a single shell-string, the LLM is responsible for shell-quoting `userQuery` correctly (this is the failure mode argv mode prevents). Precedent: lyt-sync's Phase 3 commits via `spawnSync("git", [..., "-m", message])` for the same reason.

Key rules:

- The first positional argument is the query — a single string. Multi-word queries are implicit AND. Quote the query so the shell treats it as one argv element.
- `--json` is **mandatory** for this skill. It yields the deterministic, stable key-ordered output the skill parses below; without it, the CLI prints human-readable lines that the skill can't reliably parse.
- `--limit <n>` defaults to 20 (CLI default), capped at 1000. Apply caller's `--limit` only when the user explicitly signals a cap ("top 5 results", "first 10"); otherwise rely on the CLI default.
- Never combine `--vault` AND `--mesh` — the CLI rejects it with `error: "conflicting-scope-flags"` and exits 1.

## Phase 3 — Parse the JSON output

The CLI emits stable, deterministically key-ordered JSON on stdout (exit 0 on success). Expected shape:

```json
{
  "query": "<the query>",
  "scope": "federation" | "mesh" | "vault",
  "scopeTarget": "<name>" | null,
  "limit": 20,
  "results": [
    {
      "confidence": 0.95,
      "tier": 0,
      "vault_name": "<vault>",
      "mesh_name": "<mesh>",
      "figment_path": "<relative/path.md>",
      "snippet": "<≤80-char snippet>"
    }
  ],
  "trace": {
    "tiersRun": [0, 1, 2, 3],
    "perTierHitCount": { "0": 1, "1": 3, "2": 12, "3": 4 },
    "vaultsSearched": ["<vault1>", "<vault2>"]
  },
  "durationMs": 47
}
```

Failure modes (CLI emits to stderr; exit non-zero):

- **Empty query** (exit 1) → `{ "error": "empty-query", "message": "..." }`. Surface the message verbatim and ask the user to refine.
- **Conflicting scope flags** (exit 1) → `{ "error": "conflicting-scope-flags", "flags": [...], "message": "..." }`. Skill-level bug if hit — Phase 1 should have prevented it; surface and stop.
- **Invalid limit** (exit 1) → `{ "error": "invalid-limit", "value": "<bad>", "message": "..." }`. Re-invoke with the CLI default.
- **Cascade error** (exit 2) → `{ "error": "cascade-error", "message": "..." }`. Surface verbatim; suggest re-running with narrower scope.

## Phase 4 — Format results for the handler

Group by mesh, then by vault within mesh. Order results within each vault by descending confidence (the CLI emits them ranked already). One line per result.

The CLI emits each result with TWO ranking fields — `confidence` (the float: 0.95/0.90/0.70/0.50) and `tier` (the int: 0/1/2/3, where 0=arcs, 1=lanes, 2=FTS5, 3=edges). The two are isomorphic (one tier-int maps to one canonical confidence), so the handler-facing display shows `confidence` only (it's the more readable signal). The `tier` field stays in the JSON for callers that need to filter by tier source; the skill does not surface it in the one-line format.

Format:

> **Found N matches for `"<query>"` (scope=federation, <durationMs>ms · tiers: <tier counts>):**
>
> **Mesh: `<mesh1>`**
>
> - `[0.95]` `<vault1>/notes/2026-05-24-q4-planning.md` — _the auth rewrite is a P0 for Q4..._
> - `[0.70]` `<vault1>/notes/2026-05-23-auth-decisions.md` — _moving to OAuth, deprecating session tokens..._
>
> **Mesh: `<mesh2>`**
>
> - `[0.50]` `<vault2>/notes/2026-05-22-stand-up.md` — _...session tokens flagged by legal..._

Show each result as `[<confidence>] <vault>/<figment_path> — <snippet>`. Truncate snippets to ~80 characters with an ellipsis. The top-of-output tier-hit summary uses the CLI's `trace.perTierHitCount` map (`{0:N, 1:M, 2:K, 3:L}`) so the handler sees confidence distribution at a glance.

On **empty results**: surface _"No matches for `"<query>"` across <scope>."_ and offer scope-widening hints (`--mesh` → federation; `--vault` → `--mesh`). If a vault that should contain the figment still returns nothing, its FTS index may be stale — suggest rebuilding it with `lyt vault rebuild-index <name>` (or `lyt reindex` across the pod), then re-running the search.

## Phase 5 — Concept-search discovery nudge (only when `trace.nudge.eligible` is true)

The `--json` output may carry a `trace.nudge` block. It is the signal for a one-time offer to enable **concept search** — finding notes by meaning, not just keywords. Read it; only voice the offer when it explicitly says to.

```json
"trace": {
  "nudge": {
    "eligible": true,
    "state": "not-yet-asked",
    "reason": null,
    "declines": 0,
    "daysSince": null,
    "searchesSince": 1
  }
}
```

- **`eligible: true`** → voice the offer once (see below). A null `reason` confirms it.
- **`eligible: false`** → say nothing about it. The `reason` explains why (`model-present` = already set up; `disabled` = the user chose never to be asked; `auto-quiet` = declined enough times; `cadence` = asked recently). Never override an ineligible verdict.
- **`trace.nudge` absent** → nothing to do; proceed normally.

### Voicing the offer (only when eligible)

Relay it to the user in plain language, **framed as a benefit to them — never "to help improve Lyt"**:

> _"I can also search your notes by meaning, not just keywords. It needs a one-time local setup (nothing leaves your machine). Want me to set it up?"_

Then **capture an explicit yes or no** before doing anything else.

### Response-capture contract — map the reply to exactly one verb

| User reply | Do |
|---|---|
| **Yes** (set it up) | `lyt model fetch` — runs the one-time local setup and marks the offer resolved. |
| **No** (explicit decline) | `lyt model nudge --decline` — records ONE decline (three declines → auto-quiet). |
| **"Never ask again"** | `lyt model nudge --never` — turns the offer off permanently. |
| **Surfaced / bookkeeping only** | `lyt model nudge --asked` — records that the offer was shown (stamps the ask, resets the cadence counter) when you voiced it without yet capturing a yes/no. |

- **A non-response is NOT a decline.** If the user doesn't answer the offer, record nothing — do not run `nudge --decline`. Only an explicit "no" counts as a decline.
- **Inspect anytime** with `lyt model nudge --status` (read-only; prints the current offer-state).
- Honor a `disabled` / `auto-quiet` state — once the user has opted out, never re-raise the offer.

## Rules

- **MUST pass the user's query as a single quoted argv argument**, not template-interpolated into a shell command string. Filenames or queries containing shell metacharacters (`` ` ``, `$(...)`, `;`, `&&`) inside the query MUST be safely conveyed as argv.
- **MUST pass `--json`** on every invocation. Human-readable output is not a contract this skill parses.
- **MUST resolve mesh/vault names via `lyt vault list --json` or `lyt mesh list --json` before passing `--vault` or `--mesh`.** Do not guess names.
- **MUST NOT pass `--all` explicitly.** Federation is the default; `--all` is a redundant alias. Use no scope flag instead.
- **MUST NOT combine `--vault` and `--mesh`.** The CLI exits 1 with `conflicting-scope-flags`.
- **`--no-self-heal` is a no-op under `--json`** — the empty-result self-heal (reindex stale vaults + re-query on 0 hits) is auto-disabled whenever `--json` is set, so passing `--no-self-heal` alongside the mandatory `--json` changes nothing. (`--no-semantic`, which forces the pure lexical cascade, is NOT auto-disabled under `--json` — pass it explicitly if you need to suppress dense-embedding fusion.)
- **MUST NOT re-interpret confidence tiers.** The CLI emits them as `0.95 / 0.90 / 0.70 / 0.50` per Tier 0/1/2/3 spec. Display verbatim; do not "smooth" or "round" or invent a derived score.
- **MUST NOT modify or write any vault file.** This is a read-only skill (`requires_writable_vault: false`). If the user wants results persisted to a Figment, run `/lyt-capture` separately on the formatted output.
- **MUST NOT widen scope without user signal.** If the user said "in my work vault", do not silently fall back to federation when the named vault is missing — surface the miss and stop.
- **MUST voice the concept-search offer ONLY when `trace.nudge.eligible` is true**, and MUST capture an explicit yes/no before acting. A non-response records nothing — never run `lyt model nudge --decline` on silence. Honor a `disabled` / `auto-quiet` state and never re-raise.

## Companion skills

- **`/lyt-recall`** — single-vault recall. Use when the user has only one vault in mind; same tiered-cascade engine as `/lyt-search`, pinned to `--vault` scope.
- **`/lyt-sync`** — pull-then-push a vault. Run before `/lyt-search` if the user has unpushed local edits and wants the FTS5 index reflect them (the cascade reads the local vault's libSQL state).
- **`/lyt-capture`** — write a Figment. Pair with `/lyt-search` if the user wants the recall results persisted.
