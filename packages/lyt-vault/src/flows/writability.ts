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

import { checkPushPermission, type GhExecutor } from "../util/gh-discover.js";
import { setVaultGitUrl, type VaultRow } from "../registry/repo.js";
import { readGitRemoteOriginUrl } from "../util/git.js";

// v1.G.2 — derive `writable` for a registered vault. Tri-state:
// true — user can push (gh viewerPermission ∈ {ADMIN,MAINTAIN,WRITE})
// false — user cannot push (pure subscriber, or gh viewerPermission
// ∈ {TRIAGE,READ,NONE})
// "unknown" — cannot verify (gh unavailable, no remote, orphan vault,
// unrecognised gitUrl shape); handler should pause and ask
// before any write op.
//
// Path C constraint (OD-PATH ratified 2026-06-01 by Alex): NO schema
// migration. The vaults table at registry/migrations.ts:38-55 stays
// shape-stable. Writability is derived on-demand from
// (mesh_vaults.role, gh probe) and cached in-process only.
//
// The probe reuses checkPushPermission() from util/gh-discover.ts
// (the v1.C.3 battle-tested probe). The probe takes {owner, repo}
// strings while the vaults registry stores gitUrl as a full URL;
// we parse owner/repo with a thin inline adapter (per brief CC1).
//
// Cache: in-process Map keyed by vault rid hex. 1-minute TTL.
// "unknown" verdicts are intentionally NOT cached — a transient
// outage (or a missing remote, or a probe error) should not pin a
// vault as "unknown" for a minute.
//
// v1.G.2 release review fixes (CR-1, MA-1, MA-2):
// - parseOwnerRepoFromGitUrl validates owner/repo against a strict
// GitHub-handle charset before returning, so a crafted gitUrl can't
// smuggle a flag-shaped owner like `--upload-file=...` into the gh
// CLI positional. (CR-1 gh-flag injection close.)
// - Subscriber check is now home-first: a vault that is `home` in any
// mesh derives via gh probe (home wins over a subscribed-elsewhere
// row). Pure subscribers (no home row) return false. Orphan vaults
// (no mesh_vaults rows at all) return "unknown" — they were never
// declared write-capable, and the gh probe can't infer intent. (MA-1.)
// - The reason union has a new "no-remote" variant for the gitUrl=null
// and unparseable-gitUrl branches — these are NOT gh-outage cases.
// (MA-2.)

export type WritabilityVerdict =
  | { writable: true; reason: "gh-viewerCanPush-true" }
  | { writable: false; reason: "subscriber-default-false" | "gh-viewerCanPush-false" }
  | {
      writable: "unknown";
      reason: "gh-unavailable" | "no-remote" | "orphan-vault";
    };

const cache = new Map<string, { verdict: WritabilityVerdict; expiresAt: number }>();
const TTL_MS = 60_000;

// Test seam: vitest beforeEach calls this to reset module-scope state.
export function __clearWritabilityCache(): void {
  cache.clear();
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

// GitHub handle charset: alnum, hyphen, underscore, dot. Must start with
// alnum to refuse flag-shaped tokens (e.g. `--upload-file=...`). Bounded
// length cap mirrors GitHub's own limits (39 chars for usernames; 100
// for repo names) — defensive cap is 100 here, since we don't need to
// distinguish.
const HANDLE_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// Thin adapter — extracts {owner, repo} from a gitUrl string. Handles
// the two forms emitted by lyt-vault flows: https URLs (with optional
// .git suffix) and ssh URLs (git@host:owner/repo[.git]). Returns null
// on shapes we don't recognise OR on owner/repo tokens that fail the
// handle charset check, so the caller can surface "no-remote".
function parseOwnerRepoFromGitUrl(gitUrl: string | null): OwnerRepo | null {
  if (gitUrl === null) return null;
  const trimmed = gitUrl.trim();
  if (trimmed.length === 0) return null;
  const httpsMatch = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
    const owner = httpsMatch[1];
    const repo = httpsMatch[2];
    if (HANDLE_OK.test(owner) && HANDLE_OK.test(repo)) return { owner, repo };
    return null;
  }
  const sshMatch = /^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    const owner = sshMatch[1];
    const repo = sshMatch[2];
    if (HANDLE_OK.test(owner) && HANDLE_OK.test(repo)) return { owner, repo };
    return null;
  }
  return null;
}

export type RoleSummary = { hasHome: boolean; hasSubscribed: boolean };

export async function loadRoleSummary(db: Client, vaultRid: Uint8Array): Promise<RoleSummary> {
  const r = await db.execute({
    sql: "SELECT role FROM mesh_vaults WHERE vault_rid = ?",
    args: [vaultRid],
  });
  let hasHome = false;
  let hasSubscribed = false;
  for (const row of r.rows) {
    const role = String((row as unknown as Record<string, unknown>)["role"]);
    if (role === "home") hasHome = true;
    else if (role === "subscribed") hasSubscribed = true;
  }
  return { hasHome, hasSubscribed };
}

// hardening pass (Cohort-1 fix-pass) — the CHEAP, LOCAL read-only signal shared
// by the capture write-gate and the sync skip-decision. A PURE SUBSCRIBER is a
// vault registered `subscribed` in some mesh and NOT `home` anywhere: by the
// MA-1 home-first contract in deriveVaultWritable this is exactly the
// `writable:false / subscriber-default-false` verdict — derivable with NO gh
// probe (no network on the hot capture path). This is the SAME mesh_vaults.role
// query deriveVaultWritable runs; we expose it standalone so write/sync flows
// can refuse a known-unwritable vault without paying for (or depending on) a
// live gh round-trip. A `home` vault — even one subscribed elsewhere — is NOT a
// pure subscriber (home wins), so this never refuses a vault the user owns.
export async function isPureSubscriberVault(db: Client, vaultRid: Uint8Array): Promise<boolean> {
  const roles = await loadRoleSummary(db, vaultRid);
  return !roles.hasHome && roles.hasSubscribed;
}

export interface DeriveVaultWritableOpts {
  // Injectable for tests — defaults to the real `gh` CLI invocation
  // via util/gh-discover.ts's defaultGh executor.
  gh?: GhExecutor;
}

export async function deriveVaultWritable(
  vault: VaultRow,
  db: Client,
  opts: DeriveVaultWritableOpts = {},
): Promise<WritabilityVerdict> {
  const cached = cache.get(vault.ridHex);
  if (cached && cached.expiresAt > Date.now()) return cached.verdict;

  const roles = await loadRoleSummary(db, vault.rid);

  // MA-1 home-first: a vault that is `home` anywhere derives via gh
  // probe (home wins over a subscribed-elsewhere row). Pure subscribers
  // (subscribed without a home row) get false — the same local-only
  // signal isPureSubscriberVault() exposes to the capture/sync gates.
  // Orphan vaults (no rows at all) get "unknown" — intent never declared.
  if (!roles.hasHome && roles.hasSubscribed) {
    const v: WritabilityVerdict = {
      writable: false,
      reason: "subscriber-default-false",
    };
    cache.set(vault.ridHex, { verdict: v, expiresAt: Date.now() + TTL_MS });
    return v;
  }
  if (!roles.hasHome && !roles.hasSubscribed) {
    // Orphan: not declared home anywhere, not subscribed anywhere.
    // Don't cache — promotion to home or subscribed should surface
    // immediately on the next call.
    return { writable: "unknown", reason: "orphan-vault" };
  }

  // V-A-10 self-heal (2026-06-10): a vault initialised local-first carries
  // git_url=null in the registry until a remote is wired. publish/sync set the
  // git `origin` on the vault dir but never reconcile it back, so writable would
  // be pinned "unknown" (no-remote) forever for every self-init'd home vault —
  // the gh probe below would never be reached. Read the live `origin` as the
  // source of truth and persist it back so the registry cache self-heals (L3
  // lazy-on-read; reconcile = correctness floor). The write is best-effort: a
  // failure MUST NOT change the verdict — we already hold the live value.
  let gitUrl = vault.gitUrl;
  if (gitUrl === null) {
    const liveRemote = readGitRemoteOriginUrl(vault.path);
    if (liveRemote !== null) {
      gitUrl = liveRemote;
      try {
        await setVaultGitUrl(db, vault.rid, liveRemote);
      } catch {
        // non-fatal — the verdict below uses the live value regardless.
      }
    }
  }

  const ownerRepo = parseOwnerRepoFromGitUrl(gitUrl);
  if (ownerRepo === null) {
    // MA-2: no registry git_url AND no live origin (or unparseable). NOT a gh
    // outage — distinct reason so downstream consumers (G.5, G.7) can phrase
    // the handler prompt correctly ("This vault has no remote — push won't
    // work anyway") rather than misleading "gh offline". Don't cache — adding
    // a remote later should surface immediately.
    return { writable: "unknown", reason: "no-remote" };
  }

  // hardening pass (Cohort-1 fix-pass) — RETRY ONCE before classifying gh-unavailable.
  // ROOT CAUSE (live S5 repro): the SAME session's probe returned DEFINITE
  // verdicts for two subscribed vaults seconds earlier, yet the user's OWN
  // freshly-created `personal/main` resolved `writable:"unknown"
  // /gh-unavailable`. The probe surface works; the home-vault path threw a
  // ONE-OFF. The likeliest shape on a just-created repo is GitHub's own
  // eventual consistency: `gh repo view <owner>/<repo>` can briefly 404 /
  // "could not resolve to a Repository" for a repo created seconds earlier
  // (the API node hasn't caught up) — checkPushPermission maps that 404 to
  // `false` (not a throw), so a pure 404 would NOT land here; the throw is the
  // transient-error shape (rate-limit blip, a momentary auth re-handshake, or
  // a Windows spawn hiccup distinct from the V-B-9 ENOENT already handled).
  // A single retry collapses that transient into a definite verdict, so a
  // vault the user owns + can push resolves `writable:true` on the common
  // path instead of forcing a needless `[lyt.gate]` "save local-only?" pause
  // on the user's own vault. If BOTH attempts throw it's genuinely
  // indeterminate → keep `unknown` (the handler pause is then correct), and
  // never cache it (a transient outage must not pin the vault for a minute).
  // Cohort-1 fix-pass release review (Minor) — a ~300ms backoff before attempt 2.
  // The retry's honest benefit is collapsing a TRANSIENT throw (a rate-limit
  // blip, a momentary auth re-handshake, a Windows spawn hiccup) into a definite
  // verdict; the small pause gives such a blip a moment to settle rather than
  // firing both probes inside the same millisecond. It does NOT fix GitHub's
  // eventual-consistency on a just-created repo — but that case surfaces as a
  // 404 that `checkPushPermission` already maps to `false` (not a throw), so it
  // never reaches this retry loop. The backoff is skipped when a test gh
  // executor is injected (opts.gh) so unit tests stay fast + deterministic.
  const RETRY_BACKOFF_MS = 300;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && opts.gh === undefined) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
    try {
      const canPush = await checkPushPermission({
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        ...(opts.gh !== undefined ? { gh: opts.gh } : {}),
      });
      const v: WritabilityVerdict = canPush
        ? { writable: true, reason: "gh-viewerCanPush-true" }
        : { writable: false, reason: "gh-viewerCanPush-false" };
      cache.set(vault.ridHex, { verdict: v, expiresAt: Date.now() + TTL_MS });
      return v;
    } catch (err) {
      lastErr = err;
    }
  }
  void lastErr;
  return { writable: "unknown", reason: "gh-unavailable" };
}
