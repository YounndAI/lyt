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
  meshInfoFlow,
  MeshInfoNotFoundError,
  MeshInfoRemoteGhUnavailableError,
  MeshInfoRemoteMeshYonMissingError,
} from "../flows/mesh-info.js";
import { withSpinner } from "../util/spinner.js";

// v1.B.6 — `lyt mesh info <mesh> [--remote] [--json]`. Surfaces @MESH +
// @MESH_HOME metadata from the mesh's .lyt/mesh.yon SoT (local mode) or
// peeks at the mesh.yon WITHOUT cloning under --remote (via gh api).
// Fed-v2 Slice 1b (#13 DELETE): @MESH_PUBLIC/@UPDATE_CADENCE removed.

interface MeshInfoCliOpts {
  remote?: boolean;
  json?: boolean;
}

export function buildMeshInfoSubcommand(): Command {
  return new Command("info")
    .description(
      "Show metadata for a mesh — @MESH + home vaults. --remote peeks at the mesh.yon via gh api without cloning.",
    )
    .argument(
      "<mesh>",
      "Mesh name (must be registered locally; --remote uses the registered push_target)",
    )
    .option(
      "--remote",
      "Peek at the published mesh.yon via gh api repos/<owner>/<mesh-main>/contents/.lyt/mesh.yon (no clone). Requires the mesh to be registered with a push_target.",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (meshName: string, opts: MeshInfoCliOpts) => {
      try {
        // V-DX-1 — liveness spinner over the mesh.yon read (esp. --remote,
        // which is a gh-api peek). --json stays spinner-free; non-TTY prints
        // "Reading…" once (zero escape codes). The one-shot non-TTY line
        // always shows the primary word; "Fetching" is only the op's >3s
        // TTY-animated synonym, never the piped line.
        const result =
          opts.json !== true
            ? await withSpinner(
                meshName,
                () => meshInfoFlow({ meshName, remote: opts.remote === true }),
                { op: "mesh-info" },
              )
            : await meshInfoFlow({ meshName, remote: opts.remote === true });

        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Human-readable output.
        // eslint-disable-next-line no-console
        console.log(`Mesh '${result.mesh.name}' (${result.source})`);
        // eslint-disable-next-line no-console
        console.log(`  rid:              ${result.mesh.rid}`);
        if (result.mesh.pushTarget !== null) {
          // eslint-disable-next-line no-console
          console.log(`  push target:      ${result.mesh.pushKind}:${result.mesh.pushTarget}`);
        }
        // eslint-disable-next-line no-console
        console.log(`  main vault rid:   ${result.mesh.mainVaultRid}`);
        // eslint-disable-next-line no-console
        console.log(`  created at:       ${result.mesh.createdAt}`);
        // eslint-disable-next-line no-console
        console.log(`  home vaults:      ${result.homeVaults.length}`);
        for (const h of result.homeVaults) {
          // eslint-disable-next-line no-console
          console.log(`    - ${h.vaultName} (${h.vaultRid})`);
        }
      } catch (err) {
        const status = mapErrorToExitCode(err);
        const body = errorToJsonBody(err);
        emitError(opts.json === true, body);
        process.exitCode = status ?? 1;
      }
    });
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof MeshInfoNotFoundError) return 2;
  if (err instanceof MeshInfoRemoteGhUnavailableError) return 4;
  if (err instanceof MeshInfoRemoteMeshYonMissingError) return 4;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof MeshInfoNotFoundError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  if (err instanceof MeshInfoRemoteGhUnavailableError) {
    return { error: err.errorCode, mesh_name: err.meshName, message: err.message };
  }
  if (err instanceof MeshInfoRemoteMeshYonMissingError) {
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
    console.error(`lyt mesh info: ${String(body["message"] ?? body["error"])}`);
  }
}
