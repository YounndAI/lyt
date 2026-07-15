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

// Inc-2 Phase B / the SINGLE source of truth for the reserved OWNER-BUCKET
// mesh name of a foreign (subscribed / shared) vault. BOTH the LIVE receive path
// (flows/clone.ts + flows/subscribe.ts, which home a freshly-cloned foreign vault
// into its bucket at receive time) AND the sync RECONSTITUTION
// (flows/federation/rebuildFederationCacheFlow.ts, which re-homes the derived
// mesh_subscriptions cache from the ledger) MUST agree byte-for-byte on this
// name — otherwise the live home mesh and the reconstituted one diverge and a
// foreign vault appears under two mesh names. Keeping the rule here (imported by
// both) is the coupled-constant fix (audit-coupled-constant): one rule, two
// callers, no drift.
//
// The realized bucket mesh name is `<prefix>/<owner>`:
//   subscribe  → `subscriptions/{owner}`
//   shared     → `shared/{owner}`
// where `{owner}` is the OWNER segment of the subscribed vault's origin
// coordinate (`lyt:vault:<host>/<owner>/<repo>`), so two distinct upstream
// owners home into distinct bucket meshes and never commingle with EACH OTHER
// or with one of the user's OWN meshes (the dogfood bug: a colleague's
// subscribed relay landed under the user's own `marlink/` tree).
//
// The two prefixes are the leading mesh segment guarded by RESERVED_MESH_NAMES
// (util/identity.ts) — a USER cannot occupy them; the system creates the bucket
// mesh directly via registry insertMesh (which bypasses validateMeshName), so
// the reserved-name guard blocks user occupation WITHOUT blocking this path.

export const SUBSCRIPTION_BUCKET_MESH = "subscriptions";
export const SHARED_BUCKET_MESH = "shared";

// B3a (Inc-2 Phase B slice 2) — is `name` a FOREIGN owner-bucket mesh name?
// A foreign bucket mesh is named `<prefix>/<owner>` where the LEADING segment is
// one of the two foreign bucket prefixes (`subscriptions` / `shared`). A USER
// cannot occupy these prefixes (RESERVED_MESH_NAMES guards the user-facing name
// validators), so any mesh whose leading segment is a foreign bucket prefix is
// DEFINITIVELY a system-created foreign bucket — a subscribed/shared vault's home
// mesh, which correctly has NO main_vault_rid. This is the structural
// discriminator doctor uses to suppress the no-main-vault warn for foreign
// meshes (byte-for-byte the same names bucketMeshName mints). Self-sufficient
// with zero homed vault rows (the name alone decides), so it resolves the
// own-vs-foreign question even before any vault is homed. `agents`/`published`
// are reserved but NOT foreign buckets, so they are deliberately excluded here.
export function isForeignBucketMeshName(name: string): boolean {
  const leading = name.split("/", 1)[0]?.toLowerCase() ?? "";
  return leading === SUBSCRIPTION_BUCKET_MESH || leading === SHARED_BUCKET_MESH;
}

export type BucketEntryMode = "subscribe" | "shared" | (string & {});

// (entry_mode, owner) → reserved OWNER-BUCKET mesh name. `subscribe` →
// `subscriptions/{owner}`; `shared` → `shared/{owner}`. Any other entry_mode
// defaults to the subscriptions prefix (defensive — the write path only ever
// emits subscribe|shared).
export function bucketMeshName(entryMode: BucketEntryMode, owner: string): string {
  const prefix = entryMode === "shared" ? SHARED_BUCKET_MESH : SUBSCRIPTION_BUCKET_MESH;
  return `${prefix}/${owner}`;
}

// the SINGLE mapping from the STORED `source` provenance to the ledger
// `entry_mode` used for bucket naming. `shared` (a granted PRIVATE vault) →
// `shared` bucket; `subscribed` (a self-subscribed PUBLIC vault) → `subscribe`
// bucket. Keeping this here (beside bucketMeshName) is the coupled-constant fix:
// the live receive path (subscribe/clone), the ledger write, and the sync
// reconstitution all derive the SAME entry_mode from `source`, so the on-disk
// tree can never diverge between the live home and the reconstituted one.
export function entryModeForSource(source: "shared" | "subscribed"): "shared" | "subscribe" {
  return source === "shared" ? "shared" : "subscribe";
}

// the vault-root-RELATIVE on-disk directory a foreign vault homes into:
//   subscribed → `subscriptions/{owner}/{leaf}`
//   shared     → `shared/{owner}/{leaf}`
// This is the on-disk sibling of bucketMeshName (the home MESH name is the
// `{bucket}/{owner}` prefix; the on-disk dir appends the vault leaf). Used by the
// live receive path AND the lazy repair so both compute the identical target.
export function bucketVaultRelDir(
  source: "shared" | "subscribed",
  owner: string,
  leaf: string,
): string {
  return `${bucketMeshName(entryModeForSource(source), owner)}/${leaf}`;
}
