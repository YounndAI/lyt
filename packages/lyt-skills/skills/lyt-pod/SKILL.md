---
name: lyt-pod
description: >
  Overview of the user's Lyt pod — enumerates all meshes and vaults on this machine, grouped by mesh, with orphan vaults surfaced separately and summary stats (mesh count, vault count, pushable/subscriber/orphan breakdown). Trigger when the user runs /lyt-pod, or says "what's in my pod", "show me my pod", "give me a pod overview", "list all my vaults", "what meshes do I have", "show me everything in my pod", or similar phrasing on a pod-scoped enumeration. Composes `lyt mesh list --json` (mesh-level records) + `lyt vault list --json` (vault-level records) into one agent-facing summary. Read-only; pairs with /lyt-primer-context (agent priming with active arcs + writable status) and /lyt-search (query across the pod).
visibility: public
lyt-version: 0.7.0
capabilities: [read]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-pod

Render an agent-facing overview of the user's Lyt **pod** — every mesh and every vault on this machine — by composing two CLI verbs:

1. `lyt mesh list --json` — enumerates meshes the user participates in, including each mesh's main vault, home vaults, and subscribed vaults. This is the canonical mesh-enumeration verb.
2. `lyt vault list --json` — enumerates every registered vault on the machine, with status, path, and per-vault metadata (mesh role, parent vault, tier hint). This is the canonical vault-enumeration verb.

The skill is pure prose around two existing CLI verbs — there is no new CLI verb, no new helper, no lyt-vault change. Both verbs always run on every invocation (default = full pod overview); user signal can narrow the synthesis focus post-facto but does NOT change which verbs run.

User-facing language uses **"pod"** throughout — never "federation". "Mesh" stays user-facing (it's the actual unit of grouping). "Federation" is reserved for internal data-layer prose.

## When to invoke

When the user runs `/lyt-pod`, or says something like:

- "what's in my pod"
- "show me my pod"
- "give me a pod overview"
- "list all my vaults"
- "what meshes do I have"
- "show me everything in my pod"
- "summarize my Lyt setup"
- "what's on this machine"

Invoke this skill **proactively** as the first move whenever the user asks a pod-scoped enumeration question or seems to want a survey of what's installed. Don't bypass it and start grep'ing the filesystem — the registry is the source of truth.

If the user wants to drill into a single mesh (vault list + edges for one mesh), prefer `/lyt-mesh-explore`. If the user wants per-vault writable status or agent priming, use `/lyt-primer-context`.

**Disambiguator vs `/lyt-search`.** A bare **inventory** request ("what's in my pod", "list my vaults", "what meshes do I have") → `/lyt-pod` (this skill — enumerates the pod's structure). A **content query with a topic** ("what's in my pod **about X**", "...about `<topic>`", "find anything on `<topic>`") → `/lyt-search` (queries figment content across the pod). The split is structure-vs-content: if the user names a subject they want found, route to `/lyt-search`, not here.

## Phase 1 — Determine pod-scope intent

The default is **full pod overview** — both verbs run, every mesh and vault rendered. Pick by the user's wording:

- **Default — full pod overview.** Use when the user says "my pod", "show me everything", "list all vaults", "what meshes do I have", or omits scope entirely. Run both verbs (Phase 2 + Phase 3) and synthesize a complete pod summary in Phase 4.
- **Narrow framing on a single mesh.** Use when the user says "focus on the `<name>` mesh", "just show me the `<name>` mesh's vaults", "what's in the `<name>` mesh". **Still run BOTH `lyt mesh list --json` and `lyt vault list --json`** — the CLI verbs do not support `--mesh` filtering on `lyt vault list`. Apply the user's narrow framing at **synthesis time** (Phase 4) by filtering the rendered output. Do NOT invent a CLI flag.
- **Tombstoned-vault inclusion.** Default = hide soft-tombstoned rollup aggregates (matches the CLI default). Pass `--include-tombstones` ONLY when the user explicitly says "show tombstoned vaults too", "include deleted vaults", "show buried vaults". Hard-tombstoned vaults (`status='tombstoned'`) are included in the default `lyt vault list` output already; `--no-tombstones` filters them out (do NOT pass by default — they are part of the pod's recent history).

The skill never invents mesh or vault names. If the user names one and the post-Phase-2/3 synthesis can't match it, surface the available names and stop — do not guess.

## Phase 2 — Enumerate meshes

Run the verb via the Bash tool (or your runtime's shell equivalent). **Pass the argv as an array; never shell-compose the command.** Precedent: lyt-sync's Phase 3 (`spawnSync("git", [..., "-m", message])`), lyt-search's Phase 2 (`spawnSync("lyt", ["search", userQuery, "--json"])`), lyt-primer-context's Phase 2 (`spawnSync("lyt", ["primer", "--scope", scope, ...])`) — same argv-array shape, cross-platform-safe.

```
# Shell-syntax (DOCUMENTATION ONLY — do NOT compose this as a string):
lyt mesh list --json

# Actual exec shape (argv array; cross-platform-safe):
spawnSync("lyt", ["mesh", "list", "--json"]);
```

The CLI emits stable, deterministically key-ordered JSON on stdout (exit 0 on success). The emitted shape:

```json
{
  "meshes": [
    {
      "rid": "mesh:<hex>",
      "rid_hex": "<hex>",
      "name": "<mesh-name>",
      "push_target": "<gh-target>" | null,
      "push_kind": "handle" | "org" | null,
      "main_vault": {
        "rid": "vault:<hex>",
        "rid_hex": "<hex>",
        "name": "<vault-name>"
      } | null,
      "home_vaults": [
        { "rid": "vault:<hex>", "rid_hex": "<hex>", "name": "<vault-name>" }
      ],
      "subscribed_vaults": [
        { "rid": "vault:<hex>", "rid_hex": "<hex>", "name": "<vault-name>" }
      ]
    }
  ]
}
```

`home_vaults` includes the main vault (it's a home vault with the additional `★` marker captured separately as `main_vault.rid_hex`). `subscribed_vaults` is the cross-mesh subscription role (mesh M subscribes to vault V owned by another mesh).

Empty registry: `{ "meshes": [] }`. Surface "no meshes yet — run `lyt mesh init <name>` to create one" in Phase 4 if both meshes AND vaults arrays are empty.

## Phase 3 — Enumerate vaults

Same argv-array invocation pattern.

```
# Shell-syntax (DOCUMENTATION ONLY):
lyt vault list --json

# Actual exec shape:
spawnSync("lyt", ["vault", "list", "--json"]);

# Counter-case — user explicitly asked for tombstoned-rollup inclusion:
spawnSync("lyt", ["vault", "list", "--json", "--include-tombstones"]);
```

The CLI emits stable, deterministically key-ordered JSON on stdout:

```json
{
  "vaults": [
    {
      "rid": { "0": <int>, "1": <int>, "...": <int>, "15": <int> },
      "ridHex": "<hex>",
      "name": "<vault-name>",
      "path": "<absolute-path>",
      "memscopeRid": { "0": <int>, ... } | null,
      "memscopeRidHex": "<hex>" | null,
      "parentVault": { "0": <int>, ... } | null,
      "parentVaultHex": "<hex>" | null,
      "homeMeshRid": { "0": <int>, ... } | null,
      "homeMeshRidHex": "<hex>" | null,
      "tierHint": "<string>" | null,
      "status": "active" | "disconnected" | "missing" | "tombstoned" | "access_lost",
      "gitUrl": "<url>" | null,
      "createdAt": "<iso>" | null,
      "registeredAt": "<iso>",
      "lastVerifiedAt": "<iso>" | null,
      "verifyFailCount": 0
    }
  ],
  "displayNames": { "<ridHex>": "<mesh>/<vault>" },   // ridHex → canonical qualified display name
  "rollupTombstones": { ... },        // only when --include-tombstones is passed
  "rollupThresholdDays": <int>,       // only when --include-tombstones is passed
  "rollupThresholdIso": "<iso>"       // only when --include-tombstones is passed
}
```

**Field-type note.** The four byte-typed fields (`rid`, `memscopeRid`, `parentVault`, `homeMeshRid`) are `Uint8Array` instances at the source and pass through `JSON.stringify(result, null, 2)` raw. `JSON.stringify` serializes a `Uint8Array` as a **byte-indexed object** (`{"0": 123, "1": 45, ..., "15": 254}`), NOT a hex string. **Always match on the `*Hex` companion fields** (`ridHex`, `memscopeRidHex`, `parentVaultHex`, `homeMeshRidHex`) — those are guaranteed-string and stable. Treat the raw byte-fields as opaque implementation detail.

The vault-list output is the source of truth for **per-vault mesh membership** — match each vault's `homeMeshRidHex` (string) against each mesh's `rid_hex` (string) from Phase 2 to group vaults under their mesh in Phase 4. A vault with `homeMeshRidHex === null` is an **orphan** (registered but not adopted into any mesh — see Phase 4's orphan section).

Empty registry: `{ "vaults": [] }`. Surface "no vaults registered yet — run `lyt vault init <name>` to create one" in Phase 4 if both meshes AND vaults arrays are empty.

## Phase 4 — Synthesize pod-overview

Render the pod summary as a markdown block. The handler-facing layout:

```
# Your pod

**Summary:** <N> mesh<es> · <M> vault<s> (<P> pushable · <S> subscriber · <O> orphan)

## Meshes

### `<mesh-1-name>` (<K> home vault<s><, J subscribed>)

- ★ `<main-vault-name>` — main vault · push target: `<push_kind>:<push_target>`
- `<home-vault-name>` — home vault
- ...
- `<subscribed-vault-name>` — subscribed (cross-mesh)

### `<mesh-2-name>` (<K> home vault<s>)

- ★ `<main-vault-name>` — main vault
- ...

## Orphan vaults (no mesh role)

- `<orphan-vault-name>` — heal via `lyt repair --target <orphan-vault-name> --apply --mesh <mesh>` (binds a registered vault to a mesh); `lyt mesh adopt` discovers + adopts gh clusters
- ...
```

Synthesis rules:

- **Summary line.** `N meshes` = `meshes.length` from Phase 2. `M vaults` = `vaults.length` from Phase 3 (filter out `status='tombstoned'` unless the user explicitly asked for tombstoned inclusion). The `(P pushable · S subscriber · O orphan)` breakdown counts each vault **once** by primary role, with precedence **home > subscriber > orphan** (a vault appearing in BOTH a `home_vaults` array AND any `subscribed_vaults` array is counted as **home**, not subscriber): a vault is **pushable** if it appears in any mesh's `home_vaults` AND that mesh has a non-null `push_target`; **subscriber** if it appears ONLY in `subscribed_vaults` arrays across all meshes (never as a home vault); **orphan** if its `homeMeshRidHex === null` (no mesh role at all).
- **Mesh grouping.** Sort meshes by name (alphabetical) for stable rendering. Within each mesh: main vault first (marked `★`), then other home vaults sorted alphabetically (exclude the main-vault entry from this alphabetic list — it already rendered above with `★`; `home_vaults` includes the main vault per Phase 2 shape, so an LLM iterating the array verbatim would otherwise double-render the main vault), then subscribed vaults grouped at the end with a "subscribed (cross-mesh)" hint.
- **Push-target hint.** Surface `push target: <push_kind>:<push_target>` next to the main vault when `push_target !== null`. Skip the hint when null (mesh is local-only).
- **Orphan section.** Always include the heading even when empty (rendering "(none)" under it) — handlers parsing the output can rely on the section's presence. Each orphan vault gets a one-line heal suggestion: `lyt repair --target <orphan-vault-name> --apply --mesh <mesh>` (the canonical heal — binds a registered vault to a known mesh). A vault that is _registered-but-mesh-unlinked_ (the adopt mesh-link drift) heals via `lyt repair --apply` with **no args** (`lyt doctor` flags it). `lyt mesh adopt` remains for gh **cluster-discovery** of un-registered repos — not for re-linking an already-registered vault.
- **User narrow framing.** If the user signaled a single mesh in Phase 1, render only that mesh's section under `## Meshes` plus the orphan section. Surface a one-line "(showing 1 of N meshes — re-invoke /lyt-pod for full overview)" hint.
- **Large pod truncation.** If the combined vault count exceeds ~50 across all meshes, render the summary line + per-mesh counts and offer a "show all with `lyt vault list`" follow-up rather than dumping every vault inline. Do not silently drop entries.
- **Empty pod.** If both `meshes.length === 0` AND `vaults.length === 0`, render: "**Your pod is empty.** Run `lyt mesh init <name>` to create your first mesh, or `lyt vault init <name>` to register a standalone vault. See `/lyt-mesh-explore` once you have one."
- **Use "pod" framing throughout.** Never write "federation" in handler-facing prose. "Mesh" is user-facing (the actual group). "Pod" is the user's set of meshes + vaults on this machine.

## Rules

- **MUST pass argv as an array** (`spawnSync("lyt", ["mesh", "list", "--json"])` and `spawnSync("lyt", ["vault", "list", "--json"])`), not template-interpolated into a shell command string. Both verbs accept simple argv with no user-supplied tokens, so the shell-injection surface is small — but argv parity matches lyt-sync + lyt-search + lyt-primer-context for cross-platform reliability.
- **MUST pass `--json`** on every invocation. Human-readable output is not a contract this skill parses.
- **MUST run BOTH verbs on every invocation.** The default is full pod overview; even when the user signals a narrow mesh framing, the vault list is needed to compute the orphan section and the summary-line counts. Do not skip one verb to "save time" — synthesis quality drops.
- **MUST use "pod" framing in user-facing output.** Never write "federation" in handler-facing prose; "federation" is internal data-layer vocabulary only.
- **MUST surface the orphan-vault section** even when empty (render "(none)" under the heading) so handlers can rely on its presence.
- **MUST cite `lyt mesh list` as the canonical mesh-enumeration verb.** The canonical verb is `lyt mesh list`. Do not invent a different mesh-enumeration verb.
- **MUST cite `lyt vault info <name>` with a positional argument only.** The verb accepts a positional `<name>`; the only flag is `--json`. The pod skill does not call `vault info` at all (per-vault writable status is `/lyt-primer-context`'s job — pulling it here would duplicate that surface).
- **MUST NOT pass `--include-tombstones` by default.** Pass only on explicit user signal ("show tombstoned vaults", "include deleted vaults", "show buried vaults"). Default = hide soft-tombstoned rollup aggregates per CLI default.
- **MUST NOT pass `--no-tombstones` by default.** Hard-tombstoned vaults (`status='tombstoned'`) are part of the pod's recent history; rendering them with a `[tombstoned]` status marker is the correct default. Pass `--no-tombstones` only on explicit user signal ("hide tombstones", "skip buried vaults").
- **MUST NOT modify or write any file.** This is a read-only skill (`requires_writable_vault: false`). If the user wants the pod overview persisted to a Figment, run `/lyt-capture` separately on the formatted output.
- **MUST NOT shell-compose any verb invocation.** Argv-array always (parity with lyt-sync + lyt-search + lyt-primer-context).
- **MUST NOT invent CLI flags for filtering.** The CLI verbs do not support `--mesh` filtering on `lyt vault list`; user narrow framing is synthesis-time filtering in Phase 4, not CLI-level filtering.

## Companion skills

- **/lyt-mesh-explore** — drill into a single mesh (vault list + edges + subscriptions). Pair after `/lyt-pod` when the user picks one mesh to investigate.
- **/lyt-primer-context** — prime an agent with Lyt-scoped context (top keywords, active arcs, writable status). Pair after `/lyt-pod` when the user wants the agent to start working in a specific vault — use `--scope vault --target <name>` per the chosen vault.
- **/lyt-search** — query across the pod with the tiered-cascade engine. Pair after `/lyt-pod` when the user wants to look up specific content rather than survey what exists.
- **/lyt-sync** — pull/commit/push a vault. Run before `/lyt-pod` if the user has unpushed local edits and wants the registry to reflect them (registry rows update on vault init/adopt; `/lyt-sync` doesn't change the pod shape but does freshen `lastVerifiedAt`).
