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

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { listVaults, setVaultGitUrl, type VaultRow } from "../registry/repo.js";
import { listMeshes } from "../registry/meshes-repo.js";
import { computeDisplayNameSync } from "../registry/vault-addressing.js";
import { closeVaultDb, getLytDbPath, openLytDb } from "../registry/vault-db.js";
import { readGitRemoteOriginUrl } from "../util/git.js";
import {
  countTombstonedRollupForTarget,
  latestTombstoneSeenForTarget,
} from "../registry/rollup-repo.js";
import { ROLLUP_DISCONNECTED_DAYS } from "./rebuild-rollup.js";

export interface RollupTombstoneAggregate {
  count: number;
  latestSeen: string | null;
}

export interface ListFlowOptions {
  noTombstones?: boolean;
  // v1.E.2 — when true, populate `rollupTombstones` with a per-vault
  // aggregate of rollup rows whose `last_seen` is older than
  // `rollupThresholdDays` (default ROLLUP_DISCONNECTED_DAYS). Separate
  // concept from `noTombstones` above, which filters vault.status =
  // 'tombstoned' (hard-tombstoned vaults). The naming overlap is
  // unfortunate but per master-plan §v1.E.2:902.
  includeRollupTombstones?: boolean;
  rollupThresholdDays?: number;
  // Deterministic now-iso seam for tests. When omitted, derived from
  // `new Date()` at flow entry.
  nowIso?: string;
}

export interface ListFlowResult {
  vaults: VaultRow[];
  // 0.9.4 (3a) — the COMPUTED `{mesh}/{vault}` display name per vault, keyed by
  // ridHex. Derived from each vault's live `home_mesh_rid` + leaf, so a `move`
  // is reflected here even though the stored `name` prefix may lag. The human
  // table renders these; the raw `vaults[].name` is the storage value.
  displayNames: Record<string, string>;
  // Populated only when options.includeRollupTombstones === true. Keyed
  // by vault ridHex. A vault whose lyt.db is missing or whose rollup
  // table has no stale rows surfaces with count=0, latestSeen=null.
  rollupTombstones?: Record<string, RollupTombstoneAggregate>;
  rollupThresholdDays?: number;
  rollupThresholdIso?: string;
}

export async function listVaultsFlow(opts: ListFlowOptions = {}): Promise<ListFlowResult> {
  const db = await openRegistry();
  try {
    const all = await listVaults(db);
    const vaults = opts.noTombstones ? all.filter((v) => v.status !== "tombstoned") : all;

    // hardening pass (Cohort-1 fix-pass) — reconcile a null registry `gitUrl` from the
    // vault's live git `origin` at THIS shared chokepoint, so `vault list` and
    // `vault info` AGREE. A self-init'd home vault carries git_url=null in the
    // registry until a remote is wired; `vault info` self-heals it lazily (via
    // deriveVaultWritable, writability.ts), but `vault list` runs BEFORE any
    // writable-derive and previously emitted the raw null — so `/lyt-pod`
    // mislabelled a published vault "0 pushable / no push target". Read live
    // origin + persist it back (the SAME self-heal writability does;
    // reconcile = correctness floor). Best-effort: a write failure must not
    // change the surfaced value (we already hold the live URL).
    await reconcileNullGitUrls(db, vaults);

    // 0.9.4 (3a) — compute the canonical `{mesh}/{vault}` display name from
    // each vault's live home_mesh_rid + leaf (one mesh-list query, reused).
    const meshes = await listMeshes(db);
    const meshNameByRidHex = new Map(meshes.map((m) => [m.ridHex, m.name] as const));
    const displayNames: Record<string, string> = {};
    for (const v of vaults) {
      displayNames[v.ridHex] = computeDisplayNameSync(v, meshNameByRidHex);
    }

    if (opts.includeRollupTombstones !== true) {
      return { vaults, displayNames };
    }

    const thresholdDays = opts.rollupThresholdDays ?? ROLLUP_DISCONNECTED_DAYS;
    const now = opts.nowIso !== undefined ? new Date(opts.nowIso) : new Date();
    const thresholdIso = new Date(now.getTime() - thresholdDays * 86_400_000).toISOString();

    const aggregates: Record<string, RollupTombstoneAggregate> = {};
    for (const v of vaults) {
      aggregates[v.ridHex] = await readVaultRollupTombstones(v, thresholdIso);
    }
    return {
      vaults,
      displayNames,
      rollupTombstones: aggregates,
      rollupThresholdDays: thresholdDays,
      rollupThresholdIso: thresholdIso,
    };
  } finally {
    await closeRegistry(db);
  }
}

// for each listed vault whose registry `gitUrl` is null, read the live
// git `origin` from disk and (a) patch the in-memory row so list output matches
// what `vault info` reports, and (b) persist it back to the registry so the
// self-heal is durable (the SAME reconcile writability.ts does on the info
// path). Mutates the VaultRow objects in place. Best-effort throughout: a
// missing origin leaves the null; a persist failure is swallowed (the surfaced
// value is already correct from the live read).
async function reconcileNullGitUrls(db: Client, vaults: readonly VaultRow[]): Promise<void> {
  for (const v of vaults) {
    if (v.gitUrl !== null) continue;
    if (v.status === "tombstoned" || v.status === "missing") continue;
    if (!existsSync(v.path)) continue;
    const liveRemote = readGitRemoteOriginUrl(v.path);
    if (liveRemote === null) continue;
    v.gitUrl = liveRemote;
    try {
      await setVaultGitUrl(db, v.rid, liveRemote);
    } catch {
      // non-fatal — the in-memory row already carries the correct live value.
    }
  }
}

// Open vault's lyt.db (if it exists), count stale rollup rows + read
// the latest stale last_seen. Returns zero-aggregate when the lyt.db
// doesn't exist (vault scaffolded but rollup never built) or when the
// vault is tombstoned (skip — its rollup is conceptually frozen).
async function readVaultRollupTombstones(
  vault: VaultRow,
  thresholdIso: string,
): Promise<RollupTombstoneAggregate> {
  if (vault.status === "tombstoned") {
    return { count: 0, latestSeen: null };
  }
  const lytDbPath = getLytDbPath(vault.path);
  if (!existsSync(lytDbPath)) {
    return { count: 0, latestSeen: null };
  }
  const db = await openLytDb(vault.path);
  try {
    const count = await countTombstonedRollupForTarget(db, vault.ridHex, thresholdIso);
    const latestSeen =
      count > 0 ? await latestTombstoneSeenForTarget(db, vault.ridHex, thresholdIso) : null;
    return { count, latestSeen };
  } finally {
    await closeVaultDb(db);
  }
}

export function formatHumanTable(
  vaults: readonly VaultRow[],
  rollupTombstones?: Record<string, RollupTombstoneAggregate>,
  displayNames?: Record<string, string>,
): string {
  if (vaults.length === 0) {
    return "(no vaults registered — run 'lyt vault init <name>' to create one)";
  }
  const includeRollup = rollupTombstones !== undefined;
  const headers = includeRollup
    ? ["NAME", "STATUS", "RID", "PATH", "TOMB_ROLLUPS", "LATEST_TS"]
    : ["NAME", "STATUS", "RID", "PATH"];
  const rows = vaults.map((v) => {
    // 0.9.4 (3a) — prefer the COMPUTED `{mesh}/{vault}` name (reflects a move
    // immediately); fall back to the stored name when no map is supplied.
    const shown = displayNames?.[v.ridHex] ?? v.name;
    const base = [
      (v.parentVault === null ? "★ " : "  ") + shown,
      renderStatus(v.status),
      truncate(v.ridHex, 36),
      v.path,
    ];
    if (!includeRollup) return base;
    const agg = rollupTombstones[v.ridHex];
    const countStr = agg === undefined ? "0" : String(agg.count);
    const latestStr = agg === undefined || agg.latestSeen === null ? "—" : agg.latestSeen;
    return [...base, countStr, latestStr];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cols: readonly string[]): string =>
    cols
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join(" ")
      .trimEnd();
  return [line(headers), line(headers.map((h) => "-".repeat(h.length))), ...rows.map(line)].join(
    "\n",
  );
}

function renderStatus(status: VaultRow["status"]): string {
  switch (status) {
    case "active":
      return "active";
    case "disconnected":
      return "disconnected";
    case "missing":
      return "missing";
    case "tombstoned":
      return "[tombstoned]";
    case "access_lost":
      return "[access_lost]";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
