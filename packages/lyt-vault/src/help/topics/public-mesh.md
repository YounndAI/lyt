# Public meshes — federating community knowledge bases

A **public mesh** is a Mesh whose main vault and home vaults are public
GitHub repos — anyone with internet access can clone and federate it.
Open-source documentation, public team handbooks, community wikis, research
notebooks, regulatory references, course materials — anywhere structured
markdown lives in Git, it can be published as a public mesh.

> Run `lyt help multi-mesh` for the underlying vault/mesh/federation model.
> Run `lyt help mesh` for the mesh CLI verbs.

## Why federate instead of scrape

Static documentation sites are read-only HTML. A Lyt public mesh is a
**graph your agent can edge-link from your own notes**. After federation:

- `lyt search` hits the public mesh's content as native, not RAG-scraped.
- `lyt mesh add-edge --child <public-vault> --parent <my-vault>` propagates
  rollup keywords from the public source into your private structure.
- The mesh's primer file becomes part of your agent's grounding context.
- `@STAMP` provenance survives extraction — you can always trace
  _"this Figment came from `acme-public/handbook` at commit Y."_

Per [the LYT design doc `lyt-public-mesh.md`](.) §0:
the publisher's existential risk is zero (markdown-in-Git survives anything);
the subscriber's grounding is rich (federated graph, not scraped HTML).

## Discovering a public mesh (v1)

In v1 there is no Lyt-hosted directory. Discovery rides GitHub:

```bash
# GitHub topic search — every published mesh sets the lyt-public topic
gh search repos --topic lyt-public --limit 50

# Or: lyt init --discover (read-only) surfaces GH repos that look like
# Lyt vaults but aren't in your local registry
lyt init --discover
```

Publishers may also share the discovery URL directly
(`https://github.com/{org}/{mesh}-main`).

A v2 Bridge-era hosted directory is planned but never required — discovery
stays GitHub-native by design.

## Federating a public mesh

Subscriber-side, treat it like any other mesh:

```bash
# Subscribe — flat reference, content cloned locally, included in search
lyt mesh subscribe --vault acme-public/handbook                    # v1.C.2

# Or add as parent-child — rollup propagates INTO your federation
lyt mesh add-edge --child acme-public/handbook --parent my/main    # v1.C.1

# Or join the entire mesh (mirrors every home vault)
lyt mesh join acme-public --from acme
```

Subscription writes a `@MESH_SUBSCRIPTION` record into YOUR OWN `mesh.yon`
— never into the publisher's. Per the asymmetric awareness invariant
(`lyt help multi-mesh`), the publisher is unaware of you. This is the
scalability moat: 10,000 subscribers do not bloat the publisher's SoT.

## What you can rely on

- **Read access** is GitHub-native — public repo = anyone with internet can
  clone.
- **License posture** rides the publisher's `LICENSE` file. `lyt vault info
<public-vault>` surfaces the detected license. Consumers honour it.
- **Provenance** — `@STAMP` records inside the public mesh's content survive
  federation. Extracted Figments carry attribution back to the source vault +
  commit + ts.
- **Update cadence** — the publisher may declare an `@UPDATE_CADENCE` record
  (v1.A.3 schema) telling subscribers how often to pull. Subscribers can
  override locally.

## Sharp edges

- **Secret leakage.** A misconfigured public mesh containing `.secret`,
  `credentials`, `.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` files
  is publicly readable. Publishers should run a hygiene check before going
  public; consumers should never assume the publisher did. See "Sharp edges"
  in [the LYT design doc `lyt-public-mesh.md`](.) §6.
- **Drift.** Standard `lyt sync` model — Git pulls from origin; your local
  index regenerates. Pinned subscriptions (`--pin-commit <sha>`, v1.5) skip
  drift entirely; useful for regulatory or academic citations.
- **Federation-primer leakage.** If you subscribe to many public meshes,
  your federation primer absorbs content from all of them. Use `--browse-only`
  (v1.D.4) to exclude a mesh from primer scope.
- **License collisions.** When a copyleft public mesh federates into a
  permissive parent (or vice versa), warnings will surface at federation
  time (v1.B.6+).

## Publishing a public mesh

Publisher-side verbs ship in **v1.B.6** as a coherent unit:

- `lyt mesh publish <mesh>` — sets the GH `lyt-public` topic, validates
  `LICENSE`, runs `lyt doctor public_mesh_hygiene`, emits the canonical
  discovery URL.
- `lyt doctor public_mesh_hygiene` — warns (or `--strict` hard-fails) on
  `.secret`, `credentials`, `.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `id_rsa*` patterns inside a public mesh.
- `lyt mesh info <public-mesh> [--remote]` — surfaces `@MESH_PUBLIC`
  metadata without requiring a full clone; `--remote` peeks via `gh api`.
- `lyt vault update-cadence <vault>` / `lyt mesh update-cadence <mesh>` —
  publisher-side CLIs for setting `@UPDATE_CADENCE` records.
- License-aware federation warnings — comparing subscriber license posture
  against the federated mesh's `LICENSE`.

In v1.B.5 (the current phase) these verbs are not yet available. Publishing
today: create the mesh with `lyt mesh init <name> --push-to <org>`, push it
to GitHub, set the `lyt-public` topic manually via `gh repo edit`, and
share the URL.

## See also

- `lyt help multi-mesh` — vault/mesh/federation model.
- `lyt help mesh` — mesh CLI verbs.
- `lyt help mesh-yon` — the `mesh.yon` SoT.
- `lyt help federation` — Your Pod (per-user federation repo).
- [the LYT design doc `lyt-public-mesh.md`](.) — canonical specification (§1 + §2 + §4 + §6).
- [the LYT design doc `lyt-federation-design.md`](.) §8.5 — public meshes as the demanding test of asymmetric awareness.
