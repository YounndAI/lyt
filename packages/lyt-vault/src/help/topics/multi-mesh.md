# Multi-mesh — vault, mesh, federation

Lyt models knowledge in three layers. Understanding the boundary between them
is the difference between _"I have a folder of notes"_ and _"I have a
queryable, federated graph my agent can ground in."_ The three layers are:

| Concept        | Cardinality        | Shared between users?         | Source of truth                          |
| -------------- | ------------------ | ----------------------------- | ---------------------------------------- |
| **Vault**      | 1 per content unit | Yes (via Git clone)           | The vault's own files + `.lyt/vault.yon` |
| **Mesh**       | N per user         | Yes (mesh = shared ownership) | The main vault's `.lyt/mesh.yon`         |
| **Federation** | 1 per user         | No (per-user projection)      | Implicit — derived from your registry    |

> Run `lyt help mesh-yon` for the `.lyt/mesh.yon` schema and round-trip
> contract. Run `lyt help federation` for Your Pod (the federation repo).

## Vault

A **vault** is one Git repo holding Figments (markdown), `.lyt/vault.yon`, a
per-vault libSQL index, and Obsidian config. Every vault belongs to exactly
one **home mesh** — recorded in its `vault.yon`'s `@VAULT_HOME_MESH` record.
Content lives in vaults; meshes and federations are organisational layers.

## Mesh

A **mesh** is a named group of vaults sharing a GitHub push target. Its
definition lives in the **main vault's `.lyt/mesh.yon`** — the SoT for which
vaults the mesh owns (`@MESH_HOME`) and references as edges (`@MESH_EDGE`).
Flat subscriptions to external vaults are recorded in a per-writer
**subscription ledger**, not in mesh.yon. Every mesh has exactly one main
vault, structurally locked: the vault is named `main`, and `lyt vault rename`
refuses any operation on it.

## Federation

A **federation** is the per-user projection of every mesh you can read. It is
not a stored entity — it's the runtime union of every mesh in your
`~/lyt/registry.db`. Two users in the same set of meshes have overlapping but
independent federations. Per-user state that benefits from being shared
across machines (mesh-of-meshes registry, federation-scope automators) lives
in a dedicated `{handle}/lyt-pod` GitHub repo — see
`lyt help federation`.

## Naming — `{mesh-name}/{vault-name}`

Every vault has a name with the shape `{mesh-name}/{vault-name}`, slug-safe
on both sides:

```text
personal/main         ★ main vault of personal mesh
alex/journal          personal subtree
younndai/lyt          org subtree
marlink/handbook      another org subtree
```

The `★` marker in `lyt vault list` points at the mesh's main vault. That
`{mesh}/{vault}` name is **computed** from the vault's home mesh + leaf (0.9.4)
— a `lyt vault move` re-homes the vault and the displayed name follows
automatically, with no stale-name bug.

### Addressing — the `rid` is identity (0.9.4)

A vault's **`rid` (UUIDv7) is its identity**; names are a resolution layer over
it. Every verb that takes a vault accepts ANY of these (resolved at one
chokepoint — no verb does its own resolution):

- **`{mesh}/{vault}`** — the canonical qualified address (`company/handbook`).
- **bare leaf** — `handbook` tries `personal/handbook`, then the UNIQUE leaf
  across all meshes. A colliding leaf is an **error** that lists the qualified
  candidates — Lyt never guesses a target.
- **pod-local alias** — see [Aliases](#aliases-pod-local) below.
- **origin coordinate** — `lyt:vault:<host>/<owner>/<repo>` (from the git URL)
  for cross-pod references.

For replayable / stored references (e.g. an agent persisting a vault handle),
prefer the qualified `{mesh}/{vault}` or the origin coordinate — both are stable
across pod growth + rename.

### Create-if-missing (0.9.4)

`lyt vault init {mesh}/{vault}` creates the mesh if missing, the vault if
missing, and **stops + notifies if the vault already exists**:

```bash
lyt vault init notes              # bare → personal/notes (personal mesh auto-created)
lyt vault init company/handbook   # creates the `company` mesh if absent, then the vault
lyt vault init handbook --mesh company           # same, via the flag
lyt vault init company/handbook --push-to myorg      # auto-created mesh is a SHARING mesh
```

Without `--push-to`, an auto-created mesh is **local-only** (the personal
default). This is uniform — there is no longer a `personal`-only special-case
and no `home-mesh-not-found` refusal.

### Aliases (pod-local)

```bash
lyt alias ro company/company-ro   # bind `ro` → the vault's rid
lyt capture --vault ro            # use it anywhere a vault is taken
lyt alias --list
lyt alias --remove ro
```

An alias keys on the vault's **rid**, so it survives `rename` and `move`.
Aliases are **pod-local**: synced across your own pod's machines, never to
subscribers.

### Main vault locked to `main`

`lyt vault rename` refuses any vault named `main`, refuses any TO-name of
`main`, and refuses any path under `<mesh>/main`. This is structural — agents,
marketing, and users can rely on "the main vault of mesh X is at `X/main`"
without ambiguity.

## Cross-mesh links — edges vs subscriptions

A mesh can reference vaults that live in OTHER meshes. There are two shapes:

| Form                                    | Relationship                         | Rollup propagates?                      | Searchable in referencing mesh? |
| --------------------------------------- | ------------------------------------ | --------------------------------------- | ------------------------------- |
| **Edge** (`@MESH_EDGE`, in mesh.yon)    | Parent-child between two vaults      | Yes — keywords propagate child → parent | Yes                             |
| **Subscription** (ledger record)        | Flat reference, no tree relationship | No                                      | Yes                             |

CLI verbs (subscriber-side):

```bash
lyt mesh add-edge --child <ref-vault> --parent <home-vault-in-this-mesh>
lyt mesh subscribe --vault <ref-vault>
```

Both are gated on **write-access to the referencing mesh** (the main vault's
GH repo). The referenced vault's home mesh is NOT consulted — the trust
boundary is "if you can clone it, you can reference it."

### Asymmetric awareness (the scalability win)

A vault has exactly one home mesh — recorded in its OWN `vault.yon`. Other
meshes referencing it write the reference in their OWN `mesh.yon`. The
referenced vault is unaware of its referencers.

This is the scalability moat: a popular public vault might be referenced by
10,000 subscribers, but the publisher's `mesh.yon` stays `O(home_vaults)`,
not `O(subscribers)`. Same trick works at every scale — your `alex/main`
doesn't grow when your team `marlink/main` parents 50 vaults under it.

## Moving vaults between meshes — `lyt vault move`

```bash
lyt vault move <name> --to-mesh <target-mesh>            # default: branch
lyt vault move <name> --to-mesh <target-mesh> --branch   # move children too
lyt vault move <name> --to-mesh <target-mesh> --solo     # leave children behind
```

The vault's UUIDv7 **rid is stable** across the move — only its membership
changes. The source mesh.yon loses its `@MESH_HOME`; the target gains one;
child `@MESH_EDGE` rows re-root onto the new home. Atomic via tmp+rename on
both mesh.yon files plus a single registry transaction. After committing, the
move **reads back** the registry row and only reports a clean success when the
home-mesh assignment actually landed; an unverified outcome is flagged
`(unverified — run lyt vault list)`, so a reported success always reflects
committed state. Because the displayed `{mesh}/{vault}` name is computed from the home
mesh, `lyt vault list` reflects the move immediately.

## Cloning into another mesh — `lyt vault clone --to-mesh`

```bash
lyt vault clone <source-name> --to-mesh <target-mesh>
```

Unlike `move`, `clone --to-mesh` mints a **fresh rid** for the new copy. The
source vault is untouched; the target mesh's mesh.yon gains a new `@MESH_HOME`.
Use this when you want a divergent copy; use `move` when you want to preserve
identity.

## Multi-mesh init via `lyt init`

`lyt init` is idempotent + re-runnable. Three branches, picked by current state:

- **Fresh** — no local registry → creates `personal` mesh + `personal/main`
  vault + federation repo (local, not pushed). `lyt init --auto` (the default)
  asks no questions.
- **Re-init** — registry already has meshes/vaults → runs a read-only integrity
  probe. Reports any vault whose path is missing or whose `vault.yon` doesn't
  parse. Exit 0 unless ALL vaults fail.
- **Discovery** (`--discover`) — read-only mode. Surfaces GH repos that look
  like Lyt vaults but aren't in your registry. ZERO writes. Use `lyt mesh
join <name> --from <gh-target>` to adopt.

`lyt init --custom` runs a 3-prompt walkthrough (mesh name + push target +
starter content; the main vault name is locked to `main`).

## See also

- `lyt help mesh` — `lyt mesh init/join/list/rebuild-registry` verbs.
- `lyt help mesh-yon` — the `mesh.yon` SoT format + round-trip contract.
- `lyt help federation` — Your Pod (federation repo) + cross-mesh aggregation.
