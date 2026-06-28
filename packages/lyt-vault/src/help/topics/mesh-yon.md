# `mesh.yon` — the mesh source of truth

A **mesh.yon** is the YON document that defines a mesh — its identity,
its home vaults, and its cross-mesh edges.
It lives at `.lyt/mesh.yon` inside the mesh's main vault, and only there.
(Cross-mesh **subscriptions** no longer live in mesh.yon — they moved to a
per-writer append-only **subscription ledger**; see below.)
The main vault's `mesh.yon` is the **only**
source of truth for what the mesh contains; everything else — the per-machine
`registry.db`, the `★ {mesh}/main` markers in `lyt vault list`, the
federation primer — is derived state that can be regenerated.

> Run `lyt help mesh` for the mesh CLI verbs and `lyt help multi-mesh` for the
> conceptual model (vault vs mesh vs federation).

## On-disk layout

```text
<mesh-main-vault>/
├── .git/
├── .obsidian/
├── .lyt/
│   ├── agents.md       ← AI-agent priming (under .lyt/)
│   ├── lyt-overview.md ← your identity page
│   ├── vault.yon       ← @VAULT (this vault's identity)
│   └── mesh.yon        ← @MESH + @MESH_HOME + @MESH_EDGE
│                         (this whole mesh's identity; only present in the main vault)
├── notes/
└── README.md
```

Non-main vaults in the mesh do NOT carry a `mesh.yon`. They link back to the
mesh via `@VAULT_HOME_MESH` inside their own `vault.yon`.

## The three record types

```text
@DOC ver=2.0 | id=mesh:<dashed-uuidv7> | title="<mesh-name>" | domain=yai.lyt@1.0 | kind=cfg | profile=agent

@MESH rid=mesh:<dashed-uuidv7>
  | name="<mesh-name>"
  | push_target="<gh-handle-or-org>"
  | push_kind=handle|org
  | main_vault_rid=vault:<dashed-uuidv7>
  | created_at:ts=2026-05-29T...

# Home vaults — the vaults this mesh OWNS
@MESH_HOME mesh_rid=mesh:<dashed-uuidv7>
  | vault_rid=vault:<dashed-uuidv7>
  | vault_name="<mesh>/<vault>"

# Edges — external vaults referenced as parent-child (rollup propagates)
@MESH_EDGE ref_mesh_rid=mesh:<dashed-uuidv7>
  | ref_vault_rid=vault:<dashed-uuidv7>
  | home_mesh_rid=mesh:<other-mesh-uuidv7>
  | home_vault_rid=vault:<other-vault-uuidv7>
  | kind=parent
```

| Record       | Role                                                             | Verb that writes it                                                         |
| ------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@MESH`      | The mesh's own identity (rid, name, push target, main vault rid) | `lyt mesh init`                                                             |
| `@MESH_HOME` | A vault this mesh owns                                           | `lyt vault init` / `lyt vault clone --to-mesh` / `lyt vault move --to-mesh` |
| `@MESH_EDGE` | A parent-child link to an external vault (rollup propagates)     | `lyt mesh add-edge`                                                         |

Hand-authored `@MESH_EDGE` records round-trip cleanly.

> **Subscriptions are no longer a mesh.yon record.** `lyt mesh subscribe`
> appends to a per-writer append-only **subscription ledger** (the source of
> truth), and the `mesh_subscriptions` cache is reconstituted from that ledger —
> mesh.yon is never written on subscribe.

## Round-trip preservation

The mesh.yon I/O surface guarantees two invariants:

1. **Structural round-trip:** `parseMeshYon(renderMeshYon(doc))` ≡ `doc` for any
   well-formed `MeshDoc`.
2. **Byte-identical re-render:** `renderMeshYon(parseMeshYon(file))` ≡ `file`
   when `file` was itself emitted by `renderMeshYon`. Hand-authored files that
   don't already match canonical ordering normalise on first re-render; the
   second pass is a fixed point.

This contract holds because the writer enforces **deterministic output**:

- Canonical key order inside each record (header → spec-order fields)
- `@MESH_HOME` records sorted by `vault_rid` ASC (hex-string lex)
- `@MESH_EDGE` records sorted by `(home_mesh_rid, home_vault_rid)` ASC

A second `renderMeshYon(...)` against the same `MeshDoc` produces byte-identical
output. Consumers can rely on `mesh.yon` files being machine-comparable across
machines and across time.

## The cache — `~/lyt/registry.db`

The per-machine registry caches mesh state for fast lookup:

- `meshes` ← `@MESH` (one row per mesh)
- `mesh_vaults` ← `@MESH_HOME` (one row per home vault)
- `mesh_edges` ← `@MESH_EDGE` (one row per edge)
- `mesh_subscriptions` ← reconstituted from the subscription **ledger** (one
  row per live subscription), not from mesh.yon

The cache is **regenerable**. If `registry.db` is deleted, hand-corrupted, or
falls out of sync with disk, the rebuild verb re-derives every row from the
mesh.yon SoTs:

```bash
lyt mesh rebuild-registry              # walks every registered mesh
lyt mesh rebuild-registry --mesh acme  # restricts to one mesh
```

`rebuild-registry` is purely **read-only** against mesh.yon files — it never
re-emits them. The disk SoT is authoritative; the cache catches up.

## Doctor checks

`lyt doctor` includes two checks that probe `mesh.yon` health:

- `mesh.yon.parses` — for each registered mesh, attempts `parseMeshYon` on its
  main vault's `mesh.yon`. Parse failure → `fail` with remediation
  `lyt mesh rebuild-registry --mesh <name>`.
- `markers.render` — verifies each mesh's `meshes.main_vault_rid` resolves to
  a real vault row, so `lyt vault list`'s `★ {mesh}/main` marker can render.

Run `lyt doctor` for the full check list.

## Not yet shipped

- `mesh.yon` auto-heal on sync conflicts — record-level merge is planned. Until
  then, resolve `mesh.yon` conflicts with Git and re-run `lyt mesh rebuild-registry`.

## See also

- `lyt help mesh` — the mesh CLI verbs.
- `lyt help multi-mesh` — the multi-mesh conceptual model.
- `lyt help federation` — Your Pod (federation repo) which lists every mesh.
