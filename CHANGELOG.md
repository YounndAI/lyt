# Changelog — Lyt

All notable changes to the LYT packages are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

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
