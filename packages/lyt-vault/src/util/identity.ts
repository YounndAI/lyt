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

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

import { readIdentityCache, writeIdentityCache, type CachedIdentity } from "./identity-cache.js";

// v1.A.1b — `newVaultRid` and `newMemscopeRid` deleted. rids are now BLOB
// UUIDv7 generated via `newUuidv7Bytes()` (util/uuid7.ts); slugifyVaultName
// below retains its role for NAME-level validation only (path canonicalisation
// + naming-convention enforcement + cross-OS reserved-name guard).

// Identity cache TTL. Arc §12.2: handle is GitHub-authoritative; refresh on
// expiry (or via `lyt identity refresh`).
export const IDENTITY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// GitHub username constraint: alphanumeric + single interior hyphens, 1-39
// chars, no leading/trailing hyphen. Used as a defense-in-depth guard before a
// handle reaches any `gh`/`git` spawn — a poisoned identity.yon (W2.3 pod
// recovery) could otherwise seed a metachar-bearing handle. SEE ALSO the
// wizard's GH_HANDLE_REGEX (flows/wizard.ts) — same constraint; dedupe is a
// tracked .1 follow-up.
export const GH_HANDLE_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function isValidGhHandle(handle: string): boolean {
  return GH_HANDLE_REGEX.test(handle);
}

// (2026-06-04) — derive the DEFAULT provisional handle for a
// no-gh `lyt init`: the OS username, sanitized toward a valid GitHub handle
// (lowercase, `[a-z0-9-]`, collapse + trim hyphens, cap 39). The result is
// validated against isValidGhHandle so a poisoned/odd OS username can never
// reach a `gh`/`git remote` spawn at connect (R3 — defense-in-depth); on any
// miss it falls back to the safe constant `lyt-user`. The handle is the
// PRE-FILLED default the wizard prompt offers (⏎ accepts); a custom handle the
// user types is validated separately by the caller.
export function deriveProvisionalHandle(): string {
  let raw = "";
  try {
    raw = userInfo().username ?? "";
  } catch {
    raw = "";
  }
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
    .replace(/-+$/, "");
  return sanitized.length > 0 && isValidGhHandle(sanitized) ? sanitized : "lyt-user";
}

export interface IdentityRunner {
  // Returns `true` if `gh` is present and reports "logged in".
  ghAuthStatus(): boolean;
  // Returns the authenticated GitHub handle via `gh api /user --jq .login`.
  // Throws with explicit message on failure (caller surfaces to handler).
  ghApiUser(): string;
}

export const realIdentityRunner: IdentityRunner = {
  ghAuthStatus(): boolean {
    try {
      execFileSync("gh", ["auth", "status"], {
        stdio: ["ignore", "ignore", "ignore"],
        shell: process.platform === "win32",
      });
      return true;
    } catch {
      return false;
    }
  },
  ghApiUser(): string {
    const out = execFileSync("gh", ["api", "/user", "--jq", ".login"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const handle = out.trim();
    if (handle.length === 0) {
      throw new Error("`gh api /user --jq .login` returned empty output");
    }
    return handle;
  },
};

export interface GetIdentityOptions {
  runner?: IdentityRunner;
  nowMs?: number;
  cachePath?: string;
  forceRefresh?: boolean;
}

// Returns `${provider}:${handle}` (v1: provider always "github" per arc §12.1).
// Resolution order:
// 1. LYT_IDENTITY_OVERRIDE env (test escape hatch; verbatim)
// 2. cached identity if fresh (within IDENTITY_CACHE_TTL_MS)
// 3. live refresh via gh CLI (`gh auth status` + `gh api /user --jq .login`)
// and write the cache for next time.
//
// Pre-release clean-slate: there is no email-local-part fallback. If gh is
// missing or unauthed, this throws with an install/auth hint — handler must
// fix the precondition. Arc §12.2 lock.
export function getIdentity(opts: GetIdentityOptions = {}): string {
  const override = process.env["LYT_IDENTITY_OVERRIDE"];
  if (override && override.length > 0) return override;

  const now = opts.nowMs ?? Date.now();
  if (opts.forceRefresh !== true) {
    const cached = readIdentityCache(opts.cachePath);
    if (cached && now - cached.verifiedAtMs < IDENTITY_CACHE_TTL_MS) {
      return `${cached.provider}:${cached.handle}`;
    }
  }
  return refreshIdentity(opts);
}

// Strips the `provider:` prefix from getIdentity()'s `provider:handle`
// return value. Used by the v1.A.0 federation flows where the GH handle
// alone (not the provider-qualified form) is what `gh api`, `gh repo create`,
// and the federation_state PK key on. Centralised here so a future change
// to the identity shape (e.g., multi-provider in v3-optional) only touches
// one place — three federation flow files originally each carried their
// own inline `raw.indexOf(":")` slice. Release review (Angle D + E + G).
export function getHandleFromIdentity(identity?: string): string {
  const raw = identity ?? getIdentity();
  const idx = raw.indexOf(":");
  if (idx < 0) return raw;
  return raw.slice(idx + 1);
}

export function refreshIdentity(opts: GetIdentityOptions = {}): string {
  const runner = opts.runner ?? realIdentityRunner;
  if (!runner.ghAuthStatus()) {
    throw new Error(
      "Identity refresh failed: GitHub CLI is not authenticated.\n" +
        "  Install: https://cli.github.com\n" +
        "  Then run: gh auth login",
    );
  }
  let handle: string;
  try {
    handle = runner.ghApiUser();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read identity from gh: ${msg}`);
  }
  const identity: CachedIdentity = {
    provider: "github",
    handle,
    verifiedAtMs: opts.nowMs ?? Date.now(),
    source: "gh-cli",
  };
  writeIdentityCache(identity, opts.cachePath);
  return `${identity.provider}:${identity.handle}`;
}

// Naming-audit C-3 (handoff 2026-05-28-code-scope-findings-c123-m4):
// shape validation for `lyt vault init <name>`. Accepts the two shapes the
// soft naming convention recognises (lyt-naming-convention.md "What Lyt
// does and doesn't do"): bare names (`notes`, `my-vault`) and single-slash
// `owner/repo` (`alex/main`). Rejects shapes that are structurally
// pathological — they would either escape the vaults root, produce a
// broken rid, or refuse to materialise on the filesystem.
//
// The convention is soft (Lyt does not enforce `owner/repo`); this guard
// only rejects what would BREAK, never what merely diverges.
//
// `resolveVaultPath` already catches absolute-path escape via its
// `relative()` check; this helper covers the cases that escape the
// relative()-floor (empty/dot names, slash placement, depth).
export function validateVaultName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Vault name must be a non-empty string.");
  }
  if (name.trim().length === 0) {
    throw new Error(`Vault name cannot be whitespace-only: ${JSON.stringify(name)}.`);
  }
  if (name.startsWith("/")) {
    throw new Error(
      `Vault name cannot start with '/': ${JSON.stringify(name)}. Use 'owner/repo' (e.g. 'alex/main') or a bare name (e.g. 'notes').`,
    );
  }
  if (name.endsWith("/")) {
    throw new Error(
      `Vault name cannot end with '/': ${JSON.stringify(name)}. Use 'owner/repo' (e.g. 'alex/main') or a bare name (e.g. 'notes').`,
    );
  }
  if (name.includes("//")) {
    throw new Error(
      `Vault name cannot contain '//': ${JSON.stringify(name)}. Use 'owner/repo' (e.g. 'alex/main') or a bare name (e.g. 'notes').`,
    );
  }
  const segments = name.split("/");
  if (segments.length > 2) {
    throw new Error(
      `Vault name has more than one '/' (depth > 1): ${JSON.stringify(name)}. ` +
        `Use 'owner/repo' (single slash) or a bare name. Deep paths like 'alex/personal/journal' are not supported.`,
    );
  }
  // Defence-in-depth: per-segment emptiness (e.g. `''/main` from defensive
  // upstream input). `slugifyVaultName` would also catch a fully-empty
  // result, but a clearer error pre-slug helps debugging.
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(
        `Vault name has an empty segment: ${JSON.stringify(name)}. Use 'owner/repo' (e.g. 'alex/main') or a bare name.`,
      );
    }
  }
}

// Windows reserved device names. Case-insensitive; matches the bare device
// name and any segment that begins with the device name followed by `.`
// (e.g. `CON.txt` is also reserved). Validate unconditionally on all
// platforms — a vault that works on Linux but fails on Windows is a
// federation footgun for any cross-OS mesh member.
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(\..*)?$/i;

// v1.B.1 — mesh-name slot validation. Per lyt-naming-convention.md
// §`The shape`, mesh names occupy the FIRST segment of `{mesh-name}/{vault-name}`
// — they are bare, depth-0, no `/`. Composed of the slug-safe rules in
// §`Slug-safe labels`:
// - lowercase `[a-z0-9-]+`
// - no leading / trailing hyphens
// - no consecutive hyphens (collapses to single)
// - no Windows reserved device names
// - no empty / whitespace-only input
//
// Distinct from `validateVaultName` which accepts `owner/repo` (single slash)
// and bare names. The mesh-name slot rejects `/` entirely — a mesh name
// CANNOT contain a slash. This is the resolution from the v1.B.1
// brief: `alex/main` is a full vault name; the corresponding mesh name is
// `alex`. Per naming-convention.md §`Joining and leaving organizations`
// example `lyt mesh join younndai --from gh-org younndai`, bare mesh names
// are canonical.
export function validateMeshName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Mesh name must be a non-empty string.");
  }
  if (name.trim().length === 0) {
    throw new Error(`Mesh name cannot be whitespace-only: ${JSON.stringify(name)}.`);
  }
  if (name.includes("/")) {
    throw new Error(
      `Mesh name cannot contain '/': ${JSON.stringify(name)}. ` +
        `Mesh names are bare (e.g. 'alex', 'younndai', 'marlink'); the main vault ` +
        `becomes '<mesh-name>/main' automatically. See lyt-naming-convention.md §The shape.`,
    );
  }
  if (WINDOWS_RESERVED.test(name)) {
    throw new Error(
      `Mesh name ${JSON.stringify(name)} is a Windows reserved device name. ` +
        `Pick a different name — Windows refuses to create files or directories matching: ` +
        `CON, PRN, AUX, NUL, COM1..9, LPT1..9, CONIN$, CONOUT$ (case-insensitive). ` +
        `Validated on all platforms so cross-OS mesh members can clone the mesh's main vault.`,
    );
  }
  // hardening pass/26 fix-pass release review — the error text below always
  // promised "no consecutive hyphens" but the regex accepted them; the ban
  // became LOAD-BEARING when scheme D (federation-paths.ts) made `--` the
  // provably-unique mesh/vault repo-name boundary. A mesh named `my--mesh`
  // would make `lyt-vault-my--mesh--notes` mis-parse to `my/mesh--notes`.
  // Enforce what the message documents.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || name.includes("--")) {
    throw new Error(
      `Mesh name ${JSON.stringify(name)} is not slug-safe. ` +
        `Use lowercase letters, digits, and single hyphens; no leading/trailing/consecutive hyphens. ` +
        `Examples: 'alex', 'younndai', 'marlink', 'acme-public'. ` +
        `See lyt-naming-convention.md §Slug-safe labels.`,
    );
  }
}

// Arc §6.10 — Option D: rid is `vault:<slug>` (no embedded UUID; rely on
// `vaults.name UNIQUE` for collision guarantee). Slug rules: lowercase;
// `/`, `:`, whitespace → `-`; strip non-`[a-z0-9-]`; collapse `--+`;
// trim edges. Empty result throws.
//
// Naming-audit C-2 (handoff 2026-05-28-code-scope-findings-c123-m4):
// pre-strip segment check rejects Windows reserved device names. Done at
// the name level (split on `/`, before chars get normalised) so the error
// message can quote the offending user-supplied segment.
export function slugifyVaultName(name: string): string {
  for (const segment of name.split("/")) {
    if (WINDOWS_RESERVED.test(segment)) {
      throw new Error(
        `Vault name segment ${JSON.stringify(segment)} is a Windows reserved device name. ` +
          `Pick a different name — Windows refuses to create files or directories matching: ` +
          `CON, PRN, AUX, NUL, COM1..9, LPT1..9, CONIN$, CONOUT$ (case-insensitive). ` +
          `This is validated on all platforms so cross-OS mesh members can clone the vault.`,
      );
    }
  }
  const slug = name
    .toLowerCase()
    .replace(/[\s/:]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new Error(`Cannot derive rid slug from name: ${JSON.stringify(name)}`);
  }
  return slug;
}
