/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Client } from "@libsql/client";

import { listMeshes } from "./meshes-repo.js";
import { getAliasTargetRid } from "./aliases-repo.js";
import { getVaultByRid, listVaults } from "./repo.js";
import type { VaultRow } from "./repo.js";
import { resolveLeafRids, listGitUrlRids } from "./vault-index-repo.js";

// 0.9.4 (G — the addressing foundation). This module is the SINGLE
// resolver chokepoint: every handle a verb can be handed — a `{mesh}/{vault}`
// qualified name, a bare leaf, a pod-local alias, or a cross-pod
// `lyt:vault:` origin coordinate — resolves to a `rid` HERE and nowhere else.
//
// The `rid` is identity. `{mesh}/{vault}` is a COMPUTED display
// projection of `home_mesh_rid` + leaf — never trusted as a stored
// mesh-embedding string. That is the root fix for the move-bug: `move`
// updates `home_mesh_rid` transactionally; with the name computed from it,
// `vault list` reflects the move with no second write to keep in sync.

// ---------------------------------------------------------------------------
// Typed-id scheme — `lyt:<type>:<id>` (Stripe / purl pattern).
// Store the type as a real field; the prefix is for display / transport /
// logs ONLY. Never determine an entity's type by string-prefix-matching.
// ---------------------------------------------------------------------------

export type LytEntityType = "vault" | "mesh" | "pod" | "user" | "figment" | "pattern";

export interface TypedId {
  type: LytEntityType;
  id: string;
}

// Render a typed id for display / transport / logs.
export function formatTypedId(type: LytEntityType, id: string): string {
  return `lyt:${type}:${id}`;
}

// Parse a `lyt:<type>:<id>` surface back into its parts. Returns null when the
// string is not a typed id (so callers branch on structure, never on a bare
// `startsWith("lyt:")`). The id segment may itself contain colons (a coordinate
// like `github.com/owner/repo` does not, but be liberal): everything after the
// 2nd colon is the id.
export function parseTypedId(raw: string): TypedId | null {
  if (!raw.startsWith("lyt:")) return null;
  const rest = raw.slice("lyt:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const type = rest.slice(0, sep);
  const id = rest.slice(sep + 1);
  if (id.length === 0) return null;
  if (
    type === "vault" ||
    type === "mesh" ||
    type === "pod" ||
    type === "user" ||
    type === "figment" ||
    type === "pattern"
  ) {
    return { type, id };
  }
  return null;
}

// CANONICALIZE so two spellings of the same origin compare EQUAL.
// A coordinate is an IDENTITY key (it backs the cross-pod origin-coordinate
// resolver branch AND the subscription-ledger OR-Set fold), so it MUST be
// deterministic regardless of how the git URL was cased on the write vs the
// read side — otherwise `GitHub.com/Owner/Repo` and `github.com/owner/repo`
// would be treated as two distinct origins, splitting one upstream into two
// and breaking convergence.
//
//   - host: ALWAYS lowercased — DNS hostnames are case-insensitive.
//   - owner/repo: lowercased ONLY for KNOWN forges that treat the path as
//     case-insensitive (GitHub, GitLab, Bitbucket). For an unknown/self-hosted
//     host whose path casing MIGHT be significant, owner/repo are left verbatim
//     (conservative — never collapse two genuinely-distinct repos).
const CASE_INSENSITIVE_FORGES = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
]);

// Canonicalize an already-split `<host>/<owner>/<repo>` triple. The single
// shared rule used by BOTH the git-URL → coordinate path (write side) and the
// coordinate → coordinate path (deferred-E read/fold side), so the two can
// never drift. `repo` may itself carry deeper segments (collapsed by callers).
function canonicalizeTriple(host: string, owner: string, repo: string): string {
  const canonHost = host.toLowerCase();
  if (CASE_INSENSITIVE_FORGES.has(canonHost)) {
    return `${canonHost}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }
  return `${canonHost}/${owner}/${repo}`;
}

// Canonicalize an EXISTING bare coordinate string `<host>/<owner>/<repo>` (the
// `lyt:vault:` prefix already stripped). Returns null when the string is not a
// 3+-segment coordinate so the caller can pass it through unchanged.
function canonicalizeBareCoordinate(coord: string): string | null {
  // Trailing `.git` is a git-URL artifact, NOT part of repo identity, so it is
  // stripped from the canonical form. CASE-INSENSITIVE (`/i`): `.GIT`/`.Git`/`.git`
  // must ALL strip — a case-sensitive strip lets `.GIT` survive into
  // `canonicalizeTriple`, which lowercases it to a phantom `.git` suffix that the
  // git-URL side (which strips case-insensitively below) never carries, splitting
  // one identity into two non-convergent fold keys.
  const s = coord.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const segs = s.split("/").filter((p) => p.length > 0);
  if (segs.length < 3) return null;
  return canonicalizeTriple(segs[0]!, segs[1]!, segs.slice(2).join("/"));
}

// Normalize a git origin URL into the canonical cross-pod coordinate
// `<host>/<owner>/<repo>` (purl / Go-modules pattern). Strips the
// scheme, any `git@host:` SSH form, a trailing `.git`, and a trailing slash.
// Returns null when the URL can't be parsed into the 3-segment shape.
export function gitUrlToCoordinate(gitUrl: string): string | null {
  let s = gitUrl.trim();
  if (s.length === 0) return null;
  // SSH form: git@github.com:owner/repo(.git)
  const sshMatch = /^[^@]+@([^:]+):(.+)$/.exec(s);
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // https / http / git:// — strip the scheme + any userinfo@host part.
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    s = s.replace(/^[^/@]+@/, "");
  }
  // CASE-INSENSITIVE `.git` strip (`/i`): a `.GIT`/`.Git`/`.git` suffix is a
  // git-URL artifact, never part of repo identity, so all casings strip here —
  // matching `canonicalizeBareCoordinate` so the write side and the coordinate
  // side can never disagree on whether a `.git` suffix survives.
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const segs = s.split("/").filter((p) => p.length > 0);
  if (segs.length < 3) return null;
  // host / owner / repo — collapse any deeper path into the repo segment's
  // host/owner/repo (gh has exactly host/owner/repo; be strict at 3).
  // Canonicalization is delegated to the shared `canonicalizeTriple` so the
  // git-URL and coordinate-string paths apply the SAME rule (output is
  // byte-identical to the pre-extraction inline form).
  return canonicalizeTriple(segs[0]!, segs[1]!, segs.slice(2).join("/"));
}

// deferred-E — canonicalize an EXISTING coordinate STRING (not a git URL).
//
// The subscription-ledger OR-Set fold + the subscribe-flow idempotence check
// key subscription IDENTITY on the coordinate. Two writers (or one writer
// across machines) can subscribe the SAME upstream vault via DIFFERENT
// coordinate spellings — case-different host, or a known-forge owner/repo case
// variant copy-pasted from a git remote. Keying on the RAW string would treat
// those as distinct identities and split one logical subscription into two,
// breaking convergence. Canonicalizing the key BEFORE dedup is the
// convergence-correct fix: equal-modulo-spelling coordinates collapse to one.
//
// This is the coordinate → coordinate counterpart of `gitUrlToCoordinate`
// (git URL → coordinate) and SHARES its `canonicalizeTriple` rule, so the
// write side and the fold side can never drift.
//
// Contract:
//   - NORMALIZES THE PREFIX: a successfully-canonicalized coordinate ALWAYS
//     emits the `lyt:vault:`-TYPED form — whether the input was bare
//     (`github.com/owner/repo`) or already typed (`lyt:vault:github.com/owner/repo`).
//     This is the form the ledger + index key on, so a record stored bare and a
//     record stored typed for the SAME upstream collapse to ONE fold key (else
//     they would split into two live subscriptions for one vault).
//   - Idempotent: `canonicalizeCoordinate(canonicalizeCoordinate(x)) === canonicalizeCoordinate(x)`.
//   - DEFENSIVE — a string that does not match the known 3-segment coordinate
//     shape (or whose host is not a case-insensitive forge) passes through
//     UNCHANGED (NOT re-wrapped — only a valid 3-seg coordinate gains the typed
//     prefix). Never throws. Non-forge / self-hosted coordinates keep their
//     verbatim owner/repo casing exactly as `canonicalizeTriple` does.
export function canonicalizeCoordinate(coordinate: string): string {
  // Typed-id form `lyt:vault:<host>/<owner>/<repo>` — canonicalize the inner
  // coordinate, re-wrap with the same type. `gitUrlToCoordinate` can't be used
  // on this directly: its scheme strip wants `scheme://`, which `lyt:vault:`
  // is not, so it would mis-segment. Route through the typed-id parser instead.
  const typed = parseTypedId(coordinate);
  if (typed !== null && typed.type === "vault") {
    const canon = canonicalizeBareCoordinate(typed.id);
    return canon === null ? coordinate : formatTypedId("vault", canon);
  }
  // Bare coordinate `<host>/<owner>/<repo>` — canonicalize, then RE-WRAP in the
  // `lyt:vault:` typed prefix so a bare-stored record and a typed-stored record
  // for the same upstream produce the SAME fold key. A string that does NOT
  // canonicalize to a valid 3-seg coordinate passes through unchanged (no prefix).
  const canon = canonicalizeBareCoordinate(coordinate);
  return canon === null ? coordinate : formatTypedId("vault", canon);
}

// The cross-pod origin coordinate for a vault, as a typed id, or null when the
// vault has no git origin yet (local-only). `lyt:vault:<host>/<owner>/<repo>`.
export function vaultOriginCoordinate(vault: VaultRow): string | null {
  if (vault.gitUrl === null) return null;
  const coord = gitUrlToCoordinate(vault.gitUrl);
  return coord === null ? null : formatTypedId("vault", coord);
}

// ---------------------------------------------------------------------------
// Display projection — `{mesh}/{vault}` computed from home_mesh_rid + leaf.
// ---------------------------------------------------------------------------

// The bare leaf of a vault — the part after the last '/' in its stored name.
// A stored `personal/notes` → `notes`; an unqualified `notes` → `notes`.
export function vaultLeaf(name: string): string {
  const idx = name.lastIndexOf("/");
  return idx === -1 ? name : name.slice(idx + 1);
}

// The COMPUTED canonical display name `<mesh>/<leaf>` (3a). The mesh
// segment is derived from the live `home_mesh_rid`, NOT the stored name prefix
// — so a `move` that re-points `home_mesh_rid` is reflected immediately with no
// stale-prefix bug. Falls back to the stored prefix (then the leaf alone) when
// the vault has no home-mesh assignment.
export async function computeDisplayName(db: Client, vault: VaultRow): Promise<string> {
  const leaf = vaultLeaf(vault.name);
  if (vault.homeMeshRid !== null) {
    const meshes = await listMeshes(db);
    const home = meshes.find((m) => m.ridHex === vault.homeMeshRidHex);
    if (home !== undefined) return `${home.name}/${leaf}`;
  }
  // No (resolvable) home mesh — keep the stored qualified name if any, else the
  // bare leaf. Mirrors the pre-0.9.4 surface for unaffiliated vaults.
  return vault.name.includes("/") ? vault.name : leaf;
}

// Synchronous variant when the caller already holds the mesh list (avoids an
// extra query in hot list/print loops). `meshNameByRidHex` maps a mesh
// ridHex → its name.
//
// `coordinate` (federation-v2 Phase B): the vault's origin coordinate is
// THREADED through so the owner-grouped external-display work (Phase ) can be
// layered in at this single seam without re-touching every caller. In Phase B
// it is accepted but does NOT change the output for own vaults — the display
// stays `{mesh}/{leaf}` exactly as before. Owner-grouped `{bucket}/{owner}/{leaf}`
// rendering for bucket-homed externals is Phase and is intentionally NOT
// implemented here (behavior-preserving). Passing the coordinate now fixes the
// signature so the two intra-`resolveVault` call sites and external callers do
// not need a second edit when lands.
export function computeDisplayNameSync(
  vault: VaultRow,
  meshNameByRidHex: ReadonlyMap<string, string>,
  // Threaded seam for Phase owner-grouped display; intentionally unused in
  // Phase B (underscore-prefixed so `noUnusedParameters` accepts the forward
  // seam). Callers still pass it positionally; will read it here.
  _coordinate?: string | null,
): string {
  const leaf = vaultLeaf(vault.name);
  if (vault.homeMeshRidHex !== null) {
    const meshName = meshNameByRidHex.get(vault.homeMeshRidHex);
    if (meshName !== undefined) return `${meshName}/${leaf}`;
  }
  return vault.name.includes("/") ? vault.name : leaf;
}

// ---------------------------------------------------------------------------
// Resolution — the chokepoint. Every handle resolves to a rid HERE.
// ---------------------------------------------------------------------------

// Raised when a bare leaf matches more than one vault across meshes. We NEVER
// tiebreak — a silent wrong-target write is a data-integrity bug, especially
// for agents replaying a stored reference. The error lists the
// qualified candidates so the caller can re-issue with a `{mesh}/{vault}`.
export class AmbiguousVaultLeafError extends Error {
  readonly errorCode = "ambiguous-vault-leaf";
  readonly leaf: string;
  readonly candidates: readonly string[];
  constructor(leaf: string, candidates: readonly string[]) {
    super(
      `Ambiguous vault name '${leaf}': matches ${candidates.length} vaults across meshes — ` +
        `${candidates.join(", ")}. Qualify it as '<mesh>/${leaf}' (or use an alias / the origin coordinate).`,
    );
    this.name = "AmbiguousVaultLeafError";
    this.leaf = leaf;
    this.candidates = [...candidates];
  }
}

async function rawByName(db: Client, name: string): Promise<VaultRow | null> {
  const r = await db.execute({
    sql: "SELECT rid, status FROM vaults WHERE name = ?",
    args: [name],
  });
  if (r.rows.length === 0) return null;

  // FAIL-CLOSED ON EXACT-NAME MULTIPLICITY. The `vaults.name` UNIQUE
  // constraint was DROPPED (migration 002, SC2: two same-named vaults from
  // different origins must coexist — the canonical case is a delete→clone of
  // the same `{mesh}/{vault}` name). With UNIQUE gone, an exact name can match
  // more than one row. Returning `rows[0]` here would SILENTLY TIEBREAK to an
  // arbitrary row — a wrong-target read/write, the same data-integrity hazard
  // the bare-leaf rail (step 5b) refuses to take. So this branch mirrors that
  // rail EXACTLY: it fails closed on >1 LIVE match.
  //
  // TOMBSTONE POSTURE (preserves the per-branch split documented in
  // vault-index-repo.ts): the multiplicity test counts only LIVE
  // (non-tombstoned) rows, so a delete→clone where the old name is tombstoned
  // and the clone is live resolves the live one (no false ambiguity), exactly
  // like resolveLeafRids. When NO row is live (all matches tombstoned) the
  // branch stays status-AGNOSTIC and resolves the single/first tombstoned
  // match — a stored exact reference to a tombstoned vault is still a hit, as
  // before.
  const rows = r.rows as unknown as Record<string, unknown>[];
  const rowRid = (row: Record<string, unknown>): Uint8Array => {
    const ridRaw = row["rid"];
    return ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
  };
  const live = rows.filter((row) => String(row["status"]) !== "tombstoned");

  if (live.length > 1) {
    // >1 LIVE exact-name match → NEVER tiebreak. Build the qualified candidate
    // display names (same shape as the bare-leaf rail's error) and fail closed.
    const meshes = await listMeshes(db);
    const meshNameByRidHex = new Map(meshes.map((m) => [m.ridHex, m.name] as const));
    const candidates: string[] = [];
    for (const row of live) {
      const v = await getVaultByRid(db, rowRid(row));
      if (v !== null) {
        candidates.push(computeDisplayNameSync(v, meshNameByRidHex, vaultOriginCoordinate(v)));
      }
    }
    candidates.sort();
    throw new AmbiguousVaultLeafError(name, candidates);
  }

  // Exactly one live match → resolve it. No live match → status-AGNOSTIC
  // fallback to the (single/first) tombstoned match (behavior preserved).
  const chosen = live.length === 1 ? live[0]! : rows[0]!;
  // Lazy import avoids a cycle: repo.ts → vault-addressing.ts → repo.ts. The
  // rowToVault validator lives in repo.ts, so re-fetch by rid through the
  // public surface once we have a candidate row's rid.
  return getVaultByRid(db, rowRid(chosen));
}

// Resolve a handle to its VaultRow, or null when nothing matches.
//
// federation-v2 SC3 — DISJOINT NAMESPACES. There are exactly two routes, and
// they do not overlap:
//   - a `@name` handle resolves ONLY as a pod-local alias (step 0 below).
//   - a bare (non-`@`) handle resolves ONLY as a REAL vault — exact stored name
//     → computed display name → cross-pod origin coordinate → bare leaf. It does
//     NOT fall through to the alias table. (SC3 dropped the prior bare-alias
//     short-circuit; an alias is reachable solely via its `@` sigil now.)
//
// Order (matches the code below — sigil → exact → display → coordinate → leaf):
// 0. `@`-sigil pod-local alias → rid (the ONLY alias route; see step 0)
// 1. exact stored name (`personal/notes`, `company/x`)
// 2. computed canonical display name (`company/x` after a move, before the
// stored prefix is reconciled)
// 3. cross-pod origin coordinate (`lyt:vault:<host>/<owner>/<repo>` or a bare
// `<host>/<owner>/<repo>`), matched against each vault's git_url
// 4. bare leaf: `personal/<leaf>`, then unique-leaf across meshes
// (ERRORS on collision — never tiebreaks)
//
// Throws AmbiguousVaultLeafError on a colliding bare leaf. Returns null when no
// handle form matches.
export async function resolveVault(db: Client, handle: string): Promise<VaultRow | null> {
  const trimmed = handle.trim();
  if (trimmed.length === 0) return null;

  // 0. `@`-sigil boundary strip (federation-v2 Phase B). Aliases are stored RAW
  // (no `@`); the sigil is a CHAT-surface convenience that the resolver strips
  // here, at the single boundary, before consulting the alias table. A
  // `@`-prefixed handle resolves ONLY through `vault_aliases` (the alias
  // namespace is disjoint from the name/leaf namespace) — it never falls
  // through to exact/coordinate/leaf, so a sigil handle can never be silently
  // re-read as a name. `validateAliasName` rejects a leading `@` on the write
  // side, so the stored alias form is ALWAYS sigil-free — which guarantees the
  // stripped handle here matches what was stored.
  if (trimmed.startsWith("@")) {
    const aliasName = trimmed.slice(1);
    if (aliasName.length === 0) return null;
    const sigilRid = await getAliasTargetRid(db, aliasName);
    if (sigilRid === null) return null;
    return getVaultByRid(db, sigilRid);
  }

  // 1. exact stored name.
  const exact = await rawByName(db, trimmed);
  if (exact !== null) return exact;

  // SC3: the bare (non-`@`) alias short-circuit that used to sit HERE has been
  // REMOVED. A bare handle no longer consults `vault_aliases` — it resolves
  // strictly as a real vault (exact above, then display / coordinate / leaf
  // below). Aliases are reachable ONLY through the `@`-sigil step 0, keeping the
  // alias namespace disjoint from the name/leaf namespace. A bare handle that
  // happens to spell an alias now resolves to the same-named vault (or null),
  // NOT the alias target.

  // federation-v2 D1a — the per-row O(N) scan (`SELECT rid FROM vaults` + a
  // per-row getVaultByRid round-trip) that used to load the FULL vault set here
  // is replaced by index-backed lookups (vault-index-repo.ts). The display
  // branch below is the ONLY one that still needs every row (it must compute a
  // mesh-joined display name per vault), and it ONLY fires for a `/`-containing
  // handle — so the bare-leaf hot path (step 5) never loads the full set now;
  // it reads the `idx_vaults_leaf` multiplicity query instead. Behavior is
  // preserved exactly: each branch's matching order + tombstone treatment is
  // unchanged (see the per-branch notes below). `listVaults` issues ONE query
  // (no N+1) and is consulted lazily only where the display branch needs it.

  // 2. computed canonical display name (post-move, pre-reconcile) — the
  // {mesh}/{vault} / multi-segment DISPLAY split. (federation-v2 Phase B: this
  // now runs BEFORE the origin-coordinate regex below. A multi-segment
  // display-intent handle — e.g. a future owner-grouped `subscriptions/owner/leaf`
  // — also matches the 3-segment coordinate regex, so display resolution MUST
  // be attempted first or it would mis-route to a coordinate lookup. This is
  // behavior-preserving for existing inputs: today's 2-segment `{mesh}/{leaf}`
  // display names never match the 3-segment coordinate regex, and a genuine
  // `host/owner/repo` coordinate never equals a computed `{mesh}/{leaf}` display
  // name, so neither existing path changes — only the relative ordering of two
  // branches that, for existing inputs, never both fire.)
  //
  // F3 (release review): the "display names never match the 3-segment coordinate
  // regex" claim above is GUARDED BY `validateVaultName`'s depth ≤ 1 gate
  // (identity.ts — a stored vault name may have at most ONE `/`, so a computed
  // `{mesh}/{leaf}` display name is always 2-segment and never matches the
  // 3-segment `/^[^/\s]+\/[^/\s]+\/.+$/`). If that depth gate is ever relaxed to
  // allow ≥3-segment vault names, a computed display name could collide with the
  // coordinate regex and the display-vs-coordinate overlap becomes reachable —
  // at which point the display-first ordering here stops being a harmless no-op
  // and starts deciding the winner. Revisit this branch ordering if the gate
  // moves.
  // The display branch needs full rows + a mesh-name lookup. Build both ONLY
  // when the handle contains a `/` (the only case this branch can match). One
  // query each — no per-row round-trip. (Status-AGNOSTIC: a tombstoned vault
  // whose computed display name matches still resolves, exactly as before.)
  if (trimmed.includes("/")) {
    const allVaults = await listVaults(db);
    const meshes = await listMeshes(db);
    const meshNameByRidHex = new Map(meshes.map((m) => [m.ridHex, m.name] as const));
    for (const v of allVaults) {
      if (computeDisplayNameSync(v, meshNameByRidHex, vaultOriginCoordinate(v)) === trimmed) {
        return v;
      }
    }
  }

  // 4. cross-pod origin coordinate. Index-backed: only the vaults carrying a
  // git_url are scanned (idx_vaults_git_url), in the same natural row order the
  // old full scan used, so "first coordinate match wins" is preserved.
  // Status-AGNOSTIC (listGitUrlRids does not filter status) — a tombstoned
  // vault still resolves by its origin coordinate, matching the prior behavior.
  const typed = parseTypedId(trimmed);
  const coordCandidate =
    typed !== null && typed.type === "vault"
      ? typed.id
      : /^[^/\s]+\/[^/\s]+\/.+$/.test(trimmed)
        ? trimmed
        : null;

  if (coordCandidate !== null) {
    // fix-pass — canonicalize the INPUT through the SAME canonicalizer the
    // stored side uses. gitUrlToCoordinate no-ops the scheme/SSH/.git stripping on
    // a bare host/owner/repo and applies the lowercase-host + known-forge
    // owner/repo rule, so both sides of the `coord === norm` compare are canonical.
    // Without this, a mixed-case typed coordinate (lyt:vault:GitHub.com/Owner/Repo,
    // copy-pasted from a git remote) would MISS the now-canonical stored coord — a
    // resolve regression introduced by bug 6's canonicalization. Falls back to the
    // old strip if the candidate is unparseable (defensive).
    const norm =
      gitUrlToCoordinate(coordCandidate) ??
      coordCandidate.replace(/\.git$/, "").replace(/\/+$/, "");
    for (const { rid, gitUrl } of await listGitUrlRids(db)) {
      const coord = gitUrlToCoordinate(gitUrl);
      if (coord !== null && coord === norm) return getVaultByRid(db, rid);
    }
    // A typed coordinate that matched nothing is a miss (not a leaf).
    if (typed !== null) return null;
  }

  // 5. bare leaf resolution.
  const leaf = vaultLeaf(trimmed);
  const isBare = !trimmed.includes("/");
  if (!isBare) {
    // A qualified handle that matched no exact/computed name is a genuine miss.
    return null;
  }

  // 5a. personal/<leaf> shorthand.
  const personal = await rawByName(db, `personal/${leaf}`);
  if (personal !== null) return personal;

  // 5b. unique leaf across meshes — the NEVER-TIEBREAK rail, now served by the
  // `idx_vaults_leaf` multiplicity query. resolveLeafRids replicates the prior
  // filter EXACTLY (`status != 'tombstoned'` AND leaf match) — so two LIVE
  // same-leaf vaults still yield ≥2 rids and STILL throw, while a leaf with one
  // live + one tombstoned match resolves the live one (no false ambiguity).
  const leafRids = await resolveLeafRids(db, leaf);
  if (leafRids.length === 1) return getVaultByRid(db, leafRids[0]!);
  if (leafRids.length > 1) {
    // Build the qualified candidate display names for the error (only the
    // colliding rids are fetched + the mesh-name lookup, not the whole pod).
    const meshes = await listMeshes(db);
    const meshNameByRidHex = new Map(meshes.map((m) => [m.ridHex, m.name] as const));
    const candidates: string[] = [];
    for (const rid of leafRids) {
      const v = await getVaultByRid(db, rid);
      if (v !== null) {
        candidates.push(computeDisplayNameSync(v, meshNameByRidHex, vaultOriginCoordinate(v)));
      }
    }
    candidates.sort();
    throw new AmbiguousVaultLeafError(leaf, candidates);
  }
  return null;
}
