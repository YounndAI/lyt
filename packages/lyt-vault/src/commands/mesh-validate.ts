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
  MeshValidateNotFoundError,
  validateMeshEdgesFlow,
  type ValidateMeshEdgesResult,
} from "../flows/mesh-validate.js";

// v1.C.1 — `lyt mesh validate [--mesh <name>] [--json]`.
//
// Read-only diagnostic that walks every registered mesh (or one filtered
// via `--mesh <name>`) and inspects every @MESH_EDGE row for resolvable
// ref/home vault registrations + reachable home-mesh main vault on disk.
// Surfaces broken edges as `status='warn'` CheckResult rows. Cache-drift
// (mesh.yon ↔ mesh_edges disagreement) is surfaced as a separate warn-row
// per the ratified default.
//
// Exit-code mapping (per the ratified default; matches v1.B.5 doctor `2 = warnings only`
// posture):
// 0 — every edge resolves OR no edges to check
// 2 — one or more warn-rows present (never fail; diagnostic only)

interface MeshValidateCliOpts {
  mesh?: string;
  json?: boolean;
}

export function buildMeshValidateSubcommand(): Command {
  return new Command("validate")
    .description(
      "Read-only diagnostic — walks every registered mesh's mesh.yon and verifies every @MESH_EDGE row resolves (ref/home vaults registered + home mesh main vault on disk + libSQL cache in sync); also surfaces mesh.yon parse errors as MeshFileFinding rows. (Subscriptions live in the per-writer ledger, not mesh.yon, so subscription validation is not part of this check.) Per-finding warn rows with remediation hints. Exit 2 = warnings only. This verb is read-only — see `lyt repair` for the write side.",
    )
    .option(
      "--mesh <name>",
      "Restrict the validation to a single mesh by name (default = every registered mesh)",
    )
    .option("--json", "Emit deterministic JSON CheckResult[] instead of human-readable summary")
    .action(async (opts: MeshValidateCliOpts) => {
      const json = opts.json === true;
      try {
        const result = await validateMeshEdgesFlow({
          ...(opts.mesh !== undefined ? { meshName: opts.mesh } : {}),
        });
        if (json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
        } else {
          emitHumanSummary(result);
        }
        process.exitCode = result.exitCode;
      } catch (err) {
        if (err instanceof MeshValidateNotFoundError) {
          if (json) {
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

function emitHumanSummary(r: ValidateMeshEdgesResult): void {
  // eslint-disable-next-line no-console
  console.log(
    `Validated ${r.summary.meshesValidated} mesh${r.summary.meshesValidated === 1 ? "" : "es"}; ${r.summary.edgesValidated} edge${r.summary.edgesValidated === 1 ? "" : "s"} inspected; ${r.summary.warnings} warning${r.summary.warnings === 1 ? "" : "s"}.`,
  );
  for (const c of r.checks) {
    if (c.status === "warn") {
      // eslint-disable-next-line no-console
      console.warn(`  ⚠ ${c.label}: ${c.message}`);
      if (c.remediation !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(`      → ${c.remediation}`);
      }
    }
  }
}
