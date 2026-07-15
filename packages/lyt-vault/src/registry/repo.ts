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

import { isUuidv7Bytes, uuid7BytesToHex } from "../util/uuid7.js";
import { canonicalizeVaultPath } from "../util/paths.js";

export type VaultStatus = "active" | "disconnected" | "missing" | "tombstoned" | "access_lost";

// Inc-2 Phase B / →foreign-vault PROVENANCE = the ENTRY RELATIONSHIP.
//   own        = the user's own vault (init/adopt/graduate-a-template clone)
//   shared     = a DIFFERENT owner's PRIVATE vault GRANTED to the handler
//                (affiliation; renders RO or RW) — homed into `shared/{owner}`
//   subscribed = a DIFFERENT owner's PUBLIC vault the handler self-subscribed to
//                (no grant; always RO) — homed into `subscriptions/{owner}`
// Orthogonal to `status` AND to `writable` (writability is DERIVED from the gh
// push verdict, never stored). The registry default is fail-closed `own`
// (migration 008) — a vault is `shared`/`subscribed` ONLY when a foreign-inbound
// path positively marks it. See migrations.ts migration008.
export type VaultSource = "own" | "shared" | "subscribed";

// the two FOREIGN provenances (everything that is not the user's own).
// A helper the receive paths + the lazy repair use to reason about foreignness
// without repeating the set. `own` is intentionally excluded.
export type ForeignVaultSource = "shared" | "subscribed";

// the fail-closed reader normalization: only the two exact foreign tokens
// resolve to their foreign value; ANY other value (null / absent / illegal /
// legacy) degrades to `own`. Centralized so the row reader and any future reader
// share ONE rule (a wrong own-vs-foreign signal is L0-adjacent — an ambiguous
// row must never read as a deletable foreign clone).
export function normalizeVaultSource(raw: unknown): VaultSource {
  return raw === "shared" ? "shared" : raw === "subscribed" ? "subscribed" : "own";
}

// v1.A.1b — vaults.rid + memscope_rid + parent_vault + home_mesh_rid are
// all BLOB UUIDv7 in libSQL. Typed surface here exposes BOTH the raw 16-byte
// Uint8Array (for SQL args + byte equality via ridsEqual) AND a `*Hex`
// convenience for rendering, Map<string,X> keys, and CLI surfaces.
//
// `rowToVault` validates rid bytes at the row → typed boundary, mirroring
// the precedent in `federation-state.ts:rowToState`. A row that fails the
// boundary check throws — the offending row reaches no caller in an
// invalid state.
export interface VaultRow {
  rid: Uint8Array;
  ridHex: string;
  name: string;
  path: string;
  memscopeRid: Uint8Array | null;
  memscopeRidHex: string | null;
  parentVault: Uint8Array | null;
  parentVaultHex: string | null;
  homeMeshRid: Uint8Array | null;
  homeMeshRidHex: string | null;
  tierHint: string | null;
  status: VaultStatus;
  // Inc-2 Phase B / own-vs-clone provenance (fail-closed 'own').
  source: VaultSource;
  gitUrl: string | null;
  createdAt: string | null;
  registeredAt: string;
  lastVerifiedAt: string | null;
  verifyFailCount: number;
}

// v1.A.1b — mesh_edges upgraded to the cross-mesh shape per
// federation-design v2 §7. Old single-mesh (source_vault_rid, edge_type,
// target_vault_rid) triple is gone; rows now carry the referencing mesh +
// vault (the side recording the edge) plus the home mesh + vault (the side
// being referenced). kind narrows to 'parent' in v1.A.1b; v1.C.1 widens.
export interface MeshEdgeRow {
  refMeshRid: Uint8Array;
  refMeshRidHex: string;
  refVaultRid: Uint8Array;
  refVaultRidHex: string;
  homeMeshRid: Uint8Array;
  homeMeshRidHex: string;
  homeVaultRid: Uint8Array;
  homeVaultRidHex: string;
  kind: "parent";
}

export interface InsertVaultArgs {
  rid: Uint8Array;
  name: string;
  path: string;
  memscopeRid?: Uint8Array | null;
  parentVault?: Uint8Array | null;
  homeMeshRid?: Uint8Array | null;
  tierHint?: string | null;
  status?: VaultStatus;
  // Inc-2 Phase B / own-vs-clone provenance. Omitted → fail-closed 'own'
  // (an insert without an explicit source is an OWN vault; only the foreign
  // clone/subscribe paths pass 'subscribed').
  source?: VaultSource;
  gitUrl?: string | null;
  createdAt?: string | null;
}

// fed-v2 Layer-2 P1 — refusal raised when an incoming upsert would
// OVERWRITE a registry row already owning the same rid but recorded under a
// DIFFERENT name. The ON CONFLICT(rid) DO UPDATE SET name,path clause would
// silently re-home the victim row (rid-impersonation: a hostile published
// vault.yon asserts a victim's rid). The name-mismatch refusal is the
// LOAD-BEARING defense and is UNCONDITIONAL — `trustedReconstruction` only
// relaxes the same-name/path-change arm (legitimate cross-machine
// reconstitution / rebuild), it can NEVER authorize a name re-home.
export class VaultRidImpersonationError extends Error {
  readonly errorCode = "vault-rid-impersonation";
  readonly ridHex: string;
  readonly existingName: string;
  readonly incomingName: string;
  constructor(ridHex: string, existingName: string, incomingName: string) {
    super(
      `Refusing to register vault '${incomingName}': rid ${ridHex} is already owned by a ` +
        `different registered vault '${existingName}' on this machine. A vault that asserts ` +
        `an identity (rid) already held by another local vault under a DIFFERENT name is an ` +
        `impersonation hazard (it would silently overwrite the existing vault's registry row). ` +
        `If this is a genuine re-import of '${existingName}', re-clone it under its own fresh ` +
        `identity, or 'lyt vault forget ${existingName}' first if you intend to replace it.`,
    );
    this.name = "VaultRidImpersonationError";
    this.ridHex = ridHex;
    this.existingName = existingName;
    this.incomingName = incomingName;
  }
}

export interface UpsertVaultOptions {
  // fed-v2 Layer-2 P1 — INERT today; pre-wired for the future P5
  // same-name-arm gate. The ONLY gate in the current discriminator
  // (upsertVault :261-268) is the UNCONDITIONAL name-mismatch refusal: an
  // incoming rid that a DIFFERENT-named local row owns is rejected
  // (VaultRidImpersonationError) regardless of this flag — an attacker cannot
  // fake the victim's name. A same-rid + same-name upsert (whether the path
  // changes or is identical) is ALLOWED on every axis: it falls through the
  // discriminator to the ON CONFLICT(rid) DO UPDATE, which re-homes the path
  // (matches the accurate inline comment at :244-250 — the default URL-clone
  // path, which preserves the source rid, re-registers the same vault at a new
  // path and lands here legitimately). So `trustedReconstruction` does NOT
  // change behavior today — it is threaded only to mark the genuine
  // identity-PRESERVING restore axis (recover-pod / rebuild) explicitly, so a
  // future P5 tightening (gating the same-name path-CHANGE arm on the untrusted
  // ingest axis, allowing it only when this flag is set) has the capability
  // already in place. Until P5 wires it, `void`-consumed at :267.
  trustedReconstruction?: boolean | undefined;
}

export interface InsertMeshEdgeArgs {
  refMeshRid: Uint8Array;
  refVaultRid: Uint8Array;
  homeMeshRid: Uint8Array;
  homeVaultRid: Uint8Array;
  kind?: "parent";
}

function toBytesOrNull(raw: unknown, column: string, contextName: string): Uint8Array | null {
  if (raw == null) return null;
  if (!isUuidv7Bytes(raw)) {
    throw new Error(`vaults.${column} for ${contextName} is not a valid UUIDv7 blob.`);
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

function bytesOrThrow(raw: unknown, column: string, contextName: string): Uint8Array {
  if (!isUuidv7Bytes(raw)) {
    throw new Error(`mesh_edges.${column} for ${contextName} is not a valid UUIDv7 blob.`);
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

function rowToVault(row: Record<string, unknown>): VaultRow {
  const ridRaw = row["rid"];
  const nameStr = row["name"] == null ? "<unknown>" : String(row["name"]);
  if (!isUuidv7Bytes(ridRaw)) {
    throw new Error(`vaults.rid for name ${JSON.stringify(nameStr)} is not a valid UUIDv7 blob.`);
  }
  const rid = ridRaw instanceof Uint8Array ? ridRaw : new Uint8Array(ridRaw as ArrayBuffer);
  const memscope = toBytesOrNull(row["memscope_rid"], "memscope_rid", nameStr);
  const parent = toBytesOrNull(row["parent_vault"], "parent_vault", nameStr);
  const homeMesh = toBytesOrNull(row["home_mesh_rid"], "home_mesh_rid", nameStr);
  return {
    rid,
    ridHex: uuid7BytesToHex(rid),
    name: nameStr,
    path: String(row["path"]),
    memscopeRid: memscope,
    memscopeRidHex: memscope ? uuid7BytesToHex(memscope) : null,
    parentVault: parent,
    parentVaultHex: parent ? uuid7BytesToHex(parent) : null,
    homeMeshRid: homeMesh,
    homeMeshRidHex: homeMesh ? uuid7BytesToHex(homeMesh) : null,
    tierHint: row["tier_hint"] == null ? null : String(row["tier_hint"]),
    status: String(row["status"]) as VaultStatus,
    // Inc-2 Phase B / →BACK-COMPAT, FAIL-CLOSED READER. A null/absent
    // `source` (a pre-migration-008 shape, or a NULL that somehow slipped in)
    // resolves to 'own' — never a foreign value. A downstream orphan-clone-dir
    // sweep keys on `source !== 'own'`, so defaulting the unknown case to 'own'
    // guarantees an ambiguous row is treated as the user's own data (never
    // deletable as a "confirmed clone"). Only the two exact foreign tokens
    // ('shared','subscribed') read through; any other value degrades to 'own'.
    source: normalizeVaultSource(row["source"]),
    gitUrl: row["git_url"] == null ? null : String(row["git_url"]),
    createdAt: row["created_at"] == null ? null : String(row["created_at"]),
    registeredAt: String(row["registered_at"]),
    lastVerifiedAt: row["last_verified_at"] == null ? null : String(row["last_verified_at"]),
    verifyFailCount: Number(row["verify_fail_count"] ?? 0),
  };
}

function rowToMeshEdge(row: Record<string, unknown>): MeshEdgeRow {
  const refMesh = bytesOrThrow(row["ref_mesh_rid"], "ref_mesh_rid", "row");
  const refVault = bytesOrThrow(row["ref_vault_rid"], "ref_vault_rid", "row");
  const homeMesh = bytesOrThrow(row["home_mesh_rid"], "home_mesh_rid", "row");
  const homeVault = bytesOrThrow(row["home_vault_rid"], "home_vault_rid", "row");
  const kindRaw = String(row["kind"]);
  if (kindRaw !== "parent") {
    throw new Error(`mesh_edges.kind unexpected value: ${JSON.stringify(kindRaw)}`);
  }
  return {
    refMeshRid: refMesh,
    refMeshRidHex: uuid7BytesToHex(refMesh),
    refVaultRid: refVault,
    refVaultRidHex: uuid7BytesToHex(refVault),
    homeMeshRid: homeMesh,
    homeMeshRidHex: uuid7BytesToHex(homeMesh),
    homeVaultRid: homeVault,
    homeVaultRidHex: uuid7BytesToHex(homeVault),
    kind: kindRaw,
  };
}

export async function insertVault(db: Client, args: InsertVaultArgs): Promise<void> {
  if (!isUuidv7Bytes(args.rid)) {
    throw new Error("insertVault: rid must be a 16-byte UUIDv7 BLOB.");
  }
  await db.execute({
    sql: `INSERT INTO vaults
 (rid, name, path, memscope_rid, parent_vault, home_mesh_rid, tier_hint, status, source, git_url, created_at, registered_at, last_verified_at, verify_fail_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    args: [
      args.rid,
      args.name,
      canonicalizeVaultPath(args.path),
      args.memscopeRid ?? null,
      args.parentVault ?? null,
      args.homeMeshRid ?? null,
      args.tierHint ?? null,
      args.status ?? "active",
      args.source ?? "own",
      args.gitUrl ?? null,
      args.createdAt ?? null,
      new Date().toISOString(),
    ],
  });
}

export async function upsertVault(
  db: Client,
  args: InsertVaultArgs,
  opts: UpsertVaultOptions = {},
): Promise<void> {
  if (!isUuidv7Bytes(args.rid)) {
    throw new Error("upsertVault: rid must be a 16-byte UUIDv7 BLOB.");
  }

  // fed-v2 Layer-2 P1 — context-aware refuse-on-rid guard BEFORE the
  // unconditional ON CONFLICT(rid) DO UPDATE. Discriminate the cases an incoming
  // rid-collision can take:
  //   (rid live, name DIFFERS)      → REFUSE (impersonation). This is the
  //                                    LOAD-BEARING, UNCONDITIONAL defense — no
  //                                    flag can authorize re-homing a rid to a
  //                                    DIFFERENT name (an attacker can't fake the
  // victim's name, so the hardening pass hostile clone
  //                                    — ext/attacker asserting personal/victim's
  //                                    rid — is refused here regardless of flag).
  //   (rid live, same name, path ≠) → ALLOW. A legitimate cross-machine
  //                                    reconstitution / move re-homes the SAME
  //                                    vault (same identity + name) to a new
  //                                    on-disk path; the default URL-clone path
  //                                    (which preserves the source rid) also
  //                                    lands here when the same source is
  //                                    re-registered at a new path.
  //   (rid live, same name + path)  → idempotent no-op (ON CONFLICT re-writes
  //                                    identical values harmlessly).
  // A brand-new rid (no live row) always proceeds.
  //
  // `opts.trustedReconstruction` marks the genuine identity-PRESERVING restore
  // axis (recover-pod / rebuild). In the current discriminator the name-mismatch
  // refusal is the sole gate, so the flag does NOT relax any refusal — it is
  // threaded so the restore axis is explicit and so a future tightening (e.g.
  // gating the same-name path-change arm on the untrusted ingest axis) has the
  // capability already wired. The name-mismatch refusal stays unconditional.
  const existing = await getVaultByRid(db, args.rid);
  if (existing !== null) {
    const incomingName = args.name;
    if (existing.name !== incomingName) {
      throw new VaultRidImpersonationError(existing.ridHex, existing.name, incomingName);
    }
    void opts.trustedReconstruction;
  }

  // Inc-2 Phase B / →`source` is set on the fresh INSERT arm ONLY and
  // is deliberately ABSENT from the ON CONFLICT DO UPDATE SET clause: a
  // re-register NEVER flips a row's provenance (own↔foreign) NOR downgrades it
  // (shared→subscribed). This is the fail-closed choice against the L0-adjacent
  // delete hazard — an upsert of an own vault (which passes no source → 'own')
  // can never silently mark an existing foreign row 'own' (nor vice-versa), and
  // a foreign re-receive can never demote a 'shared' row. A deliberate
  // provenance change goes through the explicit setVaultSource /
  // markVaultSourcePreserving helpers, never a bare upsert.
  await db.execute({
    sql: `INSERT INTO vaults
 (rid, name, path, memscope_rid, parent_vault, home_mesh_rid, tier_hint, status, source, git_url, created_at, registered_at, last_verified_at, verify_fail_count)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
 ON CONFLICT(rid) DO UPDATE SET
 name=excluded.name,
 path=excluded.path,
 memscope_rid=excluded.memscope_rid,
 parent_vault=excluded.parent_vault,
 home_mesh_rid=excluded.home_mesh_rid,
 tier_hint=excluded.tier_hint,
 status=excluded.status,
 git_url=excluded.git_url,
        created_at=excluded.created_at`,
    args: [
      args.rid,
      args.name,
      canonicalizeVaultPath(args.path),
      args.memscopeRid ?? null,
      args.parentVault ?? null,
      args.homeMeshRid ?? null,
      args.tierHint ?? null,
      args.status ?? "active",
      args.source ?? "own",
      args.gitUrl ?? null,
      args.createdAt ?? null,
      new Date().toISOString(),
    ],
  });
}

// Inc-2 Phase B / the EXPLICIT provenance mutation surface. The only way
// to change a vault's foreign-vs-own marker after registration (an upsert never
// flips it — see upsertVault). Used by the lazy repair + the deliberate
// graduate/upgrade movers. UNGUARDED: it writes exactly what it is given (the
// caller owns the policy). For the receive-path convergence case use
// markVaultSourcePreserving, which enforces the monotonic rule.
export async function setVaultSource(
  db: Client,
  rid: Uint8Array,
  source: VaultSource,
): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET source = ? WHERE rid = ?",
    args: [source, rid],
  });
}

// the PRESERVE-AWARE foreign mark used by the receive-path converge
// branch. Applies the ratified monotonic rule so a re-register/re-receive can
// NEVER silently corrupt provenance:
//   - own → foreign      : ALLOWED (first positive foreign mark of a row that
//                          somehow lacked it; the birth-INSERT normally sets it).
//   - shared → subscribed: REFUSED (a downgrade — a granted PRIVATE vault must
//                          not be demoted to a self-subscribe by a passive
//                          re-receive). Keeps 'shared'.
//   - subscribed → shared: NOT wired here (the relationship-UPGRADE mover is a
//                          separate slice); left 'subscribed'. This helper only
//                          ever RAISES to 'shared' from 'own'.
//   - X → X              : no-op.
// The subscribed→shared upgrade is deliberately OUT OF SCOPE — only setVaultSource
// (the explicit mover) may perform it. Returns the source the row now holds.
export async function markVaultSourcePreserving(
  db: Client,
  rid: Uint8Array,
  incoming: ForeignVaultSource,
): Promise<VaultSource> {
  const existing = await getVaultByRid(db, rid);
  const current: VaultSource = existing?.source ?? "own";
  // Only a row that is still 'own' may be raised to a foreign value here; any
  // existing foreign value is PRESERVED (no downgrade shared→subscribed, and the
  // subscribed→shared upgrade is not wired on this passive path).
  if (current !== "own") return current;
  await setVaultSource(db, rid, incoming);
  return incoming;
}

// 0.9.4 (G — the single resolver chokepoint). `getVaultByName` is the
// historic name-lookup surface every verb routes through; it now delegates to
// the addressing chokepoint (`resolveVault`) so the WHOLE verb fleet gains the
// `{mesh}/{vault}` · bare-leaf · alias · origin-coordinate grammar from one
// edit. The raw exact-string SQL match lives in `getVaultByExactName` for the
// rare caller that genuinely needs a literal `name =` probe (e.g. a rename
// collision check that must not auto-resolve a leaf). The chokepoint THROWS
// `AmbiguousVaultLeafError` on a colliding bare leaf — never tiebreaks.
export async function getVaultByName(db: Client, name: string): Promise<VaultRow | null> {
  // Lazy import breaks the repo.ts ↔ vault-addressing.ts cycle (the addressing
  // module imports getVaultByRid from here).
  const { resolveVault } = await import("./vault-addressing.js");
  return resolveVault(db, name);
}

// Literal `name = ?` probe — NO leaf/alias/coordinate resolution. Used by
// collision checks (rename/init) where "is this EXACT name taken?" must not be
// softened into "does this leaf resolve to something?".
export async function getVaultByExactName(db: Client, name: string): Promise<VaultRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM vaults WHERE name = ?",
    args: [name],
  });
  if (r.rows.length === 0) return null;
  return rowToVault(r.rows[0] as unknown as Record<string, unknown>);
}

export async function getVaultByRid(db: Client, rid: Uint8Array): Promise<VaultRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM vaults WHERE rid = ?",
    args: [rid],
  });
  if (r.rows.length === 0) return null;
  return rowToVault(r.rows[0] as unknown as Record<string, unknown>);
}

export async function getVaultByPath(db: Client, path: string): Promise<VaultRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM vaults WHERE path = ?",
    args: [canonicalizeVaultPath(path)],
  });
  if (r.rows.length === 0) return null;
  return rowToVault(r.rows[0] as unknown as Record<string, unknown>);
}

export async function listVaults(db: Client): Promise<VaultRow[]> {
  const r = await db.execute("SELECT * FROM vaults ORDER BY name ASC");
  return r.rows.map((row) => rowToVault(row as unknown as Record<string, unknown>));
}

export async function updateVaultStatus(
  db: Client,
  rid: Uint8Array,
  status: VaultStatus,
): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET status = ? WHERE rid = ?",
    args: [status, rid],
  });
}

export async function updateVaultPath(db: Client, rid: Uint8Array, path: string): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET path = ? WHERE rid = ?",
    args: [canonicalizeVaultPath(path), rid],
  });
}

// V-A-10 self-heal — reconcile a vault's git remote into the registry. A
// local-first init inserts the vault with git_url=null (no remote yet);
// publish/sync wire the `origin` on disk but don't write it back, so writable
// derivation would stay "no-remote" forever. deriveVaultWritable reads the live
// origin and calls this to heal the cache (best-effort; never blocks a verdict).
export async function setVaultGitUrl(db: Client, rid: Uint8Array, gitUrl: string): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET git_url = ? WHERE rid = ?",
    args: [gitUrl, rid],
  });
}

export async function markVaultMissing(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: `UPDATE vaults
          SET status = 'missing',
 verify_fail_count = verify_fail_count + 1,
 last_verified_at = ?
          WHERE rid = ?`,
    args: [new Date().toISOString(), rid],
  });
}

export async function markVaultActive(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: `UPDATE vaults
          SET status = 'active',
 verify_fail_count = 0,
 last_verified_at = ?
          WHERE rid = ?`,
    args: [new Date().toISOString(), rid],
  });
}

export async function tombstoneVault(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET status = 'tombstoned' WHERE rid = ?",
    args: [rid],
  });
}

// v1.B.1 — set `vaults.home_mesh_rid` after `lyt mesh init` lands a row in
// `meshes`. The FK to meshes(rid) is enforced (ON DELETE SET NULL) and was
// shipped empty in v1.A.1b; this helper is the canonical assignment surface.
export async function setVaultHomeMesh(
  db: Client,
  vaultRid: Uint8Array,
  meshRid: Uint8Array | null,
): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET home_mesh_rid = ? WHERE rid = ?",
    args: [meshRid ?? null, vaultRid],
  });
}

// Inc-2 Phase C #6 (release review R2) — every ACTIVE vault whose `home_mesh_rid`
// pointer targets `meshRid`. The `vaults.home_mesh_rid → meshes(rid)` FK is
// `ON DELETE SET NULL`, so deleting a mesh silently un-homes any vault pointing
// at it via this pointer (independent of a mesh_vaults `home` row). `lyt mesh
// prune` uses this to refuse when a live vault would be un-homed. Scoped to
// `status = 'active'` — a disconnected/missing/tombstoned row is not a live home.
export async function listActiveVaultsByHomeMesh(
  db: Client,
  meshRid: Uint8Array,
): Promise<VaultRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM vaults WHERE home_mesh_rid = ? AND status = 'active'",
    args: [meshRid],
  });
  return r.rows.map((row) => rowToVault(row as unknown as Record<string, unknown>));
}

export async function updateLastVerified(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "UPDATE vaults SET last_verified_at = ? WHERE rid = ?",
    args: [new Date().toISOString(), rid],
  });
}

export async function bumpVerifyFailCount(db: Client, rid: Uint8Array): Promise<number> {
  await db.execute({
    sql: `UPDATE vaults
 SET verify_fail_count = verify_fail_count + 1,
 last_verified_at = ?
          WHERE rid = ?`,
    args: [new Date().toISOString(), rid],
  });
  const r = await db.execute({
    sql: "SELECT verify_fail_count FROM vaults WHERE rid = ?",
    args: [rid],
  });
  if (r.rows.length === 0) return 0;
  return Number(r.rows[0]!["verify_fail_count"] ?? 0);
}

export async function deleteVault(db: Client, rid: Uint8Array): Promise<void> {
  await db.execute({
    sql: "DELETE FROM vaults WHERE rid = ?",
    args: [rid],
  });
}

export async function deleteAllVaults(db: Client): Promise<void> {
  // CASCADE on mesh_edges + mesh_vaults FKs cleans those up automatically;
  // explicit DELETE FROM mesh_edges is retained for the (rare) case where
  // a row's home FKs point at a vault row already drained by the cascade.
  await db.execute("DELETE FROM vaults");
  await db.execute("DELETE FROM mesh_edges");
}

// Slice 2a — full-table wipe of the mesh_edges cache. Used by
// rebuildFederationCacheFlow's mesh-edge reconstitution half (DELETE+reINSERT
// idempotent full-replace from the ledger fold), mirroring deleteAllSubscriptions
// / deleteAllAliases. mesh.yon is no longer the edge SoT, so the per-mesh
// deleteAllEdgesByRefMesh (mesh.yon rebuild) no longer owns this cache; the
// ledger reconstitution does, and it full-replaces.
export async function deleteAllMeshEdges(db: Client): Promise<void> {
  await db.execute("DELETE FROM mesh_edges");
}

export async function insertMeshEdge(db: Client, edge: InsertMeshEdgeArgs): Promise<void> {
  if (!isUuidv7Bytes(edge.refMeshRid)) {
    throw new Error("insertMeshEdge: refMeshRid must be a 16-byte UUIDv7 BLOB.");
  }
  if (!isUuidv7Bytes(edge.refVaultRid)) {
    throw new Error("insertMeshEdge: refVaultRid must be a 16-byte UUIDv7 BLOB.");
  }
  if (!isUuidv7Bytes(edge.homeMeshRid)) {
    throw new Error("insertMeshEdge: homeMeshRid must be a 16-byte UUIDv7 BLOB.");
  }
  if (!isUuidv7Bytes(edge.homeVaultRid)) {
    throw new Error("insertMeshEdge: homeVaultRid must be a 16-byte UUIDv7 BLOB.");
  }
  await db.execute({
    sql: `INSERT OR IGNORE INTO mesh_edges
 (ref_mesh_rid, ref_vault_rid, home_mesh_rid, home_vault_rid, kind)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      edge.refMeshRid,
      edge.refVaultRid,
      edge.homeMeshRid,
      edge.homeVaultRid,
      edge.kind ?? "parent",
    ],
  });
}

export async function listMeshEdgesByRefVault(
  db: Client,
  refVaultRid: Uint8Array,
): Promise<MeshEdgeRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM mesh_edges WHERE ref_vault_rid = ?",
    args: [refVaultRid],
  });
  return r.rows.map((row) => rowToMeshEdge(row as unknown as Record<string, unknown>));
}

export async function listMeshEdgesByHomeVault(
  db: Client,
  homeVaultRid: Uint8Array,
): Promise<MeshEdgeRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM mesh_edges WHERE home_vault_rid = ?",
    args: [homeVaultRid],
  });
  return r.rows.map((row) => rowToMeshEdge(row as unknown as Record<string, unknown>));
}
