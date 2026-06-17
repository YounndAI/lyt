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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { addSubscription } from "../registry/mesh-subscriptions-repo.js";
import { getMeshByName, getMeshByRid } from "../registry/meshes-repo.js";
import { getVaultByName, getVaultByRid } from "../registry/repo.js";
import { resolveVaultRef, type ResolvedVaultRef } from "../util/federation-paths.js";
import { ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { renderMeshYon, type MeshDoc, type MeshSubscriptionRecord } from "../yon/mesh-write.js";
import { cloneVaultFlow } from "./clone.js";
import { reindexInboundVault } from "./reindex-inbound.js";

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
// Open-once seam (v1.A.5 CR-B1 vindicated 14 times): callers may pass
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

export interface SubscribeCloneArgs {
  // Canonical `{mesh}/{vault}` name (already normalized through
  // resolveVaultRef; repo-name input arrives here as the vault name).
  vaultName: string;
  homeMeshName: string;
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

// Name-based URL construction per the ratified default + lyt-naming-convention. Hardening pass
// (subscriber-onboarding fix-pass, 2026-06-11): the URL now routes through
// the repo-name convention SoT (util/federation-paths.ts) — a vault NAMED
// `younndai/pub-test` lives at the repo `younndai/lyt-vault-younndai--pub-test`,
// not at `younndai/pub-test`. Accepts both the name form and the literal
// repo-name form (resolveVaultRef); non-two-segment input falls back to the
// legacy literal URL (defensive — subscribeFlow refuses such input upstream).
export function defaultGhUrlForVaultName(vaultName: string): string {
  const ref = resolveVaultRef(vaultName);
  if (ref === null) return `https://github.com/${vaultName}.git`;
  return ghUrlForVaultRef(ref);
}

function ghUrlForVaultRef(ref: ResolvedVaultRef): string {
  return `https://github.com/${ref.owner}/${ref.repoName}.git`;
}

const defaultCloneFn: SubscribeCloneFn = async (args) => {
  const clone = await cloneVaultFlow({
    url: args.cloneUrl,
    // register under the canonical vault name, never the repo name.
    name: args.vaultName,
    toMesh: args.homeMeshName,
    registryDb: args.registryDb,
    // subscriber intent: an unregistered home mesh becomes an
    // external-mesh RECORD (no scaffolded `<foreign>/main` vault); the
    // consumer is never told to init another owner's mesh.
    autoRegisterExternalMesh: true,
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
      try {
        await cloneFn({
          vaultName: ref.vaultName,
          homeMeshName,
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

    // 3. Read + parse the subscribing mesh's mesh.yon.
    const before = readFileSync(meshYonPath, "utf8");
    const doc = parseMeshYon(before);

    // 4. Build the @MESH_SUBSCRIPTION record + idempotence check.
    const newSub: MeshSubscriptionRecord = {
      meshRid: subMesh.rid,
      externalVaultRid: subscribedVault.rid,
      externalMeshRid: subscribedHomeMesh.rid,
      externalMeshName: subscribedHomeMesh.name,
    };

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

    const alreadyPresent = doc.subscriptions.some(
      (s) =>
        ridsEqual(s.meshRid, newSub.meshRid) &&
        ridsEqual(s.externalVaultRid, newSub.externalVaultRid),
    );
    if (alreadyPresent) {
      // Even on idempotent re-emit, refresh the local index so a previous
      // partial subscribe that never reached step 8 still ends up searchable.
      // reindexInboundVault (all tiers) is itself idempotent.
      const indexBuilt = await buildLocalIndex(subscribedVault.name, subscribedVault.path, db);
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

    // 5. Render the updated MeshDoc → tmp file.
    const updatedDoc: MeshDoc = {
      ...doc,
      subscriptions: [...doc.subscriptions, newSub],
    };
    const rendered = renderMeshYon(updatedDoc);
    const tmpPath = `${meshYonPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, rendered, "utf8");

    // 6. Registry tx + cache insert. On failure: ROLLBACK + abandon tmp.
    try {
      await db.execute("BEGIN");
      try {
        await addSubscription(db, {
          meshRid: newSub.meshRid,
          externalVaultRid: newSub.externalVaultRid,
          externalMeshRid: newSub.externalMeshRid,
          externalMeshName: newSub.externalMeshName,
        });
        await db.execute("COMMIT");
      } catch (innerErr) {
        try {
          await db.execute("ROLLBACK");
        } catch {
          /* best-effort */
        }
        throw innerErr;
      }
    } catch (err) {
      cleanupTmp(tmpPath);
      throw err;
    }

    // 7. Atomic rename tmp → mesh.yon.
    mkdirSync(dirname(meshYonPath), { recursive: true });
    renameSync(tmpPath, meshYonPath);

    // 8. Local libSQL index build (clause-a). Best-effort: upsert*Cache
    // flows open the per-vault .lyt/lyt.db; failure logs but does not
    // fail the subscribe (mirrors the lyt-mesh sync post-pull hook
    // pattern). The subscription is the durable side-effect; index
    // refresh follows.
    const indexBuilt = await buildLocalIndex(subscribedVault.name, subscribedVault.path, db);

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

// V-C-1 Phase B (L2) — reindex-on-inbound for a clone-on-subscribe. The prior
// build was upsertLanesCache + upsertFtsCache (FTS + lanes-from-SoT, NO arcs) —
// a V-B-6 gap that left tier-0 arc search + primer arcs empty on a subscribed
// vault. reindexInboundVault rebuilds ALL tiers (lanes+arcs+fts+rollup) from the
// cloned markdown + stamps the L3 watermark. Best-effort: a failure logs but
// never fails the subscribe (the subscription is the durable side-effect).
async function buildLocalIndex(
  vaultName: string,
  vaultPath: string,
  registryDb: Client,
): Promise<{ lanesRan: boolean; arcsRan: boolean; ftsRan: boolean }> {
  const idx = await reindexInboundVault({ vault: vaultName, vaultPath, registryDb });
  if (!idx.reindexed) {
    // eslint-disable-next-line no-console
    console.error(
      `lyt mesh subscribe: post-write index of ${vaultName} deferred (${idx.error ?? "unknown"}); ` +
        `markdown SoT intact — run \`lyt reindex --vault ${vaultName}\`.`,
    );
  }
  // All tiers rebuild together via rebuildVaultFlow, so the three flags move in
  // lockstep with the rebuild's success.
  return { lanesRan: idx.reindexed, arcsRan: idx.reindexed, ftsRan: idx.reindexed };
}

function cleanupTmp(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}
