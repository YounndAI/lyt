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

import { checkCurrency, formatCurrencyLine } from "@younndai/lyt-vault";

interface OutdatedCliOpts {
  json?: boolean;
}

// stay-current slice — `lyt outdated`: read-only currency check against the
// published npm alpha channel. Mirrors `npm outdated` (check, don't install;
// exit 1 when a newer version exists). Explicit → always a fresh probe.
export function buildOutdatedCommand(): Command {
  return new Command("outdated")
    .description(
      "Check whether a newer published Lyt version is available (npm alpha channel). Read-only; run `lyt update` to upgrade.",
    )
    .option("--json", "Emit a JSON result instead of the human-readable line")
    .action(async (opts: OutdatedCliOpts) => {
      const result = await checkCurrency({ force: true });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
      } else {
        // eslint-disable-next-line no-console
        console.log(formatCurrencyLine(result));
      }
      // npm-outdated convention: non-zero exit when behind. Offline can't
      // determine currency → exit 0 (never fail a script over an unreachable
      // registry).
      process.exitCode = result.stale ? 1 : 0;
    });
}
