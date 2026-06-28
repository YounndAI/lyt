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
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { addVaultToMesh } from "../registry/mesh-vaults-repo.js";
import { getMeshByName, listMeshes, type MeshRow } from "../registry/meshes-repo.js";
import { detectMeshLinkDrift, reconcileOneMesh } from "./mesh-link-reconcile.js";
import { isLytDbCorrupt } from "../registry/vault-db.js";
import { rebuildVaultFlow } from "./rebuild-vault.js";
import { findLegacyAgentFiles } from "../util/agent-file-paths.js";
import { migrateAgentFiles } from "./migrate-agent-files.js";
import { snapshotVaultFlow } from "./snapshot.js";
import { isGitRepo } from "../util/git-run.js";
import { getVaultByName, getVaultByRid, listVaults, setVaultHomeMesh } from "../registry/repo.js";
import { appendMeshHomeToFile } from "../registry/vault-home-mesh-helpers.js";
import {
  enumerateMeshYonRevisions,
  readMeshYonAtRevision,
  type GitExecutor,
} from "../util/git-history.js";
import { hexToUuid7Bytes, uuid7BytesToDashedString, uuid7BytesToHex } from "../util/uuid7.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { appendMeshEdgeTombstone } from "../yon/mesh-edge-ledger-write.js";
import {
  MeshValidateNotFoundError,
  validateMeshEdgesFlow,
  type MeshEdgeFinding,
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

// Fed-v2 Layer-1 (Phase D1c): the `remove-subscription` action kind +
// `broken-mesh-subscription` finding class are RETIRED. mesh.yon is no longer
// the subscription SoT (no-legacy, design §5), so there is no broken
// mesh.yon subscription row to detect or remove — subscriptions live in the
// per-writer ledger and are reconciled by the ledger reconstitution, not repair.
export type RepairActionKind =
  | "remove-edge"
  | "restore-mesh-yon-from-git"
  | "reattach-orphan-vault"
  | "reconcile-mesh-link"
  | "rebuild-vault-index"
  // Phase D (SC6) — relocate legacy-root agents.md / lyt-overview.md into `.lyt/`.
  | "migrate-agent-files";

export type RepairFindingClass =
  | "broken-mesh-edge"
  | "mesh-yon-parse-error"
  | "orphan-vault"
  | "mesh-link-drift"
  | "corrupt-vault-index"
  // Phase D (SC6) — a vault still carrying agent-priming files at the legacy root.
  | "legacy-agent-files";

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
      // Fed-v2 D1c: validateResult.subscriptionFindings is now always empty
      // (subscription validation retired); no broken-mesh-subscription findings
      // are translated here.
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

    // 1e. Phase D (SC6) — legacy agent-file location. A vault scaffolded before
    // Phase D carries `agents.md` / `lyt-overview.md` at the vault ROOT; the
    // post-Phase-D home is `.lyt/`. Detect every active, on-disk vault that still
    // has a legacy-root copy. The apply step is SNAPSHOT-FIRST + idempotent +
    // leaves no orphan (see applyMigrateAgentFiles). ONE-WAY DOOR on the installed
    // base — surfaced under --dry-run, only mutated under --apply.
    for (const v of allVaults) {
      if (v.status !== "active") continue;
      if (!existsSync(v.path)) continue;
      const legacy = findLegacyAgentFiles(v.path);
      if (legacy.length === 0) continue;
      findings.push({
        class: "legacy-agent-files",
        meshName: "(none)",
        targetId: `agent-files:${v.ridHex}`,
        reason: "agent-priming-files-at-legacy-root",
        // Self-targeting form (mirrors mesh-link-drift / corrupt-vault-index) so
        // the heal bypasses the batch guard regardless of total finding count.
        remediation: `Run: lyt repair --target agent-files:${v.ridHex} --apply (snapshots the vault, then moves ${legacy.map((l) => l.filename).join(" + ")} into .lyt/)`,
        details: {
          vault_rid: v.ridHex,
          vault_name: v.name,
          vault_path: v.path,
          legacy_files: legacy.map((l) => l.filename),
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
  // Try vault name match (orphan-vault + corrupt-vault-index + legacy-agent-files
  // findings carry vault_name in details).
  const byVaultName = findings.filter(
    (f) =>
      (f.class === "orphan-vault" ||
        f.class === "corrupt-vault-index" ||
        f.class === "legacy-agent-files") &&
      f.details["vault_name"] === target,
  );
  return byVaultName;
}

function edgeTargetId(f: MeshEdgeFinding): string {
  return `edge:${f.refMeshName}:${f.refVaultRidHex.slice(0, 8)}->${f.homeVaultRidHex.slice(0, 8)}`;
}

async function applyOne(db: Client, f: RepairFinding, args: RepairArgs): Promise<RepairAction> {
  try {
    switch (f.class) {
      case "broken-mesh-edge":
        return await applyRemoveEdge(db, f);
      case "mesh-yon-parse-error":
        return await applyRestoreFromGit(db, f, args);
      case "orphan-vault":
        return await applyReattachOrphan(db, f, args);
      case "mesh-link-drift":
        return await applyReconcileMeshLink(db, f);
      case "corrupt-vault-index":
        return await applyRebuildVaultIndex(f);
      case "legacy-agent-files":
        return await applyMigrateAgentFiles(f);
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
    case "mesh-yon-parse-error":
      return "restore-mesh-yon-from-git";
    case "orphan-vault":
      return "reattach-orphan-vault";
    case "mesh-link-drift":
      return "reconcile-mesh-link";
    case "corrupt-vault-index":
      return "rebuild-vault-index";
    case "legacy-agent-files":
      return "migrate-agent-files";
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

// Phase D (SC6) apply leg — SNAPSHOT-FIRST relocation of legacy-root agent-priming
// files into `.lyt/`. ONE-WAY DOOR on the installed base, so a `vault snapshot` is
// taken BEFORE any disk mutation. Two distinct snapshot outcomes, branched cleanly
// (release review F1 — do NOT fail open on a transient error):
//   • Git repo present + snapshot succeeds → fully recoverable via `lyt vault
//     restore` (a clean-tree snapshot points at HEAD; a dirty tree captures the
//     working state — either way the pre-migration bytes are banked).
//   • GENUINE non-git vault (not a Git repo at all) → DEGRADED but still safe: no
//     git snapshot is possible, but the move is `renameSync` (bytes survive on
//     disk; the `.lyt/` copy is the same inode). We proceed and record a
//     snapshot_note explaining the reduced safety net.
//   • Git repo present BUT the snapshot THREW (transient — branch-name collision
//     or a raw git failure) → REFUSE. We do NOT mutate the installed-base vault
//     with the safety net silently disabled; the action is surfaced as an error so
//     the handler can retry. (Distinguished by re-probing isGitRepo: the only
//     reason snapshotVaultFlow throws BENIGNLY is the non-git case, which it
//     guards on isGitRepo===false; any other throw on a real repo is transient.)
// The relocation itself (migrateAgentFiles) is idempotent and leaves no orphaned
// tree copy.
async function applyMigrateAgentFiles(f: RepairFinding): Promise<RepairAction> {
  const vaultName = String(f.details["vault_name"] ?? "");
  const vaultPath = String(f.details["vault_path"] ?? "");

  // Snapshot-first. Distinguish the genuine non-git case (safe to proceed without
  // a snapshot) from a transient snapshot failure on a real git repo (REFUSE —
  // migrating with the net silently down is the one-way-door concern).
  let snapshotBranch: string | null = null;
  let snapshotNote: string | null = null;
  try {
    const snap = await snapshotVaultFlow({ name: vaultName, label: "pre-agent-file-migration" });
    snapshotBranch = snap.branch;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Re-probe: is this a real git repo? snapshotVaultFlow throws BENIGNLY only
    // when the vault is NOT a git repo (it guards on isGitRepo===false before any
    // other throw). If the path IS a git repo, the throw is transient (branch-name
    // collision / raw git failure) — refuse to migrate so the safety net isn't
    // silently disabled on the installed base.
    if (await isGitRepo(vaultPath)) {
      return {
        kind: "migrate-agent-files",
        meshName: f.meshName,
        targetId: f.targetId,
        status: "error",
        message: `vault '${vaultName}' is a Git repo but the pre-migration snapshot failed; refusing to migrate without a recovery snapshot — retry after resolving: ${reason}`,
        details: { ...f.details, snapshot_branch: null, snapshot_error: reason },
      };
    }
    // Genuine non-git vault — proceed; record the reduced safety net.
    snapshotNote = `no git snapshot possible (vault is not a Git repo); migration proceeded — bytes preserved by renameSync but 'lyt vault restore' is unavailable: ${reason}`;
  }

  const result = migrateAgentFiles(vaultPath);
  if (result.noop) {
    // Idempotent: nothing left at the legacy root (already migrated between the
    // detect walk and this apply, or a concurrent run beat us to it).
    return {
      kind: "migrate-agent-files",
      meshName: f.meshName,
      targetId: f.targetId,
      status: "skipped",
      message: `vault '${vaultName}' has no legacy-root agent files to migrate (already under .lyt/)`,
      details: { ...f.details, snapshot_branch: snapshotBranch, snapshot_note: snapshotNote },
    };
  }

  // F2 (release review) — chain a reindex now that the legacy-root copy has actually
  // moved. A pre-Phase-D vault's root `agents.md` may carry an FTS row keyed on the
  // old relpath; after the move to `.lyt/` (FTS-excluded), that row is stale until
  // the next sync/reindex. Mirror applyRebuildVaultIndex: drive the same
  // rebuildVaultFlow so the stale row is cleared in THIS `repair --apply`. Reuse
  // the existing reindex flow (no hand-rolled FTS deletion). Best-effort: a reindex
  // hiccup must not undo the successful, recoverable move — the stale row is a
  // cache-staleness nuisance the next `lyt sync`/reindex still clears.
  let reindexNote: string | null = null;
  try {
    await rebuildVaultFlow({ vault: vaultName });
  } catch (err) {
    reindexNote = `reindex-after-migrate skipped: ${err instanceof Error ? err.message : String(err)} (stale FTS row clears on next sync/reindex)`;
  }

  const moved = result.migrated.map((m) => `${m.filename} (${m.action})`).join(", ");
  return {
    kind: "migrate-agent-files",
    meshName: f.meshName,
    targetId: f.targetId,
    status: "applied",
    message: `relocated agent-priming file(s) into .lyt/ for vault '${vaultName}': ${moved}${snapshotBranch !== null ? ` (snapshot: ${snapshotBranch})` : ""}`,
    details: {
      ...f.details,
      migrated: result.migrated,
      snapshot_branch: snapshotBranch,
      snapshot_note: snapshotNote,
      reindex_note: reindexNote,
    },
  };
}

// Exported for the FU-2 unit test (tests/flows/repair.test.ts) — the handler is
// dormant (no finding feeds it today; see NOTE below), so it is otherwise
// undrivable through repairFlow. Test-only seam, not a runtime caller.
export async function applyRemoveEdge(_db: Client, f: RepairFinding): Promise<RepairAction> {
  // Slice 2a — broken-edge removal retracts the edge by appending a
  // TOMBSTONE for its identity 2-tuple `(ref_vault, home_vault)` (FU-1: the key
  // narrowed from the old 3-tuple; `ref_mesh`/`home_mesh` are now VALUE fields)
  // to THIS writer's mesh-edge ledger shard, instead of filtering+rewriting the
  // mesh.yon block + deleting the cache row (mesh.yon is no longer the edge SoT;
  // the per-writer ledger is). The add-wins OR-Set fold then drops the edge from
  // the live set, and the cache catches up on the next reconstitution
  // (rebuildFederationCacheFlow). The finding stores rids as HEX; convert all
  // four to the dashed-UUIDv7 ledger form — the tombstone's 2-tuple identity
  // `(ref_vault, home_vault)` then matches the active record's identity key,
  // while `ref_mesh`/`home_mesh` ride along as persisted values.
  //
  // NOTE: after the Slice-2a deletion of mesh-validate's edge-validation block,
  // no `remove-edge` findings are produced today (the validate walk no longer
  // emits MeshEdgeFinding rows). This handler is retained for the (now-dormant)
  // reason union + as the write-side primitive a future ledger-edge validation
  // slice would drive.
  const refMeshRid = uuid7BytesToDashedString(
    hexToUuid7Bytes(f.details["ref_mesh_rid"] as string),
  );
  const refVaultRid = uuid7BytesToDashedString(
    hexToUuid7Bytes(f.details["ref_vault_rid"] as string),
  );
  const homeVaultRid = uuid7BytesToDashedString(
    hexToUuid7Bytes(f.details["home_vault_rid"] as string),
  );
  const homeMeshRid = uuid7BytesToDashedString(
    hexToUuid7Bytes(f.details["home_mesh_rid"] as string),
  );

  appendMeshEdgeTombstone({
    refMeshRid,
    refVaultRid,
    homeVaultRid,
    homeMeshRid,
    kind: "parent",
  });

  return {
    kind: "remove-edge",
    meshName: f.meshName,
    targetId: f.targetId,
    status: "applied",
    message: `retracted broken edge via mesh-edge ledger tombstone (cache catches up on next reconstitution)`,
    details: { ...f.details },
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
