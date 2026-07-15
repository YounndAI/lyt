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
  acceptShareFlow,
  AcceptShareBadRepoError,
  InvitationNotFoundError,
} from "../flows/accept-share.js";

// Inc-2 Phase B / #2 (0.12.1) — `lyt vault accept-share --invite <id> --yes`.
// Accepts a pending GitHub repository invitation for a PRIVATELY-shared vault and
// receives it into the owner-keyed `shared/{owner}` bucket (source='shared',
// auto-indexed). Sibling of `lyt vault invites --accept` (which only accepts the
// gh invite) — accept-share ALSO clones + homes + indexes in one verb.
export function buildAcceptShareCommand(): Command {
  const cmd = new Command("accept-share");
  cmd
    .description(
      "Accept a pending GitHub invitation for a privately-shared vault and receive it into " +
        "shared/{owner} (auto-indexed). Requires --yes.",
    )
    .requiredOption("--invite <id>", "The gh invitation id to accept (see 'lyt vault invites')")
    .option("--yes", "Confirm the accept + clone")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts: { invite: string; yes?: boolean; json?: boolean }) => {
      try {
        const inviteId = Number(opts.invite);
        if (!Number.isInteger(inviteId) || inviteId <= 0) {
          throw new Error(
            `invalid --invite value '${opts.invite}' — expected a positive integer id.`,
          );
        }

        const result = await acceptShareFlow({
          inviteId,
          confirmed: opts.yes === true,
        });

        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // eslint-disable-next-line no-console
        console.log(
          `Accepted share (invitation ${result.invitationId}): received '${result.vault.name}' ` +
            `into '${result.vault.homeMeshName}' (source=shared).`,
        );
        // eslint-disable-next-line no-console
        console.log(`  path: ${result.vault.path}`);
      } catch (err) {
        if (err instanceof InvitationNotFoundError || err instanceof AcceptShareBadRepoError) {
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.error(JSON.stringify({ error: err.errorCode, message: err.message }, null, 2));
          } else {
            // eslint-disable-next-line no-console
            console.error(err.message);
          }
          process.exitCode = 1;
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(msg);
        process.exitCode = 1;
      }
    });
  return cmd;
}
