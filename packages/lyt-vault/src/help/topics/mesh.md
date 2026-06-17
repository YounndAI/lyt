# `lyt mesh` — meshes of vaults (v1.B.1)

> v1.B.1 update — the v0.x manifest-driven `lyt mesh init --from <manifest>` +
> `lyt mesh clone-all` shape has been **superseded** by the per-mesh verbs
> below. See "v1.B.1 multi-mesh verbs" first. The v0.x manifest section at the
> bottom is retained as a historical reference until the manifest verb is
> removed.

## v1.B.1 multi-mesh verbs

| Verb                                                    | What it does                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `lyt mesh init <name> [--push-to <target>] [--no-push]` | Provisions a new mesh + scaffolds its `<name>/main` vault + writes initial `mesh.yon`.                    |
| `lyt mesh join <name> --from <gh-target>`               | Joins an existing mesh from a GitHub source. Clones the main vault, reads `mesh.yon`, registers locally.  |
| `lyt mesh list [--json]`                                | Lists meshes the user participates in; `★` marks each mesh's main vault.                                  |
| `lyt mesh rebuild-registry [--mesh <name>] [--json]`    | Re-derives the per-machine registry tables from every `mesh.yon` SoT on disk. Safety net for cache drift. |

Run `lyt help multi-mesh` for the underlying vault/mesh/federation model
and `lyt help mesh-yon` for the `mesh.yon` source-of-truth format. The v0.x
manifest section below stays as a historical reference.

A **mesh** is a named group of vaults sharing a GitHub push target. Every
vault belongs to exactly one mesh — its **home mesh** — and the mesh's
source-of-truth lives in the main vault's `.lyt/mesh.yon`.

> Mesh names are bare (`alex`, `younndai`, `marlink`). The vault name
> shape is `{mesh-name}/{vault-name}`. The main vault of every mesh is
> named `main`, immutable.

## The shape

```text
~/lyt/
├── registry.db                ← meshes + mesh_vaults + vaults (per-machine cache)
└── vaults/
    └── <mesh>/
        └── main/              ← cloned from github.com/<gh-target>/main
            └── .lyt/
                ├── vault.yon  ← @VAULT (vault SoT)
                └── mesh.yon   ← @MESH + @MESH_HOME (mesh SoT — main vault only)
```

`mesh.yon` (v1.B.1 initial-state shape; @MESH_EDGE writer ships v1.C.1,
@MESH_SUBSCRIPTION writer ships v1.C.2):

```text
@DOC ver=2.0 | id=mesh:<dashed-uuidv7> | title="<mesh-name>" | domain=yai.lyt@1.0 | kind=cfg | profile=agent

@MESH rid=mesh:<dashed-uuidv7>
  | name="<mesh-name>"
  | push_target="<gh-handle-or-org>"
  | push_kind=handle|org
  | main_vault_rid=vault:<dashed-uuidv7>
  | created_at:ts=2026-05-29T...

@MESH_HOME mesh_rid=mesh:<dashed-uuidv7>
  | vault_rid=vault:<dashed-uuidv7>
  | vault_name="<mesh-name>/main"
```

## Verbs

### `lyt mesh init <name> [--push-to <gh-target>] [--push-kind handle|org] [--parent <existing-mesh>] [--no-push] [--json]`

**Provisions a new mesh** + scaffolds its main vault (`<name>/main`).
Validates `<name>` against the mesh-name slot rules (bare, slug-safe,
no `/`, no Windows-reserved names). Writes initial mesh.yon with one
`@MESH` and one `@MESH_HOME` record.

`--parent <existing-mesh>` records a cross-mesh parent link — the new
main vault's `parent_vault` BLOB FK resolves to the parent mesh's main
vault rid. Useful for building hierarchies that span meshes (e.g.
`personal` mesh hanging off `alex/main` as parent).

`--no-push` keeps everything local (mesh.yon still ships in the working
tree; the registry row still lands).

### `lyt mesh join <name> --from <gh-target> [--clone-members] [--json]`

**Joins an existing mesh** from a GitHub source. Clones the main vault
repo from `github.com/<gh-target>/main`, reads its `.lyt/mesh.yon`, and
registers the mesh + main vault locally. Additional home vaults listed
in the mesh.yon are registered if already present locally; missing ones
are counted as deferred-clone (v1.B.3 wires `--clone-members` cascading
clone).

### `lyt mesh list [--json]`

Lists the meshes the user participates in. Each mesh's home vaults
are listed under its name; the main vault gets a `★` marker.
Ordering is deterministic: `created_at` ascending then `name`.

`--json` mode emits the canonical
`{ meshes: [{ rid_hex, name, push_target, push_kind, main_vault, home_vaults, subscribed_vaults }] }`
shape.

## Example — Alex's four-mesh validation

```bash
lyt registry reset --yes
lyt mesh init alex      --no-push                       # mesh "alex"     + vault "alex/main"
lyt mesh init personal  --parent alex --no-push         # mesh "personal" + vault "personal/main"
                                                        # personal/main.parent_vault → alex/main.rid
lyt mesh init younndai  --no-push                       # mesh "younndai" + vault "younndai/main"
lyt mesh init marlink   --no-push                       # mesh "marlink"  + vault "marlink/main"
lyt mesh list --json                                    # 4 meshes, 4 home vaults
```

## What v1.B.1 does NOT ship

- `lyt mesh add-edge` — parent-child edges in `mesh.yon` (v1.C.1).
- `lyt mesh subscribe` — flat cross-mesh references (v1.C.2).
- `lyt mesh validate` / `lyt mesh fsck` — read-only/write-mode diagnostics (v1.B.2 + v1.C.4).
- `lyt mesh rebuild-registry` — regenerate registry tables from mesh.yon SoT (v1.B.2).
- `lyt mesh adopt --cluster` — orphan-mesh recovery (v1.C.3).
- `lyt vault rename` (and the main-vault immutability guard at the rename surface) — v1.B.3.
- `@younndai/yon-parser` dep for mesh.yon — v1.A.3 (hand-rolled until then).

## See also

- `lyt help federation` — Your Pod (the per-user federation repo).
