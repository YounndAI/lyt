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

import { registryRebuildFlow } from "../flows/rebuild.js";
import { registryResetFlow } from "../flows/registry-reset.js";

export function buildRegistryCommand(): Command {
  const cmd = new Command("registry").description("Manage the per-machine Lyt registry");

  cmd
    .command("reset")
    .description(
      "Wipe ~/lyt/registry.db, ~/lyt/known-paths.txt, and every directory under ~/lyt/vaults/. " +
        "Lyt never touches paths outside ~/lyt/. Requires --yes to proceed.",
    )
    .option("--yes", "Confirm the destructive reset")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts: { yes?: boolean; json?: boolean }) => {
      try {
        const result = await registryResetFlow({ confirmed: opts.yes === true });
        if (opts.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`Registry reset complete (scope: ${result.lytHome}).`);
        // eslint-disable-next-line no-console
        console.log(`  registry.db:      ${result.registryRemoved ? "removed" : "not present"}`);
        // eslint-disable-next-line no-console
        console.log(`  known-paths.txt:  ${result.knownPathsRemoved ? "removed" : "not present"}`);
        // eslint-disable-next-line no-console
        console.log(`  vault dirs:       ${result.vaultDirsRemoved.length} removed`);
        for (const v of result.vaultDirsRemoved) {
          // eslint-disable-next-line no-console
          console.log(`    - ${v}`);
        }
        if (result.skipped.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`  skipped:          ${result.skipped.length}`);
          for (const s of result.skipped) {
            // eslint-disable-next-line no-console
            console.log(`    - ${s.name} (${s.reason})`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(msg);
        process.exitCode = 1;
      }
    });

  cmd
    .command("rebuild")
    .description(
      "Rebuild ~/lyt/registry.db from disk: scan ~/lyt/vaults/ + ~/lyt/known-paths.txt, " +
        "read each .lyt/vault.yon, repopulate the registry.",
    )
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts: { json?: boolean }) => {
      const result = await registryRebuildFlow();
      if (opts.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`Registry rebuild complete.`);
      // eslint-disable-next-line no-console
      console.log(`  scanned:    ${result.scanned.length} path(s)`);
      // eslint-disable-next-line no-console
      console.log(`  registered: ${result.registered.length} vault(s)`);
      for (const v of result.registered) {
        // eslint-disable-next-line no-console
        console.log(`    ${v.name} (${v.ridHex}) @ ${v.path}`);
      }
      if (result.skipped.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  skipped:    ${result.skipped.length}`);
        for (const s of result.skipped) {
          // eslint-disable-next-line no-console
          console.log(`    ${s.path} — ${s.reason}`);
        }
      }
    });

  return cmd;
}
