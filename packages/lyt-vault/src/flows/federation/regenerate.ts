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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Client } from "@libsql/client";

import { listFederationStates, readFederationState } from "../../registry/federation-state.js";
import { listMeshes } from "../../registry/meshes-repo.js";
import { listVaults } from "../../registry/repo.js";
import { resolveConfig } from "../../util/config.js";
import {
  getFederationRoot,
  getFederationYonPath,
  vaultRepoName,
} from "../../util/federation-paths.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import {
  renderFederationYon,
  type FedMeshRecord,
  type FedVaultRecord,
  type FederationDoc,
  type FederationVisibility,
} from "../../yon/federation-write.js";

// (Brief A) — the pod manifest (`pod.yon`) is a DERIVED view of the local
// registry, regenerated from `registry.db` exactly like the pod-map vault
// (pod-map-generate.ts). This is the SINGLE derivation path: both the lifecycle
// regen hooks (init / adopt / forget) and `lyt federation rebuild` route through
// `derivePodManifestDoc` so there is exactly one definition of "what the manifest
// should contain given the registry". Dissolves the empty-manifest
// limitation + the 2-SoT divergence (registry knew the vault; manifest didn't).
//
// The registry is the SoT; `pod.yon` is never hand-edited as truth. Anything a
// handler types into `pod.yon` is overwritten on the next mutation-triggered
// regen — same contract as pod-map.

export interface DerivePodManifestOptions {
  handle: string;
  // Federation-level fields NOT derivable from the registry's vault/mesh tables
  // — preserved across regens from the prior pod.yon (or defaulted on first
  // write). Visibility is the handler's repo choice; createdAt is birth time.
  visibility: FederationVisibility;
  createdAt: string;
  // The `last_synced_at` stamp value (the one drifting field).
  nowIso: string;
  // Brief B — per-vault visibility is preserved across regens from the
  // prior pod.yon (like the federation-level visibility/createdAt above — NOT
  // derivable from the registry, which has no per-vault visibility column).
  // Keyed by vaultRidHex. A vault absent from the map defaults to
  // resolveConfig().defaultRepoVisibility ("private"). When the conscious-public
  // flip ships, it writes visibility into pod.yon and this preservation keeps it
  // stable across subsequent registry-triggered regens.
  priorVaultVisibility?: ReadonlyMap<string, FederationVisibility> | undefined;
}

// Pure-ish derivation: registry rows → FederationDoc. The only IO is the three
// registry reads; no filesystem, no network, no Date. Deterministic given the
// same registry state + the same (visibility, createdAt, nowIso). The renderer
// sorts records, so listMeshes/listVaults ordering does not affect output.
export async function derivePodManifestDoc(
  db: Client,
  opts: DerivePodManifestOptions,
): Promise<FederationDoc> {
  const state = await readFederationState(db, opts.handle);
  if (state === null) {
    throw new Error(
      `Cannot derive pod manifest: no federation_state row for handle ${JSON.stringify(
        opts.handle,
      )}. Run \`lyt federation init\` to register the local pod first.`,
    );
  }

  const meshes = await listMeshes(db);
  // release review (introduced-Critical): the user-facing manifest must NOT
  // list TOMBSTONED vaults. `listVaults` returns every row regardless of status,
  // and the DEFAULT `lyt vault delete <name>` TOMBSTONES (soft-delete) rather
  // than removing the row — so an unfiltered map would keep the deleted vault in
  // pod.yon, silently breaking "pod = what you have". Drop tombstoned; KEEP
  // active / disconnected / missing / access_lost (those are legitimate pod
  // members whose repo is just unreachable, not removed). Mirrors the
  // noTombstones filter in listVaultsFlow.
  const vaults = (await listVaults(db)).filter((v) => v.status !== "tombstoned");

  // @FED_MESH: every registry mesh, attributed to this federation. pushTarget /
  // pushKind fall back to the handle when the mesh row left them null.
  //
  // KNOWN LIMITATION (release review, DEFERRED to v1.G.x.1 / Brief B): role is
  // hard-coded "own". The registry `meshes` table has no own-vs-join column, and
  // `lyt mesh join` DOES insert a joined (other-owner) mesh into `meshes` — so a
  // joined mesh is currently mislabeled role="own" in pod.yon. A `pushTarget ===
  // handle` heuristic would help but mislabels a user-owned ORG mesh as "join",
  // so it's not strictly better; the correct fix is a `meshes.role` column.
  // Deferred because role is not yet consumed by any shipped reader and pod.yon
  // is a regenerable derived view.
  const fedMeshes: FedMeshRecord[] = meshes.map((m) => ({
    fedRidHex: state.fedRidHex,
    meshRidHex: m.ridHex,
    meshName: m.name,
    pushTarget: m.pushTarget ?? opts.handle,
    pushKind: m.pushKind ?? "handle",
    role: "own",
    addedAt: m.createdAt,
  }));

  // @FED_VAULT: every registry vault, with its home-mesh membership (null →
  // orphan). This is the list that was missing before the live dogfood
  // showed the registry holding `personal/main` while the manifest was empty.
  //
  // Brief B: `repo` is computed via the vaultRepoName chokepoint (scheme D) so
  // pod.yon is self-describing for the recovery loop; `visibility` is preserved
  // from the prior manifest (priorVaultVisibility) or defaults to "private".
  const defaultVisibility = resolveConfig().defaultRepoVisibility;
  const fedVaults: FedVaultRecord[] = vaults.map((v) => ({
    vaultRidHex: v.ridHex,
    vaultName: v.name,
    homeMeshRidHex: v.homeMeshRidHex,
    repo: vaultRepoName(v.name),
    visibility: opts.priorVaultVisibility?.get(v.ridHex) ?? defaultVisibility,
    status: v.status,
    registeredAt: v.registeredAt,
  }));

  return {
    federation: {
      fedRidHex: state.fedRidHex,
      handle: opts.handle,
      visibility: opts.visibility,
      createdAt: opts.createdAt,
    },
    meshes: fedMeshes,
    vaults: fedVaults,
    lastSyncedAt: opts.nowIso,
  };
}

// Struct-level "substantive change" compare for the DERIVED manifest. Two docs
// are equal-modulo-stamp iff their federation block + meshes + vaults deep-equal
// (lastSyncedAt is intentionally omitted — it is the canonical drift field).
// Records are deterministically ordered by the writer; the parser preserves that
// order, so JSON.stringify is a stable structural comparison. (Mirrors the
// rebuild.ts helper but now spans @FED_VAULT too — the single source of the
// change-rule so callers don't each reinvent it.)
export function podManifestDocsEqualIgnoringStamp(a: FederationDoc, b: FederationDoc): boolean {
  const norm = (d: FederationDoc): string => {
    const meshes = [...d.meshes].sort(byMeshKey);
    const vaults = [...d.vaults].sort(byVaultKey);
    return JSON.stringify({ federation: d.federation, meshes, vaults });
  };
  return norm(a) === norm(b);
}

function byMeshKey(a: FedMeshRecord, b: FedMeshRecord): number {
  return a.meshName < b.meshName
    ? -1
    : a.meshName > b.meshName
      ? 1
      : a.meshRidHex < b.meshRidHex
        ? -1
        : a.meshRidHex > b.meshRidHex
          ? 1
          : 0;
}

function byVaultKey(a: FedVaultRecord, b: FedVaultRecord): number {
  return a.vaultName < b.vaultName
    ? -1
    : a.vaultName > b.vaultName
      ? 1
      : a.vaultRidHex < b.vaultRidHex
        ? -1
        : a.vaultRidHex > b.vaultRidHex
          ? 1
          : 0;
}

export interface RegeneratePodManifestOptions {
  handle: string;
  // Deterministic stamp seam — tests pin this; production defaults to now.
  nowIso?: string;
}

export interface RegeneratePodManifestResult {
  // skipped=true when the pod is not yet initialised (no federation_state row).
  // The lifecycle hooks call this on EVERY mutation, including before a pod has
  // been forged (e.g. `lyt vault init` with federation self-heal disabled); a
  // missing pod is a no-op, never an error.
  skipped: boolean;
  reason?: string;
  podYonPath: string;
  changed: boolean;
  meshCount: number;
  vaultCount: number;
  // True when a stale legacy `federation.yon` sibling was removed (
  // clean-slate: pod.yon is the single manifest; the old name is not orphaned).
  legacyRemoved: boolean;
}

// Lifecycle-facing regen. Requires the caller's already-open registry (open-once
// seam per Brief A A.4 / a review finding — init/adopt/forget all hold a db; opening a 2nd
// connection risks Windows SQLITE_BUSY). Preserves visibility + createdAt from
// the prior pod.yon when present; defaults them on first write. Best-effort
// removes a legacy `federation.yon` so exactly one manifest exists on disk.
export async function regeneratePodManifestFlow(
  db: Client,
  opts: RegeneratePodManifestOptions,
): Promise<RegeneratePodManifestResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const podYonPath = getFederationYonPath(opts.handle);

  const state = await readFederationState(db, opts.handle);
  if (state === null) {
    return {
      skipped: true,
      reason: "no-federation-state",
      podYonPath,
      changed: false,
      meshCount: 0,
      vaultCount: 0,
      legacyRemoved: false,
    };
  }

  // Preserve federation-level fields not derivable from the registry, plus
  // per-vault visibility (Brief B same not-derivable-from-registry
  // category as federation visibility/createdAt).
  let visibility: FederationVisibility = "private";
  let createdAt = nowIso;
  let existingDoc: FederationDoc | null = null;
  let priorVaultVisibility: ReadonlyMap<string, FederationVisibility> | undefined;
  if (existsSync(podYonPath)) {
    try {
      existingDoc = parseFederationYon(readFileSync(podYonPath, "utf8"));
      visibility = existingDoc.federation.visibility;
      if (existingDoc.federation.createdAt.length > 0) {
        createdAt = existingDoc.federation.createdAt;
      }
      priorVaultVisibility = new Map(existingDoc.vaults.map((v) => [v.vaultRidHex, v.visibility]));
    } catch {
      // Unparseable prior manifest — regen heals it from the registry using the
      // flow defaults (private / now). The registry is the SoT.
    }
  }

  const doc = await derivePodManifestDoc(db, {
    handle: opts.handle,
    visibility,
    createdAt,
    nowIso,
    priorVaultVisibility,
  });

  const changed = existingDoc === null || !podManifestDocsEqualIgnoringStamp(existingDoc, doc);

  mkdirSync(dirname(podYonPath), { recursive: true });
  writeFileSync(podYonPath, renderFederationYon(doc), "utf8");

  // (clean-slate, dev mode): remove any legacy `federation.yon` sibling so
  // pod.yon is the single on-disk manifest. No migration — pod.yon is fully
  // derived from the registry, so the legacy file holds no unique truth.
  let legacyRemoved = false;
  const legacyPath = join(getFederationRoot(), "federation.yon");
  if (legacyPath !== podYonPath && existsSync(legacyPath)) {
    try {
      rmSync(legacyPath, { force: true });
      legacyRemoved = true;
    } catch {
      // best-effort — a leftover federation.yon is cosmetic, never fatal.
    }
  }

  return {
    skipped: false,
    podYonPath,
    changed,
    meshCount: doc.meshes.length,
    vaultCount: doc.vaults.length,
    legacyRemoved,
  };
}

// Lifecycle convenience: resolve the handle (hint → registry federation_state),
// regen, and SWALLOW every failure. The init / adopt / forget / mesh-init hooks
// call this AFTER their registry mutations land so `pod.yon` reflects the new
// state. A missing pod (no federation_state → skipped) or a parse/IO error must
// NEVER fail the host flow — same never-fail posture as the federation self-heal
// + Lane M reconcile hooks. Requires the caller's open registry (open-once seam).
//
// Handle resolution is REGISTRY-DRIVEN, not identity-driven: when no hint is
// given, the handle comes from `federation_state` (the SoT). This (a) avoids a
// `getHandleFromIdentity()` → potential `gh api` network call on EVERY vault
// mutation, and (b) makes the no-pod case a single cheap query that short-
// circuits before any IO — a vault-init with no pod resolves zero rows and
// returns immediately.
export async function regeneratePodManifestNonFatal(
  db: Client,
  opts: { handle?: string | undefined; nowIso?: string | undefined } = {},
): Promise<void> {
  try {
    let handle = opts.handle;
    if (handle === undefined || handle.length === 0) {
      const states = await listFederationStates(db);
      // 0 rows → no pod forged yet (skip). >1 → ambiguous multi-handle (deferred
      // per federation-paths single-pod assumption); skip rather than guess.
      if (states.length !== 1) return;
      handle = states[0]!.handle;
    }
    if (handle.length === 0) return;
    await regeneratePodManifestFlow(db, {
      handle,
      ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`pod manifest regen skipped non-fatally — ${msg}`);
  }
}
