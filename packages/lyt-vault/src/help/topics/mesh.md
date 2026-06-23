# `lyt mesh` — meshes of vaults

A **mesh** is a named group of vaults sharing a GitHub push target. Every vault
belongs to exactly one mesh — its **home mesh** — and the mesh's source-of-truth
lives in the main vault's `.lyt/mesh.yon`.

> Mesh names are bare (`alex`, `younndai`, `marlink`). The vault name shape is
> `{mesh}/{vault}`. The main vault of every mesh is named `main` and is immutable.

Run `lyt help multi-mesh` for the underlying vault/mesh/federation model and
`lyt help mesh-yon` for the `mesh.yon` source-of-truth format.

## Verbs

| Verb                                                    | What it does                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lyt mesh init <name> [--push-to <target>] [--no-push]` | Provision a new mesh + scaffold its `<name>/main` vault + write the initial `mesh.yon`.                 |
| `lyt mesh join <name> --from <gh-target>`               | Join an existing mesh from a GitHub source — clone the main vault, read `mesh.yon`, register locally.   |
| `lyt mesh list [--json]`                                | List the meshes you participate in; `★` marks each mesh's main vault.                                   |
| `lyt mesh info <mesh> [--remote] [--json]`              | One mesh's members + metadata. `--remote` peeks at the published `mesh.yon` via `gh` without cloning.   |
| `lyt mesh status`                                       | Graph view of every registered vault and its edges.                                                     |
| `lyt mesh subscribe --vault <mesh>/<vault> --from-mesh <mesh>` | Clone-on-subscribe a vault from another mesh; subscribed content joins mesh-scoped search.        |
| `lyt mesh add-edge --parent <a> --child <b>`            | Declare a parent/child rollup edge between vaults.                                                       |
| `lyt mesh validate`                                     | Parse every `mesh.yon`; report broken edges, tombstone collisions, missing parents (read-only).         |
| `lyt mesh adopt`                                         | Recover an orphan mesh (a mesh on disk with no registry record) back into the registry.                 |
| `lyt mesh rebuild-registry [--mesh <name>]`             | Re-derive the per-machine registry tables from every `mesh.yon` on disk. Safety net for cache drift.    |
| `lyt mesh rebuild-rollup <mesh>`                        | Recompute cross-vault activity rollups.                                                                  |
| `lyt mesh canvas`                                       | Generate a JSON-Canvas view of the mesh for visual editors.                                             |
| `lyt mesh clone-all [--source <name>] [--dry-run]`      | Idempotent clone-or-pull of every configured vault source — stand up a machine in one verb.             |

`lyt mesh validate` is read-only; `lyt repair --apply` is the write side that
heals broken edges, broken subscriptions, `mesh.yon` parse errors (restore from
Git), and orphan vaults. See `lyt help troubleshooting`.

## The shape

```text
~/lyt/
├── registry.db                ← meshes + mesh_vaults + vaults (per-machine cache)
└── vaults/
    └── <mesh>/
        └── main/              ← cloned from github.com/<gh-target>/main
            └── .lyt/
                ├── vault.yon  ← @VAULT (vault SoT)
                └── mesh.yon   ← @MESH + @MESH_HOME + @MESH_EDGE (mesh SoT — main vault only)
```

The registry is a per-machine cache; the `mesh.yon` files on disk are the source
of truth. `lyt mesh rebuild-registry` re-derives the cache from them.

## `lyt mesh init`

```bash
lyt mesh init <name> [--push-to <gh-target>] [--push-kind handle|org] \
              [--parent <existing-mesh>] [--no-push] [--json]
```

Provisions a new mesh and scaffolds its main vault (`<name>/main`). Validates
`<name>` against the mesh-name rules (bare, slug-safe, no `/`, no Windows-reserved
names). `--parent <existing-mesh>` records a cross-mesh parent link (the new main
vault's parent resolves to the parent mesh's main vault). `--no-push` keeps
everything local.

## `lyt mesh join`

```bash
lyt mesh join <name> --from <gh-target> [--clone-members] [--json]
```

Clones the main vault repo from `github.com/<gh-target>/main`, reads its
`.lyt/mesh.yon`, and registers the mesh + main vault locally. `--clone-members`
cascades the clone to the mesh's other home vaults.

## Example — a four-mesh setup

```bash
lyt mesh init alex      --no-push                  # mesh "alex"     + vault "alex/main"
lyt mesh init personal  --parent alex --no-push    # mesh "personal" + vault "personal/main"
lyt mesh init younndai  --no-push                  # mesh "younndai" + vault "younndai/main"
lyt mesh init marlink   --no-push                  # mesh "marlink"  + vault "marlink/main"
lyt mesh list --json                               # 4 meshes, 4 home vaults
```

## See also

- `lyt help federation` — Your Pod (the per-user federation repo).
- `lyt help public-mesh` — publishing and subscribing across pods.
- `lyt help multi-mesh` — the full vault/mesh/federation model.
