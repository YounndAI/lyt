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
  applyGhPrefix,
  closeRegistry,
  listVaults,
  openRegistry,
  type ManifestShareWith,
  type ManifestVault,
  type ParsedManifest,
} from "@younndai/lyt-vault";

export type ValidateSeverity = "error" | "warn";

export interface ValidateIssue {
  code: string;
  severity: ValidateSeverity;
  message: string;
}

export interface ValidateOutcome {
  ok: boolean;
  issues: ValidateIssue[];
  // Topologically-sorted vault names (parents before children) when ok=true.
  // Vaults with no parent come first; ties broken by manifest order.
  topoOrder: string[];
}

export interface ValidateOptions {
  manifest: ParsedManifest;
  // If provided, skip the registry-collision check using this list (used in tests).
  registryVaultNames?: readonly string[] | undefined;
  // Only validate this subset of vault names (per `--only <glob>` after expansion).
  onlyNames?: readonly string[] | undefined;
  // gh-prefix is applied for the gh-org accessibility check (smoke).
  // If provided, runs `ghOrgSmoke(ghOrg)`; otherwise skips that check.
  ghOrgSmoke?: ((org: string) => Promise<boolean>) | undefined;
}

// Pre-init validator. Surfaces ALL errors at once — no fail-fast on first error —
// per the brief: "If any fail → surface all failures + exit 1; no partial state."
export async function validateMeshInit(opts: ValidateOptions): Promise<ValidateOutcome> {
  const issues: ValidateIssue[] = [];
  const manifest = opts.manifest;

  const allManifestNames = new Set(manifest.vaults.map((v) => v.name));
  const targets = opts.onlyNames ? new Set(opts.onlyNames) : allManifestNames;
  const inScope = manifest.vaults.filter((v) => targets.has(v.name));

  // 1) Uniqueness within the manifest.
  const seen = new Map<string, number>();
  for (const v of manifest.vaults) {
    seen.set(v.name, (seen.get(v.name) ?? 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count > 1) {
      issues.push({
        code: "duplicate-name",
        severity: "error",
        message: `Vault name "${name}" declared ${count} times in the manifest.`,
      });
    }
  }

  // 2) Uniqueness against the local registry.
  const registryNames = await getRegistryNames(opts);
  for (const v of inScope) {
    if (registryNames.has(v.name)) {
      issues.push({
        code: "registry-collision",
        severity: "error",
        message: `Vault "${v.name}" already exists in the local registry. Pick a different name or 'lyt vault forget' the existing one.`,
      });
    }
  }

  // 3) Parent refs resolve (within manifest OR registry).
  for (const v of inScope) {
    if (v.parent === null || v.parent === undefined || v.parent.length === 0) continue;
    const inManifest = allManifestNames.has(v.parent);
    const inRegistry = registryNames.has(v.parent);
    const inSubset = targets.has(v.parent);
    if (!inManifest && !inRegistry) {
      issues.push({
        code: "missing-parent",
        severity: "error",
        message: `Vault "${v.name}" declares parent "${v.parent}" which is not in the manifest or the local registry.`,
      });
    } else if (inManifest && !inSubset && !inRegistry) {
      issues.push({
        code: "parent-not-in-subset",
        severity: "error",
        message: `Vault "${v.name}" requires parent "${v.parent}", which is in the manifest but excluded by --only and not in the local registry.`,
      });
    }
  }

  // 4) DAG check (no cycles in parent graph; only check vaults whose entire chain is in manifest).
  const cycles = detectCycles(manifest.vaults, allManifestNames);
  for (const cycle of cycles) {
    issues.push({
      code: "parent-cycle",
      severity: "error",
      message: `Parent-graph cycle detected: ${cycle.join(" -> ")}.`,
    });
  }

  // 5) share_with peers — warn-not-error if missing (Phase 5.5 lock: idle declaration is OK).
  for (const sw of manifest.shareWith) {
    for (const peer of [sw.a, sw.b]) {
      const inManifest = allManifestNames.has(peer);
      const inRegistry = registryNames.has(peer);
      if (!inManifest && !inRegistry) {
        issues.push({
          code: "share-with-undeclared",
          severity: "warn",
          message: `@SHARE_WITH peer "${peer}" is not in the manifest or local registry — declaration kept as idle.`,
        });
      }
    }
  }

  // 6) gh-org accessibility (smoke) when ghOrgSmoke is provided + a gh-org is declared.
  if (opts.ghOrgSmoke && manifest.mesh?.ghOrg) {
    const ok = await opts.ghOrgSmoke(manifest.mesh.ghOrg).catch(() => false);
    if (!ok) {
      issues.push({
        code: "gh-org-unreachable",
        severity: "error",
        message: `GitHub org "${manifest.mesh.ghOrg}" is not reachable via 'gh repo list <org> --limit 1'. Authenticate or fix the org name.`,
      });
    }
  }

  // Compute topo order for the in-scope set (ignore cycles since they're errors).
  const order = topoSort(inScope);

  const hasError = issues.some((i) => i.severity === "error");
  return { ok: !hasError, issues, topoOrder: order };
}

async function getRegistryNames(opts: ValidateOptions): Promise<Set<string>> {
  if (opts.registryVaultNames) return new Set(opts.registryVaultNames);
  const db = await openRegistry();
  try {
    const rows = await listVaults(db);
    return new Set(rows.map((r) => r.name));
  } finally {
    await closeRegistry(db);
  }
}

// Detect parent-graph cycles. Returns each cycle as the path of names (last name == first).
function detectCycles(
  vaults: readonly ManifestVault[],
  inManifest: ReadonlySet<string>,
): string[][] {
  const byName = new Map<string, ManifestVault>();
  for (const v of vaults) byName.set(v.name, v);

  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();

  for (const start of vaults) {
    const path: string[] = [start.name];
    const seenInPath = new Set<string>([start.name]);
    let cur: ManifestVault | undefined = start;
    while (cur && cur.parent && inManifest.has(cur.parent)) {
      const next = byName.get(cur.parent);
      if (!next) break;
      if (seenInPath.has(next.name)) {
        // Found a cycle. Normalize to start at the smallest name to dedupe.
        const cycleStartIdx = path.indexOf(next.name);
        const cycle = path.slice(cycleStartIdx).concat(next.name);
        const key = cycle.slice(0, -1).sort().join(",");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(cycle);
        }
        break;
      }
      seenInPath.add(next.name);
      path.push(next.name);
      cur = next;
    }
  }
  return cycles;
}

// Topological sort: parents before children. Vaults whose parent is OUT of the input set
// are treated as roots (the registry-resident parent is assumed already initialized).
function topoSort(vaults: readonly ManifestVault[]): string[] {
  const names = new Set(vaults.map((v) => v.name));
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const v of vaults) {
    adj.set(v.name, []);
    indeg.set(v.name, 0);
  }
  for (const v of vaults) {
    if (v.parent && names.has(v.parent)) {
      adj.get(v.parent)!.push(v.name);
      indeg.set(v.name, (indeg.get(v.name) ?? 0) + 1);
    }
  }
  // Stable ordering by manifest order.
  const order: string[] = [];
  const ready = vaults.filter((v) => (indeg.get(v.name) ?? 0) === 0).map((v) => v.name);
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const child of adj.get(next) ?? []) {
      indeg.set(child, (indeg.get(child) ?? 0) - 1);
      if ((indeg.get(child) ?? 0) === 0) ready.push(child);
    }
  }
  // If we couldn't drain (cycle), append the rest in manifest order — the cycle is an error
  // and the executor will see ok=false before running.
  if (order.length < vaults.length) {
    for (const v of vaults) if (!order.includes(v.name)) order.push(v.name);
  }
  return order;
}

// Re-export so tests can convert vault name -> gh repo name in one place.
export { applyGhPrefix };
export type { ManifestShareWith };
