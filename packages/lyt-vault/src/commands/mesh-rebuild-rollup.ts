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

import {
  MeshRollupMeshNotFoundError,
  rebuildMeshRollupFlow,
} from "../flows/rebuild-mesh-rollup.js";
import { ROLLUP_DISCONNECTED_DAYS } from "../flows/rebuild-rollup.js";

interface MeshRebuildRollupCliOpts {
  mesh?: string;
  threshold?: string;
  json?: boolean;
}

// v1.E.2 — `lyt mesh rebuild-rollup [--mesh <name>]`.
//
// Mesh-level wrapper around `lyt vault rebuild-rollup`. For each home
// vault in the named mesh (or every registered mesh when --mesh is
// omitted), runs the per-vault transitive rebuild. Uses a single
// shared registry client (open-once seam) so the per-mesh rebuild
// stays connection-cheap.
//
// Exit codes (mirrors `lyt mesh rebuild-registry`):
// - 2: --mesh <name> not found in registry (MeshRollupMeshNotFoundError)
// - 1: every vault in the iteration failed
// - 0: at least one vault succeeded OR the iteration was empty
export function buildMeshRebuildRollupCommand(): Command {
  return new Command("rebuild-rollup")
    .description(
      `Rebuild transitive keyword rollup for every home vault in a mesh (or every mesh when --mesh is omitted). Edges only — subscriptions don't roll up. Disconnected descendants surface as soft-tombstones (default threshold ${ROLLUP_DISCONNECTED_DAYS} days).`,
    )
    .option("--mesh <name>", "Restrict to a single mesh by name (default = every registered mesh)")
    .option(
      "--threshold <days>",
      `Soft-tombstone threshold in days (default ${ROLLUP_DISCONNECTED_DAYS})`,
    )
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (opts: MeshRebuildRollupCliOpts) => {
      let thresholdDays: number | undefined;
      if (opts.threshold !== undefined) {
        const parsed = Number.parseInt(opts.threshold, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          // eslint-disable-next-line no-console
          console.error(
            `lyt mesh rebuild-rollup: --threshold must be a positive integer; got '${opts.threshold}'.`,
          );
          process.exitCode = 2;
          return;
        }
        thresholdDays = parsed;
      }
      try {
        const res = await rebuildMeshRollupFlow({
          ...(opts.mesh !== undefined ? { meshName: opts.mesh } : {}),
          ...(thresholdDays !== undefined ? { thresholdDays } : {}),
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(res, null, 2));
        } else {
          emitHumanSummary(res);
        }
        // Exit 1 only when at least one vault was iterated AND every
        // one of them failed (totally-failed signal). Matches the
        // exit-code shape of `lyt mesh rebuild-registry`.
        const allOutcomes = res.meshes.flatMap((m) => m.vaults);
        const failed = allOutcomes.filter((v) => v.status === "failed").length;
        if (allOutcomes.length > 0 && failed === allOutcomes.length) {
          process.exitCode = 1;
        }
      } catch (err) {
        if (err instanceof MeshRollupMeshNotFoundError) {
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.error(
              JSON.stringify(
                { error: err.errorCode, mesh_name: err.meshName, message: err.message },
                null,
                2,
              ),
            );
          } else {
            // eslint-disable-next-line no-console
            console.error(err.message);
          }
          process.exitCode = 2;
          return;
        }
        throw err;
      }
    });
}

function emitHumanSummary(res: {
  meshes: Array<{
    meshName: string;
    meshRidHex: string;
    vaults: Array<{
      vaultName: string;
      vaultRidHex: string;
      status: string;
      rollupRowsWritten: number;
      descendantsVisited: number;
      cycleDetected: boolean;
      error?: string;
    }>;
  }>;
  totalRollupRowsWritten: number;
  totalVaults: number;
  totalCycles: number;
  durationMs: number;
}): void {
  // eslint-disable-next-line no-console
  console.log(
    `Rebuilt mesh rollup: ${res.totalVaults} vault${res.totalVaults === 1 ? "" : "s"} ok across ${res.meshes.length} mesh${res.meshes.length === 1 ? "" : "es"}; ${res.totalRollupRowsWritten} row(s) upserted; ${res.totalCycles} cycle warning(s); ${res.durationMs}ms.`,
  );
  for (const m of res.meshes) {
    if (m.vaults.length === 0) continue;
    // eslint-disable-next-line no-console
    console.log(`  ${m.meshName} (mesh:${m.meshRidHex})`);
    for (const v of m.vaults) {
      const marker = v.status === "ok" ? "✓" : v.status === "failed" ? "✗" : "·";
      const detail =
        v.status === "ok"
          ? `${v.rollupRowsWritten} row(s), ${v.descendantsVisited} descendant(s)${v.cycleDetected ? " ⚠ cycle" : ""}`
          : (v.error ?? v.status);
      // eslint-disable-next-line no-console
      console.log(`    ${marker} ${v.vaultName}: ${detail}`);
    }
  }
}
