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
import { forgetWithReceipt } from "../flows/vault-forget-receipt.js";

export function buildForgetCommand(): Command {
  return new Command("forget")
    .description("Remove a local registry binding without touching vault files or the remote.")
    .argument("[name]", "Registered vault name")
    .option("--tombstone", "Leave a tombstoned registry row")
    .option("--resume <operation-id>", "Resume an interrupted, receipt-bound forget")
    .option("--json", "Emit Receipt V1 JSON")
    .action(async (name: string | undefined, opts: { tombstone?: boolean; resume?: string; json?: boolean }) => {
      const result = await forgetWithReceipt({ ...(name === undefined ? {} : { name }), ...(opts.tombstone === undefined ? {} : { tombstone: opts.tombstone }), ...(opts.resume === undefined ? {} : { resume: opts.resume }),
        onPlan: (id) => { console.error(`Forget operation ${id}`); } });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(`${result.status}: operation ${result.operation_id}. Vault files and remote were not touched.${result.next_action ? ` ${result.next_action.summary}` : ""}`);
      process.exitCode = result.exit_code;
    });
}
