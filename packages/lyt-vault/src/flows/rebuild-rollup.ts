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

// v1.E.2 — `lyt vault rebuild-rollup` flow.
//
// Implements the transitive rollup model per master-plan §v1.E.2:892-908
// + federation-design §8.6: each vault's rollup includes its descendants'
// rollups recursively. A grandparent's rollup therefore contains the union
// of its own keywords + every descendant's keywords down to the leaves.
// Soft-tombstones: when a descendant goes disconnected (no longer in the
// walk), its rollup rows are NOT deleted — they keep their old `last_seen`
// and age past ROLLUP_DISCONNECTED_DAYS, surfacing via
// `lyt vault list --include-tombstones`.
//
// Walk semantics:
// - "Children of vault X" = rows in `mesh_edges` where `ref_vault_rid = X`
// (the ref side records the edge; ref=parent, home=child per
// add-mesh-edge.ts:30-32 + federation-design §8).
// - Visited-set on vault rid HEX prevents cycles; an offending cycle
// refuses to re-enter the visited vault and surfaces a warning in the
// result.
//
// Source-path encoding: each rollup row records the chain of vault
// rids from the descendant up to the target ancestor:
// target vault A self-contribution: "vault:<A-hex>"
// direct child B: "vault:<B-hex>>vault:<A-hex>"
// grandchild C via B: "vault:<C-hex>>vault:<B-hex>>vault:<A-hex>"
// `>` reads as "rolls up into" + doesn't collide with the rid format.
//
// Open-once seam (v1.A.5 CR-B1): optional `registryDb?: Client`; when
// supplied the caller owns lifecycle; when omitted the flow opens +
// closes its own.

import { existsSync } from "node:fs";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import {
  getVaultByName,
  getVaultByRid,
  listMeshEdgesByRefVault,
  type VaultRow,
} from "../registry/repo.js";
import { closeVaultDb, getLytDbPath, openLytDbActionable } from "../registry/vault-db.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { upsertRollup } from "../registry/rollup-repo.js";
import { uuid7BytesToHex } from "../util/uuid7.js";

// v1.E.2 — disconnected detection threshold. Single source-of-truth for
// the "soft-tombstone" rule per master-plan §v1.E.2:902 + coupled-
// constant directive (2026-06-01). Consumers (rebuild-rollup default,
// list flag) import this constant rather than hard-coding 30.
//
// SEE ALSO: flows/list.ts (--include-tombstones threshold default).
// If you change this value, grep for ROLLUP_DISCONNECTED_DAYS + the
// raw `30 days` literal globally; update every site.
export const ROLLUP_DISCONNECTED_DAYS = 30;

export interface RebuildRollupArgs {
  // Registered vault name. Mutually exclusive with vaultRidOverride
  // (test seam). One or the other is required.
  vault?: string;
  // Test / mesh-wrapper seam — bypass registry lookup and operate on
  // the given vault rid directly. Used by rebuildMeshRollupFlow to
  // avoid resolving the same vault through the registry twice.
  vaultRidOverride?: Uint8Array;
  // Disconnected-detection threshold in days. Default
  // ROLLUP_DISCONNECTED_DAYS. Currently informational on the rebuild
  // side (rebuild UPSERTs all current rows; aging happens at list time);
  // surfaced in result for caller telemetry.
  thresholdDays?: number;
  // Open-once seam (v1.A.5 CR-B1).
  registryDb?: Client;
  // Deterministic timestamp override for `last_seen`. When omitted,
  // defaults to `new Date().toISOString()` at flow entry.
  nowIso?: string;
}

export interface RebuildRollupResult {
  vaultName: string;
  vaultRidHex: string;
  vaultPath: string;
  rollupRowsWritten: number;
  descendantsVisited: number;
  descendantsSkipped: number;
  cycleDetected: boolean;
  cycleWarnings: string[];
  thresholdDays: number;
  nowIso: string;
  durationMs: number;
}

interface WalkNode {
  vaultRid: Uint8Array;
  vaultRidHex: string;
  vaultPath: string;
  vaultName: string;
  sourcePathPrefix: string; // chain from this node up to (but not including) target
}

export async function rebuildRollupFlow(args: RebuildRollupArgs): Promise<RebuildRollupResult> {
  const startedAt = Date.now();
  const thresholdDays = args.thresholdDays ?? ROLLUP_DISCONNECTED_DAYS;
  const nowIso = args.nowIso ?? new Date().toISOString();

  const callerSupplied = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());

  try {
    // 1. Resolve target vault.
    const target = await resolveTargetVault(registryDb, args);
    // hardening pass (fix-pass): the rollup UPSERTs into the target's lyt.db —
    // F13 chokepoint on the write destination.
    await enforceNotFrozen(target.path, target.name);

    // 2. Walk descendants (BFS); collect (descendant, source_path) pairs.
    // Include the target itself as the depth-0 node so its own
    // keywords roll up into its own rollup (per brief test scenario
    // (a): "intra-vault rollup — single hop").
    const visited = new Set<string>();
    const cycleWarnings: string[] = [];
    const walkOrder: WalkNode[] = [];
    let cycleDetected = false;

    const targetSelf: WalkNode = {
      vaultRid: target.rid,
      vaultRidHex: target.ridHex,
      vaultPath: target.path,
      vaultName: target.name,
      sourcePathPrefix: "",
    };

    const queue: WalkNode[] = [targetSelf];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node.vaultRidHex)) {
        cycleDetected = true;
        cycleWarnings.push(
          `cycle: vault ${node.vaultRidHex} (${node.vaultName}) already visited; refusing to re-enter`,
        );
        continue;
      }
      visited.add(node.vaultRidHex);
      walkOrder.push(node);

      // Enumerate direct children: rows where ref_vault_rid = this node
      // (per add-mesh-edge.ts directionality — ref=parent, home=child).
      const edges = await listMeshEdgesByRefVault(registryDb, node.vaultRid);
      for (const e of edges) {
        if (visited.has(e.homeVaultRidHex)) {
          cycleDetected = true;
          cycleWarnings.push(
            `cycle: child ${e.homeVaultRidHex} of ${node.vaultRidHex} already in visited set; skipping`,
          );
          continue;
        }
        const childVault = await getVaultByRid(registryDb, e.homeVaultRid);
        if (childVault === null) continue; // dangling edge; mesh-validate owns it
        if (childVault.status === "tombstoned") continue; // hard-tombstoned vault contributes nothing
        queue.push({
          vaultRid: childVault.rid,
          vaultRidHex: childVault.ridHex,
          vaultPath: childVault.path,
          vaultName: childVault.name,
          sourcePathPrefix:
            node.sourcePathPrefix === ""
              ? `vault:${node.vaultRidHex}`
              : `vault:${node.vaultRidHex}>${node.sourcePathPrefix}`,
        });
      }
    }

    // 3. Open the target's lyt.db (UPSERT destination) ONCE. Per-
    // descendant lyt.db handles open + close inside the read loop
    // so we don't hold N file handles for long-walk vaults.
    // corrupt lyt.db → CorruptLytDbError naming `lyt reindex`.
    const targetDb = await openLytDbActionable(target.path, target.name);
    let rollupRowsWritten = 0;
    let descendantsVisited = 0;
    let descendantsSkipped = 0;

    try {
      for (const node of walkOrder) {
        descendantsVisited += 1;
        // source_path for this node's contribution to target's rollup:
        // chain runs leaf→root, e.g. for grandchild C via child B into
        // target A: "vault:<C-hex>>vault:<B-hex>>vault:<A-hex>".
        // For target-self (depth 0, prefix=""): just "vault:<A-hex>".
        const sourcePath =
          node.sourcePathPrefix === ""
            ? `vault:${node.vaultRidHex}`
            : `vault:${node.vaultRidHex}>${node.sourcePathPrefix}`;

        // Read this descendant's keywords from its lanes_cache. Skip
        // gracefully when the per-vault lyt.db doesn't exist yet (vault
        // initialised but rebuild-lanes never run) — its contribution
        // simply doesn't surface this round.
        const keywords = await readVaultKeywords(node.vaultPath, node.vaultName);
        if (keywords === null) {
          descendantsSkipped += 1;
          continue;
        }

        // Deterministic emit (Lock 0.3 ): sort keywords ASC before
        // INSERT so the per-rebuild row order is byte-stable across
        // invocations on the same input.
        const sortedKeywords = [...keywords].sort();
        for (const kw of sortedKeywords) {
          await upsertRollup(targetDb, {
            targetVaultRid: target.ridHex,
            keyword: kw,
            weight: 1.0,
            lastSeen: nowIso,
            sourcePath,
          });
          rollupRowsWritten += 1;
        }
      }
    } finally {
      await closeVaultDb(targetDb);
    }

    return {
      vaultName: target.name,
      vaultRidHex: target.ridHex,
      vaultPath: target.path,
      rollupRowsWritten,
      descendantsVisited,
      descendantsSkipped,
      cycleDetected,
      cycleWarnings,
      thresholdDays,
      nowIso,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(registryDb);
  }
}

async function resolveTargetVault(db: Client, args: RebuildRollupArgs): Promise<VaultRow> {
  if (args.vaultRidOverride !== undefined) {
    const v = await getVaultByRid(db, args.vaultRidOverride);
    if (v === null) {
      throw new Error(
        `rebuild-rollup: no vault registered for rid ${uuid7BytesToHex(args.vaultRidOverride)}.`,
      );
    }
    if (v.status === "tombstoned") {
      throw new Error(`rebuild-rollup: vault '${v.name}' is tombstoned; cannot rebuild rollup.`);
    }
    return v;
  }
  if (args.vault === undefined) {
    throw new Error("rebuild-rollup: either --vault <name> or vaultRidOverride is required.");
  }
  const v = await getVaultByName(db, args.vault);
  if (v === null) {
    throw new Error(`rebuild-rollup: no vault registered with name '${args.vault}'.`);
  }
  if (v.status === "tombstoned") {
    throw new Error(`rebuild-rollup: vault '${args.vault}' is tombstoned; cannot rebuild rollup.`);
  }
  return v;
}

// Read keyword set from a vault's `lanes` cache. Returns null when the
// per-vault lyt.db doesn't exist (vault has never run rebuild-lanes);
// the caller logs the skip and moves on. Returns [] when lanes is
// present but empty (vault has notes but no tags meeting threshold).
async function readVaultKeywords(vaultPath: string, vaultName: string): Promise<string[] | null> {
  const lytDbPath = getLytDbPath(vaultPath);
  if (!existsSync(lytDbPath)) return null;
  // corrupt descendant lyt.db → CorruptLytDbError (remedy names the
  // VAULT, not the path — the `--vault` remedy flag takes a name).
  const db = await openLytDbActionable(vaultPath, vaultName);
  try {
    const r = await db.execute("SELECT name FROM lanes ORDER BY name ASC");
    return r.rows.map((row) => String(row["name"]));
  } finally {
    await closeVaultDb(db);
  }
}
