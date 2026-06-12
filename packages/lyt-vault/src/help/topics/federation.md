# `lyt federation` — Your Pod (v1.A.0)

> v1.B.4 update — `lyt init` is the canonical bootstrap and will forge Your
> Pod automatically when the local registry is empty. The
> `lyt federation init` verb below remains the explicit surface, but most
> handlers should run `lyt init` instead. Run `lyt help multi-mesh` for the
> vault/mesh/federation model and how `lyt init` composes them.

The **federation repo** (user-facing: **Your Pod**) is the per-user GitHub
repo `{handle}/lyt-pod` that anchors which meshes you participate
in. It ships the repo, the local cache, the `pod.yon` manifest (a DERIVED
view of your local registry — see below), and three verbs.

> CLI verbs are plain (`init`, `list`, `rebuild`). Status messages use
> the warm voice — "Forging Your Pod…", "Your Pod spans 0 meshes" — per
> [brand voice §1 + §2](https://github.com/younndai/lyt). Errors stay plain.

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
  (no meshes yet — multi-mesh tables ship in v1.A.1)
```

`--json` mode emits a structured object every consumer can read identically.

### `lyt federation rebuild [--handle <h>] [--push] [--json]`

Re-derives `pod.yon` from registry state. **Deterministic** —
running it twice in a row produces byte-identical output modulo the
`last_synced_at` stamp (master plan §5 v1.A.0 acceptance item 4).

`--push` commits + pushes when content actually changed (not when only
the stamp drifted). Rebuild emits one `@FED_MESH` per registered mesh
and one `@FED_VAULT` per registered vault.

## Not yet shipped

- Pushing `pod.yon` to the remote pod repo on every mutation — today the
  manifest regenerates LOCALLY; the automatic commit/push round-trip ships
  with the publish/sync engine. Until then, run `lyt federation rebuild --push`.
- `@FED_AUTOMATOR` / `@FED_PRIMER` / `@FED_CANVAS` records — schema
  shapes are reserved; full writes land in later phases (v1.E.5, v1.D.4,
  v1.D.5 respectively).
- Formal yai.lyt JSON schema validation — v1.A.3.
- Public-mesh-aware federation primer (browse-only / pin-commit / cadence
  override) — those land in v1.D.4 + v1.5 Lane Pm.

## See also

- `lyt help machine` — machine roles drive automator dispatch (block-B
  consumer).
- [the LYT design doc `lyt-federation-design.md`](.) —
  canonical design (§3 mesh.yon precedent · §4 federation · §7 persistence).
- [the LYT design doc `lyt-brand-voice.md`](.) —
  the locked verb lexicon (forge / mint / weave / divine / trace / crystallize).
- [the LYT design doc `lyt-public-mesh.md`](.) —
  `--public` semantics on meshes (federation repos always stay
  private by design).
