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

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName, getMeshByRid } from "../registry/meshes-repo.js";
import {
  getVaultByName,
  getVaultByRid,
  type ForeignVaultSource,
} from "../registry/repo.js";
import {
  canonicalizeCoordinate,
  vaultLeaf,
  vaultOriginCoordinate,
} from "../registry/vault-addressing.js";
import {
  bucketMeshName,
  bucketVaultRelDir,
  entryModeForSource,
} from "../util/bucket-mesh.js";
import {
  isReservedFederationRepoName,
  resolveVaultRef,
  slugifyHandle,
  type ResolvedVaultRef,
} from "../util/federation-paths.js";
import { resolveRemoteUrl, resolveRemoteUrlFromSlug } from "../util/remote-url.js";
import { uuid7BytesToHex } from "../util/uuid7.js";
import { liveSubscriptions } from "../yon/subscription-ledger-read.js";
import { appendSubscriptionActive } from "../yon/subscription-ledger-write.js";
import { cloneVaultFlow } from "./clone.js";
import { reflectInboundIndex } from "./reflect-index.js";

// v1.C.2 — `lyt mesh subscribe --vault <ref-vault> --from-mesh <mesh>`.
//
// Writes a single @MESH_SUBSCRIPTION row into the SUBSCRIBING mesh's
// mesh.yon (the mesh whose name was passed via --from-mesh) per
// lyt-federation-design.md §3 asymmetric-awareness invariant — the
// referenced (subscribed) vault's home mesh's mesh.yon is never touched.
// The same transaction inserts the row into the per-machine
// `mesh_subscriptions` cache (regenerable per master-plan §G-6;
// `lyt mesh rebuild-registry` would re-derive it from mesh.yon SoT on
// any later reset).
//
// Order of operations:
// 1. Resolve the subscribing mesh via getMeshByName + its main vault
// (mesh.yon writes only land on main vaults per naming-convention
// "main vault locked to main").
// 2. Resolve the subscribed vault. If already registered locally, use
// its row. If not, invoke cloneFn (defaults to cloneVaultFlow with a
// name-derived GH URL per the ratified default) to clone it into the home mesh
// identified by the {owner}/{vault} prefix.
// 3. Read + parse the subscribing mesh's `.lyt/mesh.yon`.
// 4. Idempotent re-emit guard: if MeshDoc.subscriptions already
// contains a row with the same (mesh_rid, external_vault_rid),
// return `subscription-already-present` without mutating disk or
// cache (per the ratified default + v1.B.2 Lock 0.3 byte-stability + v1.C.1
// precedent).
// 5. Render the updated MeshDoc → tmp file (no disk mutation yet).
// 6. BEGIN tx → addSubscription into `mesh_subscriptions` cache
// (INSERT OR IGNORE — naturally idempotent at the cache layer).
// On failure: ROLLBACK + abandon tmp file (disk pristine).
// 7. COMMIT, then atomic rename tmp → mesh.yon.
// 8. Best-effort post-write index build (V-C-1 Phase B / L2): an ALL-TIER
// reindexInboundVault (lanes+arcs+fts+rollup) on the subscribed vault so
// the v1.D.3 cascade surfaces it under mesh-scoped uniform search — and
// tier-0 arcs + primer arcs populate too (the prior FTS+lanes-only build
// left arcs empty until a manual reindex — V-B-6).
//
// Open-once seam (v1.A.5 vindicated 14 times): callers may pass
// `registryDb`; the flow opens its own client only when omitted.
//
// Atomicity contract (mirrors flows/add-mesh-edge.ts:39-54):
// - Cache insert happens INSIDE the registry tx, BEFORE the mesh.yon
// rename. If the cache insert throws, the tx rolls back and the tmp
// file is removed — disk is unchanged.
// - Once the registry tx COMMITs the cache row exists; the rename then
// publishes mesh.yon atomically. A crash between COMMIT and rename
// leaves a registry row pointing at content that exists only in the
// tmp file; `lyt mesh rebuild-registry` re-derives the cache from
// mesh.yon (SoT primacy) and clears the orphan row on its next run.

export type SubscribeCloneOutcome = "cloned" | "already-present";

// the public-vs-private DISCRIMINATOR at receive. Resolves the upstream
// repo's GitHub visibility so the receive path can decide the ENTRY RELATIONSHIP:
//   private ⇒ shared      (a granted private vault — affiliation)
//   public  ⇒ subscribed  (a self-subscribed public vault)
//   unknown ⇒ subscribed  (fail-closed to the least-committal self-subscribe;
//                          only an explicit graduate / setVaultSource can later
//                          correct the SOURCE — the lazy homing repair relocates a
//                          vault's on-disk home but NEVER mutates `source`)
// Injectable so tests + library callers stay network-free; the CLI wires the
// real `gh repo view --json visibility` probe (util/gh-discover.checkRepoVisibility).
export type RepoVisibilityProbe = (
  owner: string,
  repoName: string,
) => Promise<"public" | "private" | "unknown">;

// map a probed visibility to the stored foreign provenance. When no probe
// is supplied the receive DEFAULTS to `subscribed` (a self-subscribe), the
// behavior — only an explicit `private` verdict promotes to `shared`.
export function foreignSourceForVisibility(
  visibility: "public" | "private" | "unknown",
): ForeignVaultSource {
  return visibility === "private" ? "shared" : "subscribed";
}

export interface SubscribeCloneArgs {
  // Canonical `{mesh}/{vault}` name (already normalized through
  // resolveVaultRef; repo-name input arrives here as the vault name). This stays
  // the publisher's canonical name — the registered vault name — NOT the bucket
  // path (the preserve-rid identity guard compares the registered name against
  // the publisher's declared vault.yon name).
  vaultName: string;
  // Inc-2 Phase B / (S1) — the mesh the foreign vault homes into. On a
  // COLLISION (the foreign mesh name equals a locally-OWNED mesh — the dogfood
  // commingle case) this is the reserved OWNER-BUCKET mesh `subscriptions/{owner}`;
  // otherwise it is the foreign mesh segment (the external-mesh record model,
  // unchanged pre-D74). The default cloneFn passes this as `--to-mesh`.
  homeMeshName: string;
  // Inc-2 Phase B / → (always-separate) — vault-root-relative ON-DISK dir
  // the clone lands under. ALWAYS set to the owner-keyed bucket tree
  // (`subscriptions/{owner}/{leaf}` or `shared/{owner}/{leaf}`), so EVERY foreign
  // vault is separated from the user's own `~/lyt/vaults/{mesh}/…` tree — not
  // only on a name collision (the superseded collides-only rule). Decoupled from
  // `vaultName` so the registered name stays the publisher's canonical
  // `{mesh}/{leaf}` while the dir is bucketed by owner.
  targetSubdir?: string | undefined;
  // the resolved foreign provenance (`shared` | `subscribed`) the receive
  // path stamps on the registered row + uses to pick the bucket tree. `shared`
  // = a granted PRIVATE vault; `subscribed` = a self-subscribed PUBLIC vault.
  foreignSource: ForeignVaultSource;
  // convention-derived clone URL
  // (`https://github.com/{owner}/lyt-vault-<mesh>--<leaf>.git`). The default
  // clone fn uses this verbatim; injected test seams may ignore it.
  cloneUrl: string;
  registryDb: Client;
}

export interface SubscribeCloneResult {
  vaultRid: Uint8Array;
  vaultRidHex: string;
  homeMeshRid: Uint8Array;
}

// Injectable clone seam: tests provide a function that materialises the
// subscribed vault locally without touching the network. The default
// implementation calls cloneVaultFlow with a GH URL built from the
// vault's `{owner}/{vault}` shape per the ratified default (lyt-naming-convention).
export type SubscribeCloneFn = (args: SubscribeCloneArgs) => Promise<SubscribeCloneResult>;

export type SubscribeResultStatus = "subscription-written" | "subscription-already-present";

export interface SubscribeArgs {
  subscribedVaultName: string;
  fromMeshName: string;
  registryDb?: Client | undefined;
  // Test seam. Default calls cloneVaultFlow with name-derived GH URL.
  cloneFn?: SubscribeCloneFn | undefined;
  // the public-vs-private discriminator. When supplied, the received
  // foreign vault's provenance is resolved from the upstream repo's visibility
  // (private ⇒ shared, public ⇒ subscribed). Omitted → default `subscribed`
  // (self-subscribe; network-free for library/test callers). The CLI wires the
  // real gh probe.
  visibilityProbe?: RepoVisibilityProbe | undefined;
}

export interface SubscribeResult {
  status: SubscribeResultStatus;
  subscribingMesh: {
    ridHex: string;
    name: string;
    mainVaultPath: string;
  };
  subscribedVault: {
    ridHex: string;
    name: string;
    homeMeshRidHex: string;
    homeMeshName: string;
  };
  meshYonPath: string;
  cloneAction: SubscribeCloneOutcome;
  indexBuilt: {
    lanesRan: boolean;
    // V-C-1 Phase B (L2) — arcs now built too (closes the V-B-6 arcs gap).
    arcsRan: boolean;
    ftsRan: boolean;
  };
  durationMs: number;
}

// v1.C.2 — structured errors. CLI maps these to per-command exit codes
// per the ratified default (1 vault-not-found clone-failed; 4 main-vault-missing).

export class SubscribeMainVaultMissingError extends Error {
  readonly errorCode = "main-vault-missing";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt mesh subscribe: subscribing mesh '${meshName}' has no main vault registered locally; cannot write mesh.yon. Run 'lyt mesh init ${meshName}' or 'lyt mesh rebuild-registry' to restore the main vault.`,
    );
    this.name = "SubscribeMainVaultMissingError";
    this.meshName = meshName;
  }
}

export class SubscribeVaultNotFoundError extends Error {
  readonly errorCode = "vault-not-found";
  readonly vaultName: string;
  constructor(vaultName: string, reason: string) {
    super(`lyt mesh subscribe: ${reason}`);
    this.name = "SubscribeVaultNotFoundError";
    this.vaultName = vaultName;
  }
}

// Fed-v2 Layer-1 (Phase C) — fail-closed when the subscribed vault has no
// resolvable git origin, so no cross-pod coordinate can be derived. The
// coordinate is the subscription store's identity + dedup key; a record
// without one would be unmergeable across writers. Refuse rather than write a
// keyless record.
export class SubscribeNoCoordinateError extends Error {
  readonly errorCode = "no-coordinate";
  readonly vaultName: string;
  constructor(vaultName: string) {
    super(
      `lyt mesh subscribe: subscribed vault '${vaultName}' has no resolvable git origin, ` +
        `so no cross-pod coordinate (lyt:vault:<host>/<owner>/<repo>) can be derived. ` +
        `A subscription record requires a coordinate as its identity key — refusing to ` +
        `subscribe a vault with no origin. Set the vault's remote and retry.`,
    );
    this.name = "SubscribeNoCoordinateError";
    this.vaultName = vaultName;
  }
}

// Name-based URL construction per the ratified default + lyt-naming-convention. Hardening pass
// (subscriber-onboarding fix-pass, 2026-06-11): the URL now routes through
// the repo-name convention SoT (util/federation-paths.ts) — a vault NAMED
// `younndai/pub-test` lives at the repo `younndai/lyt-vault-younndai--pub-test`,
// not at `younndai/pub-test`. Accepts both the name form and the literal
// repo-name form (resolveVaultRef); non-two-segment input falls back to the
// legacy literal URL (defensive — subscribeFlow refuses such input upstream).
export function defaultGhUrlForVaultName(vaultName: string): string {
  const ref = resolveVaultRef(vaultName);
  if (ref === null) return resolveRemoteUrlFromSlug(vaultName);
  return ghUrlForVaultRef(ref);
}

function ghUrlForVaultRef(ref: ResolvedVaultRef): string {
  return resolveRemoteUrl(ref.owner, ref.repoName);
}

const defaultCloneFn: SubscribeCloneFn = async (args) => {
  const clone = await cloneVaultFlow({
    url: args.cloneUrl,
    // register under the canonical vault name, never the repo name.
    name: args.vaultName,
    // Inc-2 Phase B / → (always-separate) — home into the owner-keyed
    // bucket mesh (args.homeMeshName = `subscriptions/{owner}` | `shared/{owner}`)
    // and land the clone under the separated on-disk subtree (targetSubdir), NOT
    // the user's own mesh tree.
    toMesh: args.homeMeshName,
    ...(args.targetSubdir !== undefined ? { targetSubdir: args.targetSubdir } : {}),
    registryDb: args.registryDb,
    // subscriber intent: an unregistered home mesh becomes an
    // external-mesh RECORD (no scaffolded `<foreign>/main` vault); the
    // consumer is never told to init another owner's mesh.
    autoRegisterExternalMesh: true,
    // Inc-2 Phase B / (keystone) — positively mark the received foreign
    // vault with its resolved provenance (`shared` | `subscribed`).
    foreignSource: args.foreignSource,
    // a read-only subscriber KEEPS the publisher rid (rid-first
    // convergence) and lands with a clean working tree: no fresh-rid rewrite
    // of the tracked vault.yon, no scaffold regen. Independent of detachOrigin
    // (omitted here → keep upstream origin to pull).
    preserveRid: true,
  });
  const vault = await getVaultByName(args.registryDb, clone.name);
  if (vault === null || vault.homeMeshRid === null) {
    throw new SubscribeVaultNotFoundError(
      args.vaultName,
      `clone succeeded but registry lookup of '${clone.name}' returned no vault row with home_mesh_rid (defensive — shouldn't happen).`,
    );
  }
  return {
    vaultRid: vault.rid,
    vaultRidHex: uuid7BytesToHex(vault.rid),
    homeMeshRid: vault.homeMeshRid,
  };
};

export async function subscribeFlow(args: SubscribeArgs): Promise<SubscribeResult> {
  const startedAt = Date.now();

  // G3 (design §6.1) — the federation manifest repo (`lyt-pod` / `lyt-pod-map`)
  // is UN-SUBSCRIBABLE: cloning it would pull down every push_target, vault rid,
  // and the whole federation map of the publisher. Refuse BEFORE opening the
  // registry or attempting any clone.
  //
  // FIX C (A2-R2 G3-3) — key on the REPO NAME, not every raw segment. The old scan
  // matched a bare `lyt-pod` segment ANYWHERE, which false-positived a legit vault
  // whose OWNER handle or LEAF is `lyt-pod` (real repo `lyt-vault-<mesh>--<leaf>`).
  // A resolvable CONVENTION repo (`{owner}/lyt-vault-<mesh>--<leaf>`) is authoritative:
  // it is reserved only if its convention repoName is (it never is), so a legit
  // owner/leaf `lyt-pod` in repo-name form is allowed. A DIRECT manifest reference
  // (`owner/lyt-pod`, or bare `lyt-pod`) does NOT parse as a convention repo — it is
  // caught by its repo/leaf-position segment being literally reserved.
  const subRef = resolveVaultRef(args.subscribedVaultName);
  const repoPositionSegment =
    args.subscribedVaultName.split(/[\\/]/).filter((s) => s.length > 0).pop() ??
    args.subscribedVaultName;
  const referencesReservedManifestRepo =
    subRef !== null && subRef.inputForm === "repo-name"
      ? isReservedFederationRepoName(subRef.repoName)
      : isReservedFederationRepoName(repoPositionSegment);
  if (referencesReservedManifestRepo) {
    throw new Error(
      `Refusing to subscribe '${args.subscribedVaultName}': the federation manifest repo ` +
        `(lyt-pod / lyt-pod-map) is un-subscribable — it exposes the publisher's every ` +
        `push_target, vault rid, and whole federation map. Subscribe to individual vaults instead.`,
    );
  }

  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());
  const cloneFn = args.cloneFn ?? defaultCloneFn;

  try {
    // 1. Resolve the subscribing mesh + its main vault.
    const subMesh = await getMeshByName(db, args.fromMeshName);
    if (subMesh === null) {
      throw new SubscribeMainVaultMissingError(args.fromMeshName);
    }
    if (subMesh.mainVaultRid === null) {
      throw new SubscribeMainVaultMissingError(args.fromMeshName);
    }
    const subMainVault = await getVaultByRid(db, subMesh.mainVaultRid);
    if (subMainVault === null) {
      throw new SubscribeMainVaultMissingError(args.fromMeshName);
    }
    const meshYonPath = join(subMainVault.path, ".lyt", "mesh.yon");
    if (!existsSync(meshYonPath)) {
      throw new SubscribeMainVaultMissingError(args.fromMeshName);
    }

    // 2. Resolve the subscribed vault — already-present or clone-on-
    // subscribe. The handler-supplied ref is first
    // normalized through the repo-name convention (resolveVaultRef), so
    // `{mesh}/{vault}` AND `{owner}/lyt-vault-<mesh>--<leaf>` both resolve
    // to the same canonical vault name. Registry lookup tries the
    // canonical name first, then the raw input (back-compat with rows
    // registered under a repo name before this fix-pass).
    const ref = resolveVaultRef(args.subscribedVaultName);
    let subscribedVault = ref !== null ? await getVaultByName(db, ref.vaultName) : null;
    if (subscribedVault === null && (ref === null || ref.vaultName !== args.subscribedVaultName)) {
      subscribedVault = await getVaultByName(db, args.subscribedVaultName);
    }
    let cloneAction: SubscribeCloneOutcome = "already-present";
    if (subscribedVault === null) {
      // Clone path. The home mesh name is the mesh segment of the CANONICAL
      // vault name (for repo-name input that is the mesh embedded in the
      // repo name, not the GH owner). The cloneFn registers the freshly
      // cloned vault under that mesh; the new row carries the mesh's rid as
      // home_mesh_rid.
      if (ref === null) {
        throw new SubscribeVaultNotFoundError(
          args.subscribedVaultName,
          `vault name '${args.subscribedVaultName}' is not in the canonical {owner}/{vault} shape; cannot derive the home mesh for clone-on-subscribe.`,
        );
      }
      const homeMeshName = ref.vaultName.slice(0, ref.vaultName.indexOf("/"));
      // release review — the repo-name form decouples GH owner from
      // mesh name ("owner is WHERE, mesh is WHAT"), so a crafted repo like
      // `evil/lyt-vault-personal--notes` would otherwise land a FOREIGN vault
      // as a home member of the user's OWN 'personal' mesh (including an
      // @MESH_HOME write into the user's mesh.yon). When the embedded mesh
      // segment names a locally-OWNED mesh (main vault present) but the repo
      // is hosted elsewhere, refuse with the explicit-intent remedies.
      if (ref.inputForm === "repo-name" && ref.owner !== homeMeshName) {
        const localMesh = await getMeshByName(db, homeMeshName);
        if (localMesh !== null && localMesh.mainVaultRid !== null) {
          throw new SubscribeVaultNotFoundError(
            args.subscribedVaultName,
            `repo '${ref.owner}/${ref.repoName}' declares home mesh '${homeMeshName}', ` +
              `which is one of YOUR meshes, but the repo is hosted by '${ref.owner}' — ` +
              `refusing to register a foreign vault into your own mesh. If this vault is ` +
              `genuinely yours, clone it explicitly with ` +
              `'lyt vault clone <url> --to-mesh ${homeMeshName}'; otherwise verify the ` +
              `publisher and subscribe using the {mesh}/{vault} name form.`,
          );
        }
      }
      // Inc-2 Phase B / ALWAYS-SEPARATE, owner-keyed bucket homing
      // (supersedes the collides-only rule). EVERY foreign inbound vault
      // homes into its reserved OWNER-BUCKET mesh + a separated on-disk subtree,
      // regardless of whether its mesh name collides with a locally-owned mesh —
      // a foreign vault NEVER commingles into the user's own `{mesh}` tree. The
      // bucket is chosen by the resolved provenance:
      //   subscribed (public self-subscribe) → `subscriptions/{owner}`
      //   shared     (private grant)          → `shared/{owner}`
      // `{owner}` is the slugified GH owner — the SAME segment the sync
      // reconstitution derives from the origin coordinate (shared rule in
      // util/bucket-mesh.ts), so the live home mesh and the reconstituted bucket
      // never diverge.
      //
      // The public-vs-private DISCRIMINATOR: probe the upstream repo's GitHub
      // visibility (private ⇒ shared, public ⇒ subscribed). Injectable — omitted
      // → default `subscribed` (self-subscribe; network-free). The CLI wires the
      // real `gh repo view --json visibility` probe.
      const visibility = args.visibilityProbe
        ? await args.visibilityProbe(ref.owner, ref.repoName)
        : "public";
      const foreignSource = foreignSourceForVisibility(visibility);
      const bucketOwner = slugifyHandle(ref.owner);
      const cloneHomeMesh = bucketMeshName(entryModeForSource(foreignSource), bucketOwner);
      const cloneSubdir = bucketVaultRelDir(foreignSource, bucketOwner, vaultLeaf(ref.vaultName));
      try {
        await cloneFn({
          vaultName: ref.vaultName,
          homeMeshName: cloneHomeMesh,
          targetSubdir: cloneSubdir,
          foreignSource,
          cloneUrl: ghUrlForVaultRef(ref),
          registryDb: db,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SubscribeVaultNotFoundError(
          args.subscribedVaultName,
          `clone-on-subscribe failed for vault '${ref.vaultName}': ${msg}. Ensure the GitHub repo is accessible or pre-clone via 'lyt vault clone'.`,
        );
      }
      cloneAction = "cloned";
      subscribedVault = await getVaultByName(db, ref.vaultName);
      if (subscribedVault === null) {
        throw new SubscribeVaultNotFoundError(
          args.subscribedVaultName,
          `clone succeeded but vault '${ref.vaultName}' is not in the registry (defensive).`,
        );
      }
    }
    if (subscribedVault.homeMeshRid === null) {
      throw new SubscribeVaultNotFoundError(
        args.subscribedVaultName,
        `vault '${args.subscribedVaultName}' has no home_mesh_rid binding. Run 'lyt vault clone --to-mesh' or 'lyt mesh rebuild-registry' to bind it.`,
      );
    }

    const subscribedHomeMesh = await getMeshByRid(db, subscribedVault.homeMeshRid);
    if (subscribedHomeMesh === null) {
      throw new SubscribeVaultNotFoundError(
        args.subscribedVaultName,
        `vault '${args.subscribedVaultName}' home_mesh_rid points at no registered mesh (defensive).`,
      );
    }

    // 3. Resolve the subscribed vault's cross-pod coordinate — the
    // subscription store's IDENTITY + DEDUP key. Fed-v2 Layer-1 (Phase C)
    // re-keys subscription identity OFF the self-asserted rid and ONTO the
    // origin coordinate (`lyt:vault:<host>/<owner>/<repo>`): a forged rid can
    // no longer collide a distinct vault, and two writers naming the same
    // upstream repo converge. FAIL-CLOSED: a vault with no resolvable origin
    // has no coordinate, so refuse — a keyless record is unmergeable.
    const coordinate = vaultOriginCoordinate(subscribedVault);
    if (coordinate === null) {
      throw new SubscribeNoCoordinateError(args.subscribedVaultName);
    }

    const subscribingSummary = {
      ridHex: uuid7BytesToHex(subMesh.rid),
      name: subMesh.name,
      mainVaultPath: subMainVault.path,
    };
    const subscribedSummary = {
      ridHex: uuid7BytesToHex(subscribedVault.rid),
      name: subscribedVault.name,
      homeMeshRidHex: uuid7BytesToHex(subscribedHomeMesh.rid),
      homeMeshName: subscribedHomeMesh.name,
    };

    // 4. Idempotence — re-keyed onto the coordinate. The live set is the
    // OR-Set fold over every writer's append-only shard; a coordinate already
    // live (active in some shard, not tombstone-superseded) means this
    // subscribe is a no-op. (Per the locked record shape, two records with the
    // same coordinate but different added_at are still one subscription —
    // added_at is audit-only.)
    //
    // deferred-E — compare on the CANONICAL coordinate on BOTH sides.
    // `liveSubscriptions()` already emits canonical coordinates (the fold dedups
    // on the canonical key), and `vaultOriginCoordinate` is built from the same
    // `gitUrlToCoordinate` canonicalizer — but canonicalize the local
    // `coordinate` here too so an idempotent re-subscribe under a spelling
    // variant (e.g. a case-different remote URL) is correctly a no-op rather
    // than appending a duplicate active record for the same logical vault.
    const canonicalCoordinate = canonicalizeCoordinate(coordinate);
    const alreadyPresent = liveSubscriptions().some((s) => s.coordinate === canonicalCoordinate);
    if (alreadyPresent) {
      // Even on idempotent re-emit, refresh the local index so a previous
      // partial subscribe that never reached the index build still ends up
      // searchable. reindexInboundVault (all tiers) is itself idempotent.
      const indexBuilt = await reflectInboundIndex(subscribedVault.name, subscribedVault.path);
      return {
        status: "subscription-already-present",
        subscribingMesh: subscribingSummary,
        subscribedVault: subscribedSummary,
        meshYonPath,
        cloneAction,
        indexBuilt,
        durationMs: Date.now() - startedAt,
      };
    }

    // 5. Write the @SUBSCRIPTION record to THIS writer's own append-only
    // shard (`<podRoot>/ledger/subscriptions/<writerId>/`). This is the
    // durable side-effect — the convergent store. The legacy @MESH_SUBSCRIPTION
    // mesh.yon write and the `mesh_subscriptions` cache insert are RETIRED here
    // (begin no-legacy, Phase C): the mesh.yon SoT no longer carries
    // subscriptions and the cache is EXPECTED to go stale on this branch until
    // the reconstitution phase. We do not wire reconstitution here.
    // the ledger `entry_mode` MUST match the vault's stored provenance so
    // the sync reconstitution homes it into the SAME owner-bucket tree the live
    // receive path did (`shared` → shared/{owner}, else subscriptions/{owner}).
    // Derive it from the resolved row's `source` (set by the clone/receive path,
    // or already-present for a pre-registered foreign vault) — never hardcoded.
    appendSubscriptionActive({
      coordinate,
      rid: subscribedSummary.ridHex,
      entryMode: entryModeForSource(subscribedVault.source === "shared" ? "shared" : "subscribed"),
    });

    // 6. Local libSQL index build. Best-effort: upsert*Cache flows open the
    // per-vault .lyt/lyt.db; failure logs but does not fail the subscribe
    // (mirrors the lyt-mesh sync post-pull hook pattern). The subscription
    // record is the durable side-effect; index refresh follows.
    const indexBuilt = await reflectInboundIndex(subscribedVault.name, subscribedVault.path);

    return {
      status: "subscription-written",
      subscribingMesh: subscribingSummary,
      subscribedVault: subscribedSummary,
      meshYonPath,
      cloneAction,
      indexBuilt,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

// V-C-1 Phase B (L2) — the build-on-inbound for a clone-on-subscribe is the
// SHARED reflect cascade `reflectInboundIndex` (./reflect-index.ts): it REFLECTS
// the cloned vault's COMMITTED SoT (ledger → lanes → arcs → fts) into the
// machine-local caches and stamps the L3 watermark — the SAME reconcile the
// read-only subscriber PULL path runs on every later sync. See reflect-index.ts
// for the full WHY-REFLECT-NOT-RE-CLUSTER rationale + the empty-cluster tradeoff.
// The former private `buildLocalIndex` was a byte-identical duplicate and was
// folded into that single source of truth (audit-coupled-constant: one reflect
// cascade, three receive callers — subscribe, accept-share, clone auto-index).
