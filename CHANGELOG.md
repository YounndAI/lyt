# Changelog — Lyt

All notable changes to the LYT packages are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [0.9.9] — 2026-07-01

Hardening release — reliability + agent-UX improvements to the local semantic-search pipeline. No new user-facing capability claim.

### Changed
- **The one-time local model download is now owned + observable.** The embedding-model fetch shows live download + embed progress, sends an honest `lyt/<version>` User-Agent, is cancellable, and is guarded by a hardened atomic lockfile so concurrent fetches can't collide.
- **Search never triggers a model download (read-never-fetches).** A search uses the semantic arm only when the model is already cached; otherwise it falls back to the byte-identical lexical path — it never phones home and never blocks a search on a download.

### Added
- **Discovery nudge.** A one-time, pod-global offer to enable meaning-based search ("find notes by meaning, not just keywords") via a local one-time setup — surfaced at most once per cadence, honors opt-out, and never sends anything off your machine.

---

## [0.9.8] — 2026-06-29

### Fixed
- **`/lyt-recall` no longer instructs filesystem grep.** It predated `lyt search` and told agents to discover vault content via the Grep tool; it now wraps `lyt search "<query>" --vault <name> --json` (the tiered-cascade engine). Surfaced by dogfooding a live Codex agent that string-searched a vault instead of searching it.
- **Stale skill-body claims corrected:** `lyt-mesh-explore` (`lyt mesh status` wrongly called nonexistent — it renders the mesh graph), `lyt-sync` orphan-vault recovery (`mesh adopt --cluster` → `lyt repair --target … --apply --mesh …`), `lyt-recall` vault-scope cascade tiers, and stale `lyt-search` cross-references.
- **Routing-collision disambiguators** across the search/pod/mesh-explore/primer/capture skills (incl. a `When NOT to invoke` block for `lyt-capture`).

### Added
- **Manual `[lyt.no-grep]` hard-negative:** the injected agent manual now bans filesystem discovery (`Grep`/`rg`/`find`/`Glob`/`Get-ChildItem`) of vault content — discovery goes through `lyt search`/`lyt recall` only. A behavioral class-fence independent of any skill body.
- **Build-time skill-body staleness lint** — gates the grep-discovery anti-pattern and ensures search-capability skills route through `lyt search`.
- **`lyt doctor` agent-manual freshness check** — warns when an installed manual's marker version lags the CLI version, with the `lyt agent-manual --install` remedy.

### Changed
- Coordinated monorepo version bump to 0.9.8 across the publish set + the Obsidian plugin manifest.

---
## [0.9.7] — 2026-06-27

Alpha update — release hardening, test-gate reliability, and scaffold-layout cleanup. No user-facing CLI or format changes beyond the `.lyt/` priming-file move below.

### Changed
- **Agent-priming files now scaffold under `.lyt/`.** New vaults write `agents.md` and `lyt-overview.md` into the vault's `.lyt/` system directory instead of the vault root, so the browsable vault tree carries only your README and notes. Existing vaults are migrated in place by `lyt repair --apply` (snapshot-first, idempotent); reads fall back to the legacy root location until migrated.
- **Release-publishing safeguards.** Every publish now passes a doc↔CLI accuracy gate, user-facing-string and staged-diff leak scans, doc-facts-asserted-from-source checks, and a safe multi-package version bump with publish-set version-equality enforcement.
- **Trustworthy, faster test gate.** The full suite was made deterministic (mock-dependent access tests isolated from shared single-fork pollution; git-integration timeouts raised) and split into `test:smoke` / `test:affected` / `test:release` tiers for a fast inner loop, with an orphan-reap + temp-sweep pre-gate step.

Published under the `alpha` dist-tag: `npm install -g @younndai/lyt@alpha`.

---
## [0.9.6] — 2026-06-23

Alpha update — Federation v2 (identity + governance), semantic search, and team sharing.

### Added
- **Semantic search — on-device, optional, on by default when available.** A small local embedding model reranks results to surface notes that keyword search misses (different words, same meaning). No cloud, never phones home; falls back to lexical search when the model isn't present. The one-time model download is prompted on an interactive terminal and never auto-fetched in scripted or MCP contexts. Disable with `--no-semantic` or `LYT_EMBEDDINGS=0`.
- **Smarter search** — agent query-expansion (an AI agent supplies domain terms to widen the search), keyphrase "aboutness" ranking, and faster parallel multi-vault search.
- **Team sharing & access** — `lyt vault share` / `unshare` / `access` / `invites`: grant and review per-vault access, gated through GitHub permissions. Sharing mutations are handler-gated and fail closed.
- **Vault aliases** — pod-local aliases (`lyt alias`) and origin coordinates resolve to a stable vault identity.

### Changed
- **Federation v2 — identity & governance re-architecture.** Per-vault stable identity (UUIDv7 `rid`), computed `{mesh}/{vault}` names, per-writer subscription and mesh-edge stores that converge across your machines, and handler-gated federation mutations.
- Hardened MCP error handling (internal paths no longer reach client-facing errors) and a corrected, accurate CLI/help surface.
- **BREAKING — `@younndai/lyt-vault` export `removeMeshEdge`**: signature narrowed from `(db, refMeshRid, refVaultRid, homeMeshRid, homeVaultRid, kind?)` to `(db, refVaultRid, homeVaultRid, kind?)`. Mesh-edge identity narrowed from the 3-tuple `(ref_mesh, ref_vault, home_vault)` to the 2-tuple `(ref_vault, home_vault)`; `ref_mesh` is now derived from the referenced vault's home mesh. External callers passing the dropped arguments positionally must update. Migration 006 rebuilds the `mesh_edges` cache (non-destructive — regenerated from the ledger).

Published under the `alpha` dist-tag: `npm install -g @younndai/lyt@alpha`.

---

## [0.9.5] — 2026-06-17

Alpha update — vault addressing & identity foundation, capture/upgrade reliability, packaging hygiene.

- **Vault addressing & identity** — stable per-vault identity, computed `{mesh}/{vault}` display names, a single resolution path, and vault aliases.
- **Reliability** — capture/recall fixed on upgrade; subscriber onboarding + duplicate-repo fixes; self-heal on init.
- **Packaging** — comment-free published builds; full license/notice coverage.

Published under the `alpha` dist-tag: `npm install -g @younndai/lyt@alpha`.

## [0.9.0] — 2026-06-12

Initial public alpha release of Lyt — the federated markdown-vault mesh.

Published under the `alpha` dist-tag: `npm install -g @younndai/lyt@alpha`.
