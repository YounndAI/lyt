---
name: lyt-recall
description: >
  Search a SINGLE Lyt vault using the tiered-cascade engine (`lyt search --vault`) — Tier 0 arcs (0.95) → Tier 1 lanes (0.90) → Tier 2 FTS5 (0.70) (single-vault scope skips Tier 3 edges), with confidence ranking. Trigger when the user runs /lyt-recall <query>, or asks "what did I write about X", "find my notes on X", "recall X from my vault", "remind me what my <topic> notes say", "have I captured anything about X", or similar single-vault recall phrasing. Wraps `lyt search "<query>" --vault <name> --json`. Returns ranked Figments with path, snippet, and confidence. For a pod-wide search across every vault/mesh, use /lyt-search instead. Companion to lyt-capture.
visibility: public
lyt-version: 0.9.8
capabilities: [search]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-recall

Recall content from a **single** Lyt vault using the tiered-cascade search engine. The skill is a thin LLM-driven wrapper around the `lyt search` CLI verb with `--vault` scope; the heavy lifting — arc/lane/FTS5/edge cascade, confidence scoring, deterministic JSON — already lives in the CLI. The skill resolves which one vault to search, invokes `lyt search "<query>" --vault <name> --json`, parses the stable output, and presents ranked results.

`/lyt-recall` is the **single-vault** member of the search pair; `/lyt-search` is the **pod-wide** member (federation/mesh/vault scope). They share one engine — recall just always pins `--vault`.

> **Do NOT use filesystem search.** Never answer a recall with the `Grep`/`rg`/`find`/`Get-ChildItem` tools, or by walking the vault directory yourself. The vault's libSQL FTS5 index (whole-vault since 0.9.7, not just `notes/`) is the source of truth, and `lyt search` is the only sanctioned access path. Filesystem grep bypasses the engine's ranking, tier provenance, and confidence scoring, and misses index-only signal. Read a specific file directly ONLY after `lyt search` has returned it as a hit (to quote it in full), or when the user gives an explicit path.

## When to invoke

When the user runs `/lyt-recall <query>`, or says something like:

- "what did I write about <topic>" — _single-vault case; if the user's pod has multiple vaults and they want all of them, prefer `/lyt-search`_
- "find my notes on <topic>"
- "recall <topic> from my vault"
- "remind me what my <topic> notes say"
- "have I captured anything about <topic>"

If the user's question depends on prior captured knowledge, invoke this skill proactively — don't fabricate; check the vault first.

## Phase 1 — Resolve the single target vault

Recall always searches exactly one vault. Resolve which one, in order:

1. **Explicit `--vault <name>` arg** the user supplied.
2. **`$LYT_ACTIVE_VAULT`** env var, if set.
3. **cwd-based detection** via `lyt vault info --by-path <cwd> --json` — if the cwd is inside a registered vault, use it.
4. **Sole vault** — run `lyt vault list --json`; if the pod has exactly one active vault, use it.
5. **Ambiguous** (multiple vaults, no signal) — surface the vault names from `lyt vault list --json` and ask which one, or suggest `/lyt-search` for a pod-wide search. Do NOT guess.

**Resolve + sanitize the name before passing it.** Match the user's term to a listed vault name (exact, then case-insensitive, then prefix). **Reject any resolved name that begins with `-` or `--`** before passing it to `--vault <name>` — closes the flag-injection surface (same defense as `/lyt-search` Phase 1 and `/lyt-sync` Phase 1). If no match, list the available names and stop — do not invent a name.

## Phase 2 — Invoke the CLI verb

Run the verb via the Bash tool (or your runtime's shell equivalent). **Pass the query as a single quoted argv argument; never shell-compose the command** — the query CAN contain shell metacharacters (backticks, `$()`, `;`, `&&`), which MUST travel as one argv element, not template-interpolated into a shell string.

```
# Shell-syntax (DOCUMENTATION ONLY — do NOT compose this as a string):
lyt search "<user-query>" --vault <name> --json [--limit <n>]

# Actual exec shape (argv array; cross-platform-safe):
spawnSync("lyt", ["search", userQuery, "--vault", vaultName, "--json"]);
```

Key rules:

- The first positional argument is the query — a single string. Multi-word queries are implicit AND. Quote it so the shell treats it as one argv element.
- `--vault <name>` is **mandatory for recall** (that is what makes this single-vault). Never run bare `lyt search` from this skill (that searches the whole pod — that's `/lyt-search`'s job).
- `--json` is **mandatory**. It yields the deterministic, stable key-ordered output parsed below.
- `--limit <n>` defaults to 20 (CLI default), capped at 1000. Apply a caller cap only on explicit signal ("top 5"); else rely on the default.

## Phase 3 — Parse the JSON output

The CLI emits stable, deterministically key-ordered JSON on stdout (exit 0 on success). Expected shape (scope = `vault`):

```json
{
  "query": "<the query>",
  "scope": "vault",
  "scopeTarget": "<vault-name>",
  "limit": 20,
  "results": [
    {
      "confidence": 0.70,
      "tier": 2,
      "vault_name": "<vault>",
      "mesh_name": "<mesh>",
      "figment_path": "<relative/path.md>",
      "snippet": "<snippet with <mark>…</mark> highlights>"
    }
  ],
  "trace": { "tiersRun": [0, 1, 2], "perTierHitCount": [0, 0, 4, 0], "vaultsSearched": ["<vault>"] },
  "durationMs": 41
}
```

Failure modes (CLI emits to stderr; exit non-zero):

- **Empty query** (exit 1) → `{ "error": "empty-query", "message": "..." }`. Surface verbatim; ask the user to refine.
- **Invalid limit** (exit 1) → `{ "error": "invalid-limit", ... }`. Re-invoke with the CLI default.
- **Cascade error** (exit 2) → `{ "error": "cascade-error", "message": "..." }`. Surface verbatim. Only if `lyt search` itself fails this way may you fall back to reading files directly — and you MUST label the answer as a fallback, not engine-ranked.

## Phase 4 — Present results

Order by descending confidence (the CLI emits them ranked). One line per result. Show each as `[<confidence>] <figment_path> — <snippet>`; strip the `<mark>…</mark>` tags or render them as emphasis; truncate snippets to ~80 characters.

Format:

> **Found N matches for `"<query>"` in `<vault-name>` (<durationMs>ms):**
>
> - `[0.95]` `writing/publication-voice.md` — _…the voice inside it is mine. I write jazz…_
> - `[0.70]` `writing/voice-guides.md` — _…copy-paste prompts for authorship-voice and publication-voice…_

On **empty results**: surface _"No matches for `"<query>"` in `<vault-name>`."_ and offer to widen with `/lyt-search` (pod-wide) or try a broader term. If you expected a hit, the vault's FTS index may be stale — suggest rebuilding it with `lyt vault rebuild-index <vault-name>` (or `lyt reindex`), then re-running the recall.

To quote a hit in full, read the returned `figment_path` directly **after** the engine has surfaced it (that is sanctioned — it's reading a known source, not discovery-by-grep).

## Rules

- **MUST search via `lyt search "<query>" --vault <name> --json`.** MUST NOT discover content with `Grep`/`rg`/`find`/`Get-ChildItem` or by walking the vault tree. Filesystem grep is only an explicit, labeled fallback after a `cascade-error`.
- **MUST pass the query as a single quoted argv argument**, not interpolated into a shell string.
- **MUST pass `--vault <name>` and `--json`** on every invocation. Bare `lyt search` (pod-wide) is `/lyt-search`, not this skill.
- **MUST resolve + sanitize the vault name** via `lyt vault list --json`; reject any `--`-leading name; never guess a name.
- **MUST NOT widen scope silently.** If the named vault is missing, surface the miss and stop — do not fall back to a pod-wide search without the user.
- **MUST NOT modify or write any vault file.** Read-only (`requires_writable_vault: false`). To persist results to a Figment, run `/lyt-capture` on the formatted output.
- **MUST NOT re-interpret confidence tiers.** Display the CLI's confidence verbatim (`0.95 / 0.90 / 0.70` — the Tier-3 `0.50` only appears in pod/mesh scope, never single-vault); do not round or invent a derived score.

## Companion skills

- **`/lyt-search`** — the pod-wide sibling (federation/mesh/vault scope) using the same cascade engine. Use it when the user wants every vault, a whole mesh, or hasn't pinned a single vault.
- **`/lyt-capture`** — write a Figment. Pair with `/lyt-recall` to persist what you found.
