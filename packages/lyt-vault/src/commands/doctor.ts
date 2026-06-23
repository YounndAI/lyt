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
  doctorFlow,
  renderHumanReport,
} from "../flows/doctor.js";
import { withSpinner } from "../util/spinner.js";

export function buildDoctorCommand(): Command {
  const cmd = new Command("doctor");
  cmd
    .description(
      "Diagnose Lyt's environment: binaries, ~/lyt/ shape, GitHub auth, registry consistency, per-vault .lyt/ shape, network smoke.",
    )
    .option("--json", "Emit structured JSON instead of the human report")
    .option("--quiet", "Exit code only (0 = all green, 1 = failures, 2 = warnings)")
    .option("--full", "Check every vault's .lyt/ shape instead of a 10-sample")
    .option(
      "--apply",
      "Brief F — repair instead of report: migrate a legacy ~/lyt/identity.yon → machine.yon and reconcile the machine cache against the pod SoT (pod wins on handle conflict).",
    )
    .action(async (opts: DoctorCliOpts) => {
      // V-DX-1 — liveness spinner over the binaries/gh-auth/network-smoke
      // window. Gated off for --json (byte-clean) AND --quiet (exit-code-only,
      // machine use); non-TTY prints "Diagnosing…" once (zero escape codes).
      const useSpinner = opts.json !== true && opts.quiet !== true;
      const result = useSpinner
        ? await withSpinner(
            "",
            () => doctorFlow({ full: opts.full === true, apply: opts.apply === true }),
            { op: "doctor" },
          )
        : await doctorFlow({ full: opts.full === true, apply: opts.apply === true });

      if (opts.quiet === true) {
        process.exit(result.exitCode);
      }
      if (opts.json === true) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        if (result.exitCode !== 0) process.exit(result.exitCode);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(renderHumanReport(result));
      if (result.exitCode !== 0) process.exit(result.exitCode);
    });
  return cmd;
}

interface DoctorCliOpts {
  json?: boolean;
  quiet?: boolean;
  full?: boolean;
  apply?: boolean;
}
