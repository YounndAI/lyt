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

// 0.12.0 Phase D — A6 share-revoke access re-probe (the `vault info` surface).
//
// `vault info` does no `git fetch`, so it cannot learn about a revoked share the
// way `sync` / `sync --check` do (from the fetch stderr). Here we run a light gh
// probe and, when GitHub replies with a repo-not-found / 404 (access revoked or
// repo deleted — classified by the firewall's `isAccessRemoved`, which excludes
// mere OFFLINE failures), flip the vault's registry status to `access_lost` so
// `vault info` reflects reality instead of a stale `active`.
//
// A NON-not-found gh failure (offline, rate-limit, gh missing) is left as
// `unknown` — we NEVER flip a vault to access_lost on an ambiguous signal, only
// on a definite not-found. The probe reuses the same injectable `gh` executor as
// the writability derive, so tests stay deterministic and the hot path unchanged.

import type { Client } from "@libsql/client";

import { updateVaultStatus, type VaultRow } from "../registry/repo.js";
import { readGitRemoteOriginUrl } from "../util/git.js";
import { getDefaultGhExecutor, type GhExecutor } from "../util/gh-discover.js";
import { parseOwnerRepoFromUrl } from "../util/gh.js";
import { HANDLE_OK } from "./writability.js";
import { isAccessRemoved } from "../util/git-error-firewall.js";
import { realIdentityRunner } from "../util/identity.js";

export type AccessProbeResult = "ok" | "access-removed" | "unknown";

// A6-1 (0.12.0 Phase D fix-pass) — the CURRENT gh-auth verdict. A `gh repo view`
// on a private repo returns the SAME not-found / 404 whether the repo was revoked
// OR the caller is merely unauthed (logged-out / expired token / SSO). Confirming
// auth is valid before classifying `access-removed` prevents a fixable auth state
// from false-flipping a vault to `access_lost`. Defaults to the real
// `gh auth status` probe (reused from the identity runner); injectable for tests.
export type GhAuthProbe = () => boolean | null;
const defaultGhAuthProbe: GhAuthProbe = () => realIdentityRunner.ghAuthStatus();

// Probe a repo's reachability for this user via `gh repo view`. Returns:
//   "ok"             — the repo resolved (we have at least read access),
//   "access-removed" — GitHub replied not-found / 404 (revoked or deleted) AND
//                      gh auth is confirmed valid (so it's a genuine revoke,
//                      not an unauthed 404 — A6-1),
//   "unknown"        — any other failure (offline, gh missing, rate-limit, OR a
//                      not-found under absent/unverifiable auth).
export async function probeRepoAccess(opts: {
  owner: string;
  repo: string;
  gh?: GhExecutor;
  ghAuthOk?: GhAuthProbe;
}): Promise<AccessProbeResult> {
  const gh = opts.gh ?? getDefaultGhExecutor();
  try {
    await gh(["repo", "view", `${opts.owner}/${opts.repo}`, "--json", "viewerPermission", "--jq", ".viewerPermission"]);
    return "ok";
  } catch (err) {
    // A6-1 — only treat a not-found as access-removed when gh auth is CONFIRMED
    // valid; an unauthed/expired 404 is a fixable auth state → `unknown`.
    const authOk = (opts.ghAuthOk ?? defaultGhAuthProbe)();
    if (isAccessRemoved(err, { ghAuthOk: authOk })) return "access-removed";
    return "unknown";
  }
}

export interface ReprobeAccessOpts {
  gh?: GhExecutor;
  // A6-1 — injectable gh-auth verdict (defaults to the real `gh auth status`).
  ghAuthOk?: GhAuthProbe;
}

// A6-2 (0.12.0 Phase D fix-pass) — the outcome of a re-probe. `access-lost` and
// `recovered` each persist a registry status change; `unchanged` persists nothing.
export type ReprobeOutcome = "unchanged" | "access-lost" | "recovered";

/**
 * Re-probe a vault's online access and reconcile its registry status. Best-effort
 * + conservative:
 *  - probes an `active` vault (to DETECT a fresh revoke) OR an `access_lost` vault
 *    (to DETECT recovery — A6-2); a local-only / tombstoned / missing / disconnected
 *    vault is skipped (nothing to learn);
 *  - flips `active → access_lost` only on a definite `access-removed` (never on
 *    `unknown` / offline / unauthed-404 — A6-1);
 *  - flips `access_lost → active` when the repo now resolves `ok` (A6-2), so a
 *    re-granted share stops reporting a stale "no access";
 *  - a persist failure never throws (the caller still surfaces the live verdict).
 * Returns which reconciliation happened so the caller can surface the fresh status.
 */
export async function reprobeVaultAccessLost(
  vault: VaultRow,
  db: Client,
  opts: ReprobeAccessOpts = {},
): Promise<ReprobeOutcome> {
  // A6-2 — an `access_lost` vault is re-checked too, so recovery is observable.
  if (vault.status !== "active" && vault.status !== "access_lost") return "unchanged";
  // Resolve owner/repo from the registry gitUrl, falling back to the live origin
  // (a local-first vault carries git_url=null until wired — same source the
  // writability self-heal reads).
  const gitUrl = vault.gitUrl ?? readGitRemoteOriginUrl(vault.path);
  if (gitUrl === null) return "unchanged";
  const parsed = parseOwnerRepoFromUrl(gitUrl);
  if (parsed === null) return "unchanged";
  if (!HANDLE_OK.test(parsed.owner) || !HANDLE_OK.test(parsed.repo)) return "unchanged";

  const result = await probeRepoAccess({
    owner: parsed.owner,
    repo: parsed.repo,
    ...(opts.gh !== undefined ? { gh: opts.gh } : {}),
    ...(opts.ghAuthOk !== undefined ? { ghAuthOk: opts.ghAuthOk } : {}),
  });
  if (result === "access-removed") {
    // Already lost — no state change (and nothing new to surface).
    if (vault.status === "access_lost") return "unchanged";
    try {
      await updateVaultStatus(db, vault.rid, "access_lost");
    } catch {
      // non-fatal — the caller reflects access_lost regardless.
    }
    return "access-lost";
  }
  // A6-2 — a re-granted share: the repo resolves again, so a previously-lost
  // vault recovers to active. An already-active vault needs no change.
  if (result === "ok" && vault.status === "access_lost") {
    try {
      await updateVaultStatus(db, vault.rid, "active");
    } catch {
      // non-fatal — the caller reflects the recovered status regardless.
    }
    return "recovered";
  }
  return "unchanged";
}
