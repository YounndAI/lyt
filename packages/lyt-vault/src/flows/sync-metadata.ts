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

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, listVaults, type VaultRow } from "../registry/repo.js";
import { ridsEqual } from "../util/uuid7.js";
import { formatRepoDescription, mergeTopics } from "../scaffold/github-defaults.js";
import { regenMeshContextFromYon } from "../scaffold/mesh-context.js";
import { AGENTS_MD_TEMPLATE_VERSION } from "../templates/priming.js";
import { readFrozenLock } from "../util/freeze-check.js";
import { parseOwnerRepoFromUrl, realGhClient, type GhClient } from "../util/gh.js";
import { applyGhPrefix, parseMeshManifest } from "../yon/manifest.js";
import { parseVaultYon } from "../yon/parse.js";
import { regenAgentsMd } from "./agents-md-regen.js";

export type SyncMetadataMode = "dry-run" | "apply";

export interface SyncMetadataScope {
  vault?: string | undefined;
  vaults?: readonly string[] | undefined;
  // D13: traverse mesh from a root vault (depth-bounded; default 5).
  mesh?: string | undefined;
  meshDepth?: number | undefined;
  // D13: parse a YON manifest, extract @VAULT names, sync those.
  fromManifest?: string | undefined;
}

export interface SyncMetadataArgs {
  scope: SyncMetadataScope;
  mode: SyncMetadataMode;
  noConfirm?: boolean | undefined;
  auditLog?: string | undefined;
  isTty?: boolean | undefined;
  ghClient?: GhClient | undefined;
}

export interface SyncMetadataVaultReport {
  vaultName: string;
  vaultPath: string;
  ghOwner: string | null;
  ghRepo: string | null;
  skipped: boolean;
  skipReason: string | null;
  changed: boolean;
  before: { description: string; topics: string[] } | null;
  after: { description: string; topics: string[] } | null;
  meshContextRegenerated: boolean;
  agentsMdBumped: boolean;
}

export interface SyncMetadataResult {
  mode: SyncMetadataMode;
  reports: SyncMetadataVaultReport[];
  appliedCount: number;
  skippedCount: number;
  unchangedCount: number;
}

export async function syncMetadataFlow(args: SyncMetadataArgs): Promise<SyncMetadataResult> {
  const hasExplicitScope =
    !!args.scope.vault ||
    (args.scope.vaults && args.scope.vaults.length > 0) ||
    !!args.scope.mesh ||
    !!args.scope.fromManifest;
  if (!hasExplicitScope) {
    throw new Error(
      "sync-metadata: scope is mandatory. Pass --vault <name>, --vaults <pattern[,pattern]...>, --mesh <root>, or --from-manifest <file>. " +
        "`--all` is intentionally not a flag.",
    );
  }
  if (args.mode === "apply" && args.isTty === false && args.noConfirm !== true) {
    throw new Error(
      "sync-metadata --apply on a non-TTY run requires --no-confirm (so script invocations cannot silently mutate GitHub state).",
    );
  }

  const gh = args.ghClient ?? realGhClient;
  const db = await openRegistry();
  let reports: SyncMetadataVaultReport[] = [];
  try {
    const all = await listVaults(db);
    // Expand --mesh and --from-manifest into a concrete name list before filterByScope.
    const expandedScope = await expandScope(db, all, args.scope);
    const eligible = filterByScope(all, expandedScope);

    for (const vault of eligible) {
      reports.push(await processVault(vault, args, gh));
    }
  } finally {
    await closeRegistry(db);
  }

  const appliedCount = reports.filter(
    (r) => r.changed && !r.skipped && args.mode === "apply",
  ).length;
  const skippedCount = reports.filter((r) => r.skipped).length;
  const unchangedCount = reports.filter((r) => !r.changed && !r.skipped).length;
  return { mode: args.mode, reports, appliedCount, skippedCount, unchangedCount };
}

function filterByScope(all: VaultRow[], scope: SyncMetadataScope): VaultRow[] {
  if (scope.vault) {
    const match = all.find((v) => v.name === scope.vault);
    return match ? [match] : [];
  }
  if (!scope.vaults || scope.vaults.length === 0) return [];
  const patterns = scope.vaults.map(globToRegex);
  return all.filter((v) => v.status === "active" && patterns.some((p) => p.test(v.name)));
}

// D13: expand --mesh and --from-manifest into a comma-list scope before filterByScope runs.
// Both flags resolve down to the same --vaults pathway internally — single processing path.
async function expandScope(
  db: Awaited<ReturnType<typeof openRegistry>>,
  all: VaultRow[],
  scope: SyncMetadataScope,
): Promise<SyncMetadataScope> {
  if (scope.mesh) {
    const root = await getVaultByName(db, scope.mesh);
    if (!root) {
      throw new Error(
        `sync-metadata --mesh: no vault named '${scope.mesh}' in the local registry.`,
      );
    }
    const depth = scope.meshDepth ?? 5;
    const names = await collectMeshNames(db, all, root.ridHex, depth);
    return { ...scope, vaults: names };
  }
  if (scope.fromManifest) {
    const raw = readFileSync(scope.fromManifest, "utf8");
    const manifest = parseMeshManifest(raw);
    const ghPrefix = manifest.mesh?.ghPrefix ?? null;
    // Apply gh-prefix so a manifest with `gh-prefix="cats-"` and `name="master"` resolves
    // to the registered vault `cats-master`.
    const names = manifest.vaults.map((v) => applyGhPrefix(v.name, ghPrefix));
    return { ...scope, vaults: names };
  }
  return scope;
}

async function collectMeshNames(
  _db: Awaited<ReturnType<typeof openRegistry>>,
  all: VaultRow[],
  rootRidHex: string,
  depth: number,
): Promise<string[]> {
  // v1.A.1b: mesh_edges traversal upgraded to the cross-mesh shape; the
  // share_with semantic has migrated to mesh subscriptions (v1.C.1) and the
  // mesh-aware parent traversal lands in v1.B.1. Until then, we fall back to
  // the `vaults.parent_vault` BLOB FK for upward/downward traversal — every
  // edge a single-mesh user can express today is captured by that FK.
  const byRidHex = new Map(all.map((v) => [v.ridHex, v]));
  const visited = new Set<string>([rootRidHex]);
  const queue: { ridHex: string; remaining: number }[] = [{ ridHex: rootRidHex, remaining: depth }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.remaining <= 0) continue;
    // Children: vaults whose parent_vault matches cur (by bytes).
    const curBytes = byRidHex.get(cur.ridHex)?.rid;
    for (const v of all) {
      if (v.parentVault && curBytes && ridsEqual(v.parentVault, curBytes)) {
        if (!visited.has(v.ridHex)) {
          visited.add(v.ridHex);
          queue.push({ ridHex: v.ridHex, remaining: cur.remaining - 1 });
        }
      }
    }
    // Parent (upward).
    const me = byRidHex.get(cur.ridHex);
    if (me?.parentVaultHex && !visited.has(me.parentVaultHex)) {
      visited.add(me.parentVaultHex);
      queue.push({ ridHex: me.parentVaultHex, remaining: cur.remaining - 1 });
    }
  }
  return [...visited]
    .map((hex) => byRidHex.get(hex)?.name)
    .filter((n): n is string => typeof n === "string");
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

async function processVault(
  vault: VaultRow,
  args: SyncMetadataArgs,
  gh: GhClient,
): Promise<SyncMetadataVaultReport> {
  const base: SyncMetadataVaultReport = {
    vaultName: vault.name,
    vaultPath: vault.path,
    ghOwner: null,
    ghRepo: null,
    skipped: false,
    skipReason: null,
    changed: false,
    before: null,
    after: null,
    meshContextRegenerated: false,
    agentsMdBumped: false,
  };

  if (vault.status === "tombstoned") {
    return { ...base, skipped: true, skipReason: "tombstoned" };
  }
  const frozenState = readFrozenLock(vault.path);
  if (frozenState.frozen && !frozenState.expired) {
    return { ...base, skipped: true, skipReason: "frozen" };
  }

  const yonPath = join(vault.path, ".lyt", "vault.yon");
  if (!existsSync(yonPath)) {
    return { ...base, skipped: true, skipReason: "no-vault-yon" };
  }
  const parsed = parseVaultYon(readFileSync(yonPath, "utf8"));

  // Regenerate mesh-context.md unconditionally (in-scope vault).
  let meshContextRegenerated = false;
  try {
    regenMeshContextFromYon(vault.path);
    meshContextRegenerated = true;
  } catch {
    // best-effort
  }

  // Bump / regenerate agents.md. Always regen the installed-patterns section so a
  // pattern link/unlink that happened since the last sync gets picked up. The
  // `agentsMdBumped` flag specifically tracks template-version upgrades (v1 → v2 → v3).
  let agentsMdBumped = false;
  try {
    const r = regenAgentsMd(vault.path, vault.name);
    // Track bump only when the on-disk template was older than current.
    if (
      parsed.agentTemplateVersion === null ||
      parsed.agentTemplateVersion < AGENTS_MD_TEMPLATE_VERSION
    ) {
      agentsMdBumped = r.written;
    }
  } catch {
    // best-effort
  }

  const ghUrl = vault.gitUrl ?? parsed.gitUrl;
  if (!ghUrl) {
    return {
      ...base,
      meshContextRegenerated,
      agentsMdBumped,
      skipped: true,
      skipReason: "no-git-url",
    };
  }
  const ownerRepo = parseOwnerRepoFromUrl(ghUrl);
  if (!ownerRepo) {
    return {
      ...base,
      meshContextRegenerated,
      agentsMdBumped,
      skipped: true,
      skipReason: "unparseable-git-url",
    };
  }

  let beforeInfo;
  try {
    beforeInfo = await gh.getRepo(ownerRepo.owner, ownerRepo.repo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      ghOwner: ownerRepo.owner,
      ghRepo: ownerRepo.repo,
      meshContextRegenerated,
      agentsMdBumped,
      skipped: true,
      skipReason: `gh-api-failure: ${msg}`,
    };
  }
  if (!beforeInfo.isAdmin) {
    return {
      ...base,
      ghOwner: ownerRepo.owner,
      ghRepo: ownerRepo.repo,
      meshContextRegenerated,
      agentsMdBumped,
      skipped: true,
      skipReason: "not-admin",
    };
  }

  const desiredDescription = formatRepoDescription(parsed.desc);
  const desiredTopics = mergeTopics(parsed.topics);

  const changed =
    beforeInfo.description !== desiredDescription || !sameTopics(beforeInfo.topics, desiredTopics);

  const before = { description: beforeInfo.description, topics: beforeInfo.topics };
  const after = { description: desiredDescription, topics: desiredTopics };

  if (changed && args.mode === "apply") {
    try {
      await gh.editRepo(ownerRepo.owner, ownerRepo.repo, desiredDescription, desiredTopics);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        ghOwner: ownerRepo.owner,
        ghRepo: ownerRepo.repo,
        meshContextRegenerated,
        agentsMdBumped,
        skipped: true,
        skipReason: `gh-edit-failure: ${msg}`,
        before,
        after,
      };
    }
    if (args.auditLog) {
      const entry = {
        timestamp: new Date().toISOString(),
        rid: vault.ridHex,
        owner: ownerRepo.owner,
        name: ownerRepo.repo,
        before,
        after,
      };
      appendFileSync(args.auditLog, JSON.stringify(entry) + "\n", "utf8");
    }
  }

  return {
    ...base,
    ghOwner: ownerRepo.owner,
    ghRepo: ownerRepo.repo,
    meshContextRegenerated,
    agentsMdBumped,
    changed,
    before,
    after,
  };
}

function sameTopics(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
