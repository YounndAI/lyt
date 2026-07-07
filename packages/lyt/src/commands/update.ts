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

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";

import {
  checkCurrency,
  CURRENCY_DIST_TAG,
  CURRENCY_PACKAGE,
  formatCurrencyLine,
  resolveUpdateAction,
  type CurrencyResult,
} from "@younndai/lyt-vault";

interface UpdateCliOpts {
  check?: boolean;
  yes?: boolean;
}

// Injected effects — so the safety gate (decision → dispatch) is unit-testable
// without touching the network, readline, or a real global npm install.
export interface UpdateEffects {
  log: (msg: string) => void;
  error: (msg: string) => void;
  confirm: (prompt: string) => Promise<boolean>;
  /** Runs the global install; returns npm's exit status (0 = success). */
  install: () => number;
}

export interface UpdateFlowResult {
  installed: boolean;
  exitCode: number;
}

// The load-bearing safety flow: map the currency result → an action → effects.
// `install()` is reached ONLY via `proceed` (explicit --yes) or an affirmative
// `needs-confirm` — a non-interactive run without --yes returns exitCode 1 and
// NEVER installs. All effects are injected, so this whole gate is tested headless.
export async function runUpdateFlow(
  result: CurrencyResult,
  opts: { yes?: boolean; interactive: boolean },
  fx: UpdateEffects,
): Promise<UpdateFlowResult> {
  const action = resolveUpdateAction(result, { yes: opts.yes, interactive: opts.interactive });
  switch (action.kind) {
    case "offline":
      fx.error(action.message);
      return { installed: false, exitCode: 0 };
    case "current":
      fx.log(action.message);
      return { installed: false, exitCode: 0 };
    case "blocked-noninteractive":
      fx.error(action.message);
      return { installed: false, exitCode: 1 };
    case "needs-confirm": {
      const ok = await fx.confirm(`${action.message} [y/N] `);
      if (!ok) {
        fx.log("Update cancelled.");
        return { installed: false, exitCode: 0 };
      }
      return finishInstall(fx);
    }
    case "proceed":
      fx.log(action.message);
      return finishInstall(fx);
  }
}

function finishInstall(fx: UpdateEffects): UpdateFlowResult {
  const status = fx.install();
  if (status !== 0) {
    fx.error(`lyt update: \`npm i -g ${CURRENCY_PACKAGE}@${CURRENCY_DIST_TAG}\` failed (exit ${status}).`);
    return { installed: false, exitCode: 1 };
  }
  fx.log("lyt update: done. Run `lyt --version` to confirm.");
  return { installed: true, exitCode: 0 };
}

// stay-current slice — `lyt update`: update Lyt to the latest published version.
// Mirrors `npm update`. SAFETY-gated: never mutates the global install silently —
// requires an interactive confirmation or an explicit `--yes` (see
// resolveUpdateAction). `--check` makes it a read-only alias for `lyt outdated`.
export function buildUpdateCommand(): Command {
  return new Command("update")
    .description(
      `Update Lyt to the latest published version (runs \`npm i -g ${CURRENCY_PACKAGE}@${CURRENCY_DIST_TAG}\`). Confirms before changing your global install.`,
    )
    .option("--check", "Only check for a newer version; do not install (alias for `lyt outdated`)")
    .option("--yes", "Skip the confirmation prompt (required to update non-interactively)")
    .action(async (opts: UpdateCliOpts) => {
      const result = await checkCurrency({ force: true });

      if (opts.check === true) {
        // eslint-disable-next-line no-console
        console.log(formatCurrencyLine(result));
        process.exitCode = result.stale ? 1 : 0;
        return;
      }

      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
      const { exitCode } = await runUpdateFlow(
        result,
        { yes: opts.yes, interactive },
        {
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
          // eslint-disable-next-line no-console
          error: (m) => console.error(m),
          confirm: async (prompt) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = (await rl.question(prompt)).trim().toLowerCase();
              return answer === "y" || answer === "yes";
            } finally {
              rl.close();
            }
          },
          install: () => {
            const res = spawnSync("npm", ["i", "-g", `${CURRENCY_PACKAGE}@${CURRENCY_DIST_TAG}`], {
              stdio: "inherit",
              shell: process.platform === "win32",
            });
            return res.status ?? 1;
          },
        },
      );
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}
