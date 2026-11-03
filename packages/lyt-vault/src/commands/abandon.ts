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
import { deleteWithReceipt } from "../flows/vault-delete-receipt.js";

export function buildAbandonCommand(): Command {
  return new Command("abandon")
    .description("Remove only local .lyt adoption state. Markdown and remote are untouched. Requires --yes.")
    .argument("[name]", "Registered vault name")
    .option("--resume <operation-id>", "Inspect an interrupted receipt-bound abandon")
    .option("--yes", "Confirm abandoning the vault")
    .option("--json", "Emit Receipt V1 JSON")
    .action(async (name: string | undefined, opts: { resume?: string; yes?: boolean; json?: boolean }) => {
      const result = await deleteWithReceipt({ action: "abandon", confirmed: opts.yes === true, ...(name === undefined ? {} : { name }),
        ...(opts.resume === undefined ? {} : { resume: opts.resume }), onPlan: (id) => console.error(`Abandon operation ${id}`) });
      console.log(opts.json ? JSON.stringify(result) : `${result.status}: operation ${result.operation_id}. Markdown and remote untouched.${result.next_action ? ` ${result.next_action.summary}` : ""}`);
      process.exitCode = result.exit_code;
    });
}
