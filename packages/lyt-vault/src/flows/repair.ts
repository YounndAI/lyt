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
import { removeMeshEdge } from "../registry/mesh-edges-repo.js";
import { removeSubscription } from "../registry/mesh-subscriptions-repo.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName, listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { detectMeshLinkDrift, reconcileOneMesh } from "./mesh-link-reconcile.js";
import { isLytDbCorrupt } from "../registry/vault-db.js";
import { rebuildVaultFlow } from "./rebuild-vault.js";
import { getVaultByName, getVaultByRid, listVaults, setVaultHomeMesh } from "../registry/repo.js";
import { appendMeshHomeToFile } from "../registry/vault-home-mesh-helpers.js";
import {
  enumerateMeshYonRevisions,
  readMeshYonAtRevision,
  type GitExecutor,
} from "../util/git-history.js";
import { hexToUuid7Bytes, ridsEqual, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { renderMeshYon, type MeshDoc } from "../yon/mesh-write.js";
import {
  MeshValidateNotFoundError,
  validateMeshEdgesFlow,
  type MeshEdgeFinding,
  type MeshSubscriptionFinding,
} from "./mesh-validate.js";

// v1.C.4 — `lyt repair [--target <rid|name>] [--mesh <name>]
// [--dry-run | --apply] [--from-revision <sha>]
// [--json]`.
//
// Write-side companion to `lyt mesh validate` (the read-only G-5 read
// boundary). Handles federation-design §11:515-521's 4 failure classes:
// (a) Broken @MESH_EDGE rows — ref/home vault no longer resolves OR
// home mesh main vault directory missing → REMOVE row from mesh.yon
// SoT + libSQL cache.
// (b) Broken @MESH_SUBSCRIPTION rows — external_vault or external_mesh
// no longer resolves → REMOVE row.
// (c) Orphan vaults — local `vaults.home_mesh_rid IS NULL` (pre-v1.A.3b
// vaults OR registry corruption) → re-attach to mesh specified via
// `--mesh <name>` (SET vaults.home_mesh_rid + INSERT mesh_vaults
// (role='home') + APPEND @MESH_HOME to that mesh's mesh.yon).
// (d) Unparseable mesh.yon — `parseMeshYon` throws → restore from
// Git history. `--from-revision <sha>` forces the candidate; default
// picks the most-recent revision that parses successfully.
//
// Default mode is `--dry-run` per the ratified default — safer for a write verb. The
// caller must explicitly opt into `--apply`.
//
// Composition over `validateMeshEdgesFlow` (extended in v1.C.4 to also
// surface `mesh-yon-parse-error` MeshFileFinding rows): the repair walk
// reuses validate's finding-collection then layers orphan-vault detection
// on top of it (validate stays scoped to mesh.yon row resolution; orphan
// vaults are a registry-level concern per the ratified default).
//
// Open-once seam (v1.A.5 CR-B1 — 17th vindication): callers may pass
// `registryDb`; the flow opens its own client only when omitted.

export type RepairMode = "dry-run" | "apply";

export type RepairActionKind =
  | "remove-edge"
  | "remove-subscription"
  | "restore-mesh-yon-from-git"
  | "reattach-orphan-vault"
  | "reconcile-mesh-link"
  | "rebuild-vault-index";

export type RepairFindingClass =
  | "broken-mesh-edge"
  | "broken-mesh-subscription"
  | "mesh-yon-parse-error"
  | "orphan-vault"
  | "mesh-link-drift"
  | "corrupt-vault-index";

// One row per actionable issue discovered during the walk. `target_id`
// is a stable per-finding identifier the caller can pass back as
// `--target` to scope a future repair.
export interface RepairFinding {
  class: RepairFindingClass;
  meshName: string;
  targetId: string;
  reason: string;
  remediation: string;
  details: Record<string, unknown>;
}

// Outcome of a single apply-action — what changed on disk + in the
// registry. Always populated under `--apply`; empty under `--dry-run`.
export interface RepairAction {
  kind: RepairActionKind;
  meshName: string;
  targetId: string;
  status: "applied" | "skipped" | "error";
  message: string;
  details: Record<string, unknown>;
}

export interface RepairArgs {
  // Restrict the walk to a single finding by target id (rid hex OR vault
  // name OR mesh name — resolution try-rid-first per the ratified default). Omit to walk
  // every finding.
  target?: string | undefined;
  // The mesh to re-attach an orphan vault to (required when class
  // 'orphan-vault' is the target under `--apply`). Ignored otherwise.
  mesh?: string | undefined;
  // Mode is 'dry-run' by default per the ratified default. Pass 'apply' to perform writes.
  mode?: RepairMode | undefined;
  // Force a specific revision for restore-from-Git (only meaningful for
  // mesh-yon-parse-error). When omitted, the flow picks the most-recent
  // revision that parses; under non-TTY/--json this is auto-pick.
  fromRevision?: string | undefined;
  // Open-once seam.
  registryDb?: Client | undefined;
  // Injectable git executor (test seam — mirrors gh-discover's GhExecutor
  // pattern).
  gitExecutor?: GitExecutor | undefined;
}

export interface RepairResult {
  mode: RepairMode;
  findings: RepairFinding[];
  actions: RepairAction[];
  summary: {
    findingsCount: number;
    actionsApplied: number;
    actionsSkipped: number;
    actionsErrored: number;
  };
  exitCode: 0 | 2;
  durationMs: number;
}

// Structured errors — CLI layer maps to exit code 1.

export class RepairTargetNotFoundError extends Error {
  readonly errorCode = "repair-target-not-found";
  readonly target: string;
  constructor(target: string) {
    super(
      `lyt repair: --target '${target}' did not resolve to any current finding. Run 'lyt repair --json' to list active findings.`,
    );
    this.name = "RepairTargetNotFoundError";
    this.target = target;
  }
}

export class GitHistoryEmptyError extends Error {
  readonly errorCode = "git-history-empty";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt repair: mesh '${meshName}' has no git history at .lyt/mesh.yon. Restore-from-Git cannot proceed.`,
    );
    this.name = "GitHistoryEmptyError";
    this.meshName = meshName;
  }
}

export class RestoreParseFailedError extends Error {
  readonly errorCode = "restore-parse-failed";
  readonly meshName: string;
  readonly sha: string | null;
  readonly parseCause: string;
  constructor(meshName: string, sha: string | null, parseCause: string) {
    super(
      sha === null
        ? `lyt repair: no revision in mesh '${meshName}' .lyt/mesh.yon history parsed cleanly. Cause: ${parseCause}.`
        : `lyt repair: mesh '${meshName}' .lyt/mesh.yon at ${sha} still failed to parse. Cause: ${parseCause}.`,
    );
    this.name = "RestoreParseFailedError";
    this.meshName = meshName;
    this.sha = sha;
    this.parseCause = parseCause;
  }
}

export class OrphanReattachMeshNotFoundError extends Error {
  readonly errorCode = "orphan-reattach-mesh-not-found";
  readonly meshName: string;
  constructor(meshName: string) {
    super(
      `lyt repair: --mesh '${meshName}' did not resolve to any registered mesh. Re-attach refused.`,
    );
    this.name = "OrphanReattachMeshNotFoundError";
    this.meshName = meshName;
  }
}

export class OrphanReattachMissingArgError extends Error {
  readonly errorCode = "orphan-reattach-missing-mesh";
  constructor() {
    super(
      `lyt repair: re-attaching an orphan vault requires --mesh <name>. Pass --mesh to specify which mesh to bind the vault to.`,
    );
    this.name = "OrphanReattachMissingArgError";
  }
}

const REPAIRABLE_EDGE_REASONS: ReadonlyArray<MeshEdgeFinding["reason"]> = [
  "ref-vault-not-registered",
  "home-vault-not-registered",
  "home-mesh-not-registered",
  "home-mesh-main-vault-missing-on-disk",
];

const REPAIRABLE_SUBSCRIPTION_REASONS: ReadonlyArray<MeshSubscriptionFinding["reason"]> = [
  "external-vault-not-registered",
  "external-mesh-not-registered",
];

export async function repairFlow(args: RepairArgs = {}): Promise<RepairResult> {
  const startedAt = Date.now();
  const mode: RepairMode = args.mode ?? "dry-run";
  const callerSupplied = args.registryDb !== undefined;
  const db = args.registryDb ?? (await openRegistry());

  try {
    // 1. Run the read-only validate walk to collect mesh.yon-row findings.
    let validateResult;
    try {
      validateResult = await validateMeshEdgesFlow({ registryDb: db });
    } catch (err) {
      if (err instanceof MeshValidateNotFoundError) {
        // --mesh on validate is unused by repair; treat as no findings.
        validateResult = null;
      } else {
        throw err;
      }
    }

    const findings: RepairFinding[] = [];

    // 1a. Translate MeshEdgeFinding rows into RepairFinding rows.
    if (validateResult !== null) {
      for (const f of validateResult.findings) {
        if (!REPAIRABLE_EDGE_REASONS.includes(f.reason)) continue;
        findings.push({
          class: "broken-mesh-edge",
          meshName: f.refMeshName,
          targetId: edgeTargetId(f),
          reason: f.reason,
          remediation: f.remediation,
          details: {
            ref_mesh_rid: f.refMeshRidHex,
            ref_vault_rid: f.refVaultRidHex,
            home_mesh_rid: f.homeMeshRidHex,
            home_vault_rid: f.homeVaultRidHex,
          },
        });
      }
      for (const f of validateResult.subscriptionFindings) {
        if (!REPAIRABLE_SUBSCRIPTION_REASONS.includes(f.reason)) continue;
        findings.push({
          class: "broken-mesh-subscription",
          meshName: f.meshName,
          targetId: subscriptionTargetId(f),
          reason: f.reason,
          remediation: f.remediation,
          details: {
            mesh_rid: f.meshRidHex,
            external_vault_rid: f.externalVaultRidHex,
            external_mesh_rid: f.externalMeshRidHex,
            external_mesh_name: f.externalMeshName,
          },
        });
      }
      for (const f of validateResult.fileFindings) {
        findings.push({
          class: "mesh-yon-parse-error",
          meshName: f.meshName,
          targetId: f.meshName,
          reason: f.reason,
          remediation: f.remediation,
          details: {
            mesh_yon_path: f.meshYonPath,
            parse_error: f.parseError,
          },
        });
      }
    }

    // 1b. Detect orphan vaults — `vaults.home_mesh_rid IS NULL`. Scoped
    // to active (status='active') vaults only; tombstones + missing
    // vaults are out per the ratified default.
    const allVaults = await listVaults(db);
    for (const v of allVaults) {
      if (v.homeMeshRid !== null) continue;
      if (v.status !== "active") continue;
      findings.push({
        class: "orphan-vault",
        meshName: "(none)",
        targetId: v.ridHex,
        reason: "home-mesh-not-set",
        remediation: `Run: lyt repair --target ${v.ridHex} --apply --mesh <name>`,
        details: {
          vault_rid: v.ridHex,
          vault_name: v.name,
          vault_path: v.path,
        },
      });
    }

    // 1c. V-B-8a fix-pass (2026-06-09) — mesh-link drift. A vault can carry a
    // vault-side `home_mesh_rid` yet be MISSING its mesh-side links (the
    // `mesh_vaults` home row and/or `meshes.main_vault_rid`) — the V-B-4
    // adopt drift. The orphan-vault check above SKIPS these (their
    // home_mesh_rid is non-null), which is exactly why `lyt repair` returned
    // 0 findings on a drift that `lyt doctor` flagged (two health verbs
    // disagreeing). Detect ONE finding per drifted mesh; the fix needs no
    // `--mesh` (the vault already knows its home mesh, unlike a NULL-home
    // orphan). The reconcile is shared with the adopt path (flows/
    // mesh-link-reconcile.ts) so the detect/fix can't drift from the inline
    // heal.
    for (const drift of await detectMeshLinkDrift(db)) {
      findings.push({
        class: "mesh-link-drift",
        meshName: drift.meshName,
        targetId: `mesh-link:${drift.meshName}`,
        reason: "mesh-side-links-missing",
        // Self-targeting form so the heal always works regardless of total
        // finding count: `lyt repair --apply` with NO --target is refused by the
        // batch guard (commands/repair.ts) once total findings > 5; scoping
        // to this finding's targetId bypasses that. No --mesh needed (the vault
        // already declares its home mesh).
        remediation: `Run: lyt repair --target mesh-link:${drift.meshName} --apply`,
        details: {
          mesh_rid: drift.meshRidHex,
          missing_home_vaults: drift.missingHomeVaultNames,
          missing_main_vault: drift.missingMainVaultName,
        },
      });
    }

    // 1d. hardening fix-pass (2026-06-10) — per-vault index corruption. The pod's
    // self-heal verb pair (doctor diagnoses / repair fixes) covered
    // registry + mesh drift but not the index tier: a corrupt lyt.db was
    // invisible to repair (zero findings, exit 0) while the F15 heal sat
    // one verb away. Detect via the shared read-only probe; the apply
    // action routes to the quarantine heal (rebuildVaultFlow →
    // healLytDbIfCorrupt + full content rebuild).
    for (const v of allVaults) {
      if (v.status !== "active") continue;
      if (!existsSync(v.path)) continue;
      let corrupt = false;
      try {
        corrupt = await isLytDbCorrupt(v.path);
      } catch {
        continue; // probe failure ≠ corruption; doctor surfaces probe errors
      }
      if (!corrupt) continue;
      findings.push({
        class: "corrupt-vault-index",
        meshName: "(none)",
        targetId: `index:${v.ridHex}`,
        reason: "lyt-db-corrupt",
        // Self-targeting form (mirrors mesh-link-drift) so the heal bypasses
        // the batch guard regardless of total finding count.
        remediation: `Run: lyt repair --target index:${v.ridHex} --apply (quarantines the corrupt lyt.db + rebuilds it; equivalent: lyt reindex --vault '${v.name}')`,
        details: {
          vault_rid: v.ridHex,
          vault_name: v.name,
          vault_path: v.path,
        },
      });
    }

    // 2. Filter by --target if given. Try rid-first then name.
    const filtered =
      args.target === undefined ? findings : filterFindingsByTarget(findings, args.target);

    if (args.target !== undefined && filtered.length === 0) {
      throw new RepairTargetNotFoundError(args.target);
    }

    // 3. Under --dry-run: emit the plan + return. ZERO writes.
    if (mode === "dry-run") {
      return {
        mode,
        findings: filtered,
        actions: [],
        summary: {
          findingsCount: filtered.length,
          actionsApplied: 0,
          actionsSkipped: 0,
          actionsErrored: 0,
        },
        exitCode: filtered.length > 0 ? 2 : 0,
        durationMs: Date.now() - startedAt,
      };
    }

    // 4. Under --apply: execute each repair action. We run them
    // sequentially (no parallel write to mesh.yon files of the same
    // mesh) and surface per-action outcomes.
    const actions: RepairAction[] = [];
    for (const f of filtered) {
      const a = await applyOne(db, f, args);
      actions.push(a);
    }

    const applied = actions.filter((a) => a.status === "applied").length;
    const skipped = actions.filter((a) => a.status === "skipped").length;
    const errored = actions.filter((a) => a.status === "error").length;

    return {
      mode,
      findings: filtered,
      actions,
      summary: {
        findingsCount: filtered.length,
        actionsApplied: applied,
        actionsSkipped: skipped,
        actionsErrored: errored,
      },
      exitCode: errored > 0 ? 2 : 0,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(db);
  }
}

function filterFindingsByTarget(findings: RepairFinding[], target: string): RepairFinding[] {
  // Try exact targetId match first.
  const byId = findings.filter((f) => f.targetId === target);
  if (byId.length > 0) return byId;
  // Try mesh name match (broken-edge / broken-subscription / parse-error).
  const byMesh = findings.filter((f) => f.meshName === target);
  if (byMesh.length > 0) return byMesh;
  // Try vault name match (orphan-vault + corrupt-vault-index findings carry
  // vault_name in details).
  const byVaultName = findings.filter(
    (f) =>
      (f.class === "orphan-vault" || f.class === "corrupt-vault-index") &&
      f.details["vault_name"] === target,
  );
  return byVaultName;
}

function edgeTargetId(f: MeshEdgeFinding): string {
  return `edge:${f.refMeshName}:${f.refVaultRidHex.slice(0, 8)}->${f.homeVaultRidHex.slice(0, 8)}`;
}

function subscriptionTargetId(f: MeshSubscriptionFinding): string {
  return `sub:${f.meshName}:${f.externalVaultRidHex.slice(0, 8)}`;
}

async function applyOne(db: Client, f: RepairFinding, args: RepairArgs): Promise<RepairAction> {
  try {
    switch (f.class) {
      case "broken-mesh-edge":
        return await applyRemoveEdge(db, f);
      case "broken-mesh-subscription":
        return await applyRemoveSubscription(db, f);
      case "mesh-yon-parse-error":
        return await applyRestoreFromGit(db, f, args);
      case "orphan-vault":
        return await applyReattachOrphan(db, f, args);
      case "mesh-link-drift":
        return await applyReconcileMeshLink(db, f);
      case "corrupt-vault-index":
        return await applyRebuildVaultIndex(f);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: kindForClass(f.class),
      meshName: f.meshName,
      targetId: f.targetId,
      status: "error",
      message,
      details: { ...f.details, error: message },
    };
  }
}

function kindForClass(c: RepairFindingClass): RepairActionKind {
  switch (c) {
    case "broken-mesh-edge":
      return "remove-edge";
    case "broken-mesh-subscription":
      return "remove-subscription";
    case "mesh-yon-parse-error":
      return "restore-mesh-yon-from-git";
    case "orphan-vault":
      return "reattach-orphan-vault";
    case "mesh-link-drift":
      return "reconcile-mesh-link";
    case "corrupt-vault-index":
      return "rebuild-vault-index";
  }
}

// hardening pass apply leg — route to the F15 quarantine heal. rebuildVaultFlow runs
// healLytDbIfCorrupt (rename-aside quarantine, fresh schema) then the full
// content rebuild, so the vault comes back searchable, not just openable.
async function applyRebuildVaultIndex(f: RepairFinding): Promise<RepairAction> {
  const vaultName = String(f.details["vault_name"] ?? "");
  const r = await rebuildVaultFlow({ vault: vaultName });
  return {
    kind: "rebuild-vault-index",
    meshName: f.meshName,
    targetId: f.targetId,
    status: "applied",
    message: `corrupt lyt.db quarantined${r.indexQuarantinedTo !== null ? ` to ${r.indexQuarantinedTo}` : ""} + rebuilt for vault '${vaultName}'`,
    details: { ...f.details, quarantined_to: r.indexQuarantinedTo },
  };
}

async function applyRemoveEdge(db: Client, f: RepairFinding): Promise<RepairAction> {
  // Resolve the owning mesh's main vault path so we can rewrite mesh.yon.
  const mesh = await getMeshByName(db, f.meshName);
  if (mesh === null) {
    return errorAction(f, `mesh '${f.meshName}' no longer registered locally`);
  }
  const mainVaultPath = await mainVaultPathForMesh(db, mesh);
  if (mainVaultPath === null) {
    return errorAction(f, `mesh '${f.meshName}' has no resolvable main vault path`);
  }
  const meshYonPath = join(mainVaultPath, ".lyt", "mesh.yon");
  if (!existsSync(meshYonPath)) {
    return errorAction(f, `mesh '${f.meshName}' .lyt/mesh.yon missing on disk`);
  }
  const before = readFileSync(meshYonPath, "utf8");
  const doc = parseMeshYon(before);

  const refVaultRid = hexToUuid7Bytes(f.details["ref_vault_rid"] as string);
  const homeMeshRid = hexToUuid7Bytes(f.details["home_mesh_rid"] as string);
  const homeVaultRid = hexToUuid7Bytes(f.details["home_vault_rid"] as string);
  const refMeshRid = hexToUuid7Bytes(f.details["ref_mesh_rid"] as string);

  const filteredEdges = doc.edges.filter(
    (e) =>
      !(
        ridsEqual(e.refMeshRid, refMeshRid) &&
        ridsEqual(e.refVaultRid, refVaultRid) &&
        ridsEqual(e.homeMeshRid, homeMeshRid) &&
        ridsEqual(e.homeVaultRid, homeVaultRid)
      ),
  );
  if (filteredEdges.length === doc.edges.length) {
    // SoT row already absent — only the cache may still have it. Clear
    // cache + report skipped. mesh.yon stays byte-stable.
    await removeMeshEdge(db, refMeshRid, refVaultRid, homeMeshRid, homeVaultRid);
    return {
      kind: "remove-edge",
      meshName: f.meshName,
      targetId: f.targetId,
      status: "skipped",
      message: `edge not present in mesh.yon SoT; cache row cleared`,
      details: { ...f.details, mesh_yon_path: meshYonPath },
    };
  }

  const updated: MeshDoc = {
    ...doc,
    edges: filteredEdges,
  };
  const rendered = renderMeshYon(updated);

  await atomicReplaceWithTx(db, meshYonPath, rendered, async () => {
    await removeMeshEdge(db, refMeshRid, refVaultRid, homeMeshRid, homeVaultRid);
  });

  return {
    kind: "remove-edge",
    meshName: f.meshName,
    targetId: f.targetId,
    status: "applied",
    message: `removed broken @MESH_EDGE row from mesh.yon + libSQL cache`,
    details: { ...f.details, mesh_yon_path: meshYonPath },
  };
}

async function applyRemoveSubscription(db: Client, f: RepairFinding): Promise<RepairAction> {
  const mesh = await getMeshByName(db, f.meshName);
  if (mesh === null) {
    return errorAction(f, `mesh '${f.meshName}' no longer registered locally`);
  }
  const mainVaultPath = await mainVaultPathForMesh(db, mesh);
  if (mainVaultPath === null) {
    return errorAction(f, `mesh '${f.meshName}' has no resolvable main vault path`);
  }
  const meshYonPath = join(mainVaultPath, ".lyt", "mesh.yon");
  if (!existsSync(meshYonPath)) {
    return errorAction(f, `mesh '${f.meshName}' .lyt/mesh.yon missing on disk`);
  }
  const before = readFileSync(meshYonPath, "utf8");
  const doc = parseMeshYon(before);

  const meshRid = hexToUuid7Bytes(f.details["mesh_rid"] as string);
  const externalVaultRid = hexToUuid7Bytes(f.details["external_vault_rid"] as string);

  const filteredSubs = doc.subscriptions.filter(
    (s) => !(ridsEqual(s.meshRid, meshRid) && ridsEqual(s.externalVaultRid, externalVaultRid)),
  );
  if (filteredSubs.length === doc.subscriptions.length) {
    await removeSubscription(db, meshRid, externalVaultRid);
    return {
      kind: "remove-subscription",
      meshName: f.meshName,
      targetId: f.targetId,
      status: "skipped",
      message: `subscription not present in mesh.yon SoT; cache row cleared`,
      details: { ...f.details, mesh_yon_path: meshYonPath },
    };
  }

  const updated: MeshDoc = {
    ...doc,
    subscriptions: filteredSubs,
  };
  const rendered = renderMeshYon(updated);

  await atomicReplaceWithTx(db, meshYonPath, rendered, async () => {
    await removeSubscription(db, meshRid, externalVaultRid);
  });

  return {
    kind: "remove-subscription",
    meshName: f.meshName,
    targetId: f.targetId,
    status: "applied",
    message: `removed broken @MESH_SUBSCRIPTION row from mesh.yon + libSQL cache`,
    details: { ...f.details, mesh_yon_path: meshYonPath },
  };
}

async function applyRestoreFromGit(
  db: Client,
  f: RepairFinding,
  args: RepairArgs,
): Promise<RepairAction> {
  const mesh = await getMeshByName(db, f.meshName);
  if (mesh === null) {
    return errorAction(f, `mesh '${f.meshName}' no longer registered locally`);
  }
  const mainVaultPath = await mainVaultPathForMesh(db, mesh);
  if (mainVaultPath === null) {
    return errorAction(f, `mesh '${f.meshName}' has no resolvable main vault path`);
  }
  const meshYonPath = join(mainVaultPath, ".lyt", "mesh.yon");

  // Candidate revision strategy:
  // - --from-revision <sha> wins (federation-design §11:521 explicit
  // "offer to restore from last-known-good in Git history" — the
  // user picks).
  // - Otherwise: enumerate the SHAs that touched .lyt/mesh.yon, newest
  // first; auto-pick the most recent one that parses cleanly.
  let chosenSha: string | null = null;
  let chosenContent: string | null = null;
  let lastParseError: string | null = null;

  if (args.fromRevision !== undefined) {
    try {
      const content = await readMeshYonAtRevision({
        mainVaultPath,
        sha: args.fromRevision,
        ...(args.gitExecutor !== undefined ? { git: args.gitExecutor } : {}),
      });
      try {
        parseMeshYon(content);
        chosenSha = args.fromRevision;
        chosenContent = content;
      } catch (parseErr) {
        const cause = parseErr instanceof Error ? parseErr.message : String(parseErr);
        throw new RestoreParseFailedError(f.meshName, args.fromRevision, cause);
      }
    } catch (err) {
      if (err instanceof RestoreParseFailedError) throw err;
      throw err;
    }
  } else {
    const shas = await enumerateMeshYonRevisions({
      mainVaultPath,
      ...(args.gitExecutor !== undefined ? { git: args.gitExecutor } : {}),
    });
    if (shas.length === 0) {
      throw new GitHistoryEmptyError(f.meshName);
    }
    for (const sha of shas) {
      let content: string;
      try {
        content = await readMeshYonAtRevision({
          mainVaultPath,
          sha,
          ...(args.gitExecutor !== undefined ? { git: args.gitExecutor } : {}),
        });
      } catch (err) {
        lastParseError = err instanceof Error ? err.message : String(err);
        continue;
      }
      try {
        parseMeshYon(content);
        chosenSha = sha;
        chosenContent = content;
        break;
      } catch (parseErr) {
        lastParseError = parseErr instanceof Error ? parseErr.message : String(parseErr);
        continue;
      }
    }
    if (chosenSha === null || chosenContent === null) {
      throw new RestoreParseFailedError(
        f.meshName,
        null,
        lastParseError ?? "no candidate revision parsed cleanly",
      );
    }
  }

  // No registry changes accompany a restore — the SoT mesh.yon is the
  // master, and rebuild-mesh-registry can be run after to refresh the
  // cache.
  atomicWriteFile(meshYonPath, chosenContent);

  return {
    kind: "restore-mesh-yon-from-git",
    meshName: f.meshName,
    targetId: f.targetId,
    status: "applied",
    message: `restored mesh.yon from git revision ${chosenSha.slice(0, 7)}`,
    details: { ...f.details, restored_from_sha: chosenSha, mesh_yon_path: meshYonPath },
  };
}

async function applyReattachOrphan(
  db: Client,
  f: RepairFinding,
  args: RepairArgs,
): Promise<RepairAction> {
  if (args.mesh === undefined) {
    throw new OrphanReattachMissingArgError();
  }
  const targetMesh = await getMeshByName(db, args.mesh);
  if (targetMesh === null) {
    throw new OrphanReattachMeshNotFoundError(args.mesh);
  }
  const vaultRidHex = f.details["vault_rid"] as string;
  const vaultName = f.details["vault_name"] as string;
  const vaultRid = hexToUuid7Bytes(vaultRidHex);
  const vault = await getVaultByRid(db, vaultRid);
  if (vault === null) {
    return errorAction(f, `vault rid ${vaultRidHex} no longer registered`);
  }

  // Resolve target mesh's main vault path for the @MESH_HOME append.
  const mainVaultPath = await mainVaultPathForMesh(db, targetMesh);
  if (mainVaultPath === null) {
    return errorAction(f, `target mesh '${targetMesh.name}' has no resolvable main vault path`);
  }
  const meshYonPath = join(mainVaultPath, ".lyt", "mesh.yon");
  if (!existsSync(meshYonPath)) {
    return errorAction(f, `target mesh '${targetMesh.name}' .lyt/mesh.yon missing on disk`);
  }

  // Atomic write of mesh.yon happens inside vault-home-mesh-helpers
  // (tmp+rename). Wrap registry mutations in a tx so the @MESH_HOME
  // append survives + the vault stays bound on the registry side.
  try {
    await db.execute("BEGIN");
    try {
      await setVaultHomeMesh(db, vault.rid, targetMesh.rid);
      await addVaultToMesh(db, targetMesh.rid, vault.rid, "home");
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
    const message = err instanceof Error ? err.message : String(err);
    return errorAction(f, `registry tx failed: ${message}`);
  }

  // Append @MESH_HOME to the target mesh's mesh.yon. If this throws after
  // the tx committed, the registry stays correct + the next run of
  // `lyt mesh rebuild-registry` will re-emit the row from the cache.
  appendMeshHomeToFile({
    mainVaultPath,
    meshRid: targetMesh.rid,
    vaultRid: vault.rid,
    vaultName,
  });

  return {
    kind: "reattach-orphan-vault",
    meshName: targetMesh.name,
    targetId: f.targetId,
    status: "applied",
    message: `bound vault '${vaultName}' to mesh '${targetMesh.name}' + appended @MESH_HOME`,
    details: {
      ...f.details,
      target_mesh: targetMesh.name,
      mesh_yon_path: meshYonPath,
    },
  };
}

// V-B-8a fix-pass (2026-06-09) — fix mesh-link drift by reconciling the
// mesh-side links (mesh_vaults `home` rows + meshes.main_vault_rid) from the
// authoritative vault-side home_mesh_rid + `<mesh>/main` convention. No `--mesh`
// arg needed (unlike orphan-vault re-attach): the vault already declares its home
// mesh. Idempotent — a no-op reconcile reports `skipped`.
async function applyReconcileMeshLink(db: Client, f: RepairFinding): Promise<RepairAction> {
  const mesh = await getMeshByName(db, f.meshName);
  if (mesh === null) {
    return errorAction(f, `mesh '${f.meshName}' no longer registered locally`);
  }
  const outcome = await reconcileOneMesh(db, mesh);
  const parts: string[] = [];
  if (outcome.homeRowsAdded.length > 0) {
    parts.push(
      `+${outcome.homeRowsAdded.length} home row(s) [${outcome.homeRowsAdded.join(", ")}]`,
    );
  }
  if (outcome.mainVaultSet !== null) {
    parts.push(`main_vault=${outcome.mainVaultSet}`);
  }
  if (parts.length === 0) {
    return {
      kind: "reconcile-mesh-link",
      meshName: f.meshName,
      targetId: f.targetId,
      status: "skipped",
      message: `mesh '${f.meshName}' links already consistent (no change)`,
      details: { ...f.details },
    };
  }
  return {
    kind: "reconcile-mesh-link",
    meshName: f.meshName,
    targetId: f.targetId,
    status: "applied",
    message: `reconciled mesh-side links — ${parts.join("; ")}`,
    details: {
      ...f.details,
      home_rows_added: outcome.homeRowsAdded,
      main_vault_set: outcome.mainVaultSet,
    },
  };
}

function errorAction(f: RepairFinding, message: string): RepairAction {
  return {
    kind: kindForClass(f.class),
    meshName: f.meshName,
    targetId: f.targetId,
    status: "error",
    message,
    details: { ...f.details, error: message },
  };
}

async function mainVaultPathForMesh(db: Client, mesh: MeshRow): Promise<string | null> {
  if (mesh.mainVaultRid === null) return null;
  const v = await getVaultByRid(db, mesh.mainVaultRid);
  if (v === null) return null;
  return v.path;
}

// Atomic write helper — tmp+rename inside the same dir, with a registry
// tx wrapper so cache mutations + the mesh.yon publish happen as a unit
// per the ratified default. Mirrors flows/add-mesh-edge.ts:243-294 atomicity contract.
async function atomicReplaceWithTx(
  db: Client,
  targetPath: string,
  content: string,
  txBody: () => Promise<void>,
): Promise<void> {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, "utf8");
  try {
    await db.execute("BEGIN");
    try {
      await txBody();
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
  renameSync(tmpPath, targetPath);
}

function atomicWriteFile(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    cleanupTmp(tmpPath);
    throw err;
  }
}

function cleanupTmp(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

// Convenience helper for callers that want to resolve a `--mesh <name>`
// argument BEFORE running the flow (e.g. CLI early-failure UX). Returns
// the resolved MeshRow or throws OrphanReattachMeshNotFoundError.
export async function resolveTargetMeshOrThrow(db: Client, meshName: string): Promise<MeshRow> {
  const m = await getMeshByName(db, meshName);
  if (m === null) throw new OrphanReattachMeshNotFoundError(meshName);
  return m;
}

// Convenience: resolve a vault target by name OR rid hex. Useful for CLI
// `--target <rid|name>` resolution. Returns null when nothing matches.
export async function resolveVaultTarget(
  db: Client,
  target: string,
): Promise<{ ridHex: string; name: string } | null> {
  // Try name first (cheaper SELECT).
  const byName = await getVaultByName(db, target);
  if (byName !== null) {
    return { ridHex: uuid7BytesToHex(byName.rid), name: byName.name };
  }
  // Try rid hex.
  try {
    const ridBytes = hexToUuid7Bytes(target);
    const byRid = await getVaultByRid(db, ridBytes);
    if (byRid !== null) {
      return { ridHex: byRid.ridHex, name: byRid.name };
    }
  } catch {
    // Not a valid hex string.
  }
  return null;
}

// Convenience: list registered meshes (used by CLI to help the user pick
// a target mesh when they forgot --mesh on an orphan reattach).
export async function listRegisteredMeshNames(db: Client): Promise<string[]> {
  const ms = await listMeshes(db);
  return ms.map((m) => m.name).sort();
}
