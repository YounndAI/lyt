# `lyt federation` — Your Pod

> `lyt init` is the canonical bootstrap and forges Your Pod automatically when
> the local registry is empty. The `lyt federation init` verb below remains the
> explicit surface, but most handlers should run `lyt init` instead. Run
> `lyt help multi-mesh` for the vault/mesh/federation model and how `lyt init`
> composes them.

The **federation repo** (user-facing: **Your Pod**) is the per-user GitHub
repo `{handle}/lyt-pod` that anchors which meshes you participate
in. It ships the repo, the local cache, the `pod.yon` manifest (a DERIVED
view of your local registry — see below), and three verbs.

> CLI verbs are plain (`init`, `list`, `rebuild`). Status messages use
> the warm voice — "Forging Your Pod…", "Your Pod spans 0 meshes". Errors
> stay plain.

## The shape

```
~/lyt/
├── registry.db        ← the SoT: federation_state + meshes + vaults
└── pod/
    ├── pod.yon        ← @FEDERATION + @FED_MESH + @FED_VAULT (DERIVED from registry)
    └── .git/          ← cloned from github.com/<handle>/lyt-pod
```

`pod.yon` is a **derived view** — regenerated from `registry.db` on every
registry mutation (init / adopt / mesh-init / forget) and `lyt federation
rebuild`. The registry is the single source of truth; `pod.yon` is never
hand-edited as truth (edits are overwritten on the next regen):

```
@DOC ver=2.0 | id=federation:<handle> | domain=yai.lyt@1.0 | kind=cfg | profile=agent

@FEDERATION rid=fed:<uuidv7>
  | handle="<handle>"
  | visibility=private
  | created_at:ts=2026-05-29T...

@META key=last_synced_at | value=2026-05-29T...
```

## Verbs

### `lyt federation init [--handle <h>] [--public|--private] [--no-push] [--description <text>] [--json]`

**Forges Your Pod.** Three branches:

- **fresh** — no remote, no local cache → creates `{handle}/lyt-pod`
  via `gh repo create` (private by default — your pod is yours), inits
  local working tree, scaffolds `pod.yon`, commits + pushes.
- **adopted** — remote pre-exists, no local cache → clones, writes the
  `federation_state` row. Safe to run on a second machine.
- **cached** — remote + local both present → no-op except stamping
  `last_synced_at` in the registry.

`--public` is explicit opt-in. `--no-push` keeps everything local
until you're ready (handler can push later via
`lyt federation rebuild --push`).

`lyt vault init <name>` automatically triggers federation init when no
federation cache exists AND ≥1 vault is registered — the **self-heal
branch**. Handler sees `Forging Your Pod from detected state…` on the
first vault creation; subsequent calls are no-ops.

### `lyt federation list [--handle <h>] [--json]`

Reads cached `pod.yon` and prints meshes deterministically
(sorted by `mesh_name`). Output for an empty federation:

```
$ lyt federation list
Your Pod spans 0 meshes:
  (no meshes yet)
```

`--json` mode emits a structured object every consumer can read identically.

### `lyt federation rebuild [--handle <h>] [--push] [--json]`

Re-derives `pod.yon` from registry state. **Deterministic** —
running it twice in a row produces byte-identical output modulo the
`last_synced_at` stamp.

`--push` commits + pushes when content actually changed (not when only
the stamp drifted). Rebuild emits one `@FED_MESH` per registered mesh
and one `@FED_VAULT` per registered vault.

## Cross-pod identity — the origin coordinate (0.9.4)

Locally, a vault's identity is its `rid` (a UUIDv7, minted on this machine). But
a `rid` is *local* — two pods that both clone the same shared vault mint
**different** rids for it. The cross-pod identity is therefore derived from the
one globally-unique, stable property a shared vault has: its git origin.

- **Origin coordinate** — `lyt:vault:<host>/<owner>/<repo>`, normalized from the
  vault's `git_url` (the purl / Go-modules pattern). A subscriber's clone has its
  own local `rid` but the **same** origin coordinate — that's what makes "the
  same vault" the same across pods.
- The typed-id scheme is `lyt:<type>:<id>` for every entity
  (`vault` · `mesh` · `pod` · `user` · `figment` · `pattern`).
- `commit-SHA` identifies the *bytes at a point*, not the entity (a vault is
  mutable) — it is a version/freshness marker, not identity.

`lyt vault info <name>` surfaces a vault's origin coordinate (or `null` when the
vault is local-only). Use the coordinate for replayable cross-pod references.

## Publishing Your Pod

`lyt sync` regenerates `pod.yon` and pushes Your Pod as part of its publish pass
(running `lyt sync` is the consent for that outward step). To regenerate and push
the manifest on its own, run `lyt federation rebuild --push`.

## Not yet shipped

- `@FED_AUTOMATOR` / `@FED_PRIMER` / `@FED_CANVAS` records — the schema shapes
  are reserved; full writes land in a later release.
- Public-mesh-aware federation primer (browse-only / pin-commit / cadence
  override).

## See also

- `lyt help automators` — machine roles drive automator dispatch.
- `lyt help sync` — how the pod publish pass works.
