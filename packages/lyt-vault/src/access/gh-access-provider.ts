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

import { deriveWriteGate, HANDLE_OK, type WriteGate } from "../flows/writability.js";
import { resolveVault } from "../registry/vault-addressing.js";
import { getIdentity } from "../util/identity.js";
import { checkPushPermission, type GhExecutor } from "../util/gh-discover.js";
import { parseOwnerRepoFromUrl } from "../util/gh.js";
import type { VaultRow } from "../registry/repo.js";

import type { AccessEntry, AccessProvider, Caller, Invitation } from "./access-provider.js";

// keystone Phase B — the default `AccessProvider` impl.
//
// `GhAccessProvider` is behavior-preserving delegation onto the existing
// auth-primitive flows: NO new policy, NO new logic. It mirrors the existing
// injection pattern (the optional `gh?: GhExecutor` threaded through
// `deriveWriteGate`) so the hot path stays probe-free — `gh` is passed through
// only when present.
//
// PHASE B-auth.0 (this file): the read side delegates to the same functions
// the callers call today. PHASE C: the mutate seam (`grant`/`revoke`) and
// the access-read seam (`listAccess`/`canShare`/`listInvitations`/
// `acceptInvitation`) are IMPLEMENTED — all gh access is isolated HERE (this is
// the only place `gh` is invoked), per the gh-as-sole-SoT design.
export class GhAccessProvider implements AccessProvider {
  private readonly db: Client;
  private readonly gh?: GhExecutor;

  constructor(db: Client, opts: { gh?: GhExecutor } = {}) {
    this.db = db;
    this.gh = opts.gh;
  }

  caller(): Caller {
    return getIdentity();
  }

  // Pure delegation to `deriveWriteGate`. Preserve the probe-free hot path:
  // pass `gh` through only if present (an empty opts object otherwise, exactly
  // as the callers do today). `caller` is accepted for the seam but unused in
  // v1 — the session identity is used implicitly by the underlying flow.
  async canWrite(vault: VaultRow, _caller?: Caller): Promise<WriteGate> {
    return deriveWriteGate(vault, this.db, this.gh !== undefined ? { gh: this.gh } : {});
  }

  // Pass-through to `resolveVault`. `caller` is accepted for the seam but unused
  // in v1.
  async resolveScoped(handle: string, _caller?: Caller): Promise<VaultRow | null> {
    return resolveVault(this.db, handle);
  }

  // Phase C — list the LIVE access grants on `vault`, read straight off
  // GitHub's repo-collaborator list (`gh api /repos/{owner}/{repo}/collaborators`,
  // `--paginate` so a repo with >30 collaborators isn't truncated). NO local
  // mirror — gh IS the SoT. Each collaborator carries a `permissions` object
  // ({pull, triage, push, maintain, admin}); we map push-or-higher → "write",
  // else "read". A non-zero gh exit (403/404) rejects — we never swallow it.
  async listAccess(vault: VaultRow, _caller?: Caller): Promise<AccessEntry[]> {
    const { owner, repo } = this.requireOwnerRepo(vault);
    const raw = await this.requireGh()([
      "api",
      "--paginate",
      `/repos/${owner}/${repo}/collaborators`,
    ]);
    const parsed = parseCollaborators(raw, `${owner}/${repo}`);
    return parsed.map((c) => ({
      caller: `github:${c.login}` as Caller,
      level: c.push ? "write" : "read",
    }));
  }

  // Phase C — can the (session) caller share `vault`? Reuses the v1.C.3
  // battle-tested `checkPushPermission` probe (ADMIN/MAINTAIN/WRITE → true). A
  // vault with no remote can't be shared — surface that as a clear throw, not a
  // silent `false`, so the caller learns to publish first.
  async canShare(vault: VaultRow, _caller?: Caller): Promise<boolean> {
    const { owner, repo } = this.requireOwnerRepo(vault);
    return checkPushPermission(this.gh !== undefined ? { owner, repo, gh: this.gh } : { owner, repo });
  }

  // Phase C — list the caller's PENDING GitHub repository invitations
  // (`gh api --paginate /user/repository_invitations`). This is the caller's
  // own invite inbox (no owner/repo arg). `caller` is accepted for the seam but
  // unused in v1 (gh reads as the ambient session identity). Each invitation's
  // owner/repo is HANDLE_OK-validated before we echo "owner/name" back.
  async listInvitations(_caller?: Caller): Promise<Invitation[]> {
    const raw = await this.requireGh()(["api", "--paginate", "/user/repository_invitations"]);
    return parseInvitations(raw);
  }

  // Phase C — accept a pending invitation by its gh id
  // (`PATCH /user/repository_invitations/{id}`). MUTATION: authorization /
  // confirmation is a verb-layer responsibility (the `vault invites --accept`
  // flow confirmed-gates this); the port trusts the caller is authorized. A
  // non-zero gh exit rejects — never swallowed.
  async acceptInvitation(id: number, _caller?: Caller): Promise<void> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`invalid invitation id "${id}" — expected a positive integer`);
    }
    await this.requireGh()(["api", "-X", "PATCH", `/user/repository_invitations/${id}`]);
  }

  // Phase C C8 (option A′): gh-repo-collaborator is the v1 ACL. `grant`
  // adds `grantee` as a collaborator at the gh permission that maps from
  // `level` ("write"→push, "read"→pull) via the GitHub REST collaborators API
  // (`PUT /repos/{owner}/{repo}/collaborators/{username}`). The richer
  // policy.yon store is Phase D — out of scope here. Mutate REQUIRES `gh`
  // (unlike the probe-free `canWrite` read path). Runs AS the ambient
  // gh-authenticated session identity — no impersonation, no caller threading.
  // HIL-GATE / authorization: ownership of `vault` is NOT verified here — that
  // is a verb-layer responsibility (the 0.9.6 `vault share` verb must gate
  // agent-invoked grants + confirm the caller owns the vault). This port trusts
  // the caller is authorized; gh's own auth is the backstop (you can only mutate
  // collaborators on a repo your gh token can admin). See Phase C.
  //
  // Idempotency (GitHub semantics): grant (`PUT /collaborators`) idempotently
  // sets/updates the collaborator permission — re-granting at the same or a
  // different level is a no-op/update, never an error. A non-zero gh exit (e.g.
  // 403/404 repo-missing) correctly rejects; we do NOT swallow it.
  async grant(vault: VaultRow, grantee: Caller, level: "read" | "write"): Promise<void> {
    const { owner, repo } = this.requireOwnerRepo(vault);
    const username = requireGithubUsername(grantee);
    const permission = level === "write" ? "push" : "pull";
    await this.requireGh()([
      "api",
      `/repos/${owner}/${repo}/collaborators/${username}`,
      "-X",
      "PUT",
      "-f",
      `permission=${permission}`,
    ]);
  }

  // Revoke `grantee`'s collaborator access via
  // `DELETE /repos/{owner}/{repo}/collaborators/{username}`. Same owner/repo +
  // username derivation as `grant`; same gh-required guard. Same ownership
  // deferral as `grant` above — authorization is a verb-layer / HIL-gate
  // responsibility, not checked here.
  //
  // Idempotency (GitHub semantics): revoke (`DELETE /collaborators`) returns 204
  // regardless of prior membership, so revoking a non-collaborator is a no-op,
  // NOT an error. We keep the existing behavior: a non-zero gh exit (a real
  // failure like 403/404 repo-missing) rejects — no retry/swallow.
  async revoke(vault: VaultRow, grantee: Caller): Promise<void> {
    const { owner, repo } = this.requireOwnerRepo(vault);
    const username = requireGithubUsername(grantee);
    await this.requireGh()([
      "api",
      `/repos/${owner}/${repo}/collaborators/${username}`,
      "-X",
      "DELETE",
    ]);
  }

  // Mutate REQUIRES a gh executor — unlike `canWrite`, there is no probe-free
  // fallback for a write.
  private requireGh(): GhExecutor {
    if (this.gh === undefined) {
      throw new Error("AccessProvider.grant/revoke requires a gh executor");
    }
    return this.gh;
  }

  // Derive {owner, repo} from `vault.gitUrl` via the shared parser. Throws a
  // clear, actionable error when there's no remote or the URL doesn't parse —
  // never a silent no-op.
  private requireOwnerRepo(vault: VaultRow): { owner: string; repo: string } {
    if (vault.gitUrl === null) {
      throw new Error(
        `cannot share/unshare vault "${vault.name}" — it has no remote (gitUrl is null); publish it first`,
      );
    }
    const parsed = parseOwnerRepoFromUrl(vault.gitUrl);
    if (parsed === null) {
      throw new Error(`could not parse owner/repo from gitUrl: ${vault.gitUrl}`);
    }
    // CR-1 defense-in-depth: validate owner/repo against the SAME HANDLE_OK
    // regex writability.ts uses, before either reaches gh. A flag-shaped or
    // separator-bearing token (`--upload-file`, one with `/`, `:`, whitespace)
    // throws here, never reaches the gh args.
    if (!HANDLE_OK.test(parsed.owner)) {
      throw new Error(`invalid owner "${parsed.owner}" parsed from gitUrl: ${vault.gitUrl}`);
    }
    if (!HANDLE_OK.test(parsed.repo)) {
      throw new Error(`invalid repo "${parsed.repo}" parsed from gitUrl: ${vault.gitUrl}`);
    }
    return parsed;
  }
}

// Stitch gh `--paginate` multi-page output (concatenated JSON arrays) into one
// parseable array. Splice adjacent `][` boundaries into `,`, then collapse the
// empty-array fragments a trailing (or leading) empty page leaves behind: a full
// page followed by an empty page yields `[{...}][]` → `[{...},]` (trailing comma)
// → would throw; `,]`→`]` and `[,`→`[` fix that. `[][]`→`[,]`→`[]`. Single-page
// and single `[]` pass through unchanged. Genuinely malformed JSON is left for
// the caller's `JSON.parse` to reject — this only normalizes page seams.
function spliceGhPages(trimmed: string): string {
  return trimmed
    .replace(/]\s*\[/g, ",")
    .replace(/,\s*]/g, "]")
    .replace(/\[\s*,/g, "[");
}

// Parse `gh api /repos/{owner}/{repo}/collaborators` JSON into {login, push}.
// GitHub returns an array of collaborator objects, each with a `login` and a
// `permissions` object ({pull, triage, push, maintain, admin} booleans). We
// read push-or-higher (`push || maintain || admin`) → write. Validates each
// login against HANDLE_OK before surfacing it (a malformed gh payload can't
// smuggle a flag-shaped login downstream). Throws on unparseable JSON — never a
// silent [].
export function parseCollaborators(
  raw: string,
  context: string,
): Array<{ login: string; push: boolean }> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    // `--paginate` may concatenate multiple JSON arrays (one per page). Splice
    // adjacent `][` boundaries into one array before parsing. An empty trailing
    // page (`[{...}][]`) splices to `[{...},]` (trailing comma) — collapse the
    // resulting empty-array fragments (`,]`→`]`, `[,`→`[`) so it parses.
    parsed = JSON.parse(spliceGhPages(trimmed));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse gh collaborators JSON for ${context}: ${msg}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`expected an array of collaborators for ${context}`);
  }
  const out: Array<{ login: string; push: boolean }> = [];
  for (const entry of parsed) {
    const obj = entry as Record<string, unknown>;
    const login = typeof obj["login"] === "string" ? (obj["login"] as string) : "";
    if (!HANDLE_OK.test(login)) continue; // skip any malformed login defensively
    const perms = (obj["permissions"] as Record<string, unknown> | undefined) ?? {};
    const push = perms["push"] === true || perms["maintain"] === true || perms["admin"] === true;
    out.push({ login, push });
  }
  return out;
}

// Parse `gh api /user/repository_invitations` JSON into Invitation[]. Each gh
// invitation object carries `id`, `repository.full_name` ("owner/name"),
// `inviter.login`, and `permissions` (a raw permission string). Validates
// owner/repo against HANDLE_OK before echoing `full_name`. Throws on
// unparseable JSON.
export function parseInvitations(raw: string): Invitation[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(spliceGhPages(trimmed));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse gh repository-invitations JSON: ${msg}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("expected an array of repository invitations");
  }
  const out: Invitation[] = [];
  for (const entry of parsed) {
    const obj = entry as Record<string, unknown>;
    const id = typeof obj["id"] === "number" ? (obj["id"] as number) : NaN;
    if (!Number.isInteger(id)) continue;
    const repository = (obj["repository"] as Record<string, unknown> | undefined) ?? {};
    const fullName =
      typeof repository["full_name"] === "string" ? (repository["full_name"] as string) : "";
    const slash = fullName.indexOf("/");
    const owner = slash === -1 ? "" : fullName.slice(0, slash);
    const repo = slash === -1 ? "" : fullName.slice(slash + 1);
    // Echo the repo only when both halves pass HANDLE_OK; otherwise blank it so
    // a malformed gh payload can't smuggle a flag-shaped token downstream.
    const repoEcho = HANDLE_OK.test(owner) && HANDLE_OK.test(repo) ? fullName : "";
    const inviterObj = (obj["inviter"] as Record<string, unknown> | undefined) ?? {};
    const inviter =
      typeof inviterObj["login"] === "string" ? (inviterObj["login"] as string) : "";
    const permission =
      typeof obj["permissions"] === "string" ? (obj["permissions"] as string) : "";
    out.push({ id, repo: repoEcho, inviter, permission });
  }
  return out;
}

// A `Caller` is `"${provider}:${handle}"`. v1 is github-only per the
// AccessProvider port comment — split on the FIRST `:`, validate the provider,
// and return the GitHub username. Throws a clear error for any non-github
// provider.
function requireGithubUsername(grantee: Caller): string {
  const idx = grantee.indexOf(":");
  const provider = idx === -1 ? grantee : grantee.slice(0, idx);
  const handle = idx === -1 ? "" : grantee.slice(idx + 1);
  if (provider !== "github") {
    throw new Error(
      `unsupported grantee provider "${provider}" — v1 AccessProvider is github-only (expected "github:<username>", got "${grantee}")`,
    );
  }
  if (handle.length === 0) {
    throw new Error(`invalid grantee "${grantee}" — expected "github:<username>"`);
  }
  // CR-1 defense-in-depth: validate the username against the SAME HANDLE_OK
  // regex (imported from writability.ts — single source) before it reaches the
  // gh args. A flag-shaped username (`--upload-file=x`) or one bearing a
  // separator throws here, never reaches gh.
  if (!HANDLE_OK.test(handle)) {
    throw new Error(`invalid github username "${handle}" — failed handle charset check`);
  }
  return handle;
}
