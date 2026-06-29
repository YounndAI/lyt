---
name: lyt-mesh-explore
description: >
  Drill into a single Lyt mesh — surface mesh metadata and member home vaults for one named mesh. Trigger when the user runs /lyt-mesh-explore <mesh>, or says "show me the X mesh", "what's in mesh X", "drill into X mesh", "explore the X mesh", "give me X mesh details", or similar phrasing on mesh-scoped browsing. Wraps `lyt mesh info <mesh> [--remote] [--json]` — local mode reads the mesh's `.lyt/mesh.yon` SoT; `--remote` peeks at the remote mesh.yon via gh api without cloning. Read-only; pairs with /lyt-pod (pod-level enumeration across all meshes) for breadth and /lyt-search (tiered query) for content.
visibility: public
lyt-version: 0.8.0
capabilities: [read]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-mesh-explore

Render a handler-facing overview of a single Lyt **mesh** — its metadata and its home vaults — by wrapping one primary CLI verb (plus an upstream `lyt mesh list --json` for mesh-name resolution per Phase 1):

- `lyt mesh info <mesh> [--remote] [--json]`. The canonical mesh-info verb. Local mode reads the registered mesh's main-vault `.lyt/mesh.yon` source of truth; `--remote` peeks at the published mesh.yon via `gh api repos/<owner>/<mesh-main>/contents/.lyt/mesh.yon` without cloning the repo.

The skill is pure prose around existing CLI verbs — no new CLI verb, no new helper, no lyt-vault change. The CLI does the parsing (mesh.yon → typed `MeshInfoResult`); the skill resolves the user's intent (mesh name + local-or-remote), invokes the verb with `--json`, and formats the deterministic emission into a handler-facing mesh summary.

> **Note:** `publicMeta`, `updateCadences`, and `defaultVaultUpdateCadence` were removed from `MeshInfoResult`. The JSON schema and rendering template below reflect the current post-deletion shape.

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

**Disambiguator vs `/lyt-primer-context`.** "**structure / metadata / what's IN** mesh `<name>`" (which vaults, rid, push target) → `/lyt-mesh-explore` (this skill — static mesh shape). "**state / active arcs / what's happening / lately** in mesh `<name>`" (recent activity, top keywords, in-progress arcs) → `/lyt-primer-context --scope mesh --target <name>` (dynamic priming context). The split is static-shape-vs-live-state: if the user asks what the mesh _contains_, route here; if they ask what's _going on_ in it, route to `/lyt-primer-context`.

## Phase 1 — Resolve mesh name from user signal

The CLI verb takes one required positional `<mesh>` (the mesh name). Pick by the user's wording:

- **Explicit mesh name from invocation.** When the user runs `/lyt-mesh-explore <name>` or names the mesh directly ("explore the `younndai` mesh"), use that name as the candidate.
- **Keyword in natural language.** When the user says "show me the X mesh" / "what's in mesh X" / "drill into X", extract X as the candidate.

**Resolve the candidate against `lyt mesh list --json` before passing it.** Don't guess — when the user names a mesh:

1. Run `lyt mesh list --json` first (the canonical mesh-enumeration verb). The output's `meshes[].name` field is the source of truth for registered mesh names.
2. Match the user's term to the listed names (exact, then case-insensitive, then prefix).
3. **Reject any resolved name that begins with `-` or `--`** before passing it to the positional `<mesh>` argument — closes the flag-injection surface the same way lyt-sync, lyt-search, and lyt-pod close theirs (the gh-flag-injection defense family). Mesh names are user-controlled at `lyt mesh init` time; a mesh literally named `--evil` would otherwise smuggle a flag-shaped token into the verb's argv.
4. If no match (or the only match is `--`-leading), tell the user the available mesh names from `lyt mesh list --json` and stop — do not invent a name.

**Decide `--remote` from explicit user signal only.** Pass `--remote` ONLY when the user explicitly says "without cloning" / "from GitHub" / "peek at the published mesh.yon" / "remote mesh info". The default is LOCAL invocation (no `--remote`) — it reads the locally-registered mesh's `.lyt/mesh.yon` SoT, which is faster, offline-safe, and authoritative for meshes the user owns. `--remote` requires the mesh to be registered locally with a `push_target` (the verb resolves the remote owner from the registry; it does NOT take a `--owner` override).

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

The CLI emits stable, deterministically key-ordered JSON on stdout (exit 0 on success). The emitted shape (the `MeshInfoResult` interface):

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
    "createdAt": "<iso>"
  },
  "homeVaults": [
    {
      "vaultRid": "vault:<uuid-dashed>",
      "vaultRidHex": "<hex>",
      "vaultName": "<name>"
    }
  ]
}
```

Failure modes (CLI emits to stderr; exits non-zero):

- **Mesh not registered locally** (`MeshInfoNotFoundError`, exit 2) → `{ "error": "mesh-info-not-found", "mesh_name": "<name>", "message": "..." }`. Surface the message verbatim and suggest `lyt mesh list --json` to see registered meshes.
- **--remote requested, gh unavailable** (`MeshInfoRemoteGhUnavailableError`, exit 4) → `{ "error": "remote-gh-unavailable", "mesh_name": "<name>", "message": "..." }`. Most common causes: the mesh has no `push_target` (initialized with `--no-push`), or `gh` is not authenticated. Surface the message and suggest dropping `--remote` to fall back to LOCAL mode.
- **--remote requested, remote mesh.yon missing** (`MeshInfoRemoteMeshYonMissingError`, exit 4) → `{ "error": "remote-mesh-yon-missing", "mesh_name": "<name>", "message": "..." }`. The remote repo exists but `.lyt/mesh.yon` is absent at the repo root. Surface verbatim and suggest LOCAL mode.

## Phase 3 — Format mesh-overview for handler

Render the mesh summary as a markdown block. The handler-facing layout:

```
# Mesh: `<mesh-name>` (<local | remote>)

**Metadata:**
- rid: `<mesh.rid>`
- push target: `<mesh.pushKind>:<mesh.pushTarget>`     (omit line when pushTarget is null)
- main vault rid: `<mesh.mainVaultRid>`
- created: `<mesh.createdAt>`

**Home vaults:** (count = homeVaults.length)
- ★ `<main-vault-name>` (`vault:<vaultRidHex>`)        — main vault, marked ★
- `<vault-name>` (`vault:<vaultRidHex>`)
- ...
```

Synthesis rules:

- **Source line.** Render `(local)` or `(remote)` next to the mesh name based on `source` — handlers seeing the rendered output should know whether they're looking at on-disk SoT or a remote peek.
- **Main-vault marker.** The home vault whose `vaultRid` equals `mesh.mainVaultRid` is the main vault — render it first with a `★` marker (parity with `lyt mesh list`'s human output). Other home vaults follow, sorted alphabetically by `vaultName`. Do not double-render the main vault.
- **No edges / subscriptions sections.** `lyt mesh info` surfaces mesh metadata + home vaults ONLY — it does not emit mesh-edges (`@MESH_EDGE`) or cross-mesh subscriptions. Those are inspected via other surfaces (`lyt mesh list` exposes per-mesh `subscribed_vaults`). Do NOT invent edge / subscription bullets — the verb does not expose them. Mention `/lyt-pod` as the path to subscription overview if the user asks.
- **Use "mesh" framing throughout.** Never write "federation" or "pod" in this skill's user-facing prose. "Mesh" is the unit of grouping; "pod" is the user's full set of meshes (different scope; that's `/lyt-pod`'s domain).
- **Remote-mode caveat.** When `source === "remote"`, the data is whatever the remote `.lyt/mesh.yon` currently advertises — it may be stale relative to the mesh's owner's local state if they haven't pushed recently. Mention this when the user explicitly asked for `--remote`, so they know what they're looking at.

## Rules

- **MUST pass the mesh name as a separate argv argument**, not template-interpolated into a shell command string. Mesh names are user-controlled at init time; argv-array protects against shell-meta or flag-shaped tokens.
- **MUST pass `--json`** on every invocation. Human-readable output is not a contract this skill parses.
- **MUST resolve mesh names via `lyt mesh list --json` before passing them.** The canonical mesh-enumeration verb is `lyt mesh list`. Do not guess names.
- **MUST reject `--`-leading resolved mesh names** before passing them to the positional `<mesh>` argument (the flag-injection defense family).
- **MUST NOT cite `lyt mesh status` for single-mesh inspection.** It DOES exist, but it renders the local mesh graph (vault list grouped by parent_vault subtrees), not one mesh's metadata. The canonical mesh-listing verb is `lyt mesh list`; the canonical single-mesh-inspection verb is `lyt mesh info` (this skill).
- **MUST NOT modify or write any vault file.** This is a read-only skill (`requires_writable_vault: false`). If the user wants the mesh overview persisted to a Figment, run `/lyt-capture` separately on the formatted output.
- **MUST NOT pass `--remote` by default.** LOCAL is the default; pass `--remote` only on explicit user signal ("without cloning", "from GitHub", "peek at the published mesh.yon", "remote").
- **MUST NOT invent edge or subscription bullets.** `lyt mesh info` does not emit them. For pod-wide subscription overview use `/lyt-pod`; for cross-mesh edges, inspect `.lyt/mesh.yon` directly (out of scope for this skill).
- **MUST NOT shell-compose any verb invocation.** Argv-array always (parity with lyt-sync + lyt-search + lyt-primer-context + lyt-pod).

## Companion skills

- **`/lyt-pod`** — pod-level overview across _all_ the user's meshes and vaults on this machine. Use when the user wants breadth (every mesh, every vault, orphans surfaced) rather than depth into one mesh.
- **`/lyt-search`** — query _content_ across the pod (or a single mesh / vault) via the tiered-cascade engine. Pair after `/lyt-mesh-explore` when the user has picked a mesh and now wants to look for specific content inside it (`lyt search "<q>" --mesh <name> --json`).
- **`/lyt-primer-context`** — prime an agent with Lyt-scoped context for a single vault (active arcs, writable status, primer files). Pair after `/lyt-mesh-explore` when the user picks a vault from this mesh's home-vaults list to start working in.
- **`/lyt-sync`** — pull/commit/push a vault. Run before `/lyt-mesh-explore` if the user has unpublished mesh-config edits and wants the `--remote` path to reflect them.
