---
name: lyt-sync
description: >
  Sync a Lyt vault — pull from its GitHub repo, auto-commit any uncommitted local changes (with an inferred commit message or a handler-supplied one), then push back to origin gated on the 6-reason writable verdict from `vault info --json`. Trigger when the user runs /lyt-sync, or says "sync this vault", "pull and push", "sync my notes", "push my changes", or similar phrasing. Wraps `git pull --rebase`, dirty-tree detection, commit, and push under the hood. Read-only / subscriber / orphan / no-remote / gh-offline vaults pull but skip push and surface a reason-specific handler message. Pairs with /lyt-capture.
visibility: public
lyt-version: 0.4.0
capabilities: [read, write]
runtimes: [claude, codex, agents]
requires_writable_vault: false
---

# /lyt-sync

Sync a Lyt vault — pull, detect-and-commit local changes, push (gated on the writable verdict). The skill always runs; the push step gates internally on the 6-reason `writable` contract from `lyt vault info --json`, so even read-only / subscriber / orphan / no-remote vaults pull cleanly without touching origin.

## When to invoke

When the user runs `/lyt-sync`, or says something like:

- "sync this vault"
- "sync my notes"
- "pull and push"
- "push my changes"
- "sync `<vault-name>`"
- "/lyt-sync `<vault-name>`"

If the user says "save and sync" or "/lyt-capture then sync", run /lyt-capture first, then /lyt-sync on the destination vault.

**Pod-wide sync: the `lyt sync` verb.** This skill's per-vault git flow (below) is the documented default for a **single named vault**. When the user wants to **sync everything** ("sync all my vaults", "sync my whole pod", "sync everything"), there is a real pod-wide CLI verb: `lyt sync` (no vault argument) syncs all registered active vaults — commit + push + pull --rebase — and also runs the federation publish pass. `lyt sync --watch` is a foreground daemon that auto-commits watched vaults (event-driven). `lyt sync --check` reports per-vault freshness without writing. There is **no** `lyt sync --mesh` flag; mesh-scoped sync is not a current verb.

## Phase 1 — Resolve the target vault

Follow this chain, in order, and stop at the first success (mirrors /lyt-capture Phase 1):

1. **`--vault <path>` argument** — if the user passed one in the invocation, use it as-is (resolve to absolute path if relative).
2. **`$LYT_ACTIVE_VAULT` environment variable** — if set, use it.
3. **`~/lyt/vaults/<handle>/main/`** — the default convention per the unified `{handle}/{repo}` naming (Windows: `%USERPROFILE%\lyt\vaults\<handle>\main`). Resolve `<handle>` from the pod identity (`identity.yon` / `pod.yon`); never hardcode it.

Do **not** guess from cwd. If `--vault` / env var / home convention all miss, ask the user which vault to target — fabricating a path from cwd would silently operate on the wrong tree.

If the resolved path **does not exist or is not a Lyt vault** (no `.lyt/vault.yon` inside), do **not** attempt git operations. Stop and tell the user:

> The target vault `<path>` doesn't exist (or isn't a Lyt vault — no `.lyt/vault.yon`). Use `lyt vault init <name>`, or pass `--vault <existing-path>`.

**Path-shape safety check.** Before invoking `git -C <vault-path>`, reject any resolved path that begins with `-` or `--` (defensive against a crafted `--vault` argument, `$LYT_ACTIVE_VAULT` env value, or any other resolver-input that could smuggle a flag-shaped token into the git positional). The `.lyt/vault.yon` existence check above already filters most invalid paths; this `--`-leading rejection closes the remaining flag-injection surface (the gh-flag-injection defense family). Resolved paths MUST be absolute and MUST start with a drive letter (Windows) or `/` (POSIX) before they enter any `git` argv.

## Phase 2 — Pull with rebase

Shell out to git directly with the vault path as `cwd`:

```
git -C <vault-path> pull --rebase
```

(On Windows, `git -C <path>` works with quoted paths, but the lyt-vault precedent — `flows/clone.ts`, `flows/repair.ts`, `util/git-history.ts` — uses `spawnSync` with `cwd: <vault-path>` so the path doesn't need to be embedded in argv. Skill prose recommends the `cwd` shape for cross-platform stability.)

**On rebase conflict** (`git pull --rebase` exits non-zero with conflict markers): do NOT attempt auto-resolution. Surface a structured result to the handler and halt:

```json
{
  "status": "conflict",
  "vault": "<vault-name>",
  "conflicted_files": ["<path1>", "<path2>"],
  "message": "git pull --rebase failed; resolve the listed conflicts manually, then re-invoke /lyt-sync."
}
```

The handler-facing prose to surface: _"Sync halted on rebase conflict in `<vault-name>`. Resolve the conflicts in `<files>`, then run `/lyt-sync` again."_

## Phase 3 — Detect + commit local changes

Run `git -C <vault-path> status --porcelain`. If the output is empty, skip to Phase 4 with a "no local changes" note for the handler. Otherwise:

1. Parse the porcelain output into a `GitDiffSummary`-shaped object (`{staged: string[], modified: string[]}`). Porcelain v1 (the default) emits one line per change with a 2-character prefix: column 1 is the index/staged status, column 2 is the working-tree status. Treat any line whose column-1 char is not space or `?` as **staged** (e.g. `A `, `M `, `MM`, `D `); treat any line whose column-2 char is not space (or whose prefix is `??`) as **modified**. Strip the 3-character prefix to recover the file path. Files that appear staged AND modified land in both arrays — that's tolerated; the helper sorts and de-orders naturally and the resulting message just lists the file once or twice depending on its multi-state shape.
2. Decide on a commit message. The skill exposes one **caller-options**-style choice:

- `options.commit-message: "auto"` _(default)_ — call the `inferCommitMessage(diff)` heuristic to summarise the diff:
- 0 files → `"no changes"` _(defensive; unreached because porcelain was non-empty)_
- 1 file (non-mesh.yon) → `"sync: <filename>"`
- 1 file (mesh.yon, at any depth) → `"sync: mesh.yon update"`
- 2-4 files → `"sync: N files (<comma list>)"`
- > 4 files → `"sync: N files (<first 3>, +M more)"`
- `options.commit-message: "prompt-handler"` — pause and ask the handler for a one-line message; do not invent one.

The heuristic is `inferCommitMessage`; the skill prose reproduces the rules above so an agent can run them inline without importing.

3. Stage and commit. **Pass the message via argv, NOT through shell interpolation.** The shell-syntax pseudocode below is for documentation only; agents executing this skill MUST translate it to an argv-safe `spawnSync` / `execFileSync` call so a filename containing shell metacharacters (backticks, `$()`, `;`, `"`) inside the inferred message can't escape into command execution. Concretely:

```
# Pseudocode (DO NOT shell-interpolate):
git -C <vault-path> add -A
git -C <vault-path> commit -m "<message>"

# Actual exec shape (argv array; cross-platform-safe):
spawnSync("git", ["-C", vaultPath, "add", "-A"]);
spawnSync("git", ["-C", vaultPath, "commit", "-m", message]);
```

The matching precedent is `execFileSync("git", ["clone", opts.url, target])` — the same argv-array shape used everywhere the lyt-vault flow layer shells to git.

Do **not** add a `Co-Authored-By` trailer (per the project's `CLAUDE.md` commit conventions). Do **not** add an `@STAMP` block — that is a `.yon`-write concern handled by lyt-runner, not the sync skill.

## Phase 4 — Push (gated on the 6-reason writable verdict)

Invoke `lyt vault info <vault-name> --json` and parse the `vault.writable` and `vault.writableDetermination` fields per the read-only-awareness contract. The verdict is tri-state (`true | false | "unknown"`); the determination is one of **6 reasons** the skill must branch on explicitly.

The actual reason strings emitted by `vault info --json` are listed in the **emitted name** column. The **semantic name** column gives the human-readable synonym; the SKILL.md surface uses the semantic name in handler-facing prose, but the comparison MUST be against the emitted name.

| Emitted name (writableDetermination) | Semantic name               | writable    | Phase 4 behavior                                                                                                                                               |
| ------------------------------------ | --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh-viewerCanPush-true`              | **home-pushable-true**      | `true`      | Push: `git -C <vault-path> push`. Report: _"Synced and pushed N commits to origin."_                                                                           |
| `gh-viewerCanPush-false`             | **home-not-pushable-false** | `false`     | Skip push. Report: _"Skipped push: you don't have push permission on `<vault.gitUrl>`. Request write access from the owner, or capture into a vault you own."_ |
| `subscriber-default-false`           | (subscriber)                | `false`     | Skip push. Report: _"Skipped push: this is a subscriber vault. Subscriber vaults pull but don't push. Capture into your home vault instead."_                  |
| `gh-unavailable`                     | (gh-offline)                | `"unknown"` | Skip push. Report: _"Skipped push: gh CLI is unavailable (offline / rate-limited / not authenticated). Re-try when network is available."_                     |
| `no-remote`                          | (no-remote)                 | `"unknown"` | Skip push. Report: _"Skipped push: vault has no git remote configured. Configure a remote with `gh repo create` or `git remote add origin <url>`."_            |
| `orphan-vault`                       | (orphan)                    | `"unknown"` | Skip push. Report: _"Skipped push: vault has no mesh role (orphan). Re-attach it with `lyt repair --target <vault> --apply --mesh <mesh>` (the single-orphan-vault verb; `lyt mesh adopt --cluster` is for orphan-MESH clusters, not one vault)."_                                |

**Note on emitted vs semantic names.** The semantic names `home-pushable-true` and `home-not-pushable-false` are documentation aliases for the actual emitted strings `gh-viewerCanPush-true` and `gh-viewerCanPush-false`, kept so future renames of the underlying enum don't silently break the skill prose. The 4 other reason strings (`subscriber-default-false`, `gh-unavailable`, `no-remote`, `orphan-vault`) are identical in both surfaces.

Final handler-facing result shape:

```json
{
  "status": "ok",
  "vault": "<vault-name>",
  "pulled": true,
  "committed_message": "<message>" | null,
  "pushed": true | false,
  "skipped_push_reason": "<one of the 6 writableDetermination values>" | null,
  "handler_message": "<reason-specific prose from the table above>"
}
```

## Rules

- **MUST NOT auto-resolve a rebase conflict.** Halt with the structured-output shape in Phase 2 and let the handler resolve manually.
- **MUST gate push on `vault.writable` / `vault.writableDetermination`.** Never `git push` unless `writableDetermination === "gh-viewerCanPush-true"` (equivalently, `writable === true`). The other 5 reasons all skip push.
- **MUST branch on all 6 reasons.** Each has a distinct handler-facing message; collapsing them into a generic "can't push" message loses semantic signal the handler needs to recover.
- **MUST NOT add a `Co-Authored-By` trailer** to the auto-commit. Per the project's `CLAUDE.md` commit conventions, unless the user explicitly requests one.
- **MUST NOT touch any vault other than the resolved target.** This skill's per-vault flow is single-vault. A pod-wide multi-vault sweep is the `lyt sync` verb (no vault argument — see "Pod-wide sync" above) or `mesh clone-all`, not this skill's per-vault path. There is no `lyt sync --mesh` flag.
- **MUST NOT modify `.lyt/vault.yon`, `.lyt/mesh.yon`, ledger YONs, or `@STAMP` blocks.** Those are runner / writer concerns; sync only commits handler-authored content as-is.
- **MUST NOT silently degrade `writable === "unknown"` to push.** Surface the reason to the handler.

## Companion skills

- **/lyt-capture** — write a Figment into a vault. /lyt-sync is the natural follow-up when the captured vault has push access.
- **/lyt-recall** — search the vault. Read-only; no sync interaction.
