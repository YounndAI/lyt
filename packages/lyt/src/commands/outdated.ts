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

import { createRequire } from "node:module";

import { Command, InvalidArgumentError } from "commander";

import {
  checkCurrency,
  formatCurrencyLine,
  isUpdateChannel,
  type UpdateChannel,
} from "@younndai/lyt-vault";

interface OutdatedCliOpts {
  json?: boolean;
  channel?: UpdateChannel;
}

function parseChannel(value: string): UpdateChannel {
  if (isUpdateChannel(value)) return value;
  throw new InvalidArgumentError("--channel must be alpha or latest");
}

function readMetaVersion(): string {
  return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
}

// stay-current slice — `lyt outdated`: read-only currency check against the
// selected npm channel. Mirrors `npm outdated` (check, don't install; exit 1
// when a newer version exists). An unconfigured channel does not guess: JSON
// and non-TTY callers receive the structured channel-unconfigured result.
export function buildOutdatedCommand(): Command {
  return new Command("outdated")
    .description(
      "Check whether a newer published Lyt version is available on the configured channel. Read-only; use --channel alpha|latest for an unconfigured machine.",
    )
    .option("--json", "Emit a JSON result instead of the human-readable line")
    .option(
      "--channel <alpha|latest>",
      "Check one explicit channel without changing the saved selection",
      parseChannel,
    )
    .action(async (opts: OutdatedCliOpts) => {
      const result = await checkCurrency({
        force: true,
        channel: opts.channel,
        installedVersion: readMetaVersion(),
      });
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
      } else {
        // eslint-disable-next-line no-console
        console.log(formatCurrencyLine(result));
      }
      // `channel-unconfigured` is a deliberate policy refusal, distinct from
      // an unreachable registry. npm-outdated convention remains exit 1 when
      // the selected target is newer.
      process.exitCode = result.channelUnconfigured ? 2 : result.stale ? 1 : 0;
    });
}
