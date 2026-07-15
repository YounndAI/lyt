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

import { GhAccessProvider } from "../access/gh-access-provider.js";
import type { AccessProvider, Invitation } from "../access/access-provider.js";
import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByRid } from "../registry/repo.js";
import { vaultLeaf } from "../registry/vault-addressing.js";
import { bucketMeshName, bucketVaultRelDir, entryModeForSource } from "../util/bucket-mesh.js";
import {
  isReservedFederationRepoName,
  resolveVaultRef,
  slugifyHandle,
} from "../util/federation-paths.js";
import type { GhExecutor } from "../util/gh-discover.js";
import { isValidGhHandle } from "../util/identity.js";
import { resolveRemoteUrlFromSlug } from "../util/remote-url.js";
import { uuid7BytesToHex } from "../util/uuid7.js";
import { cloneVaultFlow } from "./clone.js";
import { reflectInboundIndex, type ReflectInboundIndexResult } from "./reflect-index.js";
import type { SubscribeCloneArgs, SubscribeCloneFn, SubscribeCloneResult } from "./subscribe.js";

// Inc-2 Phase B / #2 (0.12.1) — the ONE-VERB private-share ACCEPT path.
//
// `lyt vault accept-share --invite <id> --yes` closes the receive loop for a
// PRIVATELY-GRANTED vault: it accepts the pending GitHub repository invitation
// (built on vaultInvitesFlow's AccessProvider seam), then clones the now-accessible
// private vault into its OWNER-KEYED `shared/{owner}` bucket (source='shared',
// NEVER commingled into one of the receiver's OWN meshes), and auto-indexes it so
// `lyt search`/`recall`/`primer` hit on arrival.
//
// This is the sibling of `lyt mesh subscribe` (which self-subscribes a PUBLIC
// vault into `subscriptions/{owner}`): accept-share receives a PRIVATE grant. It
// is the receive path through which `source=shared` is reachable end-to-end. The
// owner-bucket routing reuses the SAME util/bucket-mesh helpers subscribe + the
// sync reconstitution use, so the live home and the reconstituted bucket agree
// byte-for-byte.
//
// SECURITY: the invitation `repo` ("owner/name") is UNTRUSTED gh content — its
// owner + repo are HANDLE_OK-screened at parse (gh-access-provider.parseInvitations)
// and re-validated here (isValidGhHandle) before any value flows toward a git-clone
// argv; the clone-boundary field-hygiene + preserve-rid name==ref guard
// (VaultIdentityMismatchError) + the leading-dash URL guard + `--` argv terminator
// in cloneVaultFlow are the deeper backstops. A shared vault ALWAYS homes under
// `shared/{owner}` keyed by the REAL owner — it can never occupy or commingle into
// the receiver's own namespace.

export interface AcceptShareArgs {
  // The gh invitation id to accept (from `lyt vault invites`).
  inviteId: number;
  // Explicit handler confirmation for the accept + clone mutation (CLI `--yes`).
  confirmed: boolean;
  // Open-once seam — the flow opens (and closes) its own registry when omitted.
  registryDb?: Client | undefined;
  // Injectable AccessProvider — tests inject a fake exposing listInvitations +
  // acceptInvitation. Defaults to a GhAccessProvider (real gh).
  accessProvider?: AccessProvider | undefined;
  // Injectable gh executor used only when `accessProvider` is NOT supplied.
  gh?: GhExecutor | undefined;
  // Injectable clone seam (mirrors subscribeFlow.cloneFn) — tests provide a fn
  // that materializes the received vault locally without touching the network.
  cloneFn?: SubscribeCloneFn | undefined;
}

export interface AcceptShareResult {
  invitationId: number;
  vault: {
    name: string;
    ridHex: string;
    homeMeshName: string;
    path: string;
  };
  // The received foreign provenance — ALWAYS 'shared' (a private grant).
  source: "shared";
  // Machine-local index reflect result (best-effort; the vault on disk is the
  // durable side-effect). null only when the registered vault could not be
  // re-read (defensive).
  indexed: ReflectInboundIndexResult | null;
}

// Raised when the requested invitation id is not in the caller's pending
// invitations inbox. Surfaced as exit 1 by the CLI.
export class InvitationNotFoundError extends Error {
  readonly errorCode = "invitation-not-found";
  readonly inviteId: number;
  constructor(inviteId: number) {
    super(
      `No pending GitHub repository invitation with id ${inviteId} was found in your inbox. ` +
        `Run 'lyt vault invites' to list your pending invitations and their ids.`,
    );
    this.name = "InvitationNotFoundError";
    this.inviteId = inviteId;
  }
}

// Raised when an invitation's repo ("owner/name") is not a resolvable
// {owner}/{repo} shape (e.g. blanked by the HANDLE_OK screen, or not two
// segments). Fail-closed BEFORE any clone.
export class AcceptShareBadRepoError extends Error {
  readonly errorCode = "accept-share-bad-repo";
  readonly repo: string;
  constructor(repo: string) {
    super(
      `Refusing to accept-share: the invitation's repository '${repo}' is not a resolvable ` +
        `'{owner}/{repo}' reference (it may carry an unsafe owner/name, or is not a Lyt vault ` +
        `repo). Verify the invitation with 'lyt vault invites'.`,
    );
    this.name = "AcceptShareBadRepoError";
    this.repo = repo;
  }
}

// FIX B (A2-R2 G3-1) — raised when an accept-share invite targets the federation
// MANIFEST repo (`lyt-pod` / `lyt-pod-map`). Accepting it (then cloning it) would
// hand the receiver the publisher's whole federation map — every push_target and
// every vault rid. Fail-closed BEFORE the gh acceptInvitation mutation, so the
// invitation is NEVER consumed on the manifest repo. Mirrors the G3 share/subscribe
// arm refusals; a normal vault invite (`lyt-vault-<mesh>--<leaf>`) is unaffected.
export class AcceptShareReservedRepoError extends Error {
  readonly errorCode = "accept-share-reserved-repo";
  readonly repo: string;
  constructor(repo: string) {
    super(
      `Refusing to accept-share '${repo}': it is the federation manifest repo ` +
        `(lyt-pod / lyt-pod-map), which is un-shareable — accepting it would expose the ` +
        `publisher's every push_target, vault rid, and whole federation map. Accept a ` +
        `single vault invite instead.`,
    );
    this.name = "AcceptShareReservedRepoError";
    this.repo = repo;
  }
}

// a review finding (Phase B release review) — raised when the gh invitation was ALREADY
// ACCEPTED (consumed) but the subsequent clone failed. Distinct from
// InvitationNotFoundError so a retry doesn't look like a fresh bad id: the invite
// is gone, but the repo is now clonable directly. Carries the actionable remedy.
export class AcceptShareCloneFailedError extends Error {
  readonly errorCode = "accept-share-clone-failed";
  readonly cloneUrl: string;
  override readonly cause: unknown;
  constructor(cloneUrl: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Accepted the GitHub invitation, but cloning the shared vault then failed: ${detail}. ` +
        `The invitation is now CONSUMED (re-running accept-share will report the invite as not ` +
        `found), but the private repo is already accessible to your gh account. Retry the receive ` +
        `directly with 'lyt vault clone ${cloneUrl}' (or 'lyt mesh subscribe' for a public vault).`,
    );
    this.name = "AcceptShareCloneFailedError";
    this.cloneUrl = cloneUrl;
    this.cause = cause;
  }
}

// Default clone seam — clones the now-accessible PRIVATE vault into its
// `shared/{owner}` bucket via cloneVaultFlow. preserve-rid (keep the publisher
// identity + a clean tracked tree) + autoRegisterExternalMesh (the owner-bucket
// is a system mesh record, main NULL) + foreignSource='shared'. autoIndex is NOT
// set here — acceptShareFlow reflects the index itself so it can surface the stats.
const defaultCloneFn: SubscribeCloneFn = async (args: SubscribeCloneArgs): Promise<SubscribeCloneResult> => {
  const clone = await cloneVaultFlow({
    url: args.cloneUrl,
    name: args.vaultName,
    toMesh: args.homeMeshName,
    ...(args.targetSubdir !== undefined ? { targetSubdir: args.targetSubdir } : {}),
    registryDb: args.registryDb,
    autoRegisterExternalMesh: true,
    foreignSource: args.foreignSource,
    preserveRid: true,
  });
  // R3/a review finding (Phase B release review) — resolve by the RID the clone returned, not
  // the non-unique `name` (post-migration-003 names are not unique, so a crafted
  // name collision could return the WRONG row). `clone.rid` is the identity.
  const vault = await getVaultByRid(args.registryDb, clone.rid);
  if (vault === null || vault.homeMeshRid === null) {
    throw new Error(
      `accept-share: clone succeeded but registry lookup of rid '${clone.ridHex}' ` +
        `(name '${clone.name}') returned no vault row with home_mesh_rid ` +
        `(defensive — shouldn't happen).`,
    );
  }
  return {
    vaultRid: vault.rid,
    vaultRidHex: uuid7BytesToHex(vault.rid),
    homeMeshRid: vault.homeMeshRid,
  };
};

export async function acceptShareFlow(args: AcceptShareArgs): Promise<AcceptShareResult> {
  // MUTATION (gh accept + clone) — refuse without explicit confirmation, mirroring
  // vaultInvitesFlow's accept gate. Gate FIRST, before any gh call or side effect.
  if (!args.confirmed) {
    throw new Error(
      `Refusing to accept-share invitation '${args.inviteId}' without explicit confirmation. ` +
        `CLI: pass --yes. Agent/MCP: this mutation is handler-gated; confirmation is required ` +
        `and MCP dispatch is gated (default-deny unless the server was launched with ` +
        `out-of-band handler approval). This flow-layer refusal is defense-in-depth.`,
    );
  }

  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  try {
    const provider = resolveProvider(db, args);

    // 1. Resolve the invitation by id → its repo ("owner/name"). We list (read-
    //    only) BEFORE accepting so a bad id fails closed with NO mutation.
    const invitations = await provider.listInvitations();
    const invite: Invitation | undefined = invitations.find((i) => i.id === args.inviteId);
    if (invite === undefined) {
      throw new InvitationNotFoundError(args.inviteId);
    }

    // 2. Validate the UNTRUSTED repo ref BEFORE it flows toward a clone argv.
    const repo = invite.repo;
    const slash = repo.indexOf("/");
    const rawOwner = slash < 0 ? "" : repo.slice(0, slash);
    const rawRepoName = slash < 0 ? "" : repo.slice(slash + 1);
    // R3/R1 (Phase B release review) — SYMMETRIC gate: screen the repo NAME with the
    // same defense-in-depth handle check as the owner (not just a length check),
    // so a future non-screening AccessProvider can't leave a metachar-bearing repo
    // name to flow toward a git-clone argv. (`isValidGhHandle` rejects empty too,
    // subsuming the prior length guard.)
    if (!isValidGhHandle(rawOwner) || !isValidGhHandle(rawRepoName)) {
      throw new AcceptShareBadRepoError(repo);
    }
    // FIX B (A2-R2 G3-1) — G3 accept arm. Refuse the federation MANIFEST repo
    // (`lyt-pod` / `lyt-pod-map`) BEFORE the gh acceptInvitation mutation below, so
    // no invitation is consumed and no manifest is cloned. Keyed on the RAW repo
    // NAME (the true repo identity); a genuine vault repo follows the
    // `lyt-vault-<mesh>--<leaf>` convention and never collides.
    if (isReservedFederationRepoName(rawRepoName)) {
      throw new AcceptShareReservedRepoError(repo);
    }
    // Canonical `{mesh}/{leaf}` identity (a shared Lyt vault is a convention repo).
    const ref = resolveVaultRef(repo);
    if (ref === null) {
      throw new AcceptShareBadRepoError(repo);
    }

    // 3. Accept the invitation (the gh mutation). AFTER this the private repo is
    //    clonable by the caller's gh session.
    await provider.acceptInvitation(args.inviteId);

    // 4. Owner-keyed SHARED bucket routing (owner = the REAL GH owner, never the
    //    mesh segment). shared/{owner} + separated on-disk subtree.
    const bucketOwner = slugifyHandle(rawOwner);
    const homeMeshName = bucketMeshName(entryModeForSource("shared"), bucketOwner);
    const targetSubdir = bucketVaultRelDir("shared", bucketOwner, vaultLeaf(ref.vaultName));
    // Build the clone URL from the RAW invitation repo (the ground truth), not a
    // re-derived convention name — so a non-standard repo name still clones from
    // the right place; the clone-boundary name==ref guard backstops identity.
    const cloneUrl = resolveRemoteUrlFromSlug(`${rawOwner}/${rawRepoName}`);

    const cloneFn = args.cloneFn ?? defaultCloneFn;
    // a review finding (Phase B release review) — the accept (gh mutation) above already
    // consumed the invitation; if the clone now throws, a bare retry would hit
    // InvitationNotFoundError. Wrap the failure with the remediation (the repo is
    // now clonable directly). The accept→clone ordering is inherent to the gh
    // invitation model and is NOT changed.
    // a review finding (Phase B release review) — the accept (gh mutation) above already
    // consumed the invitation; if the clone now throws, a bare retry would hit
    // InvitationNotFoundError. Wrap the failure with the remediation (the repo is
    // now clonable directly). The accept→clone ordering is inherent to the gh
    // invitation model and is NOT changed.
    let cloneResult: SubscribeCloneResult;
    try {
      cloneResult = await cloneFn({
        vaultName: ref.vaultName,
        homeMeshName,
        targetSubdir,
        foreignSource: "shared",
        cloneUrl,
        registryDb: db,
      });
    } catch (err) {
      throw new AcceptShareCloneFailedError(cloneUrl, err);
    }

    // 5. Re-read the registered vault + auto-index (reflect the committed SoT so
    //    search hits on arrival — no manual reindex). Best-effort index.
    // R3/a review finding — resolve by the RID the clone returned, not the non-unique
    //    `name` (a crafted name collision could otherwise return the wrong row).
    const vault = await getVaultByRid(db, cloneResult.vaultRid);
    if (vault === null) {
      throw new Error(
        `accept-share: clone of '${ref.vaultName}' (rid ${cloneResult.vaultRidHex}) succeeded ` +
          `but the vault is not in the registry (defensive).`,
      );
    }
    const indexed = await reflectInboundIndex(vault.name, vault.path);

    return {
      invitationId: args.inviteId,
      vault: {
        name: vault.name,
        ridHex: cloneResult.vaultRidHex,
        homeMeshName,
        path: vault.path,
      },
      source: "shared",
      indexed,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

function resolveProvider(db: Client, args: AcceptShareArgs): AccessProvider {
  if (args.accessProvider !== undefined) return args.accessProvider;
  return new GhAccessProvider(db, args.gh !== undefined ? { gh: args.gh } : {});
}
