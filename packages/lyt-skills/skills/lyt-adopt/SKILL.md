---
name: lyt-adopt
description: >
  Guided adopt of an existing editor-neutral markdown directory into a Lyt pod. Trigger when the user runs /lyt-adopt, or says "adopt this vault", "bring this folder into Lyt", or similar phrasing on an existing local directory. Additive-only: it creates `.lyt/` and NEVER touches the user's `.md` files. Brand-new vaults route to /lyt-create.
visibility: public
skill-version: 1.0.0
requires-lyt: ">=0.20.0 <0.21.0"
contract-version: 1.0.0
lyt-version: 0.11.0
capabilities: [write]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-adopt

Guided adopt of an existing editor-neutral markdown directory into the user's Lyt pod. Adopt is **additive-only**: it creates the `.lyt/` derived-state directory and registers the vault, but it **never touches the user's `.md` files**. It is the inverse of `lyt vault abandon`.

Under the hood this wraps `lyt vault adopt <path> [--name <name>] [--mesh <mesh>]`. The verb registers the vault, homes it into a mesh, rebuilds per-machine pattern links under `.lyt/patterns/`, and rebuilds the content caches so `/lyt-search` and `/lyt-recall` hit immediately.

## When to invoke

When the user runs `/lyt-adopt`, or says something like:

- "adopt this vault"
- "bring this Obsidian vault into Lyt"
- "upgrade this folder into a Lyt vault"
- "make this a Lyt vault"

## When NOT to invoke

- The directory is **already a Lyt vault** (`.lyt/vault.yon` exists) — use `lyt vault join <path>` to register an already-Lyt-aware vault instead. Adopt refuses with a clear message in this case.
- The user wants to **create a brand-new** vault from scratch — use `/lyt-create`.
- The user wants to **clone a remote** vault — use `lyt vault clone <url>`.

## Phase 1 — Resolve the target path

The adopt argument is a **filesystem path** to the existing vault directory (not a vault name). Resolve it:

1. If the user passed a path in the invocation, use it (resolve relative → absolute).
2. Otherwise ask which directory to adopt. Do **not** guess from cwd.

If the resolved path does not exist or is not a directory, stop and tell the user. If it already contains `.lyt/vault.yon`, stop and point them at `lyt vault join`.

## Phase 2 — Gather the adopt parameters

Gather these before calling adopt. Only **name** and **mesh** feed the command today; **backfill** and **remote** are DEFERRED and OFFER-ONLY (see Phase 4).

| Parameter    | Default                                                                | How to resolve                                                                                                                          |
| ------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **name**     | owner/repo when the path is under `~/lyt/vaults`, else folder basename | Accept a user-supplied `{mesh}/{vault}` name or leaf. Pass via `--name`. Omit to accept the default.                                    |
| **mesh**     | `personal`                                                             | The home mesh. A bare adopt homes the vault into `personal/<leaf>` (find-or-create the `personal` mesh). Override with `--mesh <name>`. |
| **backfill** | OFFER-ONLY (deferred)                                                  | Do NOT run it. Only mention it as a possible future step (see Phase 4).                                                                 |
| **remote**   | OFFER-ONLY (deferred)                                                  | Do NOT wire a remote. Adopt never contacts a remote (see Phase 4).                                                                      |

If the user does not signal a non-default mesh or name, use the defaults — do not over-prompt.

## Phase 3 — Run adopt

```
lyt vault adopt <path> [--name <name>] [--mesh <mesh>]
```

- Omit `--name` to accept the default (owner/repo or basename).
- Omit `--mesh` to home the vault into `personal/<leaf>` (the guided default). Pass `--mesh <name>` to home it elsewhere; the mesh is find-or-created.

The command prints the adopted name, path, rid, registry status, and the resolved home mesh (or `orphan (unassigned)` if assignment was deferred). On success the vault is registered, homed, pattern-linked (under `.lyt/patterns/`, machine-local + gitignored), and indexed.

Confirm to the user in one line:

> Adopted `<name>` at `<path>`, homed into `<mesh>`.

## Phase 4 — Offer the deferred follow-ups (do NOT run them)

Adopt already rebuilds the content caches on the way in, so search/recall work immediately. Two further steps are **deferred** — OFFER them as future options only; this skill does NOT implement them:

- **Backfill** — a deeper re-index of historical figments beyond the on-adopt index. Offer it as a possible future step; do not run any backfill command.
- **Remote** — wiring a GitHub remote and first push. Adopt never contacts a remote. Once a remote exists, point the user at `/lyt-sync` for pull/commit/push (gated on the writable verdict).

Frame both as "available later," never as something this adopt performed.

## Rules

- **Additive-only.** Adopt creates `.lyt/` and registers the vault; it NEVER modifies, moves, or deletes the user's `.md` files.
- **Default mesh is `personal`.** A bare adopt homes the vault into `personal/<leaf>` rather than leaving it orphan. Only override on an explicit `--mesh`.
- **Backfill + remote are deferred.** Offer them as future steps; never claim this adopt ran them.
- **Pattern links live under `.lyt/patterns/`** — machine-local, gitignored, Lyt-owned. Adopt rebuilds them per-machine; the user never touches them.
- **Refuse an already-Lyt-aware directory** — point at `lyt vault join` instead of adopt.

## Companion skills

- `/lyt-sync` — pull/commit/push once the vault has a remote.
- `/lyt-pod` — see the vault in the pod overview after adopt.
- `/lyt-primer-context` — prime an agent on the freshly-adopted vault.
