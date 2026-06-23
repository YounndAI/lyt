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

import { vaultInvitesFlow } from "../flows/invites.js";

export function buildInvitesCommand(): Command {
  const cmd = new Command("invites");
  cmd
    .description(
      "List your pending GitHub repository invitations, or accept one with --accept <id> --yes.",
    )
    .option("--accept <id>", "Accept the pending invitation with this gh id (requires --yes)")
    .option("--yes", "Confirm accepting the invitation")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts: { accept?: string; yes?: boolean; json?: boolean }) => {
      try {
        let acceptId: number | undefined;
        if (opts.accept !== undefined) {
          acceptId = Number(opts.accept);
          if (!Number.isInteger(acceptId) || acceptId <= 0) {
            throw new Error(`invalid --accept value '${opts.accept}' — expected a positive integer id.`);
          }
        }

        const result = await vaultInvitesFlow({
          accept: acceptId,
          confirmed: opts.yes === true,
        });

        if (opts.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.action === "accepted") {
          // eslint-disable-next-line no-console
          console.log(`Accepted repository invitation ${result.id}.`);
          return;
        }

        if (result.invitations.length === 0) {
          // eslint-disable-next-line no-console
          console.log("No pending GitHub repository invitations.");
          return;
        }
        // eslint-disable-next-line no-console
        console.log("Pending GitHub repository invitations:");
        for (const inv of result.invitations) {
          // eslint-disable-next-line no-console
          console.log(`  [${inv.id}] ${inv.repo} — from ${inv.inviter} (${inv.permission})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(msg);
        process.exitCode = 1;
      }
    });
  return cmd;
}
