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
  MeshNotFoundError,
  rebuildMeshRegistryFlow,
  type MeshRebuildOutcome,
} from "../flows/rebuild-mesh-registry.js";

// v1.B.2 — `lyt mesh rebuild-registry [--mesh <name>] [--json]`.
//
// The trust-the-disk verb: walks every registered mesh's main vault,
// re-parses `.lyt/mesh.yon`, and re-derives the per-machine registry
// mesh table rows (meshes + mesh_vaults + mesh_edges +
// mesh_subscriptions). Per-mesh transactions keep blast radius small;
// parse errors skip-and-warn per the ratified default.
//
// Lock 0.3 deterministic --json output: same disk state + same nowIso
// seam = byte-identical JSON. Output schema documented inline in the
// flow's `RebuildMeshRegistryResult` type.
//
// Structured error contract :
// - exit 2 on `--mesh <name>` not found in registry (MeshNotFoundError)
// - exit 1 only if ALL meshes failed (totally-failed signal)
// - exit 0 otherwise; per-mesh status surfaces in JSON / human output

interface RebuildMeshRegistryCliOpts {
  mesh?: string;
  nowIso?: string;
  json?: boolean;
}

export function buildRebuildMeshRegistryCommand(): Command {
  return new Command("rebuild-registry")
    .description(
      "Rebuild per-machine mesh registry tables (meshes, mesh_vaults, mesh_edges, mesh_subscriptions) from each registered mesh's main vault `.lyt/mesh.yon` SoT. Per-mesh transactions; parse errors per-mesh skip-and-warn.",
    )
    .option(
      "--mesh <name>",
      "Restrict the rebuild to a single mesh by name (default = every registered mesh)",
    )
    .option("--now-iso <iso>", "Reserved for future deterministic-timestamp use")
    .option("--json", "Emit a JSON result instead of the human-readable summary")
    .action(async (opts: RebuildMeshRegistryCliOpts) => {
      try {
        const res = await rebuildMeshRegistryFlow({
          ...(opts.mesh !== undefined ? { meshName: opts.mesh } : {}),
          ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
        });

        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(res, null, 2));
        } else {
          emitHumanSummary(res.meshes, res.totalsByTable, res.durationMs);
        }

        // exit code: 1 only if ALL meshes failed (totally-failed
        // signal). 0 when at least one mesh succeeded OR the registry
        // has zero meshes.
        const failed = res.meshes.filter((m) => m.status !== "ok").length;
        if (res.meshes.length > 0 && failed === res.meshes.length) {
          process.exitCode = 1;
        }
      } catch (err) {
        if (err instanceof MeshNotFoundError) {
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

function emitHumanSummary(
  outcomes: MeshRebuildOutcome[],
  totals: { meshes: number; mesh_vaults: number; mesh_edges: number; mesh_subscriptions: number },
  durationMs: number,
): void {
  const okCount = outcomes.filter((o) => o.status === "ok").length;
  const failCount = outcomes.length - okCount;
  // eslint-disable-next-line no-console
  console.log(
    `Rebuilt mesh registry from disk YONs: ${okCount} mesh${okCount === 1 ? "" : "es"} ok, ${failCount} parse error${failCount === 1 ? "" : "s"}, ${totals.mesh_edges} edge${totals.mesh_edges === 1 ? "" : "s"} + ${totals.mesh_subscriptions} subscription${totals.mesh_subscriptions === 1 ? "" : "s"} + ${totals.mesh_vaults} home row${totals.mesh_vaults === 1 ? "" : "s"}; ${durationMs}ms.`,
  );
  for (const o of outcomes) {
    if (o.status === "ok") continue;
    // eslint-disable-next-line no-console
    console.log(`  ${o.status === "parse-error" ? "✗" : "·"} ${o.meshName}: ${o.error ?? o.status}`);
  }
}
