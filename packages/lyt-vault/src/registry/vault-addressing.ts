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
import { getVaultByRid } from "./repo.js";
import type { VaultRow } from "./repo.js";

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
  s = s.replace(/\.git$/, "").replace(/\/+$/, "");
  const segs = s.split("/").filter((p) => p.length > 0);
  if (segs.length < 3) return null;
  // host / owner / repo — collapse any deeper path into the repo segment's
  // host/owner/repo (gh has exactly host/owner/repo; be strict at 3).
  const host = segs[0]!;
  const owner = segs[1]!;
  const repo = segs.slice(2).join("/");
  return `${host}/${owner}/${repo}`;
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
export function computeDisplayNameSync(
  vault: VaultRow,
  meshNameByRidHex: ReadonlyMap<string, string>,
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
    sql: "SELECT * FROM vaults WHERE name = ?",
    args: [name],
  });
  if (r.rows.length === 0) return null;
  // Lazy import avoids a cycle: repo.ts → vault-addressing.ts → repo.ts. The
  // rowToVault validator lives in repo.ts, so re-fetch by rid through the
  // public surface once we have a candidate row's rid.
  const ridRaw = (r.rows[0] as unknown as Record<string, unknown>)["rid"];
  const rid =
    ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
  return getVaultByRid(db, rid);
}

// Resolve a handle to its VaultRow, or null when nothing matches. Order (matches
// the code below — exact → alias → coordinate → computed → leaf):
// 1. exact stored name (`personal/notes`, `company/x`)
// 2. pod-local alias → rid (checked before the leaf walk so an alias always
// wins over a same-spelled unqualified leaf)
// 3. cross-pod origin coordinate (`lyt:vault:<host>/<owner>/<repo>` or a bare
// `<host>/<owner>/<repo>`), matched against each vault's git_url
// 4. computed canonical display name (`company/x` after a move, before the
// stored prefix is reconciled)
// 5. bare leaf: `personal/<leaf>`, then unique-leaf across meshes
// (ERRORS on collision — never tiebreaks)
//
// Throws AmbiguousVaultLeafError on a colliding bare leaf. Returns null when no
// handle form matches.
export async function resolveVault(db: Client, handle: string): Promise<VaultRow | null> {
  const trimmed = handle.trim();
  if (trimmed.length === 0) return null;

  // 1. exact stored name.
  const exact = await rawByName(db, trimmed);
  if (exact !== null) return exact;

  // 3. pod-local alias (checked before the leaf walk so an alias always wins
  // over a same-spelled unqualified leaf; aliases are explicit handler
  // intent). An alias target is a rid.
  const aliasRid = await getAliasTargetRid(db, trimmed);
  if (aliasRid !== null) {
    const aliased = await getVaultByRid(db, aliasRid);
    if (aliased !== null) return aliased;
    // Dangling alias (target tombstoned/deleted) — fall through to other forms.
  }

  // 4. cross-pod origin coordinate.
  const typed = parseTypedId(trimmed);
  const coordCandidate =
    typed !== null && typed.type === "vault"
      ? typed.id
      : /^[^/\s]+\/[^/\s]+\/.+$/.test(trimmed)
        ? trimmed
        : null;

  // Load the full set once for steps 2 / 4 / 5.
  const allRows = await db.execute("SELECT rid FROM vaults");
  const allVaults: VaultRow[] = [];
  for (const row of allRows.rows) {
    const ridRaw = (row as unknown as Record<string, unknown>)["rid"];
    const rid =
      ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
    const v = await getVaultByRid(db, rid);
    if (v !== null) allVaults.push(v);
  }

  if (coordCandidate !== null) {
    const norm = coordCandidate.replace(/\.git$/, "").replace(/\/+$/, "");
    for (const v of allVaults) {
      if (v.gitUrl === null) continue;
      const coord = gitUrlToCoordinate(v.gitUrl);
      if (coord !== null && coord === norm) return v;
    }
    // A typed coordinate that matched nothing is a miss (not a leaf).
    if (typed !== null) return null;
  }

  // Build mesh-name lookup for computed display names.
  const meshes = await listMeshes(db);
  const meshNameByRidHex = new Map(meshes.map((m) => [m.ridHex, m.name] as const));

  // 2. computed canonical display name (post-move, pre-reconcile).
  if (trimmed.includes("/")) {
    for (const v of allVaults) {
      if (computeDisplayNameSync(v, meshNameByRidHex) === trimmed) return v;
    }
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

  // 5b. unique leaf across meshes.
  const leafMatches = allVaults.filter(
    (v) => v.status !== "tombstoned" && vaultLeaf(v.name) === leaf,
  );
  if (leafMatches.length === 1) return leafMatches[0]!;
  if (leafMatches.length > 1) {
    const candidates = leafMatches.map((v) => computeDisplayNameSync(v, meshNameByRidHex)).sort();
    throw new AmbiguousVaultLeafError(leaf, candidates);
  }
  return null;
}
