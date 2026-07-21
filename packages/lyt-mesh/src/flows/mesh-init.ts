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
import { relative } from "node:path";

import {
  addEdgeFlow,
  applyGhPrefix,
  closeRegistry,
  getVaultByName,
  initVaultFlow,
  LEDGER_REGISTRY,
  listVaults,
  newUuidv7Bytes,
  openRegistry,
  parseMeshManifest,
  regenContextFlow,
  ridsEqual,
  uuid7BytesToDashedString,
  uuid7BytesToHex,
  vaultRepoName,
  plannedSingleVaultEffectsV1,
  resolveVaultPath,
  CreationMutationJournal,
  asCreationMutationFailure,
  creationLocalMutationCount,
  type CreationMutationEvidence,
  type ParsedManifest,
  type VaultCreationBinding,
} from "@younndai/lyt-vault";
import {
  finalizeInitialCheckpoint,
  recordInitialCheckpointPaths,
  resolveCreationPlanV1,
  type CreationPlanV1,
  type InitialCheckpointContext,
  type LocalCheckpointResult,
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
  // Retained for CLI compatibility. Mesh initialization is local-only regardless
  // of this value; scoped `lyt sync` is the sole remote mutation owner.
  noPush?: boolean | undefined;
  overrides?: readonly string[] | undefined;
  /** One aggregate creation attempt; the command supplies its Receipt V1 id. */
  attemptId?: string | undefined;
}

export interface MeshInitPublicationStatus {
  status: "not-published";
  nextAction: string;
}

export interface MeshInitVaultResult {
  vaultName: string;
  ghRepoName: string;
  initialized: boolean;
  registered: boolean;
  pushed: boolean;
  pushUrl: string | null;
  publication: MeshInitPublicationStatus;
  creationPlan: CreationPlanV1;
  checkpoint: LocalCheckpointResult | null;
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
  attemptId: string;
  localMutationCount: number;
  mutations: CreationMutationEvidence;
}

export interface MeshInitResult {
  ok: true;
  outcome: MeshInitOutcome;
}

export interface MeshInitBlocked {
  ok: false;
  reason: "validation-failed" | "creation-planning-failed" | "legacy-creation-gated";
  issues: ValidateIssue[];
  attemptId: string;
}

// Execute a manifest-driven mesh stand-up. Order of operations:
// 1. Parse the manifest from disk.
// 2. Apply overrides (in memory).
// 3. Validate (fail-fast on errors; warns proceed).
// 4. Resolve --only subset.
// 5. Resolve one read-only batch of explicit-local CreationPlanV1 entries.
// 6. Init vaults in topological order with checkpoints deferred.
// 7. Add parent + share_with edges and journal their exact written paths.
// 8. Regen contexts, journal them, then finalize one checkpoint per new vault.
export async function meshInitFlow(
  opts: MeshInitOptions,
): Promise<MeshInitResult | MeshInitBlocked> {
  const attemptId = opts.attemptId ?? uuid7BytesToDashedString(newUuidv7Bytes());
  const raw = readFileSync(opts.manifestPath, "utf8");
  const manifest = applyOverrides(parseMeshManifest(raw), opts.overrides ?? []);

  const onlyNames = opts.only ? matchOnly(manifest, opts.only) : undefined;

  const validation = await validateMeshInit({
    manifest,
    onlyNames,
  });

  if (!validation.ok) {
    return { ok: false, reason: "validation-failed", issues: validation.issues, attemptId };
  }

  // This package's old manifest executor is not wired into the root Lyt CLI
  // and previously fabricated a pod RID plus mesh binding for each vault.
  // That contradicts the Phase B exact-plan contract.  Keep the public
  // surface fail-closed until it is rebuilt on a single real-pod aggregate
  // plan; callers can use the supported `lyt mesh init` / `lyt vault init`
  // operations, each of which now consumes an exact creation plan.
  if (isLegacyManifestCreationGated()) {
    return {
      ok: false,
      reason: "legacy-creation-gated",
      issues: [
        {
          code: "legacy-manifest-creation-gated",
          severity: "error",
          message:
            "Manifest mesh creation is gated until its aggregate plan can bind real pod, mesh, vault, and checkpoint effects. Use `lyt mesh init` and `lyt vault init` for now.",
        },
      ],
      attemptId,
    };
  }

  const targets = onlyNames ? new Set(onlyNames) : new Set(manifest.vaults.map((v) => v.name));
  const inScope = manifest.vaults.filter((v) => targets.has(v.name));
  const ghPrefix = manifest.mesh?.ghPrefix ?? null;

  // Planning is a pure, all-or-nothing batch. Every entry is an explicit local
  // request, so this standalone initializer never probes identity or permission.
  const planned = planLocalCreations(inScope, validation.topoOrder, targets, ghPrefix);
  if (planned.kind === "refusal") {
    return {
      ok: false,
      reason: "creation-planning-failed",
      issues: planned.issues,
      attemptId,
    };
  }
  const plansByName = new Map(planned.entries.map((entry) => [entry.vaultName, entry]));
  const mutationJournal = new CreationMutationJournal(attemptId);

  try {
    const vaultResults: MeshInitVaultResult[] = [];
    const edgeResults: MeshInitEdgeResult[] = [];
    const affectedVaultNames = new Set<string>();
    const checkpointContexts = new Map<
      string,
      { context: InitialCheckpointContext; gitInitialized: boolean }
    >();

    // Walk in topological order so parents are registered before children that
    // reference them via --parent.
    const ordered = validation.topoOrder.filter((n) => targets.has(n));

    for (const vaultName of ordered) {
      const v = inScope.find((x) => x.name === vaultName)!;
      const plannedVault = plansByName.get(vaultName)!;
      const { ghRepoName, creation } = plannedVault;
      const { creationPlan } = creation;

      if (opts.dryRun === true) {
        vaultResults.push({
          vaultName,
          ghRepoName,
          initialized: false,
          registered: false,
          pushed: false,
          pushUrl: null,
          publication: notPublished(vaultName),
          creationPlan,
          checkpoint: null,
        });
        continue;
      }

      // Note: do NOT pass `parent` to initVaultFlow. initVault writes parent_vault directly
      // into vault.yon as a string, which would collide with the rid-based parent edge we
      // add later via addEdgeFlow. The parent relationship is added via the edge pass below
      // so registry + vault.yon agree on the rid.
      const initialized = await initVaultFlow({
        name: vaultName,
        ...(v.desc !== null ? { desc: v.desc } : {}),
        ...(v.tier !== null ? { tierHint: v.tier } : {}),
        gitInit: true,
        checkpointMode: "deferred",
        creation,
      });
      checkpointContexts.set(vaultName, {
        context: initialized.checkpointContext,
        gitInitialized: initialized.gitInitialized,
      });
      const childMutations = initialized.creation?.mutations;
      mutationJournal.record({
        registryRows: childMutations?.registryRows ?? 1,
        topologyBindings: childMutations?.topologyBindings ?? 0,
        localDatabases: 1 + LEDGER_REGISTRY.length,
        destinationPolicyRecords: childMutations?.destinationPolicyRecords ?? 1,
        checkpointPaths: initialized.checkpointContext.paths,
      });

      vaultResults.push({
        vaultName,
        ghRepoName,
        initialized: true,
        registered: true,
        pushed: false,
        pushUrl: null,
        publication: notPublished(vaultName),
        creationPlan,
        checkpoint: initialized.checkpoint,
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
          attemptId,
          localMutationCount: 0,
          mutations: mutationJournal.snapshot(),
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
      if (!res.yonAlreadyHadEdge) {
        recordCheckpointPath(checkpointContexts.get(v.name), res.yonPath);
        mutationJournal.record({ topologyBindings: 1, checkpointPaths: [res.yonPath] });
      }
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
        if (!r1.yonAlreadyHadEdge) {
          recordCheckpointPath(checkpointContexts.get(sw.a), r1.yonPath);
          mutationJournal.record({ topologyBindings: 1, checkpointPaths: [r1.yonPath] });
        }
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
        if (!r2.yonAlreadyHadEdge) {
          recordCheckpointPath(checkpointContexts.get(sw.b), r2.yonPath);
          mutationJournal.record({ topologyBindings: 1, checkpointPaths: [r2.yonPath] });
        }
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
        recordCheckpointPath(checkpointContexts.get(name), r.meshContextPath);
        mutationJournal.record({ checkpointPaths: [r.meshContextPath] });
      } catch {
        // Best-effort; surface failure in validation later if needed.
      }
    }

    for (const vault of vaultResults) {
      const deferred = checkpointContexts.get(vault.vaultName);
      if (deferred === undefined || !deferred.gitInitialized) continue;
      vault.checkpoint = finalizeInitialCheckpoint(deferred.context);
      if (vault.checkpoint.status === "committed") {
        mutationJournal.record({ checkpointCommits: 1 });
      }
    }

    const mutations = mutationJournal.snapshot();
    const localMutationCount = creationLocalMutationCount(mutations);

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
        attemptId,
        localMutationCount,
        mutations,
      },
    };
  } catch (error) {
    throw asCreationMutationFailure(error, mutationJournal, {
      code: "mesh-init-batch-apply-failed",
      summary: "Manifest mesh creation stopped after its local apply phase began.",
      nextAction: {
        code: "inspect-local-creation",
        summary: "Run lyt repair --dry-run, inspect the local vault state, then retry creation.",
      },
    });
  }
}

interface PlannedVaultCreation {
  vaultName: string;
  ghRepoName: string;
  creation: VaultCreationBinding;
}

function isLegacyManifestCreationGated(): boolean {
  return true;
}

type PlannedCreationBatch =
  { kind: "plan"; entries: PlannedVaultCreation[] } | { kind: "refusal"; issues: ValidateIssue[] };

function planLocalCreations(
  inScope: ParsedManifest["vaults"],
  topoOrder: readonly string[],
  targets: ReadonlySet<string>,
  ghPrefix: string | null,
): PlannedCreationBatch {
  const byName = new Map(inScope.map((vault) => [vault.name, vault]));
  const entries: PlannedVaultCreation[] = [];
  const issues: ValidateIssue[] = [];
  const observedAt = new Date().toISOString();

  for (const vaultName of topoOrder.filter((name) => targets.has(name))) {
    if (!byName.has(vaultName)) continue;
    let ghRepoName: string;
    try {
      ghRepoName = applyGhPrefix(vaultName, ghPrefix);
    } catch {
      issues.push({
        code: "invalid-repository-name",
        severity: "error",
        message: `Vault "${vaultName}": creation requires a valid repository name.`,
      });
      continue;
    }
    const repositoryName = vaultRepoName(vaultName);
    const vaultAttemptId = uuid7BytesToDashedString(newUuidv7Bytes());
    const resolved = resolveCreationPlanV1({
      request: { kind: "local" },
      subject: { kind: "vault", repositoryName },
      actor: {
        attempt_id: vaultAttemptId,
        observed_at: observedAt,
        result: "unknown",
        actor: null,
        evidence_class: "unavailable",
      },
      intendedEffects: plannedSingleVaultEffectsV1({
        operationId: vaultAttemptId,
        podRid: vaultAttemptId.replaceAll("-", ""),
        mesh: { kind: "existing", name: vaultName.slice(0, vaultName.indexOf("/")) },
        vaultName,
        vaultRoot: resolveVaultPath(vaultName),
      }),
    });
    if (resolved.kind === "refusal") {
      issues.push({
        code: resolved.code,
        severity: "error",
        message: `Vault "${vaultName}": ${resolved.message}`,
      });
      continue;
    }
    entries.push({
      vaultName,
      ghRepoName,
      creation: {
        destinationRequest: resolved.plan.request,
        creationPlan: resolved.plan,
        attemptId: vaultAttemptId,
      },
    });
  }

  return issues.length > 0 ? { kind: "refusal", issues } : { kind: "plan", entries };
}

function recordCheckpointPath(
  deferred: { context: InitialCheckpointContext } | undefined,
  absolutePath: string,
): void {
  if (deferred === undefined) return;
  recordInitialCheckpointPaths(deferred.context, [
    relative(deferred.context.vaultPath, absolutePath),
  ]);
}

function notPublished(vaultName: string): MeshInitPublicationStatus {
  return {
    status: "not-published",
    nextAction: `lyt sync --vault ${vaultName}`,
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
