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

import type { WriteGate } from "../flows/writability.js";
import type { VaultRow } from "../registry/repo.js";

// keystone Phase B — the auth-primitive seam.
//
// `AccessProvider` is the GH-AGNOSTIC port over the auth primitives the vault
// flows lean on today: WHO is acting (identity), CAN they write (the write
// gate), and address resolution. The surface is identity-shaped, NOT gh-shaped:
// callers speak `Caller` (the acting identity), never gh permission strings.
// The gh-backed delegation lives behind the default impl (`GhAccessProvider`),
// so a future provider (a different host, a token store, a test double) can
// implement the same port without touching callers.
//
// PHASE B-auth.0 (this file): interface + types ONLY. No callers are moved —
// capture-index.ts / pattern-run.ts / reconcile-publish.ts still call the
// underlying flows directly; rewiring them onto the port is a later phase.
//
// PHASE C (declared, NOT implemented here): the `grant`/`revoke` mutate seam
// for the 0.9.6 sharing/publishing verbs. Declared on the port so the shape is
// frozen now; the default impl throws a clear not-implemented error naming
// Phase C (never a silent no-op).

// The acting identity, in `getIdentity()`'s `"${provider}:${handle}"` shape
// (v1: provider always "github" per arc §12.1). This is WHO a port operation
// acts as — the session identity by default; an explicit `caller` argument is
// reserved on the read/mutate signatures for the seam (impersonation,
// delegated-actor flows), even though v1 uses the session identity implicitly.
export type Caller = string;

// keystone Phase C — a single live access grant on a vault, read straight
// off GitHub's repo-collaborator list (gh-as-sole-SoT; NO local mirror). `level`
// maps gh's permission ladder (read < triage < write/push < maintain < admin)
// onto the same read/write the mutate seam speaks: write = push-or-higher
// (push/maintain/admin); read = everything below push (pull/triage — triage sits
// BELOW push, so it maps to "read", not "write"). The `caller` carries the
// `"github:<handle>"` shape so it round-trips with grant().
export interface AccessEntry {
  caller: Caller;
  level: "read" | "write";
}

// keystone Phase C — a pending GitHub repository invitation read off
// `/user/repository_invitations` (the caller's inbox). `id` is the gh
// invitation id (PATCH target for accept); `repo` is "owner/name"; `permission`
// is gh's raw permission string (read|write|admin|triage|maintain).
export interface Invitation {
  // Deliberate, scoped exception to the gh-agnostic port rule: a pending GitHub
  // invitation is a host-side artifact with no LYT-local identity to mint, so its
  // gh id is threaded as-is (confined to the invitations seam).
  id: number;
  repo: string;
  inviter: string;
  permission: string;
}

export interface AccessProvider {
  // --- Read side ---

  // Who is acting. Delegates to `getIdentity()`.
  caller(): Caller;

  // The write verdict for `vault`. Delegates to `deriveWriteGate()`. `caller`
  // is optional in v1 (the session identity is used implicitly) but PRESENT on
  // the signature so the seam carries the acting identity once Phase C lands.
  canWrite(vault: VaultRow, caller?: Caller): Promise<WriteGate>;

  // Resolve a vault address to its row, or null when nothing matches. Wraps
  // `resolveVault()`; v1 is a pass-through (returns exactly what `resolveVault`
  // returns). `caller` is reserved for caller-scoped resolution in a later phase.
  resolveScoped(handle: string, caller?: Caller): Promise<VaultRow | null>;

  // --- Access read seam (Phase C — gh-as-SoT, NO local mirror) ---

  // List the LIVE access grants on `vault`, read straight off GitHub's
  // repo-collaborator list. The default impl MUST hit gh (never a stale local
  // store) or throw — never silently return []. `caller` is reserved for the
  // seam; v1 reads as the ambient gh session identity.
  listAccess(vault: VaultRow, caller?: Caller): Promise<AccessEntry[]>;

  // Capability check: can the (session) caller share `vault` — i.e. does it have
  // push/admin on the repo? Reuses the gh push-permission probe. The default
  // impl MUST probe gh or throw — never a silent `false`.
  canShare(vault: VaultRow, caller?: Caller): Promise<boolean>;

  // --- Invitations read/accept seam (Phase C — gh-as-SoT) ---

  // List the caller's PENDING GitHub repository invitations
  // (`/user/repository_invitations`). The default impl MUST hit gh or throw.
  listInvitations(caller?: Caller): Promise<Invitation[]>;

  // Accept a pending invitation by its gh id
  // (`PATCH /user/repository_invitations/{id}`). MUTATION: the verb layer
  // confirmed-gates this; the port itself trusts the caller is authorized.
  acceptInvitation(id: number, caller?: Caller): Promise<void>;

  // --- Mutate seam (Phase C — DECLARED, NOT IMPLEMENTED) ---

  // Grant `grantee` `level` access on `vault`. The default impl MUST throw a
  // clear not-implemented error naming Phase C — never a silent no-op.
  grant(vault: VaultRow, grantee: Caller, level: "read" | "write"): Promise<void>;

  // Revoke `grantee`'s access on `vault`. The default impl MUST throw a clear
  // not-implemented error naming Phase C — never a silent no-op.
  revoke(vault: VaultRow, grantee: Caller): Promise<void>;
}

// Re-export the types consumers of the port need, so they can depend on the
// port module alone without reaching into the underlying flow/registry files.
export type { WriteGate } from "../flows/writability.js";
export type { VaultRow } from "../registry/repo.js";
