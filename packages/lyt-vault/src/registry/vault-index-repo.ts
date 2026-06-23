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

import { isUuidv7Bytes } from "../util/uuid7.js";

// federation-v2 Layer-1 D1a — the names→rid INDEX repo. This is the indexed
// query layer that replaces the resolver chokepoint's per-row O(N) scan
// (vault-addressing.resolveVault: `SELECT rid FROM vaults` + a per-row
// getVaultByRid round-trip) with single, index-backed lookups.
//
// THE PER-BRANCH TOMBSTONE RAIL (load-bearing — this module must NOT defeat it):
// resolveVault filters tombstones DIFFERENTLY per branch:
//   - exact-name / path / coordinate branches (steps 1/2/4): tombstoned vaults
//     STILL resolve (a stored exact reference to a tombstoned vault is a hit).
//   - bare-leaf branch (step 5b): tombstoned vaults are EXCLUDED, and >1 LIVE
//     match THROWS AmbiguousVaultLeafError — never tiebreaks.
// This module preserves that split in the QUERY (not the schema): the
// leaf-multiplicity query filters `status != 'tombstoned'`; the rid lookups by
// path do not. Because the leaf query returns ALL live rids for a leaf, the
// resolver still sees a multiplicity > 1 for two live same-leaf vaults and
// still throws — the never-tiebreak rail is intact.
//
// All rid blobs come back as Uint8Array (libSQL returns BLOB as ArrayBuffer on
// some Windows build paths; normalize at this boundary).

function toRidBytes(raw: unknown): Uint8Array | null {
  if (!isUuidv7Bytes(raw)) return null;
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
}

// leaf → {rids} multiplicity query (the never-tiebreak input). Returns the rids
// of every LIVE (non-tombstoned) vault whose bare leaf equals `leaf`, ordered
// stably by name so callers building candidate lists are deterministic.
//
// Mirrors resolveVault step 5b's filter EXACTLY:
//   leafMatches = allVaults.filter(v => v.status !== "tombstoned" && vaultLeaf(v.name) === leaf)
// 0 rids → leaf miss; 1 rid → unique resolve; ≥2 rids → AMBIGUOUS (the caller
// throws AmbiguousVaultLeafError; this layer never tiebreaks).
export async function resolveLeafRids(db: Client, leaf: string): Promise<Uint8Array[]> {
  const r = await db.execute({
    sql: "SELECT rid FROM vaults WHERE leaf = ? AND status != 'tombstoned' ORDER BY name ASC",
    args: [leaf],
  });
  const out: Uint8Array[] = [];
  for (const row of r.rows) {
    const rid = toRidBytes((row as unknown as Record<string, unknown>)["rid"]);
    if (rid !== null) out.push(rid);
  }
  return out;
}

// Count of LIVE vaults sharing a leaf — the multiplicity scalar. Convenience for
// callers that only need to know "is this leaf ambiguous?" without the rid list.
export async function leafMultiplicity(db: Client, leaf: string): Promise<number> {
  return (await resolveLeafRids(db, leaf)).length;
}

// rid of the vault at an on-disk path, or null. `path` is already canonicalized
// by callers (the `vaults.path` UNIQUE index backs this; status-AGNOSTIC, like
// the exact-name branch — a tombstoned vault still resolves by its path).
export async function resolvePathRid(db: Client, path: string): Promise<Uint8Array | null> {
  const r = await db.execute({
    sql: "SELECT rid FROM vaults WHERE path = ?",
    args: [path],
  });
  if (r.rows.length === 0) return null;
  return toRidBytes((r.rows[0] as unknown as Record<string, unknown>)["rid"]);
}

// All vault rids that carry a non-null git_url, paired with the raw git_url, for
// the cross-pod origin-coordinate branch. Index-backed (idx_vaults_git_url) and
// status-AGNOSTIC (matching resolveVault step 4 — a tombstoned vault still
// resolves by its origin coordinate). The caller normalizes each git_url to a
// coordinate and compares; returning the raw url keeps the normalization in the
// one place that owns gitUrlToCoordinate.
export async function listGitUrlRids(
  db: Client,
): Promise<{ rid: Uint8Array; gitUrl: string }[]> {
  const r = await db.execute(
    "SELECT rid, git_url FROM vaults WHERE git_url IS NOT NULL",
  );
  const out: { rid: Uint8Array; gitUrl: string }[] = [];
  for (const row of r.rows) {
    const rec = row as unknown as Record<string, unknown>;
    const rid = toRidBytes(rec["rid"]);
    if (rid === null) continue;
    const gitUrl = rec["git_url"];
    if (gitUrl == null) continue;
    out.push({ rid, gitUrl: String(gitUrl) });
  }
  return out;
}
