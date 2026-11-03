/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Command } from "commander";
import { unsubscribeWithReceipt } from "../flows/unsubscribe-receipt.js";

export function buildMeshUnsubscribeSubcommand(): Command {
  return new Command("unsubscribe")
    .description("Retract one orphan subscription by exact coordinate and RID. Does not delete local files or the remote repository.")
    .option("--coordinate <coordinate>", "Exact GitHub vault coordinate")
    .option("--rid <rid>", "Expected vault RID")
    .option("--resume <operation-id>", "Resume an interrupted exact retraction")
    .option("--yes", "Confirm retraction")
    .option("--json", "Emit JSON")
    .action(async (opts: { coordinate?: string; rid?: string; resume?: string; yes?: boolean; json?: boolean }) => {
      try {
        const result = await unsubscribeWithReceipt({ ...(opts.coordinate === undefined ? {} : { coordinate: opts.coordinate }), ...(opts.rid === undefined ? {} : { rid: opts.rid }), ...(opts.resume === undefined ? {} : { resume: opts.resume }), confirmed: opts.yes === true,
          onPlan: (id) => console.error(`Unsubscribe operation ${id}; resume with --resume ${id} --yes if interrupted.`) });
        console.log(opts.json ? JSON.stringify(result) : `${result.status}: operation ${result.operation_id}; local files and remote repository untouched.`);
      } catch (error) {
        console.error(`lyt mesh unsubscribe: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
