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
  AddMeshEdgeMainVaultMissingError,
  AddMeshEdgeNoHomeMeshError,
  AddMeshEdgeVaultNotFoundError,
  addMeshEdgeFlow,
  type AddMeshEdgeResult,
} from "../flows/add-mesh-edge.js";

// v1.C.1 — `lyt mesh add-edge --child <name> --parent <name> [--json]`.
//
// Writes a single @MESH_EDGE row into the parent's home mesh's mesh.yon
// (the REFERENCING mesh; the child's home mesh is unaware per federation-
// design §3:155-157 asymmetric awareness). The libSQL `mesh_edges` cache
// row is inserted in the same transaction; on cache insert failure the
// tmp+rename is abandoned and disk is pristine.
//
// Structured error contract (per the ratified default):
// exit 0 edge written OR edge-already-present (idempotent re-emit)
// exit 1 vault-not-found (--child or --parent), vault-no-home-mesh
// exit 4 main-vault-missing (parent's home mesh's main vault not in registry)

interface AddMeshEdgeCliOpts {
  child?: string;
  parent?: string;
  json?: boolean;
}

export function buildMeshAddEdgeSubcommand(): Command {
  return new Command("add-edge")
    .description(
      "v1.C.1: write a parent-child @MESH_EDGE into the parent's home mesh's mesh.yon (asymmetric — referenced child's mesh.yon untouched). Both vaults must be in the local registry; the parent's home mesh main vault must exist locally (mesh.yon writes only land on main vaults per naming-convention).",
    )
    .requiredOption(
      "--child <name>",
      "Child vault — becomes the home (referenced) side of the parent-child edge",
    )
    .requiredOption(
      "--parent <name>",
      "Parent vault — its home mesh's mesh.yon receives the @MESH_EDGE record",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: AddMeshEdgeCliOpts) => {
      const json = opts.json === true;
      try {
        const result = await addMeshEdgeFlow({
          childVaultName: opts.child!,
          parentVaultName: opts.parent!,
        });
        if (json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        emitHuman(result);
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

function emitHuman(r: AddMeshEdgeResult): void {
  if (r.status === "edge-already-present") {
    // eslint-disable-next-line no-console
    console.log(`Edge already present in ${r.meshYonPath} (no mesh.yon mutation).`);
    // eslint-disable-next-line no-console
    console.log(`  parent: ${r.parent.name} (vault:${r.parent.ridHex})`);
    // eslint-disable-next-line no-console
    console.log(`  child:  ${r.child.name} (vault:${r.child.ridHex})`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`Wrote @MESH_EDGE to ${r.meshYonPath}`);
  // eslint-disable-next-line no-console
  console.log(`  parent: ${r.parent.name} (vault:${r.parent.ridHex})`);
  // eslint-disable-next-line no-console
  console.log(`  child:  ${r.child.name} (vault:${r.child.ridHex})`);
  // eslint-disable-next-line no-console
  console.log(`  mesh:   ${r.parent.homeMeshName} (mesh:${r.parent.homeMeshRidHex})`);
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof AddMeshEdgeVaultNotFoundError) return 1;
  if (err instanceof AddMeshEdgeNoHomeMeshError) return 1;
  if (err instanceof AddMeshEdgeMainVaultMissingError) return 4;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof AddMeshEdgeVaultNotFoundError) {
    return {
      error: err.errorCode,
      vault_name: err.vaultName,
      side: err.side,
      message: err.message,
    };
  }
  if (err instanceof AddMeshEdgeNoHomeMeshError) {
    return {
      error: err.errorCode,
      vault_name: err.vaultName,
      side: err.side,
      message: err.message,
    };
  }
  if (err instanceof AddMeshEdgeMainVaultMissingError) {
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
    console.error(`lyt mesh add-edge: ${String(body["message"] ?? body["error"])}`);
  }
}
