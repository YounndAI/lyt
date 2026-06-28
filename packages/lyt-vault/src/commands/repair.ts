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

import { Command } from "commander";
import { createInterface } from "node:readline/promises";

import { closeRegistry, openRegistry } from "../registry/client.js";
import {
  GitHistoryEmptyError,
  OrphanReattachMeshNotFoundError,
  OrphanReattachMissingArgError,
  repairFlow,
  RepairTargetNotFoundError,
  RestoreParseFailedError,
  type RepairAction,
  type RepairFinding,
  type RepairMode,
  type RepairResult,
} from "../flows/repair.js";
import { enumerateMeshYonRevisions, readMeshYonAtRevision } from "../util/git-history.js";
import { getMeshByName } from "../registry/meshes-repo.js";
import { getVaultByRid } from "../registry/repo.js";
import { withSpinner } from "../util/spinner.js";
import { parseMeshYon } from "../yon/mesh-read.js";

// v1.C.4 — `lyt repair` top-level meta-CLI verb. Mirrors `lyt discover`
// attach pattern from v1.C.3.
//
// Default mode is `--dry-run` per the ratified default (safer for a write verb). The user
// explicitly opts into `--apply`.
//
// Under TTY with a mesh-yon-parse-error target + no `--from-revision`,
// the command surfaces the candidate revisions via readline/promises and
// asks the user to pick one (federation-design §11:521 "offer to
// restore"). Under `--json` or non-TTY the flow auto-picks the most
// recent revision that parses cleanly.
//
// Exit-code mapping (per the ratified default):
// 0 repair ran cleanly (no findings OR all repaired)
// 1 vault-not-found / mesh-not-found / git-history-empty /
// parse-still-fails-after-restore / orphan-reattach-mesh-not-found
// 2 partial-repair-warnings (--apply with mixed success) OR dry-run
// surfaced findings
// 3 non-TTY under interactive default OR --apply without --target when
// registry has > 5 findings (safety)

interface RepairCliOpts {
  target?: string;
  mesh?: string;
  dryRun?: boolean;
  apply?: boolean;
  fromRevision?: string;
  json?: boolean;
}

const BATCH_FINDING_THRESHOLD = 5;

export function buildRepairCommand(): Command {
  return new Command("repair")
    .description(
      "Repair broken mesh.yon references / orphan vaults / unparseable mesh.yon. Default mode is --dry-run; pass --apply to perform writes. This is the write-side companion to `lyt mesh validate`.",
    )
    .option(
      "--target <rid|name>",
      "Restrict the repair to a single finding (vault rid hex OR vault name OR mesh name)",
    )
    .option(
      "--mesh <name>",
      "Target mesh for orphan-vault re-attachment (required with --apply for class 'orphan-vault')",
    )
    .option("--dry-run", "Report findings + actions without mutating disk or registry (default)")
    .option("--apply", "Perform the writes (mutually exclusive with --dry-run)")
    .option(
      "--from-revision <sha>",
      "Force a specific git revision for restore-from-Git (mesh-yon-parse-error class only)",
    )
    .option("--json", "Emit deterministic JSON instead of human-readable output")
    .action(async (opts: RepairCliOpts) => {
      const json = opts.json === true;
      const apply = opts.apply === true;
      const dryRun = opts.dryRun === true;

      if (apply && dryRun) {
        emitError(json, {
          error: "flag-combo-invalid",
          message: "lyt repair: --apply and --dry-run are mutually exclusive. Pass at most one.",
        });
        process.exitCode = 1;
        return;
      }
      const mode: RepairMode = apply ? "apply" : "dry-run";

      try {
        // For the interactive restore-from-Git picker we need a pre-flight
        // probe: did the user target a mesh-yon-parse-error finding, are
        // we under TTY, and did they omit --from-revision?
        let chosenRevision = opts.fromRevision;
        if (
          apply &&
          opts.target !== undefined &&
          opts.fromRevision === undefined &&
          !json &&
          process.stdin.isTTY === true
        ) {
          const picked = await maybePickRevisionInteractive(opts.target);
          if (picked !== null) {
            chosenRevision = picked;
          }
        }

        // safety: --apply without --target at > 5 findings is
        // refused unless the user picked a single target. We probe with
        // a dry-run first to count findings.
        if (apply && opts.target === undefined) {
          const probeDb = await openRegistry();
          let probe: RepairResult;
          try {
            probe = await repairFlow({
              ...(opts.target !== undefined ? { target: opts.target } : {}),
              ...(opts.mesh !== undefined ? { mesh: opts.mesh } : {}),
              mode: "dry-run",
              registryDb: probeDb,
            });
          } finally {
            await closeRegistry(probeDb);
          }
          if (probe.findings.length > BATCH_FINDING_THRESHOLD) {
            emitError(json, {
              error: "batch-confirm-required",
              message: `lyt repair --apply without --target refuses to repair ${probe.findings.length} findings in bulk (> ${BATCH_FINDING_THRESHOLD}). Run lyt repair --json to list them, then pass --target <id> per finding.`,
              findings_count: probe.findings.length,
            });
            process.exitCode = 3;
            return;
          }
        }

        const repairArgs = {
          ...(opts.target !== undefined ? { target: opts.target } : {}),
          ...(opts.mesh !== undefined ? { mesh: opts.mesh } : {}),
          mode,
          ...(chosenRevision !== undefined ? { fromRevision: chosenRevision } : {}),
        };
        // V-DX-1 — liveness spinner over the registry-open + reconcile window.
        // --json stays spinner-free; non-TTY prints "Repairing…" once. The
        // interactive revision picker + apply-batch probe above are left
        // un-wrapped (the picker is interactive; the probe is a fast count).
        const result = !json
          ? await withSpinner("", () => repairFlow(repairArgs), { op: "repair" })
          : await repairFlow(repairArgs);

        if (json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(toJsonShape(result), null, 2));
        } else {
          emitHumanSummary(result);
        }
        process.exitCode = result.exitCode;
      } catch (err) {
        const status = mapErrorToExitCode(err);
        if (status !== null) {
          emitError(json, errorToJsonBody(err));
          process.exitCode = status;
          return;
        }
        throw err;
      }
    });
}

async function maybePickRevisionInteractive(target: string): Promise<string | null> {
  // Resolve the target to a mesh name (if --target is a mesh name).
  const db = await openRegistry();
  let meshYonPath: string | null = null;
  try {
    const mesh = await getMeshByName(db, target);
    if (mesh === null || mesh.mainVaultRid === null) return null;
    const mv = await getVaultByRid(db, mesh.mainVaultRid);
    if (mv === null) return null;
    meshYonPath = mv.path;
  } finally {
    await closeRegistry(db);
  }
  if (meshYonPath === null) return null;

  let shas: string[];
  try {
    shas = await enumerateMeshYonRevisions({ mainVaultPath: meshYonPath });
  } catch {
    return null;
  }
  if (shas.length === 0) return null;

  // Probe each candidate; surface up to the first 5 parseable ones.
  const candidates: { sha: string; ok: boolean }[] = [];
  for (const sha of shas.slice(0, 10)) {
    try {
      const content = await readMeshYonAtRevision({ mainVaultPath: meshYonPath, sha });
      try {
        parseMeshYon(content);
        candidates.push({ sha, ok: true });
      } catch {
        candidates.push({ sha, ok: false });
      }
    } catch {
      candidates.push({ sha, ok: false });
    }
    if (candidates.filter((c) => c.ok).length >= 5) break;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-console
    console.log(`\nmesh '${target}' mesh.yon candidate revisions (most recent first):`);
    let idx = 1;
    const parseable: string[] = [];
    for (const c of candidates) {
      const tag = c.ok ? "[ok ]" : "[bad]";
      // eslint-disable-next-line no-console
      console.log(`  ${idx}. ${tag} ${c.sha.slice(0, 7)}`);
      if (c.ok) parseable.push(c.sha);
      idx += 1;
    }
    if (parseable.length === 0) {
      // eslint-disable-next-line no-console
      console.log("No parseable revisions surfaced.");
      return null;
    }
    const ans = (
      await rl.question(
        `Pick revision number (1-${candidates.length}) or [a]uto-pick first parseable: `,
      )
    )
      .trim()
      .toLowerCase();
    if (ans === "" || ans === "a") return parseable[0] ?? null;
    const n = Number.parseInt(ans, 10);
    if (!Number.isFinite(n) || n < 1 || n > candidates.length) return null;
    const picked = candidates[n - 1];
    if (picked === undefined || !picked.ok) return null;
    return picked.sha;
  } finally {
    rl.close();
  }
}

// Exported for the release review F1 unit test (tests/flows/phase-d-agent-file-relocation.test.ts)
// — asserts a present `snapshot_note` (a non-git vault migrated without a recovery
// snapshot) surfaces in the human output, not just `details`. Test-only seam.
export function emitHumanSummary(r: RepairResult): void {
  // eslint-disable-next-line no-console
  console.log(
    `Repair ${r.mode}: ${r.summary.findingsCount} finding${r.summary.findingsCount === 1 ? "" : "s"}; ${r.summary.actionsApplied} applied; ${r.summary.actionsSkipped} skipped; ${r.summary.actionsErrored} errored.`,
  );
  for (const f of r.findings) {
    // eslint-disable-next-line no-console
    console.log(`  • [${f.class}] ${f.meshName} target=${f.targetId} — ${f.reason}`);
    // eslint-disable-next-line no-console
    console.log(`      → ${f.remediation}`);
  }
  for (const a of r.actions) {
    const marker = a.status === "applied" ? "✓" : a.status === "skipped" ? "~" : "✗";
    // eslint-disable-next-line no-console
    console.log(`  ${marker} ${a.kind} ${a.meshName} (${a.targetId}): ${a.message}`);
    // Release review F1 — a present snapshot_note (e.g. a non-git vault migrated
    // without a recovery snapshot) rides only in `details` and was invisible in
    // human output. Surface it on its own line so the reduced safety net is seen.
    const snapshotNote = a.details["snapshot_note"];
    if (typeof snapshotNote === "string" && snapshotNote.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`      ⚠ ${snapshotNote}`);
    }
  }
}

interface RepairJsonShape {
  mode: RepairMode;
  findings: ReturnType<typeof findingToJson>[];
  actions: ReturnType<typeof actionToJson>[];
  summary: RepairResult["summary"];
  exit_code: number;
  duration_ms: number;
}

function toJsonShape(r: RepairResult): RepairJsonShape {
  return {
    mode: r.mode,
    findings: r.findings.map(findingToJson),
    actions: r.actions.map(actionToJson),
    summary: r.summary,
    exit_code: r.exitCode,
    duration_ms: r.durationMs,
  };
}

function findingToJson(f: RepairFinding): Record<string, unknown> {
  return {
    class: f.class,
    mesh_name: f.meshName,
    target_id: f.targetId,
    reason: f.reason,
    remediation: f.remediation,
    details: f.details,
  };
}

function actionToJson(a: RepairAction): Record<string, unknown> {
  return {
    kind: a.kind,
    mesh_name: a.meshName,
    target_id: a.targetId,
    status: a.status,
    message: a.message,
    details: a.details,
  };
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof RepairTargetNotFoundError) return 1;
  if (err instanceof GitHistoryEmptyError) return 1;
  if (err instanceof RestoreParseFailedError) return 1;
  if (err instanceof OrphanReattachMeshNotFoundError) return 1;
  if (err instanceof OrphanReattachMissingArgError) return 1;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof RepairTargetNotFoundError) {
    return { error: err.errorCode, target: err.target, message: err.message };
  }
  if (err instanceof GitHistoryEmptyError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  if (err instanceof RestoreParseFailedError) {
    return {
      error: err.errorCode,
      mesh_name: err.meshName,
      sha: err.sha,
      parse_cause: err.parseCause,
      message: err.message,
    };
  }
  if (err instanceof OrphanReattachMeshNotFoundError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  if (err instanceof OrphanReattachMissingArgError) {
    return { error: err.errorCode, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt repair: ${String(body["message"] ?? body["error"])}`);
  }
}
