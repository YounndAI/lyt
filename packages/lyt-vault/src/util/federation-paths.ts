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

import { join } from "node:path";

import { slugifyVaultName } from "./identity.js";
import { getLytHome } from "./paths.js";

// Per master-plan §5 v1.A.0 + federation-design v2 §7 + G-1 doc cleanup
// (`~/lyt/`, NOT `~/.lyt/` — single LYT_HOME namespace shared with registry.db
// and vaults/). Cross-platform via Node `path.join` per project CLAUDE.md.

// The handle slug — naming-convention.md restricts mesh + vault segments to
// `[a-z0-9-]+`; GitHub handles are stricter
// (`[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*`).
//
// Delegates to slugifyVaultName so the C-2 Windows-reserved-name guard
// (CON, AUX, PRN, NUL, COM1..9, LPT1..9 — naming-audit handoff
// 2026-05-28-code-scope-findings-c123-m4) covers handles too. Without
// this a GH handle like `con` or `aux` (legal under the GH name shape)
// would slugify to `con`/`aux` and the federation path would refuse to
// materialise on Windows. Release review Angle A + D.
//
// The handle stored in federation_state + pod.yon keeps the
// ORIGINAL GH casing — slugifying is filesystem-only.
export function slugifyHandle(handle: string): string {
  return slugifyVaultName(handle);
}

// follow-up (v1.GP WS3, 2026-06-02): the on-disk LOCAL CACHE DIRECTORY
// the user sees is `~/lyt/pod/`. (Brief A, 2026-06-04) extends the
// user-facing rename to the FILE: `federation.yon` → `pod.yon` (see
// getFederationYonPath). The `lyt federation` CLI verbs, this
// function's NAME (getFederationRoot), and every internal "federation" symbol
// stay unchanged (internal-technical surfaces, Option 1).
//
// the pod dir is FLAT — `getFederationRepoDir` returns this root
// directly (`~/lyt/pod`), so `pod.yon` lands at `~/lyt/pod/pod.yon` (no
// `<handle>` subdir). The doctor symmetry probe (doctor.ts
// checkFederationRepoState) computes the same flat dir independently — kept in
// sync by hand; SEE ALSO doctor.ts fedRoot (it now checks for the pod.yon file
// in this flat root, not subdirs).
export function getFederationRoot(): string {
  return join(getLytHome(), "pod");
}

// FLAT pod dir: a single pod directory at `getFederationRoot()`
// (`~/lyt/pod`) holds `pod.yon` directly. The `handle` arg is kept in
// the signature (callers still pass it) to minimise blast, but the slug is no
// longer appended. Multi-handle support (a per-handle subdir for a user with
// both personal + work GH accounts on one machine) is DEFERRED — v1 ships a
// single pod dir; multi-handle would be additive (re-introduce the slug
// segment behind a multi-handle flag).
export function getFederationRepoDir(handle: string): string {
  const slug = slugifyHandle(handle);
  if (slug.length === 0) {
    throw new Error(
      `Handle ${JSON.stringify(handle)} slugified to an empty string; cannot derive federation path.`,
    );
  }
  return getFederationRoot();
}

// (Brief A): the manifest file is `pod.yon` (was `federation.yon`). The
// user-facing artifact uses the user-facing word. The function name stays
// `getFederationYonPath` (internal-technical symbol per the ratified default Option 1) — only
// the on-disk filename changed.
export function getFederationYonPath(handle: string): string {
  return join(getFederationRepoDir(handle), "pod.yon");
}

// GitHub repo name for the user's pod per (2026-06-02; amends the
// master-plan §5 `{handle}/lyt-federation` convention → `{handle}/lyt-pod`).
// = Option B: rename ONLY the user-visible repo name to "pod"; "federation"
// stays the internal architecture term (CLI verbs, symbols, design docs all
// unchanged). then renamed the FILE federation.yon → pod.yon
// too; the repo name + this constant are unaffected. This single constant is
// the chokepoint — both
// `gh repo create` (federation/init.ts) AND the cross-machine adopt-detect
// probe (wizard.ts defaultGhFederationProbe) route through it.
// Capitalisation matches the original handle (GH is case-insensitive on
// lookup but case-preserving on display).
export function federationRepoName(): string {
  return "lyt-pod";
}

export function federationRepoFullName(handle: string): string {
  return `${handle}/${federationRepoName()}`;
}

// Brief B (resolved scheme D via /insight-explore →
// /insight-critique → /insight-assess, 2026-06-04). The GitHub repo name for a
// single vault. Parallels federationRepoName() ({handle}/lyt-pod) and the
// pod-map ({handle}/lyt-pod-map): every Lyt artifact self-identifies by the
// `lyt-` prefix, so `lyt discover` can filter a bare `gh repo list` without a
// per-repo topic API call, and the `lyt-pod` / `lyt-pod-map` / `lyt-vault-*`
// family groups visually (a goal lyt-naming-convention.md §Pod repo naming
// states explicitly).
//
// Scheme D = `lyt-vault-<mesh>--<vault>`. The `--` separator is PROVABLY
// unambiguous: the slug rules (identity.ts slugifyVaultName / validateMeshName)
// forbid consecutive hyphens INSIDE a mesh or vault segment, so a `--` can only
// ever be the mesh/vault boundary. Round-trips by construction even when a
// segment itself contains single hyphens (mesh `younndai`, vault `lyt-public`
// → `lyt-vault-younndai--lyt-public` → parseVaultRepoName → `younndai/lyt-public`).
//
// CHOKEPOINT: this is the single source of truth for vault repo names. The
// formerly-hardcoded `${meshName}-main` in mesh-publish.ts + mesh-info.ts now
// routes through vaultRepoNameFromParts(meshName, "main"). SEE ALSO
// federationRepoName (pod chokepoint). Correctness paths read the vault→repo
// mapping from pod.yon `@FED_VAULT repo=...`; parseVaultRepoName is for
// discovery / human-legibility / a defensive cross-check, NOT load-bearing.
export const VAULT_REPO_PREFIX = "lyt-vault-";
export const VAULT_REPO_SEP = "--";

export function vaultRepoNameFromParts(meshName: string, vaultLeaf: string): string {
  return `${VAULT_REPO_PREFIX}${meshName}${VAULT_REPO_SEP}${vaultLeaf}`;
}

// Accepts a full vault name `{mesh}/{vault}` (e.g. "personal/main") and returns
// the repo name. Bare names auto-normalize to `personal/<name>` upstream
// (lyt-naming-convention.md §Bare-name normalization), so the name reaching
// here normally carries a mesh segment; a defensive bare name maps to mesh
// "personal".
export function vaultRepoName(vaultName: string): string {
  const segments = vaultName.split("/");
  if (segments.length === 2) {
    return vaultRepoNameFromParts(segments[0]!, segments[1]!);
  }
  return vaultRepoNameFromParts("personal", segments[0]!);
}

export function vaultRepoFullName(handle: string, vaultName: string): string {
  return `${handle}/${vaultRepoName(vaultName)}`;
}

// hardening fix-pass release review — segment charset gate. Mesh/vault
// segments are slugs per lyt-naming-convention (`[a-z0-9-]+`, no leading/
// trailing hyphen). Enforcing it HERE is load-bearing containment: parsed
// names feed `path.join(vaultsRoot, name)` at the clone target, so a crafted
// repo name like `lyt-vault-..--evil` must NEVER normalize into a `../`
// path segment. Non-slug input returns null/false and callers fall back to
// their pre-convention behavior (or refuse on shape).
const SLUG_SEGMENT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// GitHub owner (user/org) charset — case-preserving, no dots.
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

export function isSlugSegment(segment: string): boolean {
  return SLUG_SEGMENT.test(segment);
}

// fed-v2 Layer-2 P1 — clone-name containment chokepoint. A
// clone NAME (whether handler-supplied via `--name` or derived from the URL via
// deriveNameFromUrl) feeds `path.join(vaultsRoot, name)` → `mkdirSync` at the
// clone target. A crafted `../escape`, an absolute path, a `..` segment, or any
// non-slug segment must NEVER round-trip into a filesystem path that escapes the
// vaults root. This is an ALLOWLIST (per-`/`-segment slug check), NOT a `..`
// denylist — the denylist approach misses encodings/edge cases; the allowlist
// admits only paths whose EVERY `/`-segment is a slug.
//
// CONTAINMENT, NOT DEPTH: the goal is "the resolved path stays inside the vaults
// root", which is guaranteed when no segment is `..`/empty/absolute. Depth is
// NOT capped here — a multi-segment name like a reserved system bucket
// (`subscriptions/{owner}/{vault}`) must pass through so the downstream
// reserved-mesh guard (assertMeshNameNotReserved at cloneIntoTargetMesh) owns
// that policy. A legit `owner/repo` and a bare leaf pass; `../escape`, `a/../b`,
// `/abs`, `a//b` (empty segment), uppercase, dots, and `..` all fail.
export function assertSafeCloneName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Invalid clone name: name must be a non-empty string.`);
  }
  if (name.trim().length === 0) {
    throw new Error(`Invalid clone name ${JSON.stringify(name)}: must not be whitespace-only.`);
  }
  // Split on BOTH separators so a Windows-style `..\escape` is also caught.
  // A leading/trailing/double separator yields an empty segment → rejected by
  // the per-segment slug check below (empty is not a slug).
  const segments = name.split(/[\\/]+/);
  for (const segment of segments) {
    if (!isSlugSegment(segment)) {
      throw new Error(
        `Invalid clone name ${JSON.stringify(name)}: segment ${JSON.stringify(segment)} is not ` +
          `slug-safe (lowercase letters, digits, single interior hyphens — no '..', dots, ` +
          `slashes, uppercase, or empty segments). Refusing — this name could escape the ` +
          `vaults root. Pick a name like 'notes' or 'mesh/vault'.`,
      );
    }
  }
}

// Inverse of vaultRepoName: recover `{mesh}/{vault}` from a repo name. Returns
// null when the name is not a Lyt vault repo (missing `lyt-vault-` prefix) or is
// malformed (no `--` boundary, an empty segment, or a non-slug segment —
// release review: `..`/dots/uppercase must not round-trip into a vault
// name that later feeds a filesystem path). Splits on the FIRST `--`; the mesh
// side therefore can't contain `--` by construction, and a leaf containing
// `--` still round-trips (vaultRepoNameFromParts re-joins on the same
// boundary) but is rejected here as a slug-rule violation.
export function parseVaultRepoName(repoName: string): string | null {
  if (!repoName.startsWith(VAULT_REPO_PREFIX)) return null;
  const rest = repoName.slice(VAULT_REPO_PREFIX.length);
  const idx = rest.indexOf(VAULT_REPO_SEP);
  if (idx < 0) return null;
  const mesh = rest.slice(0, idx);
  const leaf = rest.slice(idx + VAULT_REPO_SEP.length);
  if (mesh.length === 0 || leaf.length === 0) return null;
  if (!isSlugSegment(mesh) || !isSlugSegment(leaf) || leaf.includes(VAULT_REPO_SEP)) return null;
  return `${mesh}/${leaf}`;
}

// hardening pass (subscriber-onboarding fix-pass, 2026-06-11) — normalize a
// handler-supplied vault reference through the repo-name convention. Two input
// forms are accepted, both two-segment:
// name form `{mesh}/{vault}` e.g. younndai/pub-test
// repo-name form `{owner}/lyt-vault-<mesh>--<leaf>` e.g. younndai/lyt-vault-younndai--pub-test
// The two can never collide: a vault-name leaf cannot contain `--` (slug rule),
// so parseVaultRepoName only matches genuine convention repo names. Returns
// null when the input is not two non-empty segments.
//
// `owner` is the GitHub location (first segment as typed); `vaultName` is the
// canonical `{mesh}/{vault}` identity. For the name form they share the first
// segment; for the repo-name form the mesh comes from inside the repo name
// (an owner can host another mesh's vault — owner is WHERE, mesh is WHAT).
export interface ResolvedVaultRef {
  // Canonical `{mesh}/{vault}` — the name the vault registers/looks-up under.
  vaultName: string;
  // GitHub owner segment, as typed.
  owner: string;
  // Convention repo name `lyt-vault-<mesh>--<leaf>`.
  repoName: string;
  inputForm: "name" | "repo-name";
}

export function resolveVaultRef(input: string): ResolvedVaultRef | null {
  const segments = input.split("/");
  if (segments.length !== 2) return null;
  const owner = segments[0]!;
  const rest = segments[1]!;
  if (owner.length === 0 || rest.length === 0) return null;
  // a review finding — the owner feeds URL construction; gate it to the GH handle
  // charset so no crafted segment reaches the URL or (via vaultName) a path.
  if (!GH_OWNER.test(owner)) return null;
  const parsedName = parseVaultRepoName(rest);
  if (parsedName !== null) {
    return { vaultName: parsedName, owner, repoName: rest, inputForm: "repo-name" };
  }
  // Name form: both segments are vault-name slugs (`{mesh}/{vault}`) — the
  // mesh segment doubles as the GH owner on URL derivation (GH lookup is
  // case-insensitive, so the lowercase slug resolves).
  if (!isSlugSegment(owner) || !isSlugSegment(rest)) return null;
  return { vaultName: input, owner, repoName: vaultRepoName(input), inputForm: "name" };
}
