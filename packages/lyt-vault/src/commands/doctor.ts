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

import { closeRegistry, openRegistry } from "../registry/client.js";
import {
  checkPublicMeshHygiene,
  doctorFlow,
  renderHumanReport,
  type CheckResult,
} from "../flows/doctor.js";
import { withSpinner } from "../util/spinner.js";

export function buildDoctorCommand(): Command {
  const cmd = new Command("doctor");
  cmd
    .description(
      "Diagnose Lyt's environment: binaries, ~/lyt/ shape, GitHub auth, registry consistency, per-vault .lyt/ shape, network smoke. v1.B.6 adds standalone subcommand 'public_mesh_hygiene'.",
    )
    .option("--json", "Emit structured JSON instead of the human report")
    .option("--quiet", "Exit code only (0 = all green, 1 = failures, 2 = warnings)")
    .option("--full", "Check every vault's .lyt/ shape instead of a 10-sample")
    .option(
      "--apply",
      "Brief F — repair instead of report: migrate a legacy ~/lyt/identity.yon → machine.yon and reconcile the machine cache against the pod SoT (pod wins on handle conflict).",
    )
    .argument(
      "[check]",
      "Optional named check to run standalone (e.g. public_mesh_hygiene). When omitted, runs the full doctor flow.",
    )
    .option(
      "--strict",
      "v1.B.6 — for public_mesh_hygiene standalone: convert warnings to hard failures (exit 1 on first match).",
    )
    .action(async (check: string | undefined, opts: DoctorCliOpts) => {
      if (check === "public_mesh_hygiene") {
        const db = await openRegistry();
        let findings: CheckResult[];
        try {
          findings = await checkPublicMeshHygiene(db, { strict: opts.strict === true });
        } finally {
          await closeRegistry(db);
        }
        const failures = findings.filter((f) => f.status === "fail").length;
        const warnings = findings.filter((f) => f.status === "warn").length;
        const exitCode = failures > 0 ? 1 : warnings > 0 ? 2 : 0;
        if (opts.json === true) {
          process.stdout.write(
            JSON.stringify(
              {
                check: "public_mesh_hygiene",
                findings,
                summary: {
                  failures,
                  warnings,
                  passes: findings.filter((f) => f.status === "pass").length,
                },
                exit_code: exitCode,
              },
              null,
              2,
            ) + "\n",
          );
          if (exitCode !== 0) process.exit(exitCode);
          return;
        }
        // eslint-disable-next-line no-console
        console.log("lyt doctor public_mesh_hygiene");
        for (const f of findings) {
          const marker =
            f.status === "pass" ? "✓" : f.status === "warn" ? "⚠" : f.status === "fail" ? "✗" : "i";
          // eslint-disable-next-line no-console
          console.log(`  ${marker} ${f.label}: ${f.message}`);
          if (f.remediation !== undefined) {
            // eslint-disable-next-line no-console
            console.log(`      → ${f.remediation}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(
          `\nsummary: ${findings.filter((f) => f.status === "pass").length} pass | ${warnings} warn | ${failures} fail`,
        );
        if (exitCode !== 0) process.exit(exitCode);
        return;
      }

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
  strict?: boolean;
  apply?: boolean;
}
