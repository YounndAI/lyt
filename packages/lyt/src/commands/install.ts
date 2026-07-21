/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { Command } from "commander";

import { buildInstallProviderInventoryV1 } from "../install/provider-inventory.js";
import {
  buildInstallReconcileFailureEnvelopeV1,
  prepareInstallReconcilePlanV1,
  reconcileInstallProvidersV1,
} from "../install/reconcile-engine.js";
import { readUpdateOperationPlanV1 } from "../install/update-operation.js";
import {
  providersFromUpdatePlan,
  resolveInstalledPackageRoot,
} from "../install/target-artifacts.js";
import { canonicalJson, UPDATE_PLAN_PACKAGES } from "../install/update-plan.js";

interface InstallReconcileOptions {
  readonly apply?: boolean;
  readonly resume?: string;
  readonly json?: boolean;
  readonly updateOperation?: string;
  readonly planDigest?: string;
}

export function buildInstallCommand(): Command {
  const install = new Command("install").description(
    "Inspect and reconcile Lyt-owned installed content without replacing shared runtime roots",
  );
  install.addCommand(buildInstallReconcileCommand());
  return install;
}

export function buildInstallReconcileCommand(): Command {
  return new Command("reconcile")
    .description(
      "Inspect Lyt-managed skills and agent manuals. Read-only by default; --apply is required to mutate.",
    )
    .option("--apply", "Apply the exact inspected reconciliation plan", false)
    .option("--resume <operation-id>", "Resume one exact durable reconciliation operation")
    .option("--json", "Emit one stable machine-readable result envelope", false)
    .option("--update-operation <operation-id>", "Consume one sealed update operation plan")
    .option("--plan-digest <sha256>", "Require the exact sealed update plan digest")
    .action(async (options: InstallReconcileOptions) => {
      let result;
      try {
        if (options.resume !== undefined && options.apply !== true) {
          throw new Error("install-reconcile-resume-requires-apply");
        }
        if ((options.updateOperation === undefined) !== (options.planDigest === undefined)) {
          throw new Error("install-reconcile-update-plan-pair-required");
        }
        const updatePlan =
          options.updateOperation === undefined
            ? null
            : readUpdateOperationPlanV1(options.updateOperation);
        if (updatePlan !== null && updatePlan.plan_digest !== options.planDigest) {
          throw new Error("install-reconcile-update-plan-digest-mismatch");
        }
        const providers =
          updatePlan === null
            ? await buildInstallProviderInventoryV1()
            : providersFromUpdatePlan(
                updatePlan,
                new Map(
                  UPDATE_PLAN_PACKAGES.map((name) => [
                    name,
                    resolveInstalledPackageRoot(name) ?? "missing-target-package",
                  ]),
                ),
              );
        if (updatePlan !== null) {
          const actual = prepareInstallReconcilePlanV1(providers).objects.map((object) => ({
            object_id: object.object_id,
            expected_digest: object.expected_digest,
            expected_applied_digest: object.expected_applied_digest,
          }));
          const expected = updatePlan.target_provider_objects.map((object) => ({
            object_id: object.object_id,
            expected_digest: object.expected_digest,
            expected_applied_digest: object.expected_applied_digest,
          }));
          if (canonicalJson(actual) !== canonicalJson(expected)) {
            throw new Error("install-reconcile-update-provider-plan-mismatch");
          }
        }
        result = await reconcileInstallProvidersV1(providers, {
          apply: options.apply === true,
          ...(options.resume !== undefined ? { resumeOperationId: options.resume } : {}),
        });
        if (updatePlan !== null) {
          const completed = new Set(result.completed);
          const expectedIds = updatePlan.target_provider_objects.map((object) => object.object_id);
          const resultObjects = new Map(
            result.plan.objects.map((object) => [object.object_id, object.expected_applied_digest]),
          );
          if (
            expectedIds.some(
              (id) =>
                !completed.has(id) ||
                resultObjects.get(id) !==
                  updatePlan.target_provider_objects.find((object) => object.object_id === id)
                    ?.expected_applied_digest,
            )
          ) {
            throw new Error("install-reconcile-update-completion-mismatch");
          }
        }
      } catch (error) {
        result = buildInstallReconcileFailureEnvelopeV1(error);
      }
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const action = options.apply === true ? "reconciled" : "inspected";
        // eslint-disable-next-line no-console
        console.log(
          `Lyt install ${action}: ${result.completed.length} current, ${result.pending.length} pending, ${result.refused.length} refused.`,
        );
        if (result.next_action !== null) {
          // eslint-disable-next-line no-console
          console.log(`Next: ${result.next_action}`);
        }
      }
      if (
        result.status === "partial" ||
        result.status === "refused" ||
        result.status === "failed"
      ) {
        process.exitCode = 1;
      }
    });
}
