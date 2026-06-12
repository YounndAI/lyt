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
  setMeshDefaultCadenceFlow,
  MeshUpdateCadenceNotFoundError,
} from "../flows/mesh-update-cadence.js";

// v1.B.6 — `lyt mesh update-cadence <mesh> --default-vault-cadence <spec>
// [--json]`. Sets @MESH.default_vault_update_cadence — the mesh-level
// fallback applied when a home vault has no @UPDATE_CADENCE of its own.

interface MeshUpdateCadenceCliOpts {
  defaultVaultCadence?: string;
  json?: boolean;
}

export function buildMeshUpdateCadenceSubcommand(): Command {
  return new Command("update-cadence")
    .description(
      "v1.B.6: set the mesh-level default sync cadence (fallback for home vaults without their own @UPDATE_CADENCE). Writes @MESH.default_vault_update_cadence into the mesh.yon.",
    )
    .argument("<mesh>", "Mesh name (must be registered locally)")
    .requiredOption(
      "--default-vault-cadence <spec>",
      "POSIX 5-field cron expression applied as the per-vault fallback (e.g. '0 9 * * 1')",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (meshName: string, opts: MeshUpdateCadenceCliOpts) => {
      try {
        const result = await setMeshDefaultCadenceFlow({
          meshName,
          defaultCadence: opts.defaultVaultCadence!,
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                mesh: { name: result.meshName, rid_hex: result.meshRidHex },
                previous_default: result.previousDefault,
                new_default: result.newDefault,
                mesh_yon_path: result.meshYonPath,
                duration_ms: result.durationMs,
              },
              null,
              2,
            ),
          );
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Set @MESH.default_vault_update_cadence on '${result.meshName}' to '${result.newDefault}'.`,
        );
        if (result.previousDefault !== null) {
          // eslint-disable-next-line no-console
          console.log(`  previous: ${result.previousDefault}`);
        }
        // eslint-disable-next-line no-console
        console.log(`  mesh.yon: ${result.meshYonPath}`);
      } catch (err) {
        const status = mapErrorToExitCode(err);
        const body = errorToJsonBody(err);
        emitError(opts.json === true, body);
        process.exitCode = status ?? 1;
      }
    });
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof MeshUpdateCadenceNotFoundError) return 2;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof MeshUpdateCadenceNotFoundError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  return { error: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function emitError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt mesh update-cadence: ${String(body["message"] ?? body["error"])}`);
  }
}
