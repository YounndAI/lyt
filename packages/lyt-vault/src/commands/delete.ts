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
import type { deleteVaultFlow } from "../flows/delete.js";
import { deleteWithReceipt } from "../flows/vault-delete-receipt.js";

export function buildDeleteCommand(dependencies: { deleteVaultFlow?: typeof deleteVaultFlow } = {}): Command {
  return new Command("delete")
    .description("Remove local .lyt state. Markdown and remote are untouched. Requires --yes.")
    .argument("[name]", "Registered vault name")
    .option("--no-tombstone", "Remove the registry row instead of tombstoning it")
    .option("--resume <operation-id>", "Inspect an interrupted receipt-bound delete")
    .option("--yes", "Confirm deleting local Lyt state")
    .option("--json", "Emit Receipt V1 JSON")
    .action(async (name: string | undefined, opts: { tombstone?: boolean; resume?: string; yes?: boolean; json?: boolean }) => {
      if (opts.yes !== true) throw new Error(`Refusing to delete '${name ?? "vault"}' without explicit confirmation. Pass --yes to proceed.`);
      if (opts.resume !== undefined && opts.tombstone === false) throw new Error("Resume cannot change the tombstone choice.");
      if (dependencies.deleteVaultFlow !== undefined) {
        if (!name) throw new Error("A vault name is required.");
        await dependencies.deleteVaultFlow(name, { noTombstone: opts.tombstone === false });
        return;
      }
      const result = await deleteWithReceipt({ action: "delete", confirmed: true, ...(name === undefined ? {} : { name }),
        ...(opts.resume === undefined ? { noTombstone: opts.tombstone === false } : { resume: opts.resume }),
        onPlan: (id) => console.error(`Delete operation ${id}`) });
      console.log(opts.json ? JSON.stringify(result) : `${result.status}: operation ${result.operation_id}. Markdown and remote untouched.${result.next_action ? ` ${result.next_action.summary}` : ""}`);
      process.exitCode = result.exit_code;
    });
}
