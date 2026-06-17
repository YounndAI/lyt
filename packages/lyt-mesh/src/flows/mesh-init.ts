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

import { readFileSync } from "node:fs";

import {
  addEdgeFlow,
  applyGhPrefix,
  closeRegistry,
  getVaultByName,
  initVaultFlow,
  listVaults,
  openRegistry,
  parseMeshManifest,
  regenContextFlow,
  ridsEqual,
  uuid7BytesToHex,
  type ParsedManifest,
} from "@younndai/lyt-vault";

import {
  validateMeshInit,
  type ValidateIssue,
  type ValidateOutcome,
} from "./mesh-init-validate.js";

export interface MeshInitOptions {
  manifestPath: string;
  dryRun?: boolean | undefined;
  only?: string | undefined;
  noPush?: boolean | undefined;
  overrides?: readonly string[] | undefined;
  // Smoke that takes a gh-org and returns true if reachable.
  // Passed through to the validator (only invoked when ghOrg is declared and not noPush).
  ghOrgSmoke?: ((org: string) => Promise<boolean>) | undefined;
  // For tests: skip actual gh repo create even when noPush is false.
  // Returns the cloneUrl that would result.
  ghRepoCreate?: ((org: string | null, repoName: string) => Promise<string>) | undefined;
}

export interface MeshInitVaultResult {
  vaultName: string;
  ghRepoName: string;
  initialized: boolean;
  registered: boolean;
  pushed: boolean;
  pushUrl: string | null;
}

export interface MeshInitEdgeResult {
  source: string;
  target: string;
  kind: "parent" | "share_with";
  applied: boolean;
}

export interface MeshInitOutcome {
  dryRun: boolean;
  manifest: ParsedManifest;
  topoOrder: string[];
  validation: ValidateOutcome;
  vaults: MeshInitVaultResult[];
  edges: MeshInitEdgeResult[];
  regenedContexts: string[];
}

export interface MeshInitResult {
  ok: true;
  outcome: MeshInitOutcome;
}

export interface MeshInitBlocked {
  ok: false;
  reason: "validation-failed";
  issues: ValidateIssue[];
}

// Execute a manifest-driven mesh stand-up. Order of operations:
// 1. Parse the manifest from disk.
// 2. Apply overrides (in memory).
// 3. Validate (fail-fast on errors; warns proceed).
// 4. Resolve --only subset.
// 5. Init vaults in topological order (parents before children).
// 6. Create GH repos per vault (unless --no-push).
// 7. Add parent + share_with edges (suppressing per-edge regen).
// 8. After ALL mutations, regen .lyt/mesh-context.md once per affected vault.
export async function meshInitFlow(
  opts: MeshInitOptions,
): Promise<MeshInitResult | MeshInitBlocked> {
  const raw = readFileSync(opts.manifestPath, "utf8");
  const manifest = applyOverrides(parseMeshManifest(raw), opts.overrides ?? []);

  const onlyNames = opts.only ? matchOnly(manifest, opts.only) : undefined;

  const validation = await validateMeshInit({
    manifest,
    onlyNames,
    ghOrgSmoke: opts.noPush === true ? undefined : opts.ghOrgSmoke,
  });

  if (!validation.ok) {
    return { ok: false, reason: "validation-failed", issues: validation.issues };
  }

  const targets = onlyNames ? new Set(onlyNames) : new Set(manifest.vaults.map((v) => v.name));
  const inScope = manifest.vaults.filter((v) => targets.has(v.name));
  const ghPrefix = manifest.mesh?.ghPrefix ?? null;
  const ghOrg = manifest.mesh?.ghOrg ?? null;

  const vaultResults: MeshInitVaultResult[] = [];
  const edgeResults: MeshInitEdgeResult[] = [];
  const affectedVaultNames = new Set<string>();

  // Walk in topological order so parents are registered before children that
  // reference them via --parent.
  const ordered = validation.topoOrder.filter((n) => targets.has(n));

  for (const vaultName of ordered) {
    const v = inScope.find((x) => x.name === vaultName)!;
    const ghRepoName = applyGhPrefix(vaultName, ghPrefix);

    if (opts.dryRun === true) {
      vaultResults.push({
        vaultName,
        ghRepoName,
        initialized: false,
        registered: false,
        pushed: false,
        pushUrl: null,
      });
      continue;
    }

    // Note: do NOT pass `parent` to initVaultFlow. initVault writes parent_vault directly
    // into vault.yon as a string, which would collide with the rid-based parent edge we
    // add later via addEdgeFlow. The parent relationship is added via the edge pass below
    // so registry + vault.yon agree on the rid.
    await initVaultFlow({
      name: vaultName,
      ...(v.desc !== null ? { desc: v.desc } : {}),
      ...(v.tier !== null ? { tierHint: v.tier } : {}),
      gitInit: true,
    });

    let pushed = false;
    let pushUrl: string | null = null;
    if (opts.noPush !== true && opts.ghRepoCreate) {
      pushUrl = await opts.ghRepoCreate(ghOrg, ghRepoName);
      pushed = true;
    }

    vaultResults.push({
      vaultName,
      ghRepoName,
      initialized: true,
      registered: true,
      pushed,
      pushUrl,
    });
    affectedVaultNames.add(vaultName);
  }

  if (opts.dryRun === true) {
    for (const v of inScope) {
      if (v.parent && v.parent.length > 0) {
        edgeResults.push({
          source: v.name,
          target: v.parent,
          kind: "parent",
          applied: false,
        });
      }
    }
    for (const sw of manifest.shareWith) {
      edgeResults.push({ source: sw.a, target: sw.b, kind: "share_with", applied: false });
      edgeResults.push({ source: sw.b, target: sw.a, kind: "share_with", applied: false });
    }
    return {
      ok: true,
      outcome: {
        dryRun: true,
        manifest,
        topoOrder: validation.topoOrder,
        validation,
        vaults: vaultResults,
        edges: edgeResults,
        regenedContexts: [],
      },
    };
  }

  // Add parent edges (each child has at most one parent — already in vault.yon from init,
  // but we want the registry edge row too).
  for (const v of inScope) {
    if (!v.parent || v.parent.length === 0) continue;
    const parentRid = await resolveRidByName(v.parent);
    if (!parentRid) continue; // parent not in registry yet (validator should've caught)
    const res = await addEdgeFlow({
      vaultName: v.name,
      peerRid: uuid7BytesToHex(parentRid),
      edge: "parent",
      skipRegenContext: true,
    });
    edgeResults.push({
      source: v.name,
      target: v.parent,
      kind: "parent",
      applied: !res.yonAlreadyHadEdge,
    });
    affectedVaultNames.add(v.name);
  }

  // Add share_with edges bidirectionally (only when both peers exist in registry).
  for (const sw of manifest.shareWith) {
    const aRid = await resolveRidByName(sw.a);
    const bRid = await resolveRidByName(sw.b);
    if (aRid && bRid) {
      const r1 = await addEdgeFlow({
        vaultName: sw.a,
        peerRid: uuid7BytesToHex(bRid),
        edge: "share_with",
        skipRegenContext: true,
      });
      edgeResults.push({
        source: sw.a,
        target: sw.b,
        kind: "share_with",
        applied: !r1.yonAlreadyHadEdge,
      });
      affectedVaultNames.add(sw.a);
      const r2 = await addEdgeFlow({
        vaultName: sw.b,
        peerRid: uuid7BytesToHex(aRid),
        edge: "share_with",
        skipRegenContext: true,
      });
      edgeResults.push({
        source: sw.b,
        target: sw.a,
        kind: "share_with",
        applied: !r2.yonAlreadyHadEdge,
      });
      affectedVaultNames.add(sw.b);
    } else {
      edgeResults.push({ source: sw.a, target: sw.b, kind: "share_with", applied: false });
    }
  }

  // Batched mesh-context regen — ONCE per affected vault, at the end.
  const regenedContexts: string[] = [];
  for (const name of affectedVaultNames) {
    try {
      const r = await regenContextFlow(name);
      regenedContexts.push(r.meshContextPath);
    } catch {
      // Best-effort; surface failure in validation later if needed.
    }
  }

  return {
    ok: true,
    outcome: {
      dryRun: false,
      manifest,
      topoOrder: validation.topoOrder,
      validation,
      vaults: vaultResults,
      edges: edgeResults,
      regenedContexts,
    },
  };
}

async function resolveRidByName(name: string): Promise<Uint8Array | null> {
  const db = await openRegistry();
  try {
    const row = await getVaultByName(db, name);
    return row?.rid ?? null;
  } finally {
    await closeRegistry(db);
  }
}

// Apply --override "<vault>.<field>=<value>" entries. Mutates the manifest in-memory.
function applyOverrides(manifest: ParsedManifest, overrides: readonly string[]): ParsedManifest {
  if (overrides.length === 0) return manifest;
  for (const o of overrides) {
    const m = o.match(/^([^.]+)\.([^=]+)=(.*)$/);
    if (!m) {
      throw new Error(`--override must be of the form '<vault>.<field>=<value>' — got '${o}'.`);
    }
    const [, vaultName, field, value] = m;
    const vault = manifest.vaults.find((v) => v.name === vaultName);
    if (!vault) {
      throw new Error(`--override targets vault '${vaultName}' which is not in the manifest.`);
    }
    switch (field) {
      case "desc":
        vault.desc = value!;
        break;
      case "tier":
        vault.tier = value!;
        break;
      case "parent":
        vault.parent = value!;
        break;
      case "seed":
        vault.seed = value!;
        break;
      default:
        throw new Error(
          `--override unknown field '${field}'. Supported: desc, tier, parent, seed.`,
        );
    }
  }
  return manifest;
}

// Expand --only <glob> to the set of matching vault names from the manifest.
function matchOnly(manifest: ParsedManifest, glob: string): string[] {
  const re = globToRegex(glob);
  return manifest.vaults.map((v) => v.name).filter((n) => re.test(n));
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

// Helper for traverse mesh graph from a root vault via parent_vault FK,
// depth-bounded, returning the set of vault names encountered (including the
// root). v1.A.1b: share_with semantic collapsed to mesh subscriptions (v1.C.1);
// only parent_vault FK is walked here. The mesh-aware traversal lands in v1.B.1.
export async function traverseMeshFromRoot(rootName: string, depth: number): Promise<string[]> {
  const db = await openRegistry();
  try {
    const all = await listVaults(db);
    const byName = new Map(all.map((v) => [v.name, v]));
    const byRidHex = new Map(all.map((v) => [v.ridHex, v]));
    const root = byName.get(rootName);
    if (!root) {
      throw new Error(`No vault named '${rootName}' in the registry.`);
    }
    const visited = new Set<string>([root.name]);
    const queue: { name: string; remaining: number }[] = [{ name: root.name, remaining: depth }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.remaining <= 0) continue;
      const v = byName.get(cur.name);
      if (!v) continue;
      // Children: any vault whose parent_vault FK points at v.rid (bytes-equal).
      for (const candidate of all) {
        if (
          candidate.parentVault &&
          ridsEqual(candidate.parentVault, v.rid) &&
          !visited.has(candidate.name)
        ) {
          visited.add(candidate.name);
          queue.push({ name: candidate.name, remaining: cur.remaining - 1 });
        }
      }
      // Parent (upward traversal too).
      if (v.parentVaultHex) {
        const parent = byRidHex.get(v.parentVaultHex);
        if (parent && !visited.has(parent.name)) {
          visited.add(parent.name);
          queue.push({ name: parent.name, remaining: cur.remaining - 1 });
        }
      }
    }
    return [...visited];
  } finally {
    await closeRegistry(db);
  }
}
