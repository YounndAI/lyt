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

// Lane V Phase 0 (0.5 / CLI gaps C1+C2) — `lyt reindex` flow.
//
// Pod / mesh / vault-wide all-content-tier reindex. Resolves the vaults in
// scope, then runs `rebuildVaultFlow` (lanes → arcs → fts → rollup) for each
// behind one shared registry connection (open-once seam). Fills the gaps Track
// A surfaced: C1 (no pod-reindex) and C2 (no mesh-reindex) — previously the
// only way to refresh every cache was `lyt vault rebuild-{fts,lanes,arcs,
// rollup} --vault X` by hand, per vault.
//
// Mesh resolution mirrors primer-generator.ts (home_mesh_rid match ∪ explicit
// mesh_vaults membership), so `--mesh` covers the same vault set the primer +
// search scope to.

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { listVaultsInMesh } from "../registry/mesh-vaults-repo.js";
import { getVaultByName, listVaults, type VaultRow } from "../registry/repo.js";
import { readFrozenLock } from "../util/freeze-check.js";
import { rebuildVaultFlow, type RebuildVaultResult } from "./rebuild-vault.js";

export type ReindexScope = "all" | "mesh" | "vault";

export interface ReindexArgs {
  scope: ReindexScope;
  // mesh name (scope=mesh) | vault name (scope=vault); ignored for scope=all.
  target?: string;
  threshold?: number;
  registryDb?: Client;
  nowIso?: string;
  // C-1 — interactivity signal threaded to each rebuildVaultFlow's
  // embeddings build gate. The CLI sets this true ONLY on an interactive TTY
  // (not --json), so the build path may prompt + visibly fetch the ~23MB model;
  // default-undefined (non-interactive) → never prompt, never auto-fetch.
  embeddingsInteractive?: boolean;
}

export interface ReindexResult {
  scope: ReindexScope;
  target: string | null;
  vaultsReindexed: number;
  vaults: RebuildVaultResult[];
  // hardening pass follow-through (release review): batch scopes (--all/--mesh)
  // SKIP actively-frozen vaults instead of aborting the whole sweep at the
  // first refusal (rebuildVaultFlow now enforces the freeze chokepoint, and a
  // bare loop-throw would silently strand every vault after the frozen one —
  // while every corrupt-index remedy string funnels users into this verb).
  // Additive; empty when nothing was frozen. scope=vault stays a LOUD refusal
  // (explicit single target — the matrix frozen-cell contract).
  vaultsSkippedFrozen: { name: string; frozenUntil: string | null }[];
  durationMs: number;
}

export async function reindexFlow(args: ReindexArgs): Promise<ReindexResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());
  try {
    const targets = await resolveScopeVaults(registryDb, args.scope, args.target);
    const vaults: RebuildVaultResult[] = [];
    const vaultsSkippedFrozen: { name: string; frozenUntil: string | null }[] = [];
    for (const v of targets) {
      if (args.scope !== "vault") {
        // Skip-with-report mirrors syncFlow's per-vault `skipped-frozen`
        // posture. EXPIRED freezes proceed (rebuildVaultFlow's
        // enforceNotFrozen auto-unfreezes them).
        const fz = readFrozenLock(v.path);
        if (fz.frozen && !fz.expired) {
          vaultsSkippedFrozen.push({ name: v.name, frozenUntil: fz.frozenUntil });
          continue;
        }
      }
      vaults.push(
        await rebuildVaultFlow({
          vault: v.name,
          registryDb,
          ...(args.nowIso !== undefined ? { nowIso: args.nowIso } : {}),
          ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
          ...(args.embeddingsInteractive !== undefined
            ? { embeddingsInteractive: args.embeddingsInteractive }
            : {}),
        }),
      );
    }
    return {
      scope: args.scope,
      target: args.target ?? null,
      vaultsReindexed: vaults.length,
      vaults,
      vaultsSkippedFrozen,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(registryDb);
  }
}

async function resolveScopeVaults(
  registryDb: Client,
  scope: ReindexScope,
  target: string | undefined,
): Promise<VaultRow[]> {
  switch (scope) {
    case "vault": {
      if (target === undefined) {
        throw new Error("reindex: scope=vault requires --vault <name>.");
      }
      const v = await getVaultByName(registryDb, target);
      if (v === null) {
        throw new Error(`reindex: no vault registered with name '${target}'.`);
      }
      if (v.status === "tombstoned") {
        throw new Error(`reindex: vault '${target}' is tombstoned; cannot reindex.`);
      }
      return [v];
    }
    case "all": {
      const all = await listVaults(registryDb);
      return all.filter((v) => v.status !== "tombstoned").sort(byNameAsc);
    }
    case "mesh": {
      if (target === undefined) {
        throw new Error("reindex: scope=mesh requires --mesh <name>.");
      }
      const mesh = await getMeshByName(registryDb, target);
      if (mesh === null) {
        throw new Error(`reindex: no mesh registered with name '${target}'.`);
      }
      const all = await listVaults(registryDb);
      const memberRows = await listVaultsInMesh(registryDb, mesh.rid);
      const memberByHex = new Set(memberRows.map((r) => r.vaultRidHex));
      const byHex = new Map<string, VaultRow>();
      for (const v of all) {
        const isHome = v.homeMeshRid !== null && equalBytes(v.homeMeshRid, mesh.rid);
        if (isHome || memberByHex.has(v.ridHex)) byHex.set(v.ridHex, v);
      }
      return [...byHex.values()].filter((v) => v.status !== "tombstoned").sort(byNameAsc);
    }
  }
}

function byNameAsc(a: VaultRow, b: VaultRow): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
