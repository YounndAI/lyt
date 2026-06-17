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
  AliasNameInvalidError,
  AliasTargetNotFoundError,
  listAliasesFlow,
  removeAliasFlow,
  setAliasFlow,
} from "../flows/alias.js";

// 0.9.4 (F) — `lyt alias <name> <target>` binds a pod-local name to a
// vault rid (survives rename + move; resolves in the addressing chokepoint).
// lyt alias ro company/company-ro → set
// lyt alias --list → list
// lyt alias --remove ro → remove
interface AliasCliOpts {
  list?: boolean;
  remove?: string;
  json?: boolean;
}

export function buildAliasCommand(): Command {
  return new Command("alias")
    .description(
      "Bind a pod-local name to a vault (alias → rid; survives rename + move). Pod-local: synced across your own pod, never to subscribers.",
    )
    .argument("[name]", "Alias name (no '/'; reserved for {mesh}/{vault})")
    .argument("[target]", "Vault to point at ({mesh}/{vault}, bare leaf, or another alias)")
    .option("--list", "List all pod-local aliases")
    .option("--remove <name>", "Remove an alias")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (name: string | undefined, target: string | undefined, opts: AliasCliOpts) => {
      try {
        if (opts.remove !== undefined) {
          const removed = await removeAliasFlow(opts.remove);
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify({ removed, alias: opts.remove }, null, 2));
          } else if (removed) {
            // eslint-disable-next-line no-console
            console.log(`Removed alias '${opts.remove}'`);
          } else {
            // eslint-disable-next-line no-console
            console.error(`lyt alias: no alias named '${opts.remove}'.`);
            process.exitCode = 2;
          }
          return;
        }

        if (opts.list === true || name === undefined) {
          const result = await listAliasesFlow();
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          if (result.aliases.length === 0) {
            // eslint-disable-next-line no-console
            console.log("(no pod-local aliases — run 'lyt alias <name> <target>' to add one)");
            return;
          }
          for (const a of result.aliases) {
            // eslint-disable-next-line no-console
            console.log(`${a.alias} → ${a.targetDisplayName}  (vault:${a.vaultRidHex})`);
          }
          return;
        }

        if (target === undefined) {
          // eslint-disable-next-line no-console
          console.error("lyt alias: a target is required (e.g. 'lyt alias ro company/company-ro').");
          process.exitCode = 2;
          return;
        }

        const result = await setAliasFlow(name, target);
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Aliased '${result.alias}' → '${result.targetDisplayName}' (vault:${result.vaultRidHex})`,
        );
      } catch (err) {
        if (err instanceof AliasTargetNotFoundError || err instanceof AliasNameInvalidError) {
          if (opts.json === true) {
            // eslint-disable-next-line no-console
            console.error(JSON.stringify({ error: err.errorCode, message: err.message }, null, 2));
          } else {
            // eslint-disable-next-line no-console
            console.error(err.message);
          }
          process.exitCode = 2;
          return;
        }
        throw err;
      }
    });
}
