---
name: lyt-mesh-explore
description: >
  Drill into a single Lyt mesh — surface mesh metadata, member home vaults, update cadences, and the published @MESH_PUBLIC description for one named mesh. Trigger when the user runs /lyt-mesh-explore <mesh>, or says "show me the X mesh", "what's in mesh X", "drill into X mesh", "explore the X mesh", "give me X mesh details", or similar phrasing on mesh-scoped browsing. Wraps `lyt mesh info <mesh> [--remote] [--json]` (v1.B.6) — local mode reads the mesh's `.lyt/mesh.yon` SoT; `--remote` peeks at the published mesh.yon via gh api without cloning. Read-only; pairs with /lyt-pod (pod-level enumeration across all meshes) for breadth and /lyt-search (tiered query) for content.
visibility: public
lyt-version: 0.8.0
capabilities: [read]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-mesh-explore

Render a handler-facing overview of a single Lyt **mesh** — its metadata, its home vaults, its update cadences, and its published `@MESH_PUBLIC` description — by wrapping one primary CLI verb (plus an upstream `lyt mesh list --json` for mesh-name resolution per Phase 1):

- `lyt mesh info <mesh> [--remote] [--json]` (shipped v1.B.6). Canonical mesh-info verb per `packages/lyt-vault/src/commands/mesh-info.ts:20` (definition; registered at `commands/mesh.ts:37`). Local mode reads the registered mesh's main-vault `.lyt/mesh.yon` SoT; `--remote` peeks at the published mesh.yon via `gh api repos/<owner>/<mesh-main>/contents/.lyt/mesh.yon` without cloning the repo.

The skill is pure prose around existing CLI verbs — no new CLI verb, no new helper, no lyt-vault change. The CLI does the parsing (mesh.yon → typed `MeshInfoResult`); the skill resolves the user's intent (mesh name + local-or-remote), invokes the verb with `--json`, and formats the deterministic emission into a handler-facing mesh summary.

User-facing language uses **"mesh"** throughout per the LYT vocabulary convention — "pod" is reserved for the user's _full_ set of meshes (which is `/lyt-pod`'s scope); "mesh" is the individual group of vaults sharing a GitHub push target.

## When to invoke

When the user runs `/lyt-mesh-explore <mesh>`, or says something like:

- "show me the `<name>` mesh"
- "what's in mesh `<name>`"
- "drill into `<name>` mesh"
- "explore the `<name>` mesh"
- "give me `<name>` mesh details"
- "what vaults are in `<name>`"
- "peek at the remote `<name>` mesh without cloning" — _use `--remote`_

If the user wants a survey across _all_ their meshes (the pod-level view), prefer `/lyt-pod`. If the user wants to search content _inside_ the mesh's vaults, prefer `/lyt-search --mesh <name>`. This skill is the mesh-scoped drill-down between those two surfaces.

## Phase 1 — Resolve mesh name from user signal

The CLI verb takes one required positional `<mesh>` (the mesh name). Pick by the user's wording:

- **Explicit mesh name from invocation.** When the user runs `/lyt-mesh-explore <name>` or names the mesh directly ("explore the `younndai` mesh"), use that name as the candidate.
- **Keyword in natural language.** When the user says "show me the X mesh" / "what's in mesh X" / "drill into X", extract X as the candidate.

**Resolve the candidate against `lyt mesh list --json` before passing it.** Don't guess — when the user names a mesh:

1. Run `lyt mesh list --json` first (canonical mesh-enumeration verb per `packages/lyt-vault/src/commands/mesh.ts:277` — `buildMeshListSubcommand` definition; registered at `commands/mesh.ts:32`). The output's `meshes[].name` field is the source of truth for registered mesh names.
2. Match the user's term to the listed names (exact, then case-insensitive, then prefix).
3. **Reject any resolved name that begins with `-` or `--`** before passing it to the positional `<mesh>` argument — closes the flag-injection surface the same way lyt-sync, lyt-search, and lyt-pod close theirs (family: G.2 CR-1 gh-flag-injection). Mesh names are user-controlled at `lyt mesh init` time; a mesh literally named `--evil` would otherwise smuggle a flag-shaped token into the verb's argv.
4. If no match (or the only match is `--`-leading), tell the user the available mesh names from `lyt mesh list --json` and stop — do not invent a name.

**Decide `--remote` from explicit user signal only.** Pass `--remote` ONLY when the user explicitly says "without cloning" / "from GitHub" / "peek at the published mesh.yon" / "remote mesh info". The default is LOCAL invocation (no `--remote`) — it reads the locally-registered mesh's `.lyt/mesh.yon` SoT, which is faster, offline-safe, and authoritative for meshes the user owns. `--remote` requires the mesh to be registered locally with a `push_target` (the verb resolves the remote owner from the registry; it does NOT take a `--owner` override in v1.B.6).

## Phase 2 — Invoke `lyt mesh info`

Run the verb via the Bash tool (or your runtime's shell equivalent). **Pass argv as an array; never shell-compose the command.** Precedent: lyt-sync's Phase 3 (`spawnSync("git", [..., "-m", message])`), lyt-search's Phase 2 (`spawnSync("lyt", ["search", userQuery, "--json"])`), lyt-pod's Phases 2 + 3 (`spawnSync("lyt", ["mesh", "list", "--json"])` + `spawnSync("lyt", ["vault", "list", "--json"])`) — same argv-array shape, cross-platform-safe.

```
# Shell-syntax (DOCUMENTATION ONLY — do NOT compose this as a string):
lyt mesh info <mesh> [--remote] --json

# Actual exec shape (argv array; cross-platform-safe):
spawnSync("lyt", ["mesh", "info", meshName, "--json"]);

# With --remote (only on explicit user signal):
spawnSync("lyt", ["mesh", "info", meshName, "--remote", "--json"]);
```

Key rules:

- The first positional argument is the mesh name — a single string already resolved + sanitized in Phase 1. Quote it in shell-equivalent docs; in argv form it is one element.
- `--json` is **mandatory** for this skill. The deterministic JSON emission is the contract the skill parses below; human-readable output is not.
- `--remote` is a boolean flag; pass it (or omit) per the Phase 1 decision. Never pass `--remote=true` or `--remote=<anything>` — the flag is bare.

The CLI emits Lock 0.3 stable-key-ordered JSON on stdout (exit 0 on success). The actual emitted shape (per `packages/lyt-vault/src/flows/mesh-info.ts:103-118`, the `MeshInfoResult` interface — `mesh-info.ts:40` does `JSON.stringify(result, null, 2)` verbatim with no transformation, so the TypeScript shape IS the JSON contract):

```json
{
  "source": "local" | "remote",
  "mesh": {
    "rid": "mesh:<uuid-dashed>",
    "ridHex": "<hex>",
    "name": "<mesh-name>",
    "pushTarget": "<gh-target>" | null,
    "pushKind": "handle" | "org" | null,
    "mainVaultRid": "vault:<uuid-dashed>",
    "createdAt": "<iso>",
    "defaultVaultUpdateCadence": "<cadence-string>" | null
  },
  "publicMeta": {
    "description": "<string>",
    "topics": "<comma-separated>",
    "maintainerContact": "<string>",
    "maintainerHandle": "<string>",
    "licenseOverride": "<spdx-id>",
    "acceptContributions": true,
    "contributionUrl": "<url>",
    "homepageUrl": "<url>",
    "chatUrl": "<url>",
    "createdAt": "<iso>"
  } | null,
  "updateCadences": [
    {
      "vaultRid": "vault:<uuid-dashed>",
      "vaultRidHex": "<hex>",
      "cadenceType": "cron" | "interval" | "on-demand",
      "cron": "<expr>",
      "intervalSeconds": <number>,
      "timezone": "<tz>",
      "peakHours": "<expr>",
      "onDemandAllowed": <boolean>
    }
  ],
  "homeVaults": [
    {
      "vaultRid": "vault:<uuid-dashed>",
      "vaultRidHex": "<hex>",
      "vaultName": "<name>"
    }
  ]
}
```

Within `publicMeta` and `updateCadences[]`, every field except `description` (in publicMeta) and `vaultRid` / `vaultRidHex` / `cadenceType` (in updateCadences[]) is omitted from the emission when undefined — they are conditional object-literal spreads at flow-emission time. Treat missing keys as "field not set on this mesh", not "field is null".

Failure modes (CLI emits to stderr; exits non-zero):

- **Mesh not registered locally** (`MeshInfoNotFoundError`, exit 2) → `{ "error": "mesh-info-not-found", "mesh_name": "<name>", "message": "..." }`. Surface the message verbatim and suggest `lyt mesh list --json` to see registered meshes.
- **--remote requested, gh unavailable** (`MeshInfoRemoteGhUnavailableError`, exit 4) → `{ "error": "remote-gh-unavailable", "mesh_name": "<name>", "message": "..." }`. Most common causes: the mesh has no `push_target` (initialized with `--no-push`), or `gh` is not authenticated. Surface the message and suggest dropping `--remote` to fall back to LOCAL mode.
- **--remote requested, remote mesh.yon missing** (`MeshInfoRemoteMeshYonMissingError`, exit 4) → `{ "error": "remote-mesh-yon-missing", "mesh_name": "<name>", "message": "..." }`. The remote repo exists but `.lyt/mesh.yon` is absent at the repo root — the mesh has not yet been published via `lyt mesh publish`. Surface verbatim and suggest LOCAL mode.

## Phase 3 — Format mesh-overview for handler

Render the mesh summary as a markdown block. The handler-facing layout:

```
# Mesh: `<mesh-name>` (<local | remote>)

**Metadata:**
- rid: `<mesh.rid>`
- push target: `<mesh.pushKind>:<mesh.pushTarget>`     (omit line when pushTarget is null)
- main vault rid: `<mesh.mainVaultRid>`
- created: `<mesh.createdAt>`
- default cadence: `<mesh.defaultVaultUpdateCadence>`  (omit line when null)

**Public description:** (omit entire block when publicMeta is null)
- description: <publicMeta.description>
- topics: <publicMeta.topics>                          (omit when undefined)
- maintainer: <publicMeta.maintainerContact>           (omit when undefined)
- license: <publicMeta.licenseOverride>                (omit when undefined)
- homepage: <publicMeta.homepageUrl>                   (omit when undefined)
- chat: <publicMeta.chatUrl>                           (omit when undefined)

**Home vaults:** (count = homeVaults.length)
- ★ `<main-vault-name>` (`vault:<vaultRidHex>`)        — main vault, marked ★
- `<vault-name>` (`vault:<vaultRidHex>`)
- ...

**Update cadences:** (count = updateCadences.length; omit entire block when length is 0)
- `<vault-ridHex truncated to 12 chars>…` — <cadenceType> <detail>
- ...
```

Synthesis rules:

- **Source line.** Render `(local)` or `(remote)` next to the mesh name based on `source` — handlers seeing the rendered output should know whether they're looking at on-disk SoT or a remote peek.
- **Main-vault marker.** The home vault whose `vaultRid` equals `mesh.mainVaultRid` is the main vault — render it first with a `★` marker (parity with `lyt mesh list`'s human output per `packages/lyt-vault/src/commands/mesh.ts:333`). Other home vaults follow, sorted alphabetically by `vaultName`. Do not double-render the main vault.
- **Cadence detail.** For `cadenceType: "cron"`, render the `cron` expression. For `"interval"`, render `every <intervalSeconds>s`. For `"on-demand"`, render `on-demand`. Truncate `vaultRidHex` to the first 12 chars with `…` for readability (parity with `mesh-info.ts:104`).
- **Optional-field omission.** Treat absent keys in `publicMeta` + `updateCadences[]` as "field not set on this mesh"; omit those lines entirely rather than rendering `undefined` or `null` placeholders.
- **No edges / subscriptions sections.** `lyt mesh info` surfaces mesh metadata + publicMeta + home vaults + update cadences ONLY — it does not emit mesh-edges (`@MESH_EDGE`) or cross-mesh subscriptions (`@MESH_SUBSCRIPTION`). Those are inspected via other surfaces (`lyt mesh list` exposes per-mesh `subscribed_vaults`; mesh-edges live in `.lyt/mesh.yon` but are not surfaced by this verb). Do NOT invent edge / subscription bullets — the verb does not expose them. Mention `/lyt-pod` as the path to subscription overview if the user asks.
- **Empty publicMeta.** When `publicMeta === null`, the mesh was initialized without a `@MESH_PUBLIC` block. Omit the entire "Public description" section — do NOT render an empty heading.
- **Use "mesh" framing throughout.** Never write "federation" or "pod" in this skill's user-facing prose. "Mesh" is the unit of grouping; "pod" is the user's full set of meshes (different scope; that's `/lyt-pod`'s domain).
- **Remote-mode caveat.** When `source === "remote"`, the data is whatever the remote `.lyt/mesh.yon` currently advertises — it may be stale relative to the mesh's owner's local state if they haven't run `lyt mesh publish` recently. Mention this when the user explicitly asked for `--remote`, so they know what they're looking at.

## Rules

- **MUST pass the mesh name as a separate argv argument**, not template-interpolated into a shell command string. Mesh names are user-controlled at init time; argv-array protects against shell-meta or flag-shaped tokens.
- **MUST pass `--json`** on every invocation. Human-readable output is not a contract this skill parses.
- **MUST resolve mesh names via `lyt mesh list --json` before passing them.** The canonical mesh-enumeration verb is `lyt mesh list` per `packages/lyt-vault/src/commands/mesh.ts:277` (`buildMeshListSubcommand` definition; registered at `commands/mesh.ts:32`). Do not guess names.
- **MUST reject `--`-leading resolved mesh names** before passing them to the positional `<mesh>` argument (G.2 CR-1 flag-injection family defense).
- **MUST NOT cite `lyt mesh status`** as a verb. It does not exist. The canonical mesh-listing verb is `lyt mesh list`; the canonical single-mesh-inspection verb is `lyt mesh info` (this skill).
- **MUST NOT modify or write any vault file.** This is a read-only skill (`requires_writable_vault: false`). If the user wants the mesh overview persisted to a Figment, run `/lyt-capture` separately on the formatted output.
- **MUST NOT pass `--remote` by default.** LOCAL is the default; pass `--remote` only on explicit user signal ("without cloning", "from GitHub", "peek at the published mesh.yon", "remote").
- **MUST NOT invent edge or subscription bullets.** `lyt mesh info` does not emit them. For pod-wide subscription overview use `/lyt-pod`; for cross-mesh edges, inspect `.lyt/mesh.yon` directly (out of scope for this skill).
- **MUST NOT shell-compose any verb invocation.** Argv-array always (parity with lyt-sync + lyt-search + lyt-primer-context + lyt-pod).

## Companion skills

- **`/lyt-pod`** — pod-level overview across _all_ the user's meshes and vaults on this machine. Use when the user wants breadth (every mesh, every vault, orphans surfaced) rather than depth into one mesh.
- **`/lyt-search`** — query _content_ across the pod (or a single mesh / vault) via the tiered-cascade engine. Pair after `/lyt-mesh-explore` when the user has picked a mesh and now wants to look for specific content inside it (`lyt search "<q>" --mesh <name> --json`).
- **`/lyt-primer-context`** — prime an agent with Lyt-scoped context for a single vault (active arcs, writable status, primer files). Pair after `/lyt-mesh-explore` when the user picks a vault from this mesh's home-vaults list to start working in.
- **`/lyt-sync`** — pull/commit/push a vault. Run before `/lyt-mesh-explore` if the user has unpublished mesh-config edits and wants the `--remote` path to reflect them.
