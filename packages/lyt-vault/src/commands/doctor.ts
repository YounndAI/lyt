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
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse as parsePath, resolve, sep } from "node:path";

import { doctorFlow, renderHumanReport } from "../flows/doctor.js";
import { validateVaultName } from "../util/identity.js";
import { withSpinner } from "../util/spinner.js";
import {
  inspectEditorLocalizationV1,
  observeEditorLocalizationMachineReceiptV1,
  readEditorLocalizationMachineEvidenceFilesV1,
  type EditorLocalizationMachineReceiptV1,
  type EditorLocalizationPlanV1,
  type PrepareEditorLocalizationArgs,
} from "../flows/editor-localization.js";

const EDITOR_LOCALIZATION_TARGET_PREFIX = "editor-localization:";

export interface DoctorCommandDependencies {
  doctor?: typeof doctorFlow;
  inspectEditorLocalization?: typeof inspectEditorLocalizationV1;
  observeEditorLocalizationMachineReceipt?: typeof observeEditorLocalizationMachineReceiptV1;
  /** Isolated seam pending the Handler's decision on canonical CLI roster evidence input. */
  editorLocalizationMachineEvidence?: () => Pick<
    PrepareEditorLocalizationArgs,
    "declared_machines" | "machine_receipts"
  >;
}

export function buildDoctorCommand(dependencies: DoctorCommandDependencies = {}): Command {
  const cmd = new Command("doctor");
  cmd
    .description(
      "Diagnose Lyt's environment: binaries, ~/lyt/ shape, GitHub auth, registry consistency, per-vault .lyt/ shape, network smoke.",
    )
    .option("--json", "Emit structured JSON instead of the human report")
    .option("--quiet", "Exit code only (0 = all green, 1 = failures, 2 = warnings)")
    .option("--full", "Check every vault's .lyt/ shape instead of a 10-sample")
    .option("--target <target>", "Run one scoped read-only diagnostic target")
    .option(
      "--declared-machine <id>",
      "Declare one machine in the Handler-defined editor-localization roster (repeatable)",
      collectRepeatableString,
      [],
    )
    .option(
      "--machine-receipt <file>",
      "Read one strict receipt for a declared machine; omitted receipts stay unavailable (repeatable)",
      collectRepeatableString,
      [],
    )
    .option(
      "--emit-machine-receipt",
      "Emit one canonical local machine receipt for the exact editor-localization target",
    )
    .option("--out <path>", "Write the emitted machine receipt to one new reparse-safe file")
    .option(
      "--apply",
      "Repair instead of report: migrate a legacy ~/lyt/identity.yon → machine.yon and reconcile the machine cache against the pod SoT (pod wins on handle conflict).",
    )
    .action(async (opts: DoctorCliOpts) => {
      const editorTarget = exactEditorLocalizationTarget(opts.target);
      if (editorLocalizationIntent(opts) && editorTarget === null) {
        emitEditorLocalizationDoctor(
          {
            operation: "editor-localization-diagnostic",
            status: "refused",
            error: {
              code: "editor-localization-target-required",
              summary: "Editor-localization options require one exact qualified vault target.",
            },
            next_action: editorLocalizationDoctorSyntax(),
          },
          opts,
          true,
        );
        process.exitCode = 2;
        return;
      }
      if (editorTarget !== null) {
        await runEditorLocalizationDoctor(opts, dependencies);
        return;
      }
      // V-DX-1 — liveness spinner over the binaries/gh-auth/network-smoke
      // window. Gated off for --json (byte-clean) AND --quiet (exit-code-only,
      // machine use); non-TTY prints "Diagnosing…" once (zero escape codes).
      const useSpinner = opts.json !== true && opts.quiet !== true;
      const result = useSpinner
        ? await withSpinner(
            "",
            () =>
              (dependencies.doctor ?? doctorFlow)({
                full: opts.full === true,
                apply: opts.apply === true,
              }),
            { op: "doctor" },
          )
        : await (dependencies.doctor ?? doctorFlow)({
            full: opts.full === true,
            apply: opts.apply === true,
          });

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
  target?: string;
  declaredMachine?: string[];
  machineReceipt?: string[];
  emitMachineReceipt?: boolean;
  out?: string;
}

async function runEditorLocalizationDoctor(
  opts: DoctorCliOpts,
  dependencies: DoctorCommandDependencies,
): Promise<void> {
  const target = opts.target!.slice(EDITOR_LOCALIZATION_TARGET_PREFIX.length);
  if (opts.emitMachineReceipt === true) {
    await runEditorLocalizationMachineReceiptEmission(target, opts, dependencies);
    return;
  }
  if (opts.apply === true || opts.full === true) {
    const body = {
      operation: "editor-localization-diagnostic",
      status: "refused",
      error: {
        code: "editor-localization-doctor-flag-combo-invalid",
        summary: "Use an exact editor-localization target without --apply or --full.",
      },
      next_action: editorLocalizationDoctorSyntax(target),
    };
    emitEditorLocalizationDoctor(body, opts, true);
    process.exitCode = 2;
    return;
  }
  let evidence: Pick<PrepareEditorLocalizationArgs, "declared_machines" | "machine_receipts">;
  try {
    evidence =
      dependencies.editorLocalizationMachineEvidence?.() ??
      readEditorLocalizationMachineEvidenceFilesV1(
        opts.declaredMachine ?? [],
        opts.machineReceipt ?? [],
      );
    if (evidence.declared_machines.length === 0) {
      throw new Error("at least one declared machine is required");
    }
  } catch {
    emitEditorLocalizationDoctor(
      {
        operation: "editor-localization-diagnostic",
        status: "refused",
        error: {
          code: "editor-localization-machine-evidence-invalid",
          summary:
            "Declare at least one unique machine and supply only strict receipts for declared machines.",
        },
        next_action: editorLocalizationDoctorSyntax(target),
      },
      opts,
      true,
    );
    process.exitCode = 2;
    return;
  }
  const result = await (dependencies.inspectEditorLocalization ?? inspectEditorLocalizationV1)({
    target,
    ...evidence,
  });
  const body =
    result.kind === "prepared"
      ? {
          operation: "editor-localization-diagnostic",
          status: "observed",
          target: result.plan.target.canonical_name,
          eligibility: result.plan.eligibility,
          git: result.plan.git,
          authority: result.plan.authority,
          machine_evidence: result.plan.machine_evidence,
          before: result.plan.before,
          next_action: diagnosticNextAction(result.plan),
        }
      : {
          operation: "editor-localization-diagnostic",
          status: "refused",
          target,
          reason: result.reason,
          next_action: editorLocalizationDoctorSyntax(target),
        };
  emitEditorLocalizationDoctor(body, opts);
  process.exitCode =
    result.kind === "prepared" &&
    (result.plan.eligibility.disposition === "eligible" ||
      result.plan.eligibility.disposition === "handler-approval-required")
      ? 0
      : 2;
}

async function runEditorLocalizationMachineReceiptEmission(
  target: string,
  opts: DoctorCliOpts,
  dependencies: DoctorCommandDependencies,
): Promise<void> {
  if (
    opts.json !== true ||
    opts.quiet === true ||
    opts.apply === true ||
    opts.full === true ||
    (opts.declaredMachine?.length ?? 0) !== 1 ||
    (opts.machineReceipt?.length ?? 0) !== 0
  ) {
    emitEditorLocalizationDoctor(
      {
        operation: "editor-localization-machine-receipt",
        status: "refused",
        error: {
          code: "editor-localization-receipt-flag-combo-invalid",
          summary:
            "Receipt emission requires --json, exactly one --declared-machine, and no receipt/apply/full/quiet flags.",
        },
        next_action: editorLocalizationReceiptSyntax(target),
      },
      opts,
      true,
    );
    process.exitCode = 2;
    return;
  }
  const result = await (
    dependencies.observeEditorLocalizationMachineReceipt ??
    observeEditorLocalizationMachineReceiptV1
  )({ target, machine_id: opts.declaredMachine![0]! });
  if (result.kind === "observed") {
    if (opts.out !== undefined) {
      try {
        writeMachineReceiptOutput(opts.out, result.receipt);
      } catch {
        emitEditorLocalizationDoctor(
          {
            operation: "editor-localization-machine-receipt",
            status: "refused",
            error: {
              code: "editor-localization-receipt-output-unavailable",
              summary: "The machine receipt output file could not be created safely.",
            },
            next_action: editorLocalizationReceiptSyntax(target, opts.declaredMachine![0]!),
          },
          opts,
          true,
        );
        process.exitCode = 2;
        return;
      }
    }
    process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
    process.exitCode = 0;
    return;
  }
  emitEditorLocalizationDoctor(
    {
      operation: "editor-localization-machine-receipt",
      status: "refused",
      error: {
        code: result.reason,
        summary: "Local editor-state receipt observation was unavailable.",
      },
      next_action: editorLocalizationReceiptSyntax(target, opts.declaredMachine![0]!),
    },
    opts,
  );
  process.exitCode = 2;
}

function collectRepeatableString(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function repairNextAction(target: string): string {
  return `lyt repair --target editor-localization:${target} --dry-run --plan-out <path> --declared-machine <id> [--machine-receipt <file>] --json`;
}

function diagnosticNextAction(plan: EditorLocalizationPlanV1): string {
  const unavailable = plan.machine_evidence.machines.find(
    (machine) => machine.state === "unavailable",
  );
  return unavailable === undefined
    ? repairNextAction(plan.target.canonical_name)
    : editorLocalizationReceiptSyntax(plan.target.canonical_name, unavailable.machine_id);
}

function editorLocalizationReceiptSyntax(target: string, machineId = "<id>"): string {
  return `lyt doctor --target '${powerShellQuote(`editor-localization:${target}`)}' --emit-machine-receipt --declared-machine '${powerShellQuote(machineId)}' --json --out '.\\editor-localization-machine-receipt.json'`;
}

function editorLocalizationDoctorSyntax(target = "<qualified-vault>"): string {
  return `lyt doctor --target editor-localization:${target} --declared-machine <id> [--machine-receipt <file>] --json`;
}

function exactEditorLocalizationTarget(value: string | undefined): string | null {
  if (value?.startsWith(EDITOR_LOCALIZATION_TARGET_PREFIX) !== true) return null;
  const target = value.slice(EDITOR_LOCALIZATION_TARGET_PREFIX.length);
  try {
    validateVaultName(target);
    return target.includes("/") ? target : null;
  } catch {
    return null;
  }
}

function editorLocalizationIntent(opts: DoctorCliOpts): boolean {
  return (
    opts.target?.startsWith("editor-localization") === true ||
    opts.emitMachineReceipt === true ||
    opts.out !== undefined ||
    (opts.declaredMachine?.length ?? 0) > 0 ||
    (opts.machineReceipt?.length ?? 0) > 0
  );
}

function powerShellQuote(value: string): string {
  return value.replaceAll("'", "''");
}

function writeMachineReceiptOutput(
  requestedPath: string,
  receipt: EditorLocalizationMachineReceiptV1,
): void {
  const target = resolve(requestedPath);
  if (
    !isAbsolute(target) ||
    target.length > 384 ||
    Buffer.byteLength(target, "utf8") > 384 ||
    /[\u0000-\u001f\u007f]/u.test(target)
  ) {
    throw new Error("machine receipt output path invalid");
  }
  const parsed = parsePath(target);
  let current = parsed.root;
  const components = target.slice(parsed.root.length).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    const leaf = index === components.length - 1;
    if (!existsSync(current)) {
      if (leaf) break;
      throw new Error("machine receipt output parent missing");
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("machine receipt output path contains a reparse point");
    }
    if (leaf) throw new Error("machine receipt output already exists");
  }
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}

function emitEditorLocalizationDoctor(
  body: Record<string, unknown>,
  opts: DoctorCliOpts,
  forceJson = false,
): void {
  if (forceJson) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }
  if (opts.quiet === true) return;
  if (opts.json === true) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else
    console.log(
      body["status"] === "observed"
        ? `Editor localization: ${JSON.stringify(body["eligibility"])}\nNext: ${String(body["next_action"])}`
        : `Editor localization diagnostic refused: ${String(body["reason"] ?? (body["error"] as { summary?: string } | undefined)?.summary ?? "unknown")}\nNext: ${String(body["next_action"] ?? "correct the flags and retry")}`,
    );
}
