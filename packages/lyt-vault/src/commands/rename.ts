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
  MainVaultImmutableError,
  RenameVaultNotFoundError,
  renameVaultFlow,
  VaultNameTakenError,
} from "../flows/rename.js";

// v1.B.3 Commit 3 — `lyt vault rename <old> <new>`.
//
// Refusing main vault rename closes v1.B.1 retro clause `g`.

interface RenameCliOpts {
  json?: boolean;
}

export function buildRenameCommand(): Command {
  return new Command("rename")
    .description(
      "v1.B.3: rename a vault. Refuses any name involving 'main' — main vaults are structurally locked per federation-design §3. Emits a @AUDIT vault.renamed ledger record.",
    )
    .argument("<old>", "Existing vault name (e.g., 'personal/notes')")
    .argument("<new>", "New vault name (slug-safe; lowercase; depth 1)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (oldName: string, newName: string, opts: RenameCliOpts) => {
      try {
        const result = await renameVaultFlow({ oldName, newName });

        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`Renamed vault '${result.oldName}' → '${result.newName}'`);
        // eslint-disable-next-line no-console
        console.log(`  rid:        vault:${result.vaultRidHex} (stable)`);
        // eslint-disable-next-line no-console
        console.log(`  old path:   ${result.oldPath}`);
        // eslint-disable-next-line no-console
        console.log(`  new path:   ${result.newPath}`);
        if (result.meshName !== null) {
          // eslint-disable-next-line no-console
          console.log(
            `  mesh:       '${result.meshName}'${result.meshYonUpdated ? " (mesh.yon @MESH_HOME updated)" : " (mesh.yon update skipped — check 'lyt mesh fsck')"}`,
          );
        }
        if (result.auditRecorded === false) {
          // eslint-disable-next-line no-console
          console.warn(
            " audit: EMISSION FAILED (rename body landed; run 'lyt vault rebuild-index --ledger audit' to reconstruct)",
          );
        }
      } catch (err) {
        const exitCode = mapErrorToExitCode(err);
        if (exitCode !== null) {
          const body = errorToJsonBody(err);
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.error(JSON.stringify(body, null, 2));
          } else {
            // eslint-disable-next-line no-console
            console.error(`lyt vault rename: ${String(body["message"] ?? body["error"])}`);
          }
          process.exitCode = exitCode;
          return;
        }
        throw err;
      }
    });
}

function mapErrorToExitCode(err: unknown): number | null {
  if (err instanceof MainVaultImmutableError) return 2;
  if (err instanceof VaultNameTakenError) return 2;
  if (err instanceof RenameVaultNotFoundError) return 2;
  // validateVaultName throws plain Error for slug-violations; surface as
  // exit 2 too.
  if (err instanceof Error && err.message.includes("Vault name")) return 2;
  return null;
}

function errorToJsonBody(err: unknown): Record<string, unknown> {
  if (err instanceof MainVaultImmutableError) {
    return { error: err.errorCode, message: err.message };
  }
  if (err instanceof VaultNameTakenError) {
    return { error: err.errorCode, new_name: err.newName, message: err.message };
  }
  if (err instanceof RenameVaultNotFoundError) {
    return { error: err.errorCode, vault_name: err.vaultName, message: err.message };
  }
  return { error: "validation-error", message: err instanceof Error ? err.message : String(err) };
}
