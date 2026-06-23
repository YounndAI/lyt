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

import { vaultAccessFlow } from "../flows/access.js";

export function buildAccessCommand(): Command {
  const cmd = new Command("access");
  cmd
    .description(
      "Show a vault's live GitHub collaborator access and reconcile it against LYT subscriptions (read-only).",
    )
    .argument("<name>", "Registered vault name")
    .option("--can-i-share", "Print only whether you can share this vault")
    .option("--json", "Emit machine-readable JSON")
    .action(async (name: string, opts: { canIShare?: boolean; json?: boolean }) => {
      try {
        const result = await vaultAccessFlow(
          { vaultName: name },
          { canIShareOnly: opts.canIShare === true },
        );

        if (opts.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (opts.canIShare) {
          // eslint-disable-next-line no-console
          console.log(
            result.canShare
              ? `Yes — you can share '${result.vault}'.`
              : `No — you cannot share '${result.vault}' (no push/admin on the repo).`,
          );
          return;
        }

        // eslint-disable-next-line no-console
        console.log(`Access for '${result.vault}' (GitHub collaborators — gh is the source of truth):`);
        if (result.grants.length === 0) {
          // eslint-disable-next-line no-console
          console.log("  (no collaborators)");
        } else {
          for (const g of result.grants) {
            // eslint-disable-next-line no-console
            console.log(`  ${g.caller} — ${g.level}`);
          }
        }

        // eslint-disable-next-line no-console
        console.log(`LYT subscriptions referencing this vault: ${result.subscribers.length}`);
        for (const s of result.subscribers) {
          // eslint-disable-next-line no-console
          console.log(`  mesh '${s.subscribingMeshName}'`);
        }

        if (result.drift) {
          if (result.drift.ghOnly) {
            // eslint-disable-next-line no-console
            console.log(
              "Drift: gh reports collaborators but LYT records no subscription for this vault.",
            );
          }
          if (result.drift.subscriptionsWithoutGhAccess) {
            // eslint-disable-next-line no-console
            console.log(
              "Drift: LYT records subscriptions but gh reports no collaborators (access may be gone).",
            );
          }
        }

        // eslint-disable-next-line no-console
        console.log(`You can share this vault: ${result.canShare ? "yes" : "no"}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(msg);
        process.exitCode = 1;
      }
    });
  return cmd;
}
