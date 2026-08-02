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
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName, getMeshByRid, insertMesh, type MeshRow } from "../registry/meshes-repo.js";
import {
  getVaultByPath,
  getVaultByRid,
  markVaultSourcePreserving,
  setVaultHomeMesh,
  type ForeignVaultSource,
  type VaultRow,
} from "../registry/repo.js";
import { gitUrlToCoordinate, vaultLeaf } from "../registry/vault-addressing.js";
import { resolveEffectiveOwnedMeshDestination } from "../registry/destination-policy.js";
import { appendMeshHomeToFile } from "../registry/vault-home-mesh-helpers.js";
import { newUuidv7Bytes, ridsEqual, uuid7BytesToDashedString } from "../util/uuid7.js";
import {
  assertSafeCloneName,
  isSlugSegment,
  parseVaultRepoName,
  slugifyHandle,
} from "../util/federation-paths.js";
import { bucketMeshName, bucketVaultRelDir, entryModeForSource } from "../util/bucket-mesh.js";
import { getDefaultVaultsRoot } from "../util/paths.js";
import { assertNoSymlinkOnWritePath } from "../util/write-path-guard.js";
import { assertMeshNameNotReserved } from "../util/identity.js";
import { rmWithRetry } from "../scaffold/delete.js";
import { stripNestedReparsePoints } from "../util/reparse-safe.js";
import { reflectInboundIndex } from "./reflect-index.js";
import { writeScaffoldConformance } from "../scaffold/init.js";
import { renderVaultYon } from "../yon/vault.js";
import { parseVaultYon } from "../yon/parse.js";
import { hexToUuid7Bytes } from "../util/uuid7.js";
import { joinVaultFlow, type JoinResult } from "./join.js";
import { relinkAllPatternsForVault } from "./pattern-relink-vault.js";

// v1.B.3 — `lyt vault clone` extended with a `--to-mesh <name>` option.
//
// Default (no --to-mesh): URL-based clone into ~/lyt/vaults, registered as
// a new rid via joinVaultFlow. Bit-identical to v1.B.2 HEAD.
//
// With --to-mesh <mesh-name>: the cloned vault gets a FRESH UUIDv7 rid
// (NOT the source rid — per master-plan §526 "new rid; original preserved")
// and the target mesh.yon gains a @MESH_HOME row. The source vault is
// untouched. Use cases: graduating a public template into your own pod;
// importing reference content with provenance to your own mesh.
//
// Acceptance (brief A6): when --to-mesh is omitted, behavior is bit-
// identical to v1.B.2 HEAD; when --to-mesh is set, the target rid is a
// fresh UUIDv7 (NOT copied from source).

export interface CloneOptions {
  url: string;
  name?: string | undefined;
  parentDir?: string | undefined;
  // v1.B.3 — when set, the cloned vault is freshly-rid'd, written with
  // @VAULT_HOME_MESH pointing at this mesh, and the mesh's main vault's
  // mesh.yon gains a @MESH_HOME row. Mesh must already exist in the local
  // registry — clone --to-mesh does NOT auto-create the target mesh
  // (Plan-D1: explicit mesh-init for non-personal namespaces).
  toMesh?: string | undefined;
  // Open-once seam — when omitted the flow opens its own registry; caller
  // owns lifecycle when supplied.
  registryDb?: Client | undefined;
  // Override the assigned_at timestamp; defaults to `new Date().toISOString()`.
  // Tests pin for deterministic round-trip assertions.
  nowIso?: string | undefined;
  // Track C Wave 3 F8 + release review — CALLER INTENT, never automatic.
  // true = the clone is a NEW standalone vault (the `lyt vault clone
  // --to-mesh` graduate-a-template case): detach the inherited `origin` (the
  // SOURCE vault's repo) + drop the inherited gitUrl, so the new vault
  // starts remote-less and earns its own repo at first publish. Pre-fix the
  // unconditional keep pushed one vault's tree onto another vault's remote
  // (live incident); but an unconditional DETACH breaks the OTHER --to-mesh
  // callers — subscribeFlow's clone-on-subscribe and mesh-adopt's member
  // clones MUST keep origin to pull upstream (release review). Default
  // false = keep origin (subscriber/adopt semantics; the writable verdict
  // gates pushes).
  detachOrigin?: boolean | undefined;
  // hardening pass (subscriber-onboarding fix-pass, 2026-06-11) — SUBSCRIBER INTENT.
  // When true and the --to-mesh target is not registered locally, register an
  // external-mesh RECORD (a meshes row with main_vault_rid NULL — no
  // scaffolded `<foreign>/main` vault, no foreign mesh.yon) and proceed. A
  // consumer must never be told to `lyt mesh init` another owner's mesh.
  // Default false: the standalone `vault clone --to-mesh` path keeps refusing
  // on an unregistered target (Plan-D1 — explicit mesh-init for meshes the
  // user OWNS). subscribeFlow's clone-on-subscribe passes true.
  autoRegisterExternalMesh?: boolean | undefined;
  // (Phase-0 A2b) — CALLER INTENT, never automatic. When true the clone
  // KEEPS the source/publisher rid instead of minting a fresh one, and leaves
  // the committed `.lyt/vault.yon` (+ agents.md/README) BYTE-UNCHANGED, so a
  // read-only subscriber clone lands with a CLEAN working tree (rid-first
  // convergence — the Phase-0 ledger keys identity on `vault_rid` alone; a
  // rewritten-with-fresh-rid tracked file is the dirty-tree precondition that
  // later wedges the read-only pull). Default (undefined/false) = current
  // behavior: mint a fresh rid + rewrite vault.yon (+ regen scaffold) — the
  // standalone `lyt vault clone --to-mesh` graduate-a-template case. Kept
  // INDEPENDENT of `detachOrigin`: subscribe/adopt pass preserveRid:true +
  // detachOrigin:false (keep upstream origin AND the publisher rid); the
  // standalone CLI clone passes neither. subscribeFlow's clone-on-subscribe
  // and mesh-adopt's member clones pass true.
  preserveRid?: boolean | undefined;
  // Inc-2 Phase B / (S1) — ON-DISK SEPARATION. A vault-root-relative
  // directory (e.g. `subscriptions/{owner}/{leaf}`) under which the clone lands
  // on disk, DECOUPLED from the registered vault `name`. The subscribe / foreign
  // clone path passes this so a received foreign vault materializes under the
  // separated `~/lyt/vaults/subscriptions/…` (or `shared/…`) subtree instead of
  // commingling into the user's own `~/lyt/vaults/{mesh}/…` tree — while the
  // registered name STAYS the publisher's canonical `{mesh}/{leaf}` (so the
  // preserve-rid name==publisher-declared identity guard still holds). Every
  // `/`-segment is slug-checked (assertSafeCloneName) — a `..`/absolute/empty
  // segment is refused before it reaches join(parent, subdir)/mkdirSync. Omitted
  // → the on-disk dir is derived from `name` exactly as before.
  targetSubdir?: string | undefined;
  // Inc-2 Phase B / (S1, keystone) — own-vs-clone PROVENANCE intent. When
  // true the registered vault is positively marked FOREIGN. EXPLICIT, never
  // inferred (a wrong own-vs-clone signal is L0-adjacent): only the subscribe /
  // mesh-adopt member clone passes it. Omitted → fail-closed `own`
  // (standalone/graduate-a-template clone). retained as the boolean
  // back-compat trigger; when `foreignSource` is ALSO supplied it takes
  // precedence (and picks shared vs subscribed); a bare `markSubscribed:true`
  // defaults to `subscribed`.
  markSubscribed?: boolean | undefined;
  // Inc-2 Phase B / the resolved FOREIGN provenance (`shared` |
  // `subscribed`). `shared` = a granted PRIVATE vault (homes into `shared/{owner}`);
  // `subscribed` = a self-subscribed PUBLIC vault (homes into `subscriptions/{owner}`).
  // Set by the receive path (subscribe/clone) from the public-vs-private
  // discriminator. Wins over `markSubscribed`. Omitted (with markSubscribed
  // false/absent) → fail-closed `own`.
  foreignSource?: ForeignVaultSource | undefined;
  // Inc-2 Phase B / (S4) — the STANDALONE `lyt vault clone <url>` CLI intent
  // to AUTO-ROUTE a FOREIGN vault to the subscribe (bucket-home) path instead of
  // half-cloning it then refusing with VaultHomeMeshNotRegisteredError + leaving
  // an orphan. When set (and no explicit --to-mesh is given), the flow resolves
  // the clone's home mesh from the URL: if it is NOT a locally-OWNED mesh the
  // clone is routed to `subscriptions/{owner}` (bucket-home + markSubscribed +
  // separated on-disk), exactly like a subscribe. A locally-owned mesh (a
  // graduate-a-template / own re-clone) keeps the default behavior. ONLY the CLI
  // clone verb passes this; library callers (subscribe/adopt) never do.
  routeForeignToBucket?: boolean | undefined;
  // Inc-2 Phase B / #2 (0.12.1) — AUTO-INDEX on receive. When true, after a
  // foreign vault is cloned + registered into its owner-bucket, its machine-local
  // content caches are REFLECTED from the committed SoT (reflectInboundIndex) so
  // `lyt search`/`recall`/`primer` hit on arrival — no manual `lyt reindex`. Set
  // by the receive verbs that OWN their own post-clone step: the standalone
  // `lyt vault clone <url>` foreign auto-route (resolveEffectiveCloneOptions) and
  // the `accept-share` flow. Omitted by subscribeFlow's clone-on-subscribe (it
  // runs its own buildLocalIndex afterward) so the reflect never double-fires.
  // Best-effort: an index failure logs + returns, never fails the clone.
  autoIndex?: boolean | undefined;
}

export interface CloneResult extends JoinResult {
  cloneTargetPath: string;
  // v1.B.3 — set when --to-mesh applied; null otherwise. Carries the
  // home-mesh assignment that landed in vault.yon + mesh.yon.
  meshAssignment: {
    meshRidHex: string;
    meshName: string;
    freshRidApplied: boolean;
    // true when the target mesh did not exist locally and an
    // external-mesh record (main_vault_rid NULL) was auto-registered.
    externalMeshAutoRegistered: boolean;
  } | null;
  // Track C Wave 3 F8 — true when the clone's git `origin` (the SOURCE
  // vault's repo) was detached per the caller's detachOrigin intent. null
  // when detach was not requested (default URL-clone, subscribe-on-clone,
  // adopt member clones — keeping origin is the point there: subscriber
  // semantics; the writable verdict gates pushes).
  originDetached: boolean | null;
}

// Structured error: --to-mesh target not registered. CLI surfaces as exit 2.
export class CloneTargetMeshNotFoundError extends Error {
  readonly errorCode = "clone-target-mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    // release review — the mesh-init advice carries
    // the YOUR-mesh hedge so this surface never re-issues the banned
    // "scaffold someone else's mesh" instruction.
    super(
      `lyt vault clone --to-mesh: no usable mesh registered with name '${meshName}'. ` +
        `If '${meshName}' is YOUR mesh, run 'lyt mesh init ${meshName}' first, then re-clone. ` +
        `To consume another owner's vault, use ` +
        `'lyt mesh subscribe --vault <mesh>/<vault> --from-mesh <your-mesh>' instead — ` +
        `never scaffold another owner's mesh locally.`,
    );
    this.name = "CloneTargetMeshNotFoundError";
    this.meshName = meshName;
  }
}

// (Phase-0 A2b, CRIT-2) — refusal raised when a preserve-rid clone's
// UNTRUSTED `.lyt/vault.yon` declares a vault NAME that does not match the
// caller's canonical subscribe/adopt ref. On the preserve path the clone KEEPS
// the publisher's declared rid AND registers under the publisher's declared
// name; both come from the cloned (possibly hostile) vault.yon. Without this
// check a hostile repo could declare name="victim/vault" + the victim's public
// rid and plant a poisoned registry row that later short-circuits the victim's
// real subscribe. An honest publisher's vault.yon name equals the ref, so the
// honest path is unaffected; a mismatch is impersonation-or-misconfig and is
// refused BEFORE any registry side-effect (no orphan vaults/meshes row). Sibling
// of repo.ts's VaultRidImpersonationError (the rid-collision defense); this one
// guards the clone-boundary NAME-vs-ref contract on the preserve path.
export class VaultIdentityMismatchError extends Error {
  readonly errorCode = "vault-identity-mismatch";
  readonly ref: string;
  readonly declaredName: string;
  constructor(ref: string, declaredName: string, target: string) {
    super(
      `Refusing to register the vault cloned into ${target}: its .lyt/vault.yon ` +
        `declares the vault name '${declaredName}', which does not match the requested ` +
        `vault '${ref}'. A subscribe/adopt clone preserves the publisher's identity ` +
        `(rid + name), so the declared name must equal the vault you asked for. A ` +
        `mismatch means the published repo is not the vault named by the reference — ` +
        `a renamed vault (the publisher renamed it after you last referenced it), ` +
        `a misconfigured publisher, or an impersonation attempt asserting another ` +
        `vault's identity. If the vault was legitimately renamed, subscribe/adopt ` +
        `using its CURRENT '${declaredName}' name; otherwise verify the publisher ` +
        `and the '{mesh}/{vault}' reference, then retry.`,
    );
    this.name = "VaultIdentityMismatchError";
    this.ref = ref;
    this.declaredName = declaredName;
  }
}

// (R3) — refusal raised when a caller passes `preserveRid:true` WITHOUT a
// target mesh. The preserve-rid invariant (CRIT-2 publisher-identity guard +
// CRIT-1 local home-mesh rebind) is only DEFINED for the mesh-targeted path:
// both live inside cloneIntoTargetMesh, reached only when `toMesh` is non-empty.
// A `preserveRid` clone with no target mesh would otherwise fall through to the
// default URL-clone path — minting/keeping a rid with NO home-mesh rebind and
// NO identity guard, silently ignoring the caller's preserve intent. Refuse at
// the flow boundary so the unsupported combination fails loudly, not silently.
export class PreserveRidRequiresTargetMeshError extends Error {
  readonly errorCode = "preserve-rid-requires-target-mesh";
  constructor() {
    super(
      `preserveRid requires --to-mesh / a target mesh: the identity guard + ` +
        `home-mesh rebind are only defined for the mesh-targeted clone path. ` +
        `Re-run the subscribe/adopt clone with an explicit target mesh, or drop ` +
        `preserveRid for a standalone 'lyt vault clone <url>'.`,
    );
    this.name = "PreserveRidRequiresTargetMeshError";
  }
}

// Inc-2 Phase B / collapse the two foreign-provenance intents into the
// single resolved value the register path stamps. `foreignSource` wins; a bare
// `markSubscribed:true` (the boolean, kept for back-compat) maps to
// `subscribed`; neither → undefined (fail-closed `own`).
function resolveForeignSourceOpt(opts: CloneOptions): ForeignVaultSource | undefined {
  if (opts.foreignSource !== undefined) return opts.foreignSource;
  if (opts.markSubscribed === true) return "subscribed";
  return undefined;
}

// Inc-2 Phase B / → (S4) — resolve the EFFECTIVE clone options. Auto-routes
// a STANDALONE `lyt vault clone <url>` of a FOREIGN vault to the always-separate
// BUCKET-HOME subscribe path (owner-keyed `subscriptions/{owner}` bucket +
// separated on-disk subtree + foreignSource + preserve-rid), so it no longer
// half-clones then refuses with VaultHomeMeshNotRegisteredError and orphans a
// dir. Gated hard: only when the CLI passed routeForeignToBucket AND no explicit
// --to-mesh / subscriber intent is present (library subscribe/adopt callers
// already set those and are never re-routed). "Foreign" = the URL's declared
// mesh is NOT a locally-OWNED mesh (a registered mesh WITH a main vault); an
// owned mesh (graduate-a-template / own re-clone) keeps the default path
// untouched.
//
// PROVENANCE: the standalone clone verb has no cheap PRE-clone visibility signal
// (the repo is not cloned yet), so it defaults to `subscribed` (a self-subscribe)
// — the safe, least-committal foreign relationship. A privately-granted vault a
// user clones directly is corrected to `shared` by an explicit graduate, the lazy
// repair, or the dedicated `accept-share` verb once its visibility is known.
//
// Inc-2 Phase B / B2 (0.12.1) — OWNER-DERIVATION is now keyed off the URL's ORIGIN
// COORDINATE owner (deriveForeignCloneOwner), NOT the mesh segment. The GH owner is
// WHERE the repo lives; the mesh segment is WHAT the vault is — they diverge
// whenever an owner hosts another mesh's vault (`realowner/lyt-vault-teammesh--leaf`
// → mesh 'teammesh', owner 'realowner'). Keying the bucket off the mesh segment
// (the pre-B2 bug) commingled distinct owners under one bucket + mis-keyed the
// reconstitution. MASQUERADE GUARD: a locally-OWNED mesh name keeps the default
// (own) path ONLY when the URL owner MATCHES that mesh's push_target — else a
// crafted foreign repo embedding one of the user's own mesh names is routed to the
// foreign owner-bucket, NEVER commingled into the own mesh (mirrors subscribe.ts's
// repo-name masquerade guard).
export async function resolveEffectiveCloneOptions(opts: CloneOptions): Promise<CloneOptions> {
  if (
    opts.routeForeignToBucket !== true ||
    opts.toMesh !== undefined ||
    opts.autoRegisterExternalMesh === true ||
    opts.preserveRid === true ||
    opts.markSubscribed === true ||
    opts.foreignSource !== undefined
  ) {
    return opts;
  }
  let canonicalName: string;
  try {
    canonicalName = opts.name ?? deriveNameFromUrl(opts.url);
  } catch {
    return opts; // unparseable URL/name — let the default path refuse actionably
  }
  const slash = canonicalName.indexOf("/");
  if (slash < 0) return opts; // bare name — no mesh segment to classify as foreign
  const mesh = canonicalName.slice(0, slash);

  // B2 — the owner key is the URL's origin-coordinate owner (falls back to the
  // mesh segment only for a non-remote/local URL that carries no coordinate).
  const owner = deriveForeignCloneOwner(opts.url, canonicalName);

  const callerSupplied = opts.registryDb !== undefined;
  const db = opts.registryDb ?? (await openRegistry());
  try {
    const localMesh = await getMeshByName(db, mesh);
    // The mesh segment names a locally-OWNED mesh (has a main vault). KEEP the
    // default (own) clone path ONLY when the clone's real owner MATCHES this
    // mesh's push_target owner — i.e. the user is genuinely re-cloning / graduating
    // their OWN vault. A MISMATCH (a foreign owner whose crafted repo embeds one of
    // the user's OWN mesh names — the masquerade) or an unconfirmable owner (a
    // local-only mesh with no push_target) MUST NOT commingle into the own mesh and
    // MUST NOT occupy the own namespace as its owner key: fall through to the
    // owner-bucket under the REAL (foreign) owner below.
    if (localMesh !== null && localMesh.mainVaultRid !== null) {
      const destination = resolveEffectiveOwnedMeshDestination(localMesh);
      if (destination.kind === "github" && slugifyHandle(destination.owner) === owner) {
        return opts; // genuine own re-clone / graduate-a-template
      }
    }
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }

  // Foreign → always-separate bucket-home subscribe: auto-register the reserved
  // owner-bucket mesh (keyed by the REAL owner), land under the separated on-disk
  // subtree, preserve the publisher rid, mark it `subscribed` (the standalone-clone
  // default), and auto-index on arrival.
  const foreignSource: ForeignVaultSource = "subscribed";
  const bucketMesh = bucketMeshName(entryModeForSource(foreignSource), owner);
  const targetSubdir = bucketVaultRelDir(foreignSource, owner, vaultLeaf(canonicalName));
  return {
    ...opts,
    name: canonicalName,
    toMesh: bucketMesh,
    targetSubdir,
    foreignSource,
    autoRegisterExternalMesh: true,
    preserveRid: true,
    autoIndex: true,
  };
}

// Inc-2 Phase B / B2 (0.12.1) — derive the FOREIGN clone's owner key from the clone
// URL's ORIGIN COORDINATE (`<host>/<owner>/<repo>` → <owner>), NOT the mesh segment
// of the vault name. Falls back to the mesh segment ONLY when the URL is not a
// recognizable remote (a bare local path has no owner coordinate — this preserves
// the local-path clone behavior the S4 tests exercise). The returned owner is
// slug-normalized for path/mesh-name safety.
export function deriveForeignCloneOwner(url: string, canonicalName: string): string {
  const meshSegment = canonicalName.includes("/")
    ? canonicalName.slice(0, canonicalName.indexOf("/"))
    : canonicalName;
  if (looksLikeRemoteUrl(url)) {
    const coord = gitUrlToCoordinate(url); // canonical `<host>/<owner>/<repo>`
    const ownerSeg = coord?.split("/")[1];
    if (ownerSeg !== undefined && ownerSeg.length > 0) return slugifyHandle(ownerSeg);
    // a review finding (Phase B release review) — FAIL CLOSED: a remote-SHAPED URL whose
    // coordinate won't parse must NOT silently fall back to the mesh segment.
    // The pre-B2 window did exactly that, letting a crafted remote URL key the
    // foreign clone under the vault name's mesh segment instead of the real
    // owner. The mesh-segment fallback is for GENUINE LOCAL paths only.
    throw new Error(
      `lyt clone: cannot derive owner from remote URL '${url}' — its origin ` +
        `coordinate (<host>/<owner>/<repo>) did not parse. Refusing to key the ` +
        `foreign clone by the vault-name mesh segment (a security fallback that ` +
        `could mis-home the vault). Verify the URL is a valid remote repository.`,
    );
  }
  return slugifyHandle(meshSegment);
}

// A recognizable remote URL: a `scheme://…` form (https/http/git/ssh) or the
// `user@host:path` SSH shorthand. A bare local filesystem path (no scheme, no
// `user@host:`) is NOT a remote and carries no owner coordinate. Mirrors the
// branch discriminator deriveNameFromUrl uses.
function looksLikeRemoteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^@/\\]+@[^:]+:/.test(url);
}

export async function cloneVaultFlow(rawOpts: CloneOptions): Promise<CloneResult> {
  // Inc-2 Phase B / (S4) — resolve the effective options FIRST (may re-route
  // a standalone foreign clone to the bucket-home subscribe path). Everything
  // below operates on the resolved `opts`.
  const opts = await resolveEffectiveCloneOptions(rawOpts);

  // (R3) — boundary refusal for the unsupported preserveRid-without-target-
  // mesh combination, BEFORE any filesystem side-effect (mkdir/clone). See
  // PreserveRidRequiresTargetMeshError: the preserve-path guards only exist on
  // the mesh-targeted path.
  if (opts.preserveRid === true && (opts.toMesh === undefined || opts.toMesh.length === 0)) {
    throw new PreserveRidRequiresTargetMeshError();
  }

  // fed-v2 Layer-2 P1 — git option-injection guard. A URL beginning
  // with '-' would be consumed by `git clone` as an OPTION (e.g.
  // `--upload-pack=<cmd>` → arbitrary command execution), not a positional URL.
  // Refuse leading-dash URLs BEFORE any git spawn, with an actionable
  // shape-error (NOT the raw `git clone failed` that proves the option reached
  // git). Paired with the `--` argv terminator at the spawn below.
  if (typeof opts.url === "string" && opts.url.startsWith("-")) {
    throw new Error(
      `Refusing to clone URL ${JSON.stringify(opts.url)}: a clone URL must not begin with '-'. ` +
        `A leading dash is interpreted by git as a command-line option (option-injection), ` +
        `not a repository URL. Provide a normal https:// or git@ URL.`,
    );
  }

  // fed-v2 Layer-2 P1 — route BOTH the handler-supplied
  // `opts.name` AND the URL-derived name through the clone-name containment
  // allowlist BEFORE join(parent, name)/mkdirSync. A crafted `--name ../escape`
  // (or a `..`-bearing derived name) would otherwise materialize a directory
  // OUTSIDE the vaults root. deriveNameFromUrl now also rejects `..` segments at
  // its own chokepoint, but assert here unconditionally so the handler-supplied
  // name (which BYPASSES deriveNameFromUrl entirely) is contained too.
  const name = opts.name ?? deriveNameFromUrl(opts.url);
  assertSafeCloneName(name);
  const parent = resolve(opts.parentDir ?? getDefaultVaultsRoot());
  // Inc-2 Phase B / (S1) — the ON-DISK dir is `targetSubdir` when supplied
  // (the subscribe/foreign path's `subscriptions/{owner}/{leaf}` separation),
  // else derived from `name` (unchanged default). Route the subdir through the
  // SAME clone-name containment allowlist so a crafted `..`/absolute/empty
  // segment can never escape the vaults root at join(parent, …)/mkdirSync.
  const onDiskRel = opts.targetSubdir ?? name;
  if (opts.targetSubdir !== undefined) assertSafeCloneName(opts.targetSubdir);
  const target = join(parent, onDiskRel);

  // Inc-2 Phase B / WRITE-PATH SYMLINK GUARD (standing directive). Before
  // materializing the clone dir under a handler-influenced path, lstat every
  // EXISTING ancestor from the vaults root down to the leaf's parent and refuse
  // on any symlink/junction — never follow it. A `subscriptions/{owner}` bucket
  // parent that an attacker replaced with a reparse point would otherwise let
  // the clone (and its later teardown) escape the vaults root.
  assertNoSymlinkOnWritePath(parent, target);

  // hardening pass release review — claim the target EXCLUSIVELY before cloning
  // (non-recursive mkdir throws EEXIST on a race). git clones happily into an
  // existing EMPTY dir, and from here on every dir this flow may remove is
  // provably one THIS call created — never a concurrent process's in-flight
  // clone that slipped between an existsSync probe and the clone.
  if (existsSync(target)) {
    throw cloneTargetExistsError(target);
  }
  mkdirSync(dirname(target), { recursive: true });
  try {
    mkdirSync(target);
  } catch {
    throw cloneTargetExistsError(target);
  }

  try {
    // fed-v2 Layer-2 P1 — `--` terminates git option parsing so the
    // URL + target are always treated as positionals, never as options, even if
    // a future code path lets a dash-leading value slip past the guard above.
    // 0.20.17 — `-c core.longPaths=true` is set ON THE CLONE, which applies it
    // BEFORE checkout and persists it in the new repo. A post-hoc `git config`
    // would be too late: the failure happens DURING checkout, per file
    // ("unable to create file ...: Filename too long"), leaving a partial
    // worktree. Inert on non-Windows, so it is unconditional rather than
    // platform-branched -- one code path, nothing to get wrong per OS.
    execFileSync("git", ["clone", "-c", "core.longPaths=true", "--", opts.url, target], {
      stdio: "inherit",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // We claimed the dir above, so it is ours to sweep (no
    // half-state may block the retry).
    await removeFailedCloneDir(target);
    throw new Error(`git clone failed for ${opts.url}: ${msg}`);
  }

  // cleanup-on-failure: the dir was created by THIS call; if
  // registration fails after a successful git clone (the live hardening pass
  // shapes), remove it so the retry doesn't dead-end on
  // "Clone target already exists". The upstream repo still has everything.
  try {
    // v1.B.3 — when --to-mesh is set, mutate the cloned vault.yon BEFORE the
    // joinVaultFlow registers it: rewrite @VAULT.rid to a fresh UUIDv7, set
    // @VAULT.name to the clone-target name (so it doesn't collide with the
    // source's name in the registry), and add a @VAULT_HOME_MESH block
    // pointing at the target mesh. joinVaultFlow then re-parses the rewritten
    // vault.yon and registers the fresh (rid, name) pair.
    if (opts.toMesh !== undefined && opts.toMesh.length > 0) {
      const result = await cloneIntoTargetMesh({
        target,
        name,
        toMeshName: opts.toMesh,
        registryDb: opts.registryDb,
        nowIso: opts.nowIso ?? new Date().toISOString(),
        detachOrigin: opts.detachOrigin === true,
        autoRegisterExternalMesh: opts.autoRegisterExternalMesh === true,
        preserveRid: opts.preserveRid === true,
        foreignSource: resolveForeignSourceOpt(opts),
        autoIndex: opts.autoIndex === true,
      });
      return result;
    }

    // Default path: no --to-mesh; v1.B.2-identical behavior.
    //
    // fed-v2 Layer-2 P1 — the cloned vault.yon is
    // FOREIGN (possibly hostile) content. joinVaultFlow → registerVaultFromYon
    // parse it with the RAW parseVaultYon (join.ts), which leaks
    // `@VAULT rid`/`parseVaultYon`/`fatal:` jargon up the default `lyt vault
    // clone <url>` CLI surface on a malformed repo. Pre-validate the cloned
    // vault.yon through the same actionable-refusal wrapper the --to-mesh path
    // uses, BEFORE join, so the default path surfaces a field-named, remedy-
    // bearing refusal instead of raw parser jargon (the over-long-name cap also
    // fires here for free). A missing .lyt/vault.yon is left to joinVaultFlow's
    // own actionable "Use 'lyt vault adopt'" message (join.ts:38-42).
    const defaultYonPath = join(target, ".lyt", "vault.yon");
    if (existsSync(defaultYonPath)) {
      parseClonedVaultYonOrRefuse(readFileSync(defaultYonPath, "utf8"), target);
    }
    const defaultForeign = resolveForeignSourceOpt(opts);
    const join_ = await joinVaultFlow(target, {
      // A clone is a checkout of an existing published vault. Local pattern
      // relinking regenerates tracked `.lyt/agents.md`; keep the checkout
      // byte-clean and let machine-local pattern repair run explicitly.
      skipPatternRelink: true,
      ...(defaultForeign !== undefined ? { source: defaultForeign } : {}),
    });
    // Pattern links are machine-local and ignored. Rebuild only those links;
    // never regenerate the publisher's tracked `.lyt/agents.md` during clone.
    await relinkAllPatternsForVault(join_.name, { regenerateAgentsMd: false });

    // registerVaultFromYon resolves the declared home mesh, but the default
    // clone path previously omitted the corresponding mesh_vaults home row.
    // That made a correctly homed clone report `mesh_assignment:null` and later
    // `orphan-vault`. Materialize the registry-side membership without rewriting
    // the publisher's tracked vault.yon/scaffold.
    const callerSupplied = opts.registryDb !== undefined;
    const db = opts.registryDb ?? (await openRegistry());
    let meshAssignment: CloneResult["meshAssignment"] = null;
    try {
      const vaultRow = await getVaultByRid(db, join_.rid);
      const homeMesh =
        vaultRow?.homeMeshRid !== null && vaultRow?.homeMeshRid !== undefined
          ? await getMeshByRid(db, vaultRow.homeMeshRid)
          : null;
      if (vaultRow !== null && homeMesh !== null) {
        await addVaultToMesh(db, homeMesh.rid, vaultRow.rid, "home");
        meshAssignment = {
          meshRidHex: homeMesh.ridHex,
          meshName: homeMesh.name,
          freshRidApplied: false,
          externalMeshAutoRegistered: false,
        };
      }
    } finally {
      if (!callerSupplied) await closeRegistry(db);
    }
    return { ...join_, cloneTargetPath: target, meshAssignment, originDetached: null };
  } catch (err) {
    // release review — scope the cleanup to failures AT-OR-BEFORE
    // registration. If the vault row already landed (a late best-effort step
    // died: initVaultDbs, pattern relink, the @MESH_HOME append), deleting
    // the dir would mint the INVERSE half-state — a registry row pointing at
    // nothing. Invariant: never remove a dir the registry references; the
    // retry then resolves via the already-registered path.
    if (!(await isVaultPathRegistered(target, opts.registryDb))) {
      await removeFailedCloneDir(target);
    }
    throw err;
  }
}

// the leftover-dir refusal names its remedies (the dir is NOT ours
// to delete: it predates this call or belongs to a concurrent clone).
// Post-fix-pass a FAILED clone removes its own claimed dir, so this fires
// only on genuinely pre-existing/raced dirs.
function cloneTargetExistsError(target: string): Error {
  return new Error(
    `Clone target already exists: ${target}. ` +
      `If it is a previous clone of the same vault, register it with ` +
      `'lyt vault join ${target}'; otherwise remove or rename the directory and re-run.`,
  );
}

// a review finding — cleanup gate: true when the registry already references this
// path. Conservative on probe failure (returns true → keep the dir; a
// surviving dir degrades to the actionable already-exists refusal).
async function isVaultPathRegistered(
  target: string,
  registryDb: Client | undefined,
): Promise<boolean> {
  const callerSupplied = registryDb !== undefined;
  let db: Client | null = null;
  try {
    db = registryDb ?? (await openRegistry());
    return (await getVaultByPath(db, target)) !== null;
  } catch {
    return true;
  } finally {
    if (!callerSupplied && db !== null) await closeRegistry(db);
  }
}

// best-effort removal of a clone dir THIS call created (claimed via
// the exclusive mkdir above). L0 destructive-delete conformance — the
// guarantee is RM-SEMANTICS-BASED, not git-config-based (release review
// a review finding): a cloned tree CAN contain symlinks when the user globally
// enabled core.symlinks (a Git-for-Windows installer option), so the
// load-bearing protections are (1) Node's rm lstats entries and UNLINKS
// reparse points/symlinks rather than descending them, and (2) the top-level
// lstat bail below. Do NOT replace rmWithRetry with a shell `rm -rf` — that
// is the exact 2026-06-03 junction-traversal incident vector. Removal rides
// the shared rmWithRetry 180s Windows budget (scaffold/delete.ts — per-vault
// libsql lock-release lag); in the common refusal paths no vault db was ever
// opened (joinVaultFlow registers BEFORE initVaultDbs) so attempt 1 wins.
// Cleanup failures are swallowed — the ORIGINAL error is the one the caller
// must see; a surviving dir degrades to the actionable already-exists
// refusal above.
async function removeFailedCloneDir(target: string): Promise<void> {
  try {
    if (!existsSync(target)) return;
    if (lstatSync(target).isSymbolicLink()) return;
    // 🔴 L0 DESTRUCTIVE-SAFETY: a cloned tree CAN contain nested junctions/
    // symlinks (user globally enabled `core.symlinks`). ENUMERATE + detach every
    // nested reparse point BEFORE the recursive teardown — not just the
    // top-level lstat bail above — so rmWithRetry never risks descending an
    // unenumerated escaper into a source-of-truth outside the clone root.
    stripNestedReparsePoints(target);
    await rmWithRetry(target);
  } catch {
    // best-effort
  }
}

// fed-v2 Layer-2 P1 — cap the vault name parsed out of a FOREIGN
// (cloned, possibly hostile) vault.yon. An unbounded name feeds registry rows,
// path joins, and CLI surfaces; cap it at the parse/register chokepoint.
// fed-v2 Layer-2 P3 — the SAME bound now also caps `desc` and each
// `topics` value (assertCloneFieldHygiene below). All three @VAULT single-line
// metadata fields share this one constant.
// SEE ALSO (coupled-constant — keep these enforcement sites in sync; this
// trail is bidirectional):
//   - name + desc + topics cap enforced → assertCloneFieldHygiene (this file)
//   - invoked from → parseClonedVaultYonOrRefuse (this file, post-parse)
const CLONED_VAULT_NAME_MAX = 128;

// fed-v2 Layer-2 P3 — a single-line @VAULT metadata field carrying an
// embedded line-breaking control char is MALFORMED. YON is line-based
// (yon/parse.ts splits on /\r?\n/ and reads fields with line-anchored regexes)
// and escapeQuoted (yon/vault.ts:135) escapes only `\` and `"`, NOT control
// chars — so a raw newline/CR inside a quoted desc/topic value SPLITS the
// record on re-emit, breaking the round-trip and enabling forged-record
// injection (a @TAG/@META smuggled in after a `\n` becomes its own top-level
// record on re-parse). We refuse the whole C0 control set (U+0000–U+001F) plus
// DEL (U+007F): none are legitimate in a single-line field, and any of them can
// break the line-based parse or its anchored regexes. Deliberately NOT a
// broadening into ordinary punctuation — a leading `|` (U+007C) is printable,
// not a control char, so it is still accepted (its round-trip is contained).
//
// fed-v2 Layer-2 P3 residual — ALSO refuse the Unicode line terminators
// U+0085 (NEL), U+2028 (LINE SEPARATOR), and U+2029 (PARAGRAPH SEPARATOR). The
// JS regex engine's `m`-flag `^` treats U+2028/U+2029 as logical line-starts
// (and `\s` matches them), which was WIDER than this guard's C0/DEL notion — a
// forged @META/@TAG smuggled after a U+2028 inside a quoted desc value slipped
// past this door yet was matched by the parser's anchored record readers
// (gitUrl/ACL-retarget hijack). The parse layer is re-anchored on `\n`/BOF
// (yon/parse.ts) as the primary fix; widening the guard here brings its
// line-terminator notion into parity with the regex engine and closes it at the
// clone boundary for ALL readers (incl. the @VAULT rid / @VAULT_HOME_MESH
// headers) as defense-in-depth.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// fed-v2 Layer-2 P3 — unified
// FIELD-HYGIENE refusal at the clone chokepoint for a FOREIGN cloned vault.yon's
// single-line metadata fields. REFUSE the clone (throw) when a value is
// over-length (> CLONED_VAULT_NAME_MAX, hardening pass) OR contains an embedded
// line-breaking control char. The message names the field + the
// remedy, in the same style as the original name-cap refusal. This is a
// BOUNDARY refusal — it does NOT touch escapeQuoted/renderVaultYon (the
// un-escaped-control-char root in shared YON serialization is a tracked residual
// hardening pass, not fixed here).
//
// fed-v2 Layer-2 P3 (guard field-completeness) — the CONTROL-CHAR screen
// is now applied to EVERY foreign single-line string field, not just
// name/desc/topics. Rationale: each is a single-line value by format; a raw
// line-breaker (`\n`/`\r`, U+2028/U+2029/NEL) in ANY of them is malformed and a
// would-be forged-record carrier on re-emit. The LENGTH cap stays scoped to the
// short-metadata fields where a 128-char bound is clearly correct (name/desc/
// topics). gitUrl and version are NOT length-capped — URLs and version strings
// can legitimately vary in length — but ARE control-char screened. tier_hint is
// borderline; control-char-only is the conservative choice (no length cap).
function assertCloneFieldHygiene(parsed: ReturnType<typeof parseVaultYon>, target: string): void {
  // LENGTH-CAPPED + control-char screened: short-metadata fields with a
  // clearly-correct 128-char bound.
  const cappedFields: Array<{ label: string; value: string }> = [];
  if (typeof parsed.name === "string") cappedFields.push({ label: "name", value: parsed.name });
  if (typeof parsed.desc === "string") cappedFields.push({ label: "desc", value: parsed.desc });
  parsed.topics.forEach((t, i) => {
    if (typeof t === "string") cappedFields.push({ label: `topic[${i}]`, value: t });
  });

  // CONTROL-CHAR ONLY (no length cap): the remaining foreign single-line string
  // fields. URLs/versions/identity tokens can legitimately vary in length, so we
  // screen them for line-breakers only — conservative: control-char everywhere,
  // length-cap only where a bound is provably correct.
  const ctrlOnlyFields: Array<{ label: string; value: string }> = [];
  if (typeof parsed.tierHint === "string") {
    ctrlOnlyFields.push({ label: "tier_hint", value: parsed.tierHint });
  }
  if (typeof parsed.version === "string") {
    ctrlOnlyFields.push({ label: "version", value: parsed.version });
  }
  if (typeof parsed.parentVault === "string") {
    ctrlOnlyFields.push({ label: "parent_vault", value: parsed.parentVault });
  }
  if (typeof parsed.memscopeRid === "string") {
    ctrlOnlyFields.push({ label: "memscope", value: parsed.memscopeRid });
  }
  if (typeof parsed.gitUrl === "string") {
    ctrlOnlyFields.push({ label: "git_url", value: parsed.gitUrl });
  }
  if (typeof parsed.primaryOwner === "string") {
    ctrlOnlyFields.push({ label: "primary_owner", value: parsed.primaryOwner });
  }
  if (typeof parsed.lifecycle === "string") {
    ctrlOnlyFields.push({ label: "lifecycle", value: parsed.lifecycle });
  }
  parsed.shareWith.forEach((s, i) => {
    if (typeof s === "string") ctrlOnlyFields.push({ label: `share_with[${i}]`, value: s });
  });
  parsed.acceptsFrom.forEach((s, i) => {
    if (typeof s === "string") ctrlOnlyFields.push({ label: `accepts_from[${i}]`, value: s });
  });

  const throwControlChar = (label: string): never => {
    throw new Error(
      `The cloned repository at ${target} declares a vault ${label} containing an embedded ` +
        `line-breaking control character. Refusing — a single-line metadata field must not ` +
        `carry control characters (a raw newline/CR would split the record and could inject a ` +
        `forged YON record on re-emit). Verify the publisher, or republish the vault with a ` +
        `single-line ${label}.`,
    );
  };

  for (const f of cappedFields) {
    if (f.value.length > CLONED_VAULT_NAME_MAX) {
      throw new Error(
        `The cloned repository at ${target} declares a vault ${f.label} of ${f.value.length} ` +
          `characters, which exceeds the ${CLONED_VAULT_NAME_MAX}-character limit. Refusing — ` +
          `an over-long ${f.label} is rejected at the clone/subscribe boundary. Verify the publisher.`,
      );
    }
    if (hasControlChar(f.value)) throwControlChar(f.label);
  }

  for (const f of ctrlOnlyFields) {
    if (hasControlChar(f.value)) throwControlChar(f.label);
  }
}

// fed-v2 Layer-2 P1 — parse a cloned vault.yon at the post-clone
// chokepoint, converting any raw parser failure (`@VAULT rid`/`@DOC`/parser
// jargon) into an ACTIONABLE refusal that names the problem (the repo is not a
// valid Lyt vault) + a remedy, and enforcing the name length cap. Both clone
// paths route their cloned-yon parse through here so neither leaks raw jargon up
// to the subscribe/CLI surface:
//   - default `lyt vault clone <url>` — pre-validates the cloned vault.yon here
//     BEFORE joinVaultFlow (which would otherwise raw-parseVaultYon it);
//   - --to-mesh / subscribe (cloneIntoTargetMesh) — parses the cloned vault.yon
//     here both for the external-mesh-record source read and the rid-rewrite.
// A genuinely MISSING .lyt/vault.yon is handled by joinVaultFlow's own
// actionable "use 'lyt vault adopt'" refusal, not here.
function parseClonedVaultYonOrRefuse(
  yonContent: string,
  target: string,
): ReturnType<typeof parseVaultYon> {
  let parsed: ReturnType<typeof parseVaultYon>;
  try {
    parsed = parseVaultYon(yonContent);
  } catch {
    // Swallow the raw parser message (it carries @VAULT/@DOC/rid= jargon the
    // handler can't act on) and surface a field-named, remedy-bearing refusal.
    throw new Error(
      `The cloned repository at ${target} is not a valid Lyt vault: its .lyt/vault.yon ` +
        `is malformed or missing its required vault-identity declaration. Only well-formed ` +
        `Lyt-published vaults can be cloned or subscribed; verify the publisher, or for a ` +
        `plain repo clone it with git and run 'lyt vault adopt <path>' instead.`,
    );
  }
  // fed-v2 Layer-2 P3 — unified field hygiene: the name length cap
  // (P1/hardening pass) now lives alongside the desc/topics length cap + the
  // control-char refusal, all enforced over the same FOREIGN parsed
  // shape at this one chokepoint. Both clone paths (default + --to-mesh/
  // subscribe) route through here, so they inherit the hygiene.
  assertCloneFieldHygiene(parsed, target);
  return parsed;
}

interface CloneIntoTargetMeshArgs {
  target: string;
  name: string;
  toMeshName: string;
  registryDb: Client | undefined;
  nowIso: string;
  detachOrigin: boolean;
  autoRegisterExternalMesh: boolean;
  preserveRid: boolean;
  // Inc-2 Phase B / →positively mark the registered vault with its
  // resolved FOREIGN provenance (`shared` | `subscribed`). EXPLICIT intent from
  // the subscribe / foreign-clone / mesh-adopt member path; omitted elsewhere
  // (undefined) → fail-closed 'own'.
  foreignSource: ForeignVaultSource | undefined;
  // Inc-2 Phase B / #2 (0.12.1) — reflect the committed SoT into the machine-local
  // caches after registration so the received vault is searchable on arrival.
  autoIndex: boolean;
}

async function cloneIntoTargetMesh(args: CloneIntoTargetMeshArgs): Promise<CloneResult> {
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // Fed-v2 Layer-1 (Phase release review) — guard-bypass close. A USER-supplied
    // `--to-mesh <reserved>` (the standalone graduate-a-template clone) could
    // clone INTO an existing system bucket (`subscriptions/{owner}`), occupying
    // the reserved namespace without routing through validateMeshName. Mirror the
    // move guard's mesh-segment extraction. Gate ONLY the user path: the
    // SUBSCRIBE / mesh-adopt internal callers pass autoRegisterExternalMesh:true
    // and legitimately home into the (foreign) bucket namespace — they must NOT
    // be blocked.
    if (!args.autoRegisterExternalMesh) {
      assertMeshNameNotReserved(args.toMeshName.split("/")[0]!);
    }

    // (CRIT-2) — validate the UNTRUSTED publisher identity against the
    // caller's canonical ref BEFORE any registry side-effect (external-mesh
    // auto-register, vault upsert) on the preserve-rid path. Refusing here — the
    // first thing the flow does after opening the registry, and before the
    // external-mesh insert / origin detach / vault register — guarantees a
    // mismatch leaves NO orphan row or mesh. Only the preserve path keeps the
    // publisher's name; the re-mint `lyt vault clone --to-mesh` path deliberately
    // RENAMES to args.name (graduate-a-template), so it is exempt.
    if (args.preserveRid) {
      const guardYonPath = join(args.target, ".lyt", "vault.yon");
      if (!existsSync(guardYonPath)) {
        throw new Error(
          `The cloned repository at ${args.target} is not a Lyt vault ` +
            `(no .lyt/vault.yon). Only Lyt-published vaults can be subscribed or ` +
            `adopted; for a plain repo, clone it with git and run ` +
            `'lyt vault adopt <path>' instead.`,
        );
      }
      const declared = parseClonedVaultYonOrRefuse(readFileSync(guardYonPath, "utf8"), args.target);
      if (declared.name !== args.name) {
        throw new VaultIdentityMismatchError(args.name, declared.name, args.target);
      }
    }

    let meshRow: MeshRow | null = await getMeshByName(db, args.toMeshName);
    let externalMeshAutoRegistered = false;
    if (meshRow === null) {
      if (!args.autoRegisterExternalMesh) {
        throw new CloneTargetMeshNotFoundError(args.toMeshName);
      }
      // register the external mesh RECORD only: a meshes row with
      // main_vault_rid NULL. No `<foreign>/main` vault is scaffolded and no
      // foreign mesh.yon is written (asymmetric awareness — the vault's home
      // mesh never learns about its subscribers). Prefer the foreign mesh's
      // canonical rid from the cloned vault.yon's @VAULT_HOME_MESH when its
      // name matches (keeps subscription rows pointing at the mesh's true
      // federation identity); fall back to a fresh UUIDv7.
      //
      // release review — a published repo that is not a Lyt vault must
      // refuse actionably here, not leak a raw ENOENT from the read below.
      const sourceYonPath = join(args.target, ".lyt", "vault.yon");
      if (!existsSync(sourceYonPath)) {
        throw new Error(
          `The cloned repository at ${args.target} is not a Lyt vault ` +
            `(no .lyt/vault.yon). Only Lyt-published vaults can be subscribed; ` +
            `for a plain repo, clone it with git and run 'lyt vault adopt <path>' instead.`,
        );
      }
      const sourceParsed = parseClonedVaultYonOrRefuse(
        readFileSync(sourceYonPath, "utf8"),
        args.target,
      );
      let externalRid: Uint8Array | null = null;
      if (sourceParsed.homeMesh !== null && sourceParsed.homeMesh.meshName === args.toMeshName) {
        const candidate = hexToUuid7Bytes(sourceParsed.homeMesh.meshRid);
        if ((await getMeshByRid(db, candidate)) === null) {
          externalRid = candidate;
        }
      }
      try {
        await insertMesh(db, {
          rid: externalRid ?? newUuidv7Bytes(),
          name: args.toMeshName,
          mainVaultRid: null,
        });
      } catch {
        // release review — check-then-insert race: a concurrent
        // subscribe of another vault from the same foreign mesh can win the
        // insert between our getMeshByName probe and here. Converge on the
        // winner's row (re-read below) instead of surfacing raw
        // SQLITE_CONSTRAINT.
      }
      meshRow = await getMeshByName(db, args.toMeshName);
      if (meshRow === null) {
        throw new CloneTargetMeshNotFoundError(args.toMeshName); // defensive
      }
      externalMeshAutoRegistered = true;
    }
    // External mesh records carry no main vault — there is no local mesh.yon
    // to append @MESH_HOME to (and writing the FOREIGN mesh.yon is forbidden
    // by asymmetric awareness). Subscriber clones therefore skip the append.
    // A mesh whose main_vault_rid is SET but dangling stays a refusal on BOTH
    // paths (release review — that is local corruption, not an external
    // mesh; 'lyt repair' owns the heal).
    let mainVault: VaultRow | null = null;
    if (meshRow.mainVaultRid !== null) {
      mainVault = await getVaultByRid(db, meshRow.mainVaultRid);
      if (mainVault === null) {
        throw new CloneTargetMeshNotFoundError(args.toMeshName);
      }
    }
    if (mainVault === null && !args.autoRegisterExternalMesh) {
      throw new CloneTargetMeshNotFoundError(args.toMeshName);
    }

    // Track C Wave 3 F8 (+ release review/a review finding) — detach ONLY on caller
    // intent: a standalone fresh-rid clone pushes to its SOURCE otherwise
    // (live incident: writable:true on your own source + self-heal
    // persisting the source URL → automator push landed one vault's tree on
    // another vault's remote). Subscribe/adopt clones pass detachOrigin:false
    // — they NEED origin to pull upstream. A real removal failure throws
    // (proceeding silently would leave the hazard live); only the benign
    // "No such remote" is absorbed.
    let originDetached: boolean | null = null;
    if (args.detachOrigin) {
      originDetached = false;
      try {
        execFileSync("git", ["remote", "remove", "origin"], { cwd: args.target, stdio: "pipe" });
        originDetached = true;
      } catch (err) {
        const stderr =
          err !== null && typeof err === "object" && "stderr" in err
            ? String((err as { stderr: unknown }).stderr ?? "")
            : "";
        if (/no such remote/i.test(stderr)) {
          // Already detached / cloned without origin — hazard absent.
          originDetached = true;
        } else {
          throw new Error(
            `clone --to-mesh: failed to detach the source origin at ${args.target} — ` +
              `refusing to register a standalone clone still pointing at its source repo ` +
              `(pushes would land on the SOURCE vault's remote). Underlying: ${stderr || String(err)}`,
          );
        }
      }
    }

    // Read + parse the cloned vault.yon. Both paths need the parsed shape; the
    // re-mint path also rewrites the file, the preserve-rid path leaves it
    // byte-unchanged (read only).
    const vaultYonPath = join(args.target, ".lyt", "vault.yon");
    const oldContent = readFileSync(vaultYonPath, "utf8");
    const parsed = parseClonedVaultYonOrRefuse(oldContent, args.target);

    let join_: JoinResult;
    let freshRidApplied: boolean;
    // set on the converge branch (preserved rid already registered
    // locally). Drives the FIX-3 re-home guard + the orphan-dir sweep below.
    let converged = false;

    if (args.preserveRid) {
      // (Phase-0 A2b) — KEEP the publisher rid; leave the tracked
      // `.lyt/vault.yon` BYTE-UNCHANGED (no fresh mint, no rewrite) and SKIP
      // the scaffold-conformance regen below, so the read-only subscriber
      // clone's working tree stays CLEAN. The home-mesh binding is done
      // registry-side (belt-and-braces below), not via a vault.yon rewrite.
      freshRidApplied = false;
      const preservedRid = hexToUuid7Bytes(parsed.rid);

      // Rid-already-present guard: with a preserved rid the register/join path
      // could hit UNIQUE(rid) when the same vault is already registered
      // locally (a co-located publisher+clone, or a genuine re-subscribe).
      // CONVERGE on the existing row instead of a blind re-INSERT. The guard is
      // scoped to a SAME-NAME match: a preserved rid held locally under a
      // DIFFERENT name is an impersonation hazard, so we fall through to
      // joinVaultFlow → upsertVault, which surfaces the load-bearing
      // VaultRidImpersonationError. Full 2-machine converge is Phase B; this is
      // the minimal Phase-0 guard.
      const existingByRid = await getVaultByRid(db, preservedRid);
      if (existingByRid !== null && existingByRid.name === parsed.name) {
        join_ = {
          rid: existingByRid.rid,
          ridHex: existingByRid.ridHex,
          name: existingByRid.name,
          path: existingByRid.path,
          alreadyRegistered: true,
          patternsLinked: 0,
        };
        converged = true;
      } else {
        // Pure new subscriber: the preserved rid is not present locally →
        // joinVaultFlow INSERTs cleanly under the publisher rid + name. The
        // home-mesh override (CRIT-1) files the vault under the LOCAL target
        // mesh (meshRow.rid), NOT the publisher's foreign @VAULT_HOME_MESH rid,
        // while the committed vault.yon stays byte-unchanged. skipPatternRelink
        // keeps the tracked agents.md byte-unchanged too (clean tree — A2c).
        join_ = await joinVaultFlow(args.target, {
          homeMeshRidOverride: meshRow.rid,
          skipPatternRelink: true,
          ...(args.foreignSource !== undefined ? { source: args.foreignSource } : {}),
        });
      }
    } else {
      // Default (standalone `lyt vault clone --to-mesh`): rewrite the cloned
      // vault.yon with a FRESH rid + @VAULT_HOME_MESH block.
      freshRidApplied = true;
      const freshRid = newUuidv7Bytes();
      const freshRidStr = uuid7BytesToDashedString(freshRid);
      const oldRidStr = parsed.rid;

      // Replace the rid string verbatim everywhere it appears in the file
      // (@DOC id=, @VAULT rid=, any other reference). vault.yon emits the
      // dashed-UUIDv7 form in two places (@DOC.id + @VAULT.rid); a literal
      // replace is safe because UUIDv7 strings don't appear as substrings of
      // other content.
      let rewritten = oldContent.split(oldRidStr).join(freshRidStr);

      // Insert/replace the @VAULT_HOME_MESH block. Easiest: re-parse the
      // rewritten content (with new rid), then re-render via renderVaultYon
      // using the parsed shape + the new homeMesh.
      const reparsed = parseVaultYon(rewritten);
      // Re-render via the canonical writer to get a clean @VAULT_HOME_MESH
      // block + canonical key order. We need to translate the parsed shape
      // back to the renderer's input shape; minor reconstruction here.
      const memscopeBytes = reparsed.memscopeRid
        ? hexToUuid7Bytes(reparsed.memscopeRid)
        : undefined;
      const parentBytes = reparsed.parentVault ? hexToUuid7Bytes(reparsed.parentVault) : undefined;
      rewritten = renderVaultYon({
        vault: {
          rid: freshRid,
          // v1.B.3 — clone --to-mesh sets vault.yon's @VAULT.name to the
          // clone-target name (args.name) so the fresh-rid clone registers under
          // its own name rather than the source vault's when both are registered
          // locally. NOTE: `name` is NOT a UNIQUE column post-migration-003; the
          // load-bearing protections against a colliding/impersonating clone are
          // the canonical-URL coupling, the clone-boundary name==ref guard
          // (VaultIdentityMismatchError), and the rid-impersonation defense
          // (VaultRidImpersonationError) — not a bare UNIQUE(name).
          name: args.name,
          ...(reparsed.desc !== null ? { desc: reparsed.desc } : {}),
          ...(parentBytes !== undefined ? { parentVault: parentBytes } : {}),
          ...(reparsed.tierHint !== null ? { tierHint: reparsed.tierHint } : {}),
          ...(memscopeBytes !== undefined ? { memscope: memscopeBytes } : {}),
          createdAt: reparsed.createdAt ?? args.nowIso,
          version: reparsed.version ?? "0.1",
        },
        // F8 — when detaching, never carry the SOURCE vault's gitUrl into the
        // fresh-rid clone's vault.yon: paired with the origin detach above,
        // the new vault starts remote-less and earns its own repo at first
        // publish. Subscribe/adopt clones (detachOrigin:false) keep it — it IS
        // their upstream.
        ...(!args.detachOrigin && reparsed.gitUrl !== null ? { gitUrl: reparsed.gitUrl } : {}),
        primaryOwner: reparsed.primaryOwner ?? "github:unknown",
        lifecycle:
          reparsed.lifecycle === "active" ||
          reparsed.lifecycle === "archived" ||
          reparsed.lifecycle === "frozen"
            ? reparsed.lifecycle
            : "active",
        topics: reparsed.topics,
        ...(reparsed.agentTemplateVersion !== null
          ? { agentTemplateVersion: reparsed.agentTemplateVersion }
          : {}),
        // Phase A — preserve scaffold-system version stamps across parse→render.
        // SEE ALSO: yon/parse.ts ParsedVaultYon + yon/vault.ts renderVaultYon.
        ...(reparsed.templateVersion !== null ? { templateVersion: reparsed.templateVersion } : {}),
        ...(reparsed.contractVersion !== null ? { contractVersion: reparsed.contractVersion } : {}),
        homeMesh: {
          vaultRid: freshRid,
          meshRid: meshRow.rid,
          meshName: meshRow.name,
          assignedAt: args.nowIso,
        },
      });

      writeFileSync(vaultYonPath, rewritten, "utf8");

      // Now register via join — joinVaultFlow re-reads the rewritten
      // vault.yon and INSERTs vaults row with the fresh rid + home_mesh_rid
      // primed via register.ts's @VAULT_HOME_MESH parse path.
      join_ = await joinVaultFlow(
        args.target,
        args.foreignSource !== undefined ? { source: args.foreignSource } : undefined,
      );
    }

    // Belt-and-braces (fresh-INSERT paths): ensure vaults.home_mesh_rid is set,
    // INSERT mesh_vaults role='home', append @MESH_HOME to the target mesh's
    // mesh.yon.
    // A0 (0.20.17) — continue by the RID we already hold, never by `name`.
    // `getVaultByName` delegates to the PUBLIC resolver (repo.ts → resolveVault),
    // whose exact-name rail fails closed on >1 live row. A received foreign vault
    // keeps the PUBLISHER's stored name (preserve-rid path registers vault.yon's
    // name verbatim; only the home mesh + disk path are re-keyed to the bucket),
    // so a receiver that already owns the same name — `personal/main` on any two
    // default installs — made this internal continuation throw
    // AmbiguousVaultLeafError AFTER the gh invitation had been consumed. The
    // resolver is correct; using a non-unique human handle for an internal
    // post-insert identity check is not. `join_.rid` is the identity.
    const vaultRow = await getVaultByRid(db, join_.rid);
    if (vaultRow === null) {
      throw new Error(
        `cloneVaultFlow: registered vault '${join_.name}' (rid ${join_.ridHex}) did not land in the registry (defensive).`,
      );
    }
    // Inc-2 Phase B / → (keystone) — positively mark the received foreign
    // vault with its resolved provenance. The fresh-INSERT branches already
    // passed `source` via join, but the CONVERGE branch resolved an EXISTING row
    // without a fresh insert (source untouched by upsert's preserve-on-conflict
    // rule). markVaultSourcePreserving applies the monotonic rule there: it
    // raises an `own` row to the foreign value but NEVER downgrades an existing
    // `shared` to `subscribed` nor silently re-flips a foreign row — so a
    // converge onto the user's own co-located vault, or onto an already-`shared`
    // grant, is left intact. No-op for the insert branches (already foreign).
    // Only ever runs on explicit foreign intent (foreignSource defined).
    if (args.foreignSource !== undefined) {
      await markVaultSourcePreserving(db, vaultRow.rid, args.foreignSource);
    }
    // (FIX-3) — do NOT re-home a vault that is ALREADY homed into a
    // DIFFERENT mesh. On the converge branch the preserved rid resolves to an
    // existing row whose home mesh may differ; re-issuing setVaultHomeMesh +
    // addVaultToMesh(role='home') for a second mesh violates the partial unique
    // index idx_mesh_vaults_home_per_vault (one home mesh per vault) and
    // clobbers unrelated home state. Skip the home mutation when the existing
    // home mesh differs; stay idempotent for the same-mesh case (ON CONFLICT
    // re-writes identical values harmlessly). A fresh INSERT always has
    // homeMeshRid == meshRow.rid here (register set it), so it proceeds.
    const alreadyHomedElsewhere =
      vaultRow.homeMeshRid !== null && !ridsEqual(vaultRow.homeMeshRid, meshRow.rid);
    if (!alreadyHomedElsewhere) {
      // Wrap the paired registry mutations in a tx (repair.ts precedent) so
      // the vault never lands half-homed (home_mesh_rid set without the
      // mesh_vaults `home` row, or vice-versa) on a mid-write failure. The
      // mesh.yon @MESH_HOME append stays OUTSIDE the tx (a file write; if it
      // throws post-commit, `lyt mesh rebuild-registry` re-emits the row).
      await db.execute("BEGIN");
      try {
        await setVaultHomeMesh(db, vaultRow.rid, meshRow.rid);
        await addVaultToMesh(db, meshRow.rid, vaultRow.rid, "home");
        await db.execute("COMMIT");
      } catch (innerErr) {
        try {
          await db.execute("ROLLBACK");
        } catch {
          /* best-effort */
        }
        throw innerErr;
      }
      if (mainVault !== null) {
        appendMeshHomeToFile({
          mainVaultPath: mainVault.path,
          meshRid: meshRow.rid,
          vaultRid: vaultRow.rid,
          vaultName: join_.name,
        });
      }
    }

    // (FIX-3) — sweep the orphaned freshly-cloned dir on the converge
    // short-circuit. The registry converged onto the EXISTING row (join_.path),
    // so the fresh clone at args.target is a redundant duplicate not referenced
    // by any registry row; remove it (junction-safe rmWithRetry) so it does not
    // leak. Guard on a genuine path difference (the fresh clone is always a
    // distinct new dir, but compare defensively) AND on the existing registered
    // path being present on disk (m1) — if the converged-onto row's path is gone
    // (a stale registry pointing at a removed dir), the fresh clone is the ONLY
    // surviving copy, so do NOT sweep it out from under the user.
    const convergedElsewhere =
      converged && resolve(join_.path) !== resolve(args.target) && existsSync(join_.path);
    if (convergedElsewhere) {
      await removeFailedCloneDir(args.target);
    }
    const finalTargetPath = converged ? join_.path : args.target;

    // UNIT 4 — scaffold conformance on clone --to-mesh / subscribe-on-clone: the
    // freshly-rid'd vault gets sentinel-bearing priming seeds so it does not
    // FTS-pollute. Additive + marker-bounded (never clobbers handler content).
    // SKIP on the preserve-rid path: regenAgentsMd/regenReadme would
    // rename agents.md/README with the clone name (or otherwise touch the
    // tracked files) and dirty the subscriber's working tree, which is exactly
    // what A2b forbids. A published Lyt vault already carries sentinel-bearing
    // scaffold, so skipping conformance does not FTS-pollute.
    if (!args.preserveRid) {
      writeScaffoldConformance({ vaultPath: args.target, name: join_.name });
    }

    // Inc-2 Phase B / #2 (0.12.1) — AUTO-INDEX on receive. Reflect the committed
    // SoT of the just-received vault into the machine-local caches so `lyt search`/
    // `recall`/`primer` hit with NO manual `lyt reindex`. Reflect (not re-cluster)
    // keeps the tracked tree clean (see reflect-index.ts). Best-effort: never
    // throws into the clone (the vault on disk is the durable side-effect). Only
    // the receive verbs that own their own post-clone step set autoIndex;
    // subscribeFlow leaves it off (it runs its own buildLocalIndex), so the reflect
    // never double-fires.
    if (args.autoIndex) {
      await reflectInboundIndex(join_.name, finalTargetPath);
    }

    return {
      ...join_,
      cloneTargetPath: finalTargetPath,
      meshAssignment: {
        meshRidHex: meshRow.ridHex,
        meshName: meshRow.name,
        freshRidApplied,
        externalMeshAutoRegistered,
      },
      originDetached,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

export function deriveNameFromUrl(url: string): string {
  let s = url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[\\/]+$/, "");
  if (s.length === 0) throw new Error(`Cannot derive vault name from URL: ${url}`);

  let pathPart: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // protocol://host/path — http(s), ssh, git, file
    const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(.*)$/i);
    pathPart = m?.[1] ?? "";
  } else if (/^[^@/\\]+@[^:]+:/.test(s)) {
    // user@host:path SSH shorthand
    pathPart = s.replace(/^[^@/\\]+@[^:]+:/, "");
  } else {
    pathPart = s;
  }

  pathPart = pathPart.replace(/^[\\/]+/, "");
  const segments = pathPart.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) throw new Error(`Cannot derive vault name from URL: ${url}`);
  // a convention repo name (`lyt-vault-<mesh>--<leaf>`) normalizes to
  // its `{mesh}/{vault}` NAME at the derive chokepoint, so subscribed/cloned
  // vaults register under their vault name, not their repo name. The parse
  // inverse can't false-positive: vault-name segments never contain `--`.
  // parseVaultRepoName already enforces per-segment slug-safety internally, so
  // a convention hit is containment-safe.
  const leaf = segments[segments.length - 1]!;
  const parsedRepoName = parseVaultRepoName(leaf);
  if (parsedRepoName !== null) return parsedRepoName;

  // fed-v2 Layer-2 P1 — the derived name feeds join(vaultsRoot, name)
  // → mkdirSync at the clone target, so a `..` (or any non-slug) segment must
  // NEVER round-trip into a traversal path. `.filter(Boolean)` above drops empty
  // segments but KEEPS `..`, so a URL like `https://github.com/ext/..` would
  // otherwise derive `ext/..`. Enforce an ALLOWLIST (per-segment slug check) —
  // NOT a `..`-denylist — on the segments that compose the returned name, and
  // REFUSE on any violation. assertSafeCloneName at the cloneVaultFlow boundary
  // is the second layer; rejecting here keeps the unit chokepoint honest for
  // direct callers.
  const derived = segments.length === 1 ? leaf : `${segments[segments.length - 2]!}/${leaf}`;
  for (const seg of derived.split("/")) {
    if (!isSlugSegment(seg)) {
      throw new Error(
        `Cannot derive a safe vault name from URL ${JSON.stringify(url)}: the derived name ` +
          `${JSON.stringify(derived)} contains a non-slug segment ${JSON.stringify(seg)} ` +
          `(e.g. '..', a dot, or uppercase) that could escape the vaults root. ` +
          `Pass an explicit '--name <mesh/vault>' with slug-safe segments instead.`,
      );
    }
  }
  return derived;
}
