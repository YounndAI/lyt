# Changelog — Lyt (Link Your Think™)

All notable changes to the Lyt packages are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [0.20.23] — 2026-08-04

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.22] — 2026-08-03

### Changed

- Fixed `lyt mesh init` on an existing pod by checkpointing only pod files the operation actually rewrites, while preserving exact-path concurrency guards.
- Surfaced the deepest receipt-safe creation failure cause and made `lyt vault init` enumerate every checkpoint repository, commit, and path it mutates.
- Made local creation checkpoint commits truthful across vault, mesh-main, and pod repositories.
- Required `--yes` for `lyt vault delete` and made `lyt housekeep` preview-only unless `--apply` is explicit.
- Restored the root and all seven package `LICENSE` files to the exact, unmodified Apache License 2.0 text; MARLINK attribution remains in `NOTICE`.

---

## [0.20.21] — 2026-08-03

### Changed

- Corrected managed agent-manual provider payloads to bind their digest to the exact marker block and preserve one terminal newline when composing a fresh file, allowing `lyt update` reconciliation to apply the sealed manual safely.

---

## [0.20.20] — 2026-08-02

### Changed

- Corrected the install-provider manual digests so existing Lyt installations can validate and apply the sealed update through `lyt update`.

---

## [0.20.19] — 2026-08-02

### Changed

- Prevented `lyt undo` from reaching through a newer pattern write and silently deleting an older captured Figment.
- Made sync and restore establish a per-command Git identity fallback when a fresh machine has no configured author, while preserving configured identity and reporting commit failures instead of claiming a false save.
- Corrected the generated agent manual so one-vault recall routes through `/lyt-recall` and its real `lyt search --vault` implementation.

### Known limitation

- `lyt mesh init` can fail before mutation with an over-generic diagnostic on current installations. This release does not claim to repair mesh creation; the diagnostic and root-cause repair are the immediate fix-forward.

---

## [0.20.18] — 2026-08-02

### Changed

- Accepted deterministic UUIDv8 operation and entity identities at their persisted read boundaries while keeping genuinely clock-derived attempt, machine, writer, and release identities strict UUIDv7.
- Corrected `lyt doctor` to recognize current per-writer audit and provenance ledger shards, preserving legacy flat-ledger compatibility and real source-loss warnings without falsely reporting healthy vaults as damaged.

---

## [0.20.17] — 2026-08-02

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.16] — 2026-07-31

### Added

- Added `lyt vault files` for read-only Markdown inclusion, index, frontmatter, and stale-cache inventory.
- Added sealed preview/apply receipts for `lyt vault backfill` and `lyt vault reconcile`, with explicit drift refusal and partial-mutation reporting.
- Added durable mesh and subscription retraction so a local rebuild does not resurrect a retired relationship.
- Added independent direct-result and meaning-candidate budgets, labelled result groups, retrieval-method provenance, bounded frontmatter projection, and exact-title retrieval.

### Changed

- Made the untagged `latest` channel the normal install; `@alpha` remains the opt-in preview channel while Lyt retains its public-alpha maturity label.
- Raised the default search maximum from 20 to 30: 20 lexical/structural results plus up to 10 additional meaning-only candidates.
- Corrected the prior sparse-result behavior: 0.20.15 could run meaning retrieval silently, without a separate cap or label, when keyword results were scarce. 0.20.16 labels and bounds those candidates instead of describing meaning search as simply off.
- Hardened scoped sync truth, resumable conflict handling, post-push readback, and first-publication planning. The `creation-plan.ts` correction is a separate creation-path change, not part of search.

### Verification and known limits

- The packed MCP entrypoint will be covered by release dogfood before publication, but its source-suite unit/typecheck command was not executed because this worktree's nested dependency remained stale; that dependency was not mutated inside the unbanked release tree.
- Meaning candidates do not use an absolute score floor. Live populated-pod evidence showed relevant and irrelevant cosine scores interleaving, so the Handler-approved contract uses a bounded, separately labelled, metadata-only candidate group with a standing not-confirmed-match caveat instead of an unreliable threshold.
- Five search follow-ups remain carried to 0.20.17: compatibility-result re-merge caveats, truthful direct-result labelling for structural rows, `meaningLimit: 0` corroboration semantics, stricter metadata-projection enforcement, and test hygiene.
- Vault public/private transition is not part of 0.20.16 and is not claimed here. It remains deferred to 0.20.17 for a dedicated disposable-account rig and explicit Handler readback.

## [0.20.15] — 2026-07-24

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.14] — 2026-07-24

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.13] — 2026-07-23

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.12] — 2026-07-23

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.11] — 2026-07-23

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.10] — 2026-07-22

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.9] — 2026-07-22

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.8] — 2026-07-22

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.7] — 2026-07-21

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.6] — 2026-07-21

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.5] — 2026-07-21

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.4] — 2026-07-21

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.3] — 2026-07-21

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.2] — 2026-07-21

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.1] — 2026-07-21

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.20.0] — 2026-07-19

### Changed

- Stabilized lifecycle operations, update/reconciliation, editor localization, and the exact seven-package release contract.

---

## [0.13.5] — 2026-07-17

### Fixed

- **Existing-pod re-init** — refresh the online pod manifest before recovery, acquire newly advertised vaults, and never create a stale local pod commit during re-init.
- **Quoted Git paths** — decode porcelain-quoted filenames before staging so global sync handles deleted files whose paths contain spaces or escaped characters.

---

## [0.13.4] — 2026-07-17

### Fixed

- **Scoped first publication on legacy pods** — inherit the configured mesh push target during an explicit one-vault sync even when old ownership provenance is stale; GitHub authorization remains the final permission gate.
- **Cross-machine discovery after publication** — publish the federation ledger and pod manifest immediately after a successful scoped first publication so another machine can acquire the new vault.

---

## [0.13.3] — 2026-07-17

### Fixed

- **Scoped sync of existing vaults** — recognize a verified existing Git remote on legacy joined meshes without granting authority to create new repositories.
- **Clean-machine adoption** — reflect committed index metadata instead of rewriting tracked lane/arc files, and report manifest-recovered vaults in `vaultsAcquired`.
- **Agent bootstrap** — direct non-interactive agents to `lyt init --auto --json`; plain `lyt init` remains the Handler-driven wizard.

---
## [0.13.2] — 2026-07-17

### Fixed

- **Clean-machine pod recovery** — preserve pod-manifest vault identities and mesh creation timestamps instead of creating duplicate vault records.
- **Existing-pod adoption** — absorb the cloned pod without creating an ahead commit, migration-ledger dirt, fresh-pod demo/pod-map state, or a publication prompt; label the resolved vault with its actual mesh.

---

## [0.13.1] — 2026-07-17

### Fixed

- **Fresh-machine pod recovery** — an owned mesh may use any name while targeting a personal account or organization. Recovery now authenticates legacy organization targets that were recorded as `push_kind=handle`, normalizes them to `org`, and preserves fail-closed handling for unverified owners.

---

## [0.13.0] — 2026-07-17

Reliable team use across machines, with an editor-neutral vault format, safe scoped first publication, and a deliberately small programmatic lifecycle-hook surface. The unreleased `0.12.2` candidate is included here; no `0.12.2` package was published.

### Added

- **Small lifecycle hooks.** `@younndai/lyt-vault` exports caller-supplied `afterOperation` and `doctorChecks` callbacks for programmatic composition. They are in-process and opt-in: Lyt does not discover, register, authorize, spawn, or otherwise understand consuming layers.
- **Selective skill installation.** `lyt skills install <name...>` installs only the named bundled skills and deterministically rejects unknown names; calling it without names still installs the complete bundle.
- **Editor-neutral creation** — `lyt vault init` supports JSON, defaults to an editor-neutral scaffold, and creates `.obsidian/` only with explicit `--template obsidian-default`; its receipt names the exact scoped sync follow-up and confirms init made no online change.
- **Scoped first publication** — `lyt sync --vault <vault>` uses an owned mesh's trusted target to create the exact missing private repository, attach the remote, establish the first upstream, and publish only that vault; genuine local/no-target vaults remain local.

### Fixed

- **Second-machine reconstruction** — legacy joins resolve their declared organization owner, clones are homed into the intended mesh, reconstruction failures reach the process exit code, and machine-local repair no longer dirties tracked `.lyt/agents.md`.
- **Main-vault lifecycle safety** — delete, forget, and abandon refuse a mesh main vault; verification reports a missing main vault rather than silently tombstoning it.
- **Remote and ownership hardening** — publication rejects mismatched origins, revalidates immediately before push, and authenticates claimed user or organization ownership before remote creation or writes.
- **Truthful sync outcomes** — scoped JSON and quiet mode distinguish published, already-online, local-only, held, read-only, deferred, origin-mismatch, and incomplete outcomes and preserve failure in the exit code.
- **Local-only sync isolation** — `--no-publish` performs no network discovery, fetch, remote creation, or push.
- **Origin validation before network writes** — scoped sync validates the expected origin before both fetch and push, refusing mismatches.
- **Adopted pod validation** — malformed `pod.yon` input is refused instead of being accepted into recovery.

### Changed

- **Truthful skill documentation** — `lyt help skills` documents the real `lyt skills` command tree, supported runtimes, selective installation, and stable exit behavior.
- **Public artifact compliance** — package tarballs carry `LICENSE`, `NOTICE`, `CONTRIBUTING.md`, and `SECURITY.md`, use the correct prominent Lyt mark, and stamp required headers into shipped JavaScript.
- **Maintained tar extraction** — Lyt's direct `tar` dependency is upgraded to maintained 7.x.

---

## [0.12.1] — 2026-07-14

Reliability follow-up for multi-machine and team use. This release preserves pod ownership during reconstruction, gives received vaults a clean home, and adds stricter identity checks before remote state is adopted.

### Added

- **`lyt vault accept-share`.** Accept a GitHub vault invitation, place the received vault under `shared/{owner}`, and index it immediately. Read-write receives retain the same junction-safety boundary as the rest of the pod.
- **`lyt mesh prune`.** Remove empty or orphan mesh records only when the durable ledger and registered foreign-vault state prove that a rebuild will not recreate them; otherwise the command refuses and explains why.

### Fixed

- **Ownership-preserving reconstruction.** `lyt init` and `recover-pod` restore owned meshes and vaults from the manifest instead of reclassifying them as joined state, and clone owned vaults from the recorded push target. Ambiguous ownership fails closed and write-back cannot let a foreign winner overwrite the owner record.
- **Received-vault routing.** Shared and subscribed vaults derive their owner bucket from the origin coordinate, reject masquerading origins, and reuse one indexing path after receive.
- **Manifest identity safety.** Remote pod manifests are semantically validated before adoption, `push_target` handles are shape-checked, and the pod repository itself cannot be shared, subscribed, or accepted as a vault. A refused manifest now stops every init/adopt caller cleanly and restores a rename-aside local pod.
- **Clock-skew visibility.** Implausibly future-dated federation records are surfaced for diagnosis while normal last-writer-wins convergence remains available.

---

## [0.12.0] — 2026-07-13

Reliability for multi-machine and team use — the integrity and receive floor. How you write and search is unchanged; this makes a pod converge correctly across machines and receive shared/subscribed vaults cleanly, ahead of open testing.

### Added

- **Cross-machine convergence.** A vault's federation state is now a per-writer, time-ordered (HLC) record set that converges by last-writer-wins. Renames and moves author their own records, so edits made on different machines reconcile deterministically instead of flip-flopping — and the git-tracked state, not a local cache, is the source of truth.
- **Receive & scoped sync.** Clean receive of shared and subscribed vaults into their own homes, `lyt sync` scoped to a single vault, and a reparse-safe `leave` that never follows a junction out of your pod.
- **Actionable connect.** Connecting a local pod to an existing remote renames your local home aside, adopts the remote fresh, and funnels your notes back in through the import flow — fail-closed, nothing deleted.
- **Clear conflict & access handling.** A concurrent-write conflict offers plain keep-mine / keep-theirs / keep-both; a revoked subscription says "access removed" in plain language and recovers automatically when access returns.

### Fixed

- **Crash containment on unsupported machines.** A native embeddings crash is now contained by a one-time out-of-process capability probe — search falls back to lexical cleanly instead of taking the process down.
- **Data-safety hardening.** Corrupt-database detection in `lyt doctor`/`repair`, migration replay safety, and a guard against clobbering a vault with no resolvable home.

---

## [0.11.0] — 2026-07-07

Reliability-floor release — a safe-write spine plus a deliberately smaller, unopinionated surface. How search and federation behave is unchanged; this hardens the write path and trims Lyt down to focused primitives.

### Added

- **`lyt undo`** — reverses the last vault-writing operation (currently `lyt capture`) from an on-disk operation log. It validates the target against the registry and refuses to follow symlinks, so an undo can never write outside the vault it recorded.
- **Plain-language git errors across `lyt sync`.** When a sync hits a git problem (no remote, auth, conflict, detached state), Lyt explains it in plain language and tells you what to do — no raw git output — and records it to an audit log. `lyt sync --check` reports the same way.
- **Stay current — `lyt outdated` + `lyt update`.** Check whether a newer Lyt is published and install it (confirmation-gated). `lyt doctor` and `lyt init` surface a one-line currency check; an unreachable registry is reported, never an error.
- **`lyt vault adopt`** — bring an existing Obsidian vault into your pod additively (creates `.lyt/`, never touches your markdown), then registers, homes, links patterns, and indexes it so search/recall hit immediately.

### Changed

- **A smaller, unopinionated surface — 11 skills, 1 bundled pattern.** Removed the seven opinionated workflow skills (`/lyt-plan`, `/lyt-handoff`, `/lyt-insight`, `/lyt-decision`, `/lyt-progress`, `/lyt-result`, `/lyt-retro`) and the workflow patterns behind them (`work-management`, `decision-log`, `project-lifecycle`). Lyt now ships 11 focused skills and one bundled pattern — `knowledge-capture` (behind `/lyt-capture` + `/lyt-recall`). Opinionated workflow patterns are now bring-your-own via `lyt pattern install --from <dir>`: Lyt federates your markdown; it no longer imposes a workflow vocabulary.
- **Clearer writable vs publishable distinction.** `lyt vault info` separates whether a vault is locally writable from whether it is publishable (pushable), so an agent never blocks a local write on a remote/push condition.

---

## [0.10.0] — 2026-07-03

Frontmatter-contract release — every note's metadata is now correct at rest, enforced at write, and healable for legacy files, with optional tag/topic enrichment. No change to how search or federation behave.

### Added

- **Capture resolves where a note lands.** `lyt capture` now takes an explicit `--dir <vault-subdir>` (or an opt-in topic folder, else the default `notes/`), guarded fail-closed against escapes (`..`, `.lyt/`, `.git/`, the vault root). On an interactive terminal it offers your existing topics (recommended first, with an "other" escape) and always sets `topic:`.
- **`lyt vault backfill`** — fills missing frontmatter on existing notes (title, real dates, model-free tags, topic, defaults) in place, without moving files. `purpose` is left blank and flagged rather than guessed, and every machine-filled field is provenance-stamped so it stays distinguishable from what you authored.
- **`lyt vault reconcile [--apply]`** — scans every note against the index, flags files that are present-but-unindexed or missing frontmatter, and with `--apply` backfills then reindexes them. Drop a raw `.md` into a vault and it gets healed. Both verbs commit locally by default (`--push` to opt in).
- **`lyt doctor`** now detects and counts notes with missing or invalid frontmatter.
- **Optional tag & topic enrichment.** Notes get keyword tags with no model required, on any vault including a freshly imported one. When a local embedding model is present, capture and backfill additionally suggest a `topic:` (recommended, never auto-selected) ranked against your vault's _current_ on-disk topic labels. With no model, tags still fill and topic stays blank — nothing is ever sent off your machine, and an authored value is never overwritten.

### Changed

- **Real dates, not 1970.** Fresh vault seeds and backfilled notes now carry genuine created/modified dates (git history, falling back to file mtime) instead of the `1970-01-01` epoch placeholder that previously shipped to GitHub.
- **The frontmatter contract is taught from one source.** The agent manual and the capture skill render the 8-field contract from a single definition, so the guidance can't drift out of sync with what the tools enforce.

### Fixed

- **`lyt vault share` / `unshare` / `access` / `invites` now work.** The entire vault access/sharing verb family was non-functional in 0.9.9 — every invocation failed with `AccessProvider.grant/revoke requires a gh executor`, even with `gh` installed and authenticated. The CLI never wired a GitHub executor into the access provider, so it fell back to a guard that refused every call; it now defaults to the real `gh` executor (matching every other gh-backed command). Sharing a vault with a colleague, revoking access, and listing collaborators all work end-to-end, and the read-only `access` verb no longer fails through the grant/revoke path. The probe-free capture/sync write gate and the handler-confirmation (`--yes`) / MCP fail-closed guards are unchanged. Surfaced by a two-handler federation dogfood.

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
