---
name: lyt-primer-context
description: >
  Prime an agent with Lyt-scoped context — for a vault, a mesh, or the whole pod — by composing `lyt primer` (top keywords + active arcs + recent activity + top lanes) and `lyt vault info --json` (writable status for vault-scope). Trigger when the user runs /lyt-primer-context, or says "prime me for X", "give me context on this vault", "what's been happening in my pod lately", "what arcs are active in mesh Y", "give the agent context before X", or similar phrasing on a scope they want surfaced for agent priming. Wraps `lyt primer` (v1.D.4) + `lyt vault info --json` (v1.G.2 6-reason writable contract) — composes both into an agent-facing summary. Read-only; pairs with /lyt-search (query-driven recall) and /lyt-capture (write).
visibility: public
lyt-version: 0.6.0
capabilities: [read]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-primer-context

Prime an agent with Lyt-scoped context for a **vault**, a **mesh**, or the whole **pod** by composing two CLI verbs:

1. `lyt primer --scope <vault|mesh|federation> [--target <name>] --json --dry-run` (shipped v1.D.4) — aggregates top keywords, active arcs, recent activity, and top lanes across the scope into a Lock 0.3 stable-key-ordered JSON payload (including the full primer markdown body).
2. `lyt vault info <name> --json` (shipped v1.G.2; 6-reason writable contract) — only for vault-scope priming, fetches `writable` + `writableDetermination` so the skill can surface a capability hint to the agent ("you can /lyt-capture here" vs reason-specific guidance).

The skill is pure prose around two existing CLI verbs — there is no new CLI verb, no new helper, no lyt-vault change. The skill READS; it does not write (except the CLI's atomic primer-file write on non-dry-run, which is opt-in per Phase 2 the ratified default).

## When to invoke

When the user runs `/lyt-primer-context`, or says something like:

- "prime me for `<vault|mesh|pod-scoped task>`"
- "give me context on this vault"
- "what's been happening in my pod lately"
- "what arcs are active in mesh `<name>`"
- "give the agent context before `<task>`"
- "prime the agent for working in `<vault>`"
- "what's the current state of my `<mesh>` mesh"

Invoke this skill **proactively** before a knowledge-work task whenever the agent needs scope-wide situational awareness (recent activity, dominant themes, in-progress arcs). Don't bypass it and start fabricating context.

## Phase 1 — Determine scope + target from user signal

The `lyt primer` verb requires `--scope` and rejects ambiguity. Pick by the user's wording (default is federation when no scope signal):

- **Default — federation (entire pod, every vault across every mesh).** Use when the user says "my pod", "all my vaults", "across everything", or omits scope entirely. Invocation: `lyt primer --scope federation --json --dry-run` (no `--target`; CLI ignores it for federation scope).
- **Single mesh.** Use `--scope mesh --target <name>` when the user says "in mesh `<name>`", "for the `<name>` mesh", "across my `<name>` mesh".
- **Single vault.** Use `--scope vault --target <name>` when the user says "in vault `<name>`", "for my `<name>` vault", "for this vault". For "this vault", resolve from the env-default chain (mirrors lyt-sync Phase 1): `$LYT_ACTIVE_VAULT` env var, then `~/lyt/vaults/<handle>/main/` convention, then ask the user — do not guess from cwd.

**Resolve names before passing them.** Don't guess at mesh/vault names — when the user names one:

1. Run `lyt vault list --json` (vaults) or `lyt mesh list --json` (meshes) first. `lyt mesh list` is the canonical mesh-enumeration verb (per `packages/lyt-vault/src/commands/mesh.ts:32`); both verbs emit Lock 0.3 stable-key-ordered JSON on `--json`.
2. Match the user's term to the listed names (exact, then case-insensitive, then prefix).
3. **Reject any resolved name that begins with `-` or `--`** before passing it to `--target <name>` — closes the flag-injection surface the same way lyt-sync (Phase 1) and lyt-search (Phase 1) do (family: G.2 CR-1 gh-flag-injection). Vault and mesh names are user-controlled at vault-init / mesh-create time; a vault literally named `--evil` would otherwise smuggle a flag-shaped token into the verb's argv.
4. If no match (or the only match is `--`-leading), tell the user the available names and stop — do not invent a name.

The `--scope federation` invocation MUST NOT pass `--target` — the CLI ignores it for federation scope but it's noise; only pass `--target` for vault/mesh scopes.

## Phase 2 — Invoke `lyt primer`

Run the verb via the Bash tool (or your runtime's shell equivalent). **Pass scope and target as separate argv arguments; never shell-compose the command.** The matching precedent is lyt-search's Phase 2 (`spawnSync("lyt", ["search", userQuery, "--json"])`) and lyt-sync's Phase 3 (`spawnSync("git", ["-C", vaultPath, "commit", "-m", message])`) — argv-array shape, cross-platform-safe.

```
# Shell-syntax (DOCUMENTATION ONLY — do NOT compose this as a string):
lyt primer --scope <scope> [--target <name>] --json --dry-run

# Actual exec shape (argv array; cross-platform-safe):
spawnSync("lyt", ["primer", "--scope", scope, "--target", target, "--json", "--dry-run"]);
# or for federation scope (no --target):
spawnSync("lyt", ["primer", "--scope", "federation", "--json", "--dry-run"]);
```

Key rules:

- `--scope` is **mandatory** (CLI rejects with `error: "invalid-scope"`, exit 1, if missing or unrecognised). The skill always passes one; default to `federation` when no user signal.
- `--target <name>` is **required** for `--scope vault` and `--scope mesh`; **omitted** for `--scope federation`. CLI rejects missing target with `error: "missing-target"`, exit 1.
- `--json` is **mandatory** for this skill. Without it, the CLI prints human-readable output that the skill can't reliably parse.
- `--dry-run` is the **default for this skill** (ratified default). The CLI's non-dry-run mode atomically writes the primer markdown to `<vault>/.lyt/primers/{scope}-primer.md`; the skill READS the result for agent priming and does not need that persisted file as a side-effect of every invocation. Pass `--dry-run` unless the user explicitly asks to regenerate the on-disk primer ("refresh the primer file", "regenerate the on-disk primer" — then omit `--dry-run`).
- `--top-keywords <n>`, `--top-arcs <n>`, `--provenance-days <n>` are advanced flags. Apply only when the user explicitly signals a cap ("top 50 keywords", "last 30 days of activity"); otherwise rely on CLI defaults (20 / 10 / 7).

## Phase 3 — Parse the JSON output

The CLI emits Lock 0.3 stable-key-ordered JSON on stdout (exit 0 on success). The actual emitted shape (per `packages/lyt/src/commands/primer.ts:174-215`):

```json
{
  "scope": "vault" | "mesh" | "federation",
  "scopeTarget": "<name>" | null,
  "primerPath": "<vault>/.lyt/primers/<scope>-primer.md" | null,
  "dryRun": true | false,
  "vaultsScanned": ["<vault1>", "<vault2>"],
  "topKeywords": [
    { "keyword": "<term>", "score": 0.92, "totalMemCount": 12, "lastSeen": "ISO8601" }
  ],
  "topArcs": [
    {
      "name": "<arc-name>",
      "category": "<category>",
      "lastTouched": "ISO8601",
      "vaultName": "<vault>",
      "memberCount": 7
    }
  ],
  "recentActivity": [
    {
      "ts": 1717200000,
      "tsIso": "ISO8601",
      "targetType": "<kind>",
      "targetId": "<rid-or-id>",
      "src": "<source>",
      "vaultName": "<vault>",
      "idHex": "<rid-hex>"
    }
  ],
  "topLanes": [
    { "name": "<lane-name>", "keywords": ["<kw1>", "<kw2>"], "memCount": 5, "vaultName": "<vault>" }
  ],
  "markdown": "<full primer markdown body — what would be written to .lyt/primers/{scope}-primer.md>",
  "durationMs": 47
}
```

On `--dry-run`: `primerPath` is the path the CLI WOULD write to (not null — it's pre-computed), but no file is written. `dryRun: true` confirms this. On non-dry-run: `dryRun: false` and the file at `primerPath` is freshly written (atomic).

Failure modes (CLI emits to stderr; exit non-zero):

- **Invalid scope** (exit 1) → `{ "error": "invalid-scope", "value": "<bad>", "message": "..." }`. Skill-level bug if hit — Phase 1 should have prevented it; surface the message and stop.
- **Missing target** (exit 1) → `{ "error": "missing-target", "scope": "<vault|mesh>", "message": "..." }`. Skill-level bug — Phase 1 should have resolved a name; surface and stop.
- **Invalid `--top-keywords` / `--top-arcs` / `--provenance-days`** (exit 1) → `{ "error": "invalid-<flag>", "value": "<bad>", "message": "..." }`. Re-invoke with CLI defaults.
- **Underlying flow throws** (exit 2) → `{ "error": "primer-generate-error", "message": "..." }`. Surface verbatim; suggest a narrower scope.

## Phase 4 — Fetch writable status (vault-scope ONLY)

**Skip this phase for `--scope mesh` and `--scope federation`** — those scopes span multiple vaults and there's no single writable status to surface (per the ratified default). For mesh/federation, jump to Phase 5 and present the primer summary alone. The agent can re-invoke `/lyt-primer-context` per-vault with `--scope vault --target <name>` if it needs write-action guidance for a specific vault.

For `--scope vault --target <name>`, invoke `lyt vault info <name> --json` via Bash (argv-array form):

```
# Shell-syntax (DOCUMENTATION ONLY):
lyt vault info <name> --json

# Actual exec shape:
# `vaultName` MUST be the same Phase-1-resolved name (already passed through
# the `--`-leading rejection check); do not re-resolve from a different source
# at Phase 4, or the flag-injection defense is dropped.
spawnSync("lyt", ["vault", "info", vaultName, "--json"]);
```

Parse the `vault.writable` + `vault.writableDetermination` fields per the v1.G.2 read-only-awareness contract (see `packages/lyt-vault/src/flows/writability.ts:42-48`). The verdict is tri-state (`true | false | "unknown"`); the determination is one of **6 reasons** the skill must branch on explicitly in Phase 5.

## Phase 5 — Synthesize agent-facing context

Render the agent-priming output as a markdown block. Layout:

```
# Primer for <scope>: <target-or-pod>

**Top keywords:** <keyword1> (<score1>) · <keyword2> (<score2>) · … · <keywordN> (<scoreN>)

**Active arcs (top-N):**
- <arc-name> · <category> · last touched <ISO> · vault <vault> · <memberCount> members
- …

**Active lanes (top-N):**
- <lane-name> · keywords [<kw1>, <kw2>] · <memCount> members · vault <vault>
- …

**Recent activity (last N days):**
- <tsIso> — <targetType> in <vaultName>: <targetId>
- …

**Capability hint (vault-scope only):**
<one of the 6 reason-specific messages — see the table below>

**Primer markdown** (full body, truncated to ≤200 lines with ellipsis if longer):
<markdown payload from CLI>
```

### Capability hint — 6-reason writable contract (vault-scope only)

For vault-scope invocations, surface a reason-specific capability hint based on `writable` + `writableDetermination`. The actual reason strings emitted by `vault info --json` (per `packages/lyt-vault/src/flows/writability.ts`) are listed in the **emitted name** column. The **semantic name** column gives the human-readable synonym some briefs use; the SKILL.md handler-facing prose uses the semantic name, but the comparison MUST be against the emitted name.

| Emitted name (writableDetermination) | Semantic name               | writable    | Phase 5 capability hint                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh-viewerCanPush-true`              | **home-pushable-true**      | `true`      | ✓ This vault is yours and pushable — you can `/lyt-capture` here.                                                                                                                                                                                 |
| `gh-viewerCanPush-false`             | **home-not-pushable-false** | `false`     | ⚠ This vault is yours but you lack push permission. Request write access from the owner, or capture into a vault you own.                                                                                                                         |
| `subscriber-default-false`           | (subscriber)                | `false`     | ⚠ This is a subscriber vault — pull-only. Capture into your home vault instead.                                                                                                                                                                   |
| `gh-unavailable`                     | (gh-offline)                | `"unknown"` | ⚠ Writable status unknown — gh CLI offline / rate-limited. Re-check when network is available.                                                                                                                                                    |
| `no-remote`                          | (no-remote)                 | `"unknown"` | ⚠ Writable status unknown — vault has no git remote configured. Configure with `gh repo create` or `git remote add origin <url>`.                                                                                                                 |
| `orphan-vault`                       | (orphan)                    | `"unknown"` | ⚠ Writable status unknown — vault has no mesh role (orphan). Heal: `lyt repair --apply` (fixes the adopt mesh-link drift, no args needed); a truly un-adopted vault: `lyt repair --target <vault> --apply --mesh <mesh>`. `lyt doctor` diagnoses. |

**Note on emitted vs semantic names.** The brief that authored this skill (v1.G.7 handoff) lists `home-pushable-true` / `home-not-pushable-false` as semantic aliases for the first two reasons. The actual strings emitted by `writability.ts` are `gh-viewerCanPush-true` / `gh-viewerCanPush-false`. The semantic names are kept here as documentation aliases so future renames of the underlying enum (e.g. when the gh-probe naming hardens in v1.G.2.1) don't silently break the skill prose. The 4 unchanged reason strings (`subscriber-default-false`, `gh-unavailable`, `no-remote`, `orphan-vault`) match in both surfaces. **Comparison code MUST use the emitted name; handler-facing prose uses either.**

## Rules

- **MUST pass `--scope`, `--target` (if applicable), and `--json` as separate argv arguments**, not template-interpolated into a shell command string. Mesh/vault names CAN contain shell metacharacters (backticks, `$()`, `;`, `&&`) — those MUST be conveyed as one argv element per name.
- **MUST pass `--json`** on every invocation. Human-readable output is not a contract this skill parses.
- **MUST pass `--dry-run`** UNLESS the user explicitly asks to regenerate the on-disk primer file (the ratified default counter-case). Otherwise every priming call pollutes `<vault>/.lyt/primers/`.
- **MUST resolve mesh/vault names via `lyt vault list --json` or `lyt mesh list --json` before passing `--target`.** Do not guess names.
- **MUST reject `--`-leading names** from `lyt vault list --json` / `lyt mesh list --json` results before passing them to `--target` (G.6 inherited defense; family: G.2 CR-1 gh-flag-injection).
- **MUST branch on all 6 writable reasons in Phase 5 (vault-scope).** Each has a distinct capability hint; collapsing them into a generic "can't write" message loses semantic signal the agent needs to recover.
- **MUST NOT call `lyt primer` without `--scope`.** The CLI rejects with `error: "invalid-scope"`, exit 1.
- **MUST NOT call `lyt primer` with `--scope vault` or `--scope mesh` without `--target`.** The CLI rejects with `error: "missing-target"`, exit 1.
- **MUST NOT call `lyt vault info` for `--scope mesh` or `--scope federation`.** Phase 4 is skipped for those scopes (the ratified default); the primer summary alone is the output.
- **MUST NOT modify or write any file.** This is a read-only skill (`requires_writable_vault: false`). The CLI's atomic primer-file write on non-dry-run is opt-in via the the ratified default counter-case; the skill itself never writes.
- **MUST NOT compose shell command strings.** Argv-array always (parity with lyt-sync + lyt-search).
- **MUST NOT silently degrade `writable === "unknown"` to a "writable" hint.** Surface the reason-specific guidance.

## Companion skills

- **/lyt-search** — query-driven recall (NOT primer aggregation). Use after priming when the agent needs to look up specific content. Companion: prime first, then search the cued surfaces.
- **/lyt-capture** — write a Figment. Use after priming when the Phase 5 capability hint is `home-pushable-true` (✓) and the agent has a captureable insight.
- **/lyt-sync** — pull/commit/push a vault. Run BEFORE priming if the user has unpushed local edits and wants the primer's recent-activity surface to reflect them.
