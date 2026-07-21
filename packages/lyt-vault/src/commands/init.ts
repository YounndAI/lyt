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

import { Command, Option } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { initVaultFlow, type InitFlowResult } from "../flows/init.js";
import {
  creationPlanChildV1,
  deriveCreationOperationIdV1,
  mergeCreationIntendedEffectsV1,
  plannedSingleVaultEffectsV1,
  resolveCreationPlanV1,
  withCreationRepositoryEffectsV1,
  type CreationPlanV1,
  type DestinationRequest,
} from "../flows/creation-plan.js";
import {
  inspectVaultInitPreflight,
  type VaultCreationBinding,
} from "../flows/vault-init-preflight.js";
import { vaultRepoName } from "../util/federation-paths.js";
import { resolveVaultPath } from "../util/paths.js";
import type { DestinationPolicyValue } from "../registry/destination-policy.js";
import { parseGithubPublicationTarget } from "../util/permission-observation.js";
import { DEFAULT_TEMPLATE, type TemplateName } from "../templates/index.js";
import { observeActiveActor, type ActiveActorObservation } from "../op/active-actor-observation.js";
import { normalizeCommanderCreationDestination } from "../op/cli-destination-normalization.js";
import {
  makeCreationCommandReceipt,
  type CreationReceiptEvidence,
} from "../op/creation-command-receipt.js";
import {
  openReceiptAttempt,
  type OpenReceiptAttemptResult,
  type ReceiptAttemptSession,
  type ReceiptAttemptWarningCode,
} from "../op/receipt-attempt.js";
import type { ReceiptV1 } from "../op/receipt-v1.js";
import { CreationMutationFailure } from "../op/creation-mutation-journal.js";
import { plannedInitialScaffoldPaths, plannedObsidianScaffoldPaths } from "../scaffold/init.js";
import BetterSqlite3 from "better-sqlite3";
import {
  observePublicationPermission,
  type PublicationPermissionObserver,
} from "../flows/federation/publication-permission.js";
import {
  hexToUuid7Bytes,
  newUuidv7Bytes,
  uuid7BytesToDashedString,
  uuid7BytesToHex,
} from "../util/uuid7.js";
import { parseVaultYon } from "../yon/parse.js";
import { parseMeshYon } from "../yon/mesh-read.js";
import { foldFedMeshes, readAllFedMeshRecords } from "../yon/federation-mesh-ledger-read.js";
import { foldFedVaults, readAllFedVaultRecords } from "../yon/federation-vault-ledger-read.js";
import {
  observeVaultAliasRecommendation,
  type VaultAliasRecommendation,
} from "../flows/alias-recommendation.js";

export interface InitCommandDependencies {
  observeActor?: typeof observeActiveActor;
  observePermission?: PublicationPermissionObserver;
  inspectPreflight?: typeof inspectVaultInitPreflight;
  initVault?: typeof initVaultFlow;
  openReceiptAttempt?: (receipt: ReceiptV1) => Promise<OpenReceiptAttemptResult>;
  recommendAlias?: typeof observeVaultAliasRecommendation;
}

export function buildInitCommand(dependencies: InitCommandDependencies = {}): Command {
  const cmd = new Command("init");
  cmd
    .description("Create a new Lyt vault (folder + .lyt/) and register it")
    .argument("<name>", "Vault name (used for path + vault rid)")
    .option("--path <dir>", "Override the default location (~/lyt/vaults/<name>)")
    .option(
      "--mesh <mesh>",
      "Create the vault in mesh <mesh> (create-if-missing). Equivalent to passing '<mesh>/<name>'. The mesh is created if absent.",
    )
    .option(
      "--push-to <handle>",
      "When the home mesh is auto-created, make it a SHARING mesh pointed at this GitHub handle/org (otherwise the new mesh is local-only).",
    )
    .addOption(
      new Option("--push-kind <kind>", "Legacy --push-to kind")
        .choices(["handle", "org"])
        .default("handle"),
    )
    .option(
      "--target <github-target>",
      "Destination policy: github:user/<owner> or github:org/<owner>",
    )
    .option("--local", "Persist a local-only destination policy")
    .option("--no-push", "Legacy local-only intent; creation never publishes")
    .addOption(
      new Option("--template <name>", "Scaffold template")
        .choices(["empty", "obsidian-default"])
        .default("empty"),
    )
    .option("--parent <vault>", "Parent vault ref (e.g., vault:al0)")
    .option("--tier-hint <tier>", "Tier label hint (e.g., L0, L1, L2 — informational only)")
    .option(
      "--description <text>",
      "One-line vault description (written to vault.yon + used on gh repo create)",
    )
    .option(
      "--ask-description",
      "Prompt for the description interactively (TTY only; non-TTY runs skip the prompt)",
    )
    .option(
      "--topic <name>",
      "Custom GitHub topic (repeatable; appended to brand topics)",
      collectTopic,
      [] as string[],
    )
    .option("--no-starter-figment", "Skip writing the optional notes/welcome.md starter Figment")
    .option("--no-git", "Skip 'git init' inside the new vault")
    .option(
      "--commit-initial",
      "Compatibility flag; creation already checkpoints its exact planned local files automatically (never `git add -A`).",
    )
    .option("--json", "Emit machine-readable JSON instead of human-readable output")
    .action(async (name: string, opts: InitCliOpts, command: Command) => {
      const startedAt = new Date().toISOString();
      let operationId = uuid7BytesToDashedString(newUuidv7Bytes());
      const attemptId = uuid7BytesToDashedString(newUuidv7Bytes());
      let logicalKey: unknown = { name, request: "unresolved" };
      let receiptAttempt: ReceiptAttemptSession | undefined;
      let receiptScope: { kind: "vault"; vault_id: string } | undefined;

      // 0.9.4 (3c) — `--mesh <m>` is sugar for the `<m>/<name>` qualified form.
      // Reject the contradiction where both `--mesh` and a slashed name are
      // given with different meshes.
      let effectiveName = name;
      if (opts.mesh !== undefined && opts.mesh.length > 0) {
        if (name.includes("/")) {
          const namedMesh = name.slice(0, name.indexOf("/"));
          if (namedMesh !== opts.mesh) {
            const message = `lyt vault init: conflicting mesh — name '${name}' specifies mesh '${namedMesh}' but --mesh is '${opts.mesh}'. Pass one or the other.`;
            emitInitDiagnostic(message);
            emitInitReceipt(
              makeCreationCommandReceipt({
                operation: "vault-init",
                operationId,
                attemptId,
                startedAt,
                logicalKey: { name, mesh: opts.mesh, request: "invalid" },
                status: "refused",
                error: {
                  code: "conflicting-mesh",
                  summary: "Vault name and --mesh conflict.",
                  retryable: false,
                },
                next: {
                  code: "correct-vault-init",
                  summary: "Pass one matching mesh name and retry.",
                },
              }),
            );
            process.exitCode = 2;
            return;
          }
        } else {
          effectiveName = `${opts.mesh}/${name}`;
        }
      }

      let result: Awaited<ReturnType<typeof initVaultFlow>>;
      try {
        const normalized = normalizeCommanderCreationDestination(opts, {
          getOptionValueSource: (optionName) => initOptionSource(command, optionName),
        });
        if (normalized.kind === "refusal") {
          logicalKey = { name: effectiveName, request: "invalid" };
          emitInitDiagnostic(normalized.message);
          emitInitReceipt(
            makeCreationCommandReceipt({
              operation: "vault-init",
              operationId,
              attemptId,
              startedAt,
              logicalKey,
              status: "refused",
              error: { code: normalized.code, summary: normalized.message, retryable: false },
              next: { code: "correct-vault-init", summary: normalized.next_action },
            }),
          );
          process.exitCode = 2;
          return;
        }

        const desc = await resolveDescription(opts);
        const creation = await planInitCreation(
          effectiveName,
          opts,
          normalized.request,
          attemptId,
          dependencies,
        );
        operationId = uuid7BytesToDashedString(
          hexToUuid7Bytes(creation.vault.creationPlan.intended_effects.operation_id),
        );
        logicalKey = {
          name: effectiveName,
          path: opts.path ?? null,
          mesh: opts.mesh ?? null,
          template: opts.template ?? DEFAULT_TEMPLATE,
          starterFigment: opts.starterFigment !== false,
          // Keep the Handler's request as the logical operation identity.
          // Execution may resolve an omitted/default request to the existing
          // mesh policy, but that is an effective destination, not a new
          // creation request.
          request: normalized.request,
        };
        receiptScope = {
          kind: "vault",
          vault_id: uuid7BytesToDashedString(
            hexToUuid7Bytes(creation.vault.creationPlan.intended_effects.primary_vault_rid),
          ),
        };
        const openedReceiptAttempt = await (dependencies.openReceiptAttempt ?? openReceiptAttempt)(
          makeCreationCommandReceipt({
            operation: "vault-init",
            operationId,
            attemptId,
            startedAt,
            logicalKey,
            status: "no-op",
            scope: receiptScope,
          }),
        );
        if (openedReceiptAttempt.kind === "unavailable") {
          emitInitReceipt(
            makeCreationCommandReceipt({
              operation: "vault-init",
              operationId,
              attemptId,
              startedAt,
              logicalKey,
              status: "refused",
              scope: receiptScope,
              error: {
                code: "receipt-store-unavailable",
                summary:
                  "Vault creation did not start because its durable receipt could not be opened.",
                retryable: true,
              },
              next: {
                code: "retry-vault-init",
                summary:
                  "Resolve the local receipt-store problem, then retry the same vault creation.",
              },
              exitCode: 2,
            }),
          );
          emitReceiptStoreWarnings(openedReceiptAttempt.warnings);
          process.exitCode = 2;
          return;
        }
        receiptAttempt = openedReceiptAttempt.session;
        if (creation.replay !== undefined) {
          await emitPersistedInitReceipt(
            receiptAttempt,
            makeCreationCommandReceipt({
              operation: "vault-init",
              operationId,
              attemptId,
              startedAt,
              logicalKey,
              status: "replayed",
              replayDisposition: "replayed",
              scope: receiptScope,
              evidence: {
                destination:
                  creation.vault.creationPlan.destination.kind === "github"
                    ? creation.vault.creationPlan.destination.target
                    : "local",
                childReplayKeys: creation.vault.creationPlan.children.map(
                  (child) => child.logical_replay_key,
                ),
              },
            }),
          );
          return;
        }
        const init = dependencies.initVault ?? initVaultFlow;
        result = await init({
          name: effectiveName,
          path: opts.path,
          template: opts.template as TemplateName | undefined,
          parent: opts.parent,
          tierHint: opts.tierHint,
          desc,
          topics: opts.topic ?? [],
          starterFigment: opts.starterFigment !== false,
          gitInit: opts.git !== false,
          commitInitial: opts.commitInitial === true,
          creation: creation.vault,
          // v1.A.0 — `lyt vault init` opts into federation self-heal so a
          // handler running `lyt vault init alex/main` on a fresh machine
          // gets {handle}/lyt-pod forged transparently. Brief
          // acceptance (c). The flow's catch-block keeps failures
          // non-fatal — vault creation always succeeds first.
          //
          // v1.A.1 — reshaped to the `selfHeal.federation` sub-options bag
          // (fold #12). `mesh` sub-options ship empty in v1.A.1; v1.B.1
          // fills the body when `lyt mesh init` lands.
          //
          // v1.B.3 — populates `mesh` self-heal: a bare-name init
          // auto-normalizes to `personal/<name>`, auto-creating the
          // `personal` mesh in-process if it doesn't exist (local; no
          // push). `<owner>/<name>` form is preserved verbatim but the
          // `<owner>` mesh must already exist (HomeMeshNotFoundError
          // otherwise — avoids silently auto-creating non-personal
          // meshes with ambiguous push-target semantics).
          selfHeal: {
            federation: { enabled: false },
            mesh: {
              enabled: true,
              ...(creation.meshTargetOwner === null ? {} : { pushTo: creation.meshTargetOwner }),
              ...(creation.mesh === undefined ? {} : { creation: creation.mesh }),
            },
          },
        });
      } catch (err) {
        if (err instanceof CreationPlanRefusal) {
          emitInitDiagnostic(err.message);
          const receipt = makeCreationCommandReceipt({
            operation: "vault-init",
            operationId,
            attemptId,
            startedAt,
            logicalKey,
            status: "refused",
            ...(receiptScope === undefined ? {} : { scope: receiptScope }),
            error: { code: err.errorCode, summary: err.message, retryable: false },
            next: { code: "correct-vault-init", summary: err.nextAction },
          });
          if (receiptAttempt === undefined) emitInitReceipt(receipt);
          else await emitPersistedInitReceipt(receiptAttempt, receipt);
          process.exitCode = 2;
          return;
        }
        // Lane O Phase 0 — record the first-vault-create death point before
        // re-throwing. `lyt vault init` had no try/catch, so a throw here
        // crashed the command silently (no durable trail). Capture an
        // AI-readable record, then re-throw to PRESERVE the existing
        // control flow (commander surfaces the error + non-zero exit).
        const mutationFailure = err instanceof CreationMutationFailure ? err : null;
        const local = mutationFailure?.mutations;
        const evidence: CreationReceiptEvidence | undefined =
          local === undefined
            ? undefined
            : {
                registryRows: local.registryRows,
                topologyBindings: local.topologyBindings,
                localDatabases: local.localDatabases,
                destinationPolicyRecords: local.destinationPolicyRecords,
                filesystemWrites: local.filesystemWrites,
                failureLogRecords: local.failureLogRecords,
                checkpointCommits: local.checkpointCommits,
                checkpointRepositories: local.checkpointRepositories,
                checkpointPaths: local.checkpointPaths,
              };
        const hasMutation =
          evidence !== undefined &&
          (evidence.registryRows ?? 0) +
            (evidence.topologyBindings ?? 0) +
            (evidence.localDatabases ?? 0) +
            (evidence.destinationPolicyRecords ?? 0) +
            (evidence.checkpointCommits ?? 0) +
            (evidence.checkpointPaths?.length ?? 0) >
            0;
        const code =
          mutationFailure?.code ??
          (typeof err === "object" &&
          err !== null &&
          "errorCode" in err &&
          typeof err.errorCode === "string"
            ? err.errorCode
            : "vault-init-failed");
        emitInitDiagnostic(safeInitFailureDiagnostic(code));
        const receipt = makeCreationCommandReceipt({
          operation: "vault-init",
          operationId,
          attemptId,
          startedAt,
          logicalKey,
          status: hasMutation ? "partial" : "failed",
          ...(receiptScope === undefined ? {} : { scope: receiptScope }),
          evidence,
          error: { code, summary: "Vault creation did not complete.", retryable: true },
          next: hasMutation
            ? {
                code: "inspect-local-creation",
                summary: "Inspect local state, then run scoped sync or retry.",
              }
            : {
                code: "correct-or-retry-vault-init",
                summary:
                  "Correct the reported creation input or retry the unchanged local operation.",
              },
          exitCode: 1,
        });
        if (receiptAttempt === undefined) emitInitReceipt(receipt);
        else await emitPersistedInitReceipt(receiptAttempt, receipt);
        process.exitCode = 1;
        return;
      }

      const displayName = result.meshAssignment?.meshName
        ? `${result.meshAssignment.meshName}/${effectiveName.includes("/") ? effectiveName.slice(effectiveName.indexOf("/") + 1) : effectiveName}`
        : effectiveName;
      const aliasRecommendation = await (
        dependencies.recommendAlias ?? observeVaultAliasRecommendation
      )({
        canonicalName: displayName,
        vaultRid: uuid7BytesToDashedString(result.vaultRid),
      }).catch(() => null);
      if (result.creation === null) {
        emitInitDiagnostic("Vault creation returned no lifecycle evidence.");
        const receipt = makeCreationCommandReceipt({
          operation: "vault-init",
          operationId,
          attemptId,
          startedAt,
          logicalKey,
          status: "failed",
          ...(receiptScope === undefined ? {} : { scope: receiptScope }),
          error: {
            code: "missing-creation-evidence",
            summary: "Vault creation evidence is missing.",
            retryable: false,
          },
          next: {
            code: "inspect-local-creation",
            summary: "Inspect the created vault and run lyt repair --dry-run before retrying.",
          },
          exitCode: 1,
        });
        if (receiptAttempt === undefined) emitInitReceipt(receipt);
        else await emitPersistedInitReceipt(receiptAttempt, receipt);
        process.exitCode = 1;
        return;
      }
      const publishNext = buildInitPublishNextStep(result, displayName);
      if (opts.json !== true) {
        emitInitDiagnostic(
          `Created '${displayName}' locally at ${result.vaultPath}. ${publishNext.message}`,
        );
        if (aliasRecommendation !== null) {
          emitInitDiagnostic(formatAliasRecommendationHuman(aliasRecommendation));
        }
      }
      const checkpointFailed = result.creation.checkpoints.some(
        (checkpoint) => checkpoint.status === "failed" || checkpoint.status === "partial",
      );
      const checkpointCommit =
        result.creation.checkpoints.find((checkpoint) => checkpoint.commitSha)?.commitSha ?? null;
      const destination =
        result.creation.plan.destination.kind === "github"
          ? result.creation.plan.destination.target
          : "local";
      const evidence: CreationReceiptEvidence = {
        ...result.creation.mutations,
        checkpointCommit,
        destination,
        scopedSync: publishNext.command,
        childReplayKeys: result.creation.plan.children.map((child) => child.logical_replay_key),
        editorLocalWritePaths: plannedObsidianScaffoldPaths(result.template),
        ...(aliasRecommendation === null ? {} : { aliasRecommendation }),
      };
      await emitPersistedInitReceipt(
        receiptAttempt,
        makeCreationCommandReceipt({
          operation: "vault-init",
          operationId,
          attemptId,
          startedAt,
          logicalKey,
          status: checkpointFailed ? "partial" : "success",
          scope: receiptScope ?? {
            kind: "vault",
            vault_id: uuid7BytesToDashedString(result.vaultRid),
          },
          evidence,
          ...(checkpointFailed
            ? {
                error: {
                  code: "checkpoint-failed",
                  summary: "Vault was created but its local checkpoint failed.",
                  retryable: true,
                },
                next: {
                  code: "complete-local-checkpoint",
                  summary: `Run ${publishNext.command} to recover the checkpoint.`,
                },
                exitCode: 2,
              }
            : {}),
        }),
      );
      if (checkpointFailed) process.exitCode = 2;
    });
  return cmd;
}

async function planInitCreation(
  name: string,
  opts: InitCliOpts,
  normalizedRequest: DestinationRequest,
  attemptId: string,
  dependencies: InitCommandDependencies,
): Promise<{
  vault: VaultCreationBinding;
  mesh?: VaultCreationBinding;
  meshTargetOwner: string | null;
  replay?: { vaultRid: string; kind: "exact" };
}> {
  const preflight = (dependencies.inspectPreflight ?? inspectVaultInitPreflight)({
    name,
    ...(opts.path === undefined ? {} : { path: opts.path }),
    meshEnabled: true,
    ...(opts.mesh === undefined ? {} : { defaultMeshName: opts.mesh }),
  });
  const requestedPolicy = normalizedRequest;
  const request: DestinationRequest =
    normalizedRequest.kind === "auto" &&
    preflight.mesh?.policy !== null &&
    preflight.mesh?.policy !== undefined
      ? { kind: "inherit", meshRid: preflight.mesh.rid }
      : normalizedRequest;
  const actor = await actorForVaultRequest(
    request,
    attemptId,
    dependencies.observeActor ?? observeActiveActor,
  );
  const inherited =
    request.kind === "inherit" &&
    preflight.mesh?.policy !== null &&
    preflight.mesh?.policy !== undefined
      ? { meshRid: preflight.mesh.rid, policy: preflight.mesh.policy }
      : undefined;
  const vaultRepositoryName = vaultRepoName(preflight.effectiveName);
  // One vault-init invocation may create both a mesh/main vault and the
  // requested member. They are one logical operation: share its deterministic
  // identity allocation so a missing pod is created exactly once.
  const logicalOperationId = deriveCreationOperationIdV1({
    request: requestedPolicy,
    subject: { kind: "vault", repositoryName: vaultRepositoryName },
    scope: vaultInitCreationIdentityScope({
      effectiveName: preflight.effectiveName,
      vaultPath: preflight.vaultPath,
      template: opts.template as TemplateName | undefined,
      starterFigment: opts.starterFigment !== false,
    }),
  });
  const permission = await permissionForVaultRequest({
    request,
    actor,
    inherited,
    repositoryName: vaultRepositoryName,
    observer: dependencies.observePermission ?? observePublicationPermission,
  });
  const meshName = preflight.effectiveName.slice(0, preflight.effectiveName.indexOf("/"));
  const pod =
    preflight.podIdentity.state === "present"
      ? ({ kind: "existing", rid: preflight.podIdentity.rid } as const)
      : ({ kind: "create", handle: actor.actor ?? "local" } as const);
  let mesh: VaultCreationBinding | undefined;
  let childPlans: ReturnType<typeof creationPlanChildV1>[] = [];
  let meshTargetOwner: string | null = null;
  if (preflight.mesh === null) {
    const meshRepositoryName = vaultRepoName(`${meshName}/main`);
    const meshPermission = await permissionForVaultRequest({
      request,
      actor,
      inherited: undefined,
      repositoryName: meshRepositoryName,
      observer: dependencies.observePermission ?? observePublicationPermission,
    });
    const meshEffects = withCreationRepositoryEffectsV1(
      plannedSingleVaultEffectsV1({
        operationId: logicalOperationId,
        pod,
        mesh: { kind: "create", name: meshName },
        vaultName: `${meshName}/main`,
        vaultRoot: resolveVaultPath(`${meshName}/main`),
      }),
      preflight.podIdentity.state === "present"
        ? [{ repositoryRoot: preflight.podIdentity.repositoryRoot, exactPaths: ["pod.yon"] }]
        : [],
    );
    const meshPlan = resolveCreationPlanV1({
      request,
      subject: { kind: "mesh", repositoryName: meshRepositoryName },
      actor,
      intendedEffects: meshEffects,
      permission: meshPermission,
    });
    if (meshPlan.kind === "refusal") throw new CreationPlanRefusal(meshPlan);
    mesh = { destinationRequest: request, creationPlan: meshPlan.plan, attemptId };
    childPlans = [creationPlanChildV1(meshPlan.plan)];
    meshTargetOwner = planTargetOwner(meshPlan.plan);
  }

  const vaultEffects = withCreationRepositoryEffectsV1(
    plannedSingleVaultEffectsV1({
      operationId: logicalOperationId,
      pod,
      mesh:
        preflight.mesh === null
          ? { kind: "create", name: meshName }
          : { kind: "existing", name: meshName, rid: preflight.mesh.rid },
      vaultName: preflight.effectiveName,
      vaultRoot: preflight.vaultPath,
      ...(opts.template === undefined ? {} : { template: opts.template as TemplateName }),
      starterFigment: opts.starterFigment !== false,
    }),
    [
      ...(preflight.podIdentity.state === "present"
        ? [{ repositoryRoot: preflight.podIdentity.repositoryRoot, exactPaths: ["pod.yon"] }]
        : []),
      ...(preflight.mesh !== null && preflight.mesh.mainVaultPath.length > 0
        ? [{ repositoryRoot: preflight.mesh.mainVaultPath, exactPaths: [".lyt/mesh.yon"] }]
        : []),
    ],
  );
  const aggregateEffects =
    mesh === undefined
      ? vaultEffects
      : mergeCreationIntendedEffectsV1({
          primary: vaultEffects,
          children: [mesh.creationPlan.intended_effects],
        });
  const vaultPlan = resolveCreationPlanV1({
    request,
    subject: { kind: "vault", repositoryName: vaultRepositoryName },
    actor,
    intendedEffects: aggregateEffects,
    ...(inherited === undefined ? {} : { inherited }),
    permission,
    ...(childPlans.length === 0 ? {} : { children: childPlans }),
  });
  if (vaultPlan.kind === "refusal") throw new CreationPlanRefusal(vaultPlan);
  const vault: VaultCreationBinding = {
    destinationRequest: request,
    creationPlan: vaultPlan.plan,
    attemptId,
  };
  const replay = exactExistingVaultReplay(preflight, vaultPlan.plan);
  if (preflight.existingVault !== null && replay === null) {
    throw new CreationPlanRefusal({
      kind: "refusal",
      code: "creation-replay-unproven",
      message:
        "A vault with this name already exists, but its current identity or planned local scaffold does not prove the same logical creation request.",
      next_action:
        "Inspect the existing vault with 'lyt vault info <name> --json' and choose an explicit repair or a different name.",
    });
  }
  if (mesh === undefined) {
    return {
      vault,
      meshTargetOwner: planTargetOwner(vaultPlan.plan),
      ...(replay === null ? {} : { replay }),
    };
  }
  return {
    vault,
    mesh,
    meshTargetOwner,
    ...(replay === null ? {} : { replay }),
  };
}

/** Canonical semantic inputs that own deterministic vault-init replay identity. */
export function vaultInitCreationIdentityScope(args: {
  effectiveName: string;
  vaultPath: string;
  template?: TemplateName | undefined;
  starterFigment: boolean;
}): string {
  return (
    `${args.effectiveName}\0${args.vaultPath}` +
    `\0template:${args.template ?? DEFAULT_TEMPLATE}` +
    `\0starter:${args.starterFigment ? "included" : "omitted"}`
  );
}

function exactExistingVaultReplay(
  preflight: ReturnType<typeof inspectVaultInitPreflight>,
  plan: CreationPlanV1,
): { vaultRid: string; kind: "exact" } | null {
  const existing = preflight.existingVault;
  if (existing === null) return null;
  const planned = plan.intended_effects.vaults.find(
    (vault) => vault.rid === plan.intended_effects.primary_vault_rid,
  );
  if (
    planned === undefined ||
    existing.rid !== planned.rid ||
    existing.path !== planned.root ||
    preflight.vaultPath !== planned.root ||
    !exactDestinationPolicy(existing.policy, plan) ||
    !hasExactCreationReplayState(preflight.registryPath, plan)
  ) {
    return null;
  }
  return {
    vaultRid: existing.rid,
    kind: "exact",
  };
}

/** Shared fail-closed proof for an already-applied exact local creation plan. */
export function hasExactCreationReplayState(
  registryPath: string,
  plan: CreationPlanV1,
  options: { requireGit?: boolean } = {},
): boolean {
  if (
    !plan.intended_effects.checkpoints.every((checkpoint) =>
      checkpoint.exact_paths.every((path) => existsSync(join(checkpoint.repository_root, path))),
    ) ||
    !plan.intended_effects.vaults.every((vault) => hasExactPlannedVaultIdentity(plan, vault)) ||
    !hasExactRegistryMeshMainReplay(registryPath, plan, options.requireGit !== false) ||
    !hasExactPodLedgerProjection(plan) ||
    !hasExactReverseMeshTopology(plan) ||
    !allPlannedRegistryStateExists(registryPath, plan)
  ) {
    return false;
  }
  return (
    options.requireGit === false ||
    plan.intended_effects.checkpoints.every((checkpoint) =>
      isExactCleanCheckpoint(plan, checkpoint.repository_root, checkpoint.exact_paths),
    )
  );
}

function hasExactPodLedgerProjection(plan: CreationPlanV1): boolean {
  if (plan.intended_effects.mesh.kind === "none") return true;
  const checkpoint = plan.intended_effects.checkpoints.find(
    (entry) =>
      entry.exact_paths.some((path) => path.startsWith("ledger/meshes/")) &&
      entry.exact_paths.some((path) => path.startsWith("ledger/vaults/")),
  );
  if (checkpoint === undefined) return false;
  try {
    const target =
      plan.destination.kind === "github"
        ? parseGithubPublicationTarget(plan.destination.target)
        : null;
    const meshRid = normalizeRid(plan.intended_effects.mesh.rid);
    const liveMesh = foldFedMeshes(readAllFedMeshRecords(checkpoint.repository_root)).find(
      (mesh) => normalizeRid(mesh.meshRid) === meshRid,
    );
    if (
      liveMesh === undefined ||
      liveMesh.meshName !== plan.intended_effects.mesh.name ||
      liveMesh.pushTarget !== (target?.owner ?? "") ||
      liveMesh.pushKind !== (target?.kind === "org" ? "org" : "handle") ||
      liveMesh.role !== "own"
    ) {
      return false;
    }
    const liveVaults = foldFedVaults(readAllFedVaultRecords(checkpoint.repository_root));
    return plan.intended_effects.vaults.every((plannedVault) => {
      const liveVault = liveVaults.find(
        (vault) => normalizeRid(vault.vaultRid) === normalizeRid(plannedVault.rid),
      );
      return (
        liveVault !== undefined &&
        liveVault.vaultName === plannedVault.name &&
        normalizeRid(liveVault.homeMeshRidHex ?? "") === meshRid &&
        liveVault.status === "active"
      );
    });
  } catch {
    return false;
  }
}

function hasExactReverseMeshTopology(plan: CreationPlanV1): boolean {
  const bindingsByMesh = new Map<string, CreationPlanV1["intended_effects"]["topology_bindings"]>();
  for (const binding of plan.intended_effects.topology_bindings) {
    const bindings = bindingsByMesh.get(binding.mesh_rid) ?? [];
    bindingsByMesh.set(binding.mesh_rid, [...bindings, binding]);
  }
  if (bindingsByMesh.size === 0) return true;
  const meshCheckpoints = plan.intended_effects.checkpoints.filter((checkpoint) =>
    checkpoint.exact_paths.includes(".lyt/mesh.yon"),
  );
  try {
    for (const [meshRid, bindings] of bindingsByMesh) {
      const documents = meshCheckpoints
        .map((checkpoint) =>
          parseMeshYon(readFileSync(join(checkpoint.repository_root, ".lyt", "mesh.yon"), "utf8")),
        )
        .filter((document) => uuid7BytesToHex(document.mesh.rid) === meshRid);
      if (documents.length !== 1) return false;
      const document = documents[0]!;
      const mainBinding = bindings.find((binding) => binding.role === "main");
      const target =
        plan.destination.kind === "github"
          ? parseGithubPublicationTarget(plan.destination.target)
          : null;
      if (
        document.mesh.name !== plan.intended_effects.mesh.name ||
        (mainBinding !== undefined &&
          uuid7BytesToHex(document.mesh.mainVaultRid) !== mainBinding.vault_rid) ||
        (target === null
          ? document.mesh.pushTarget !== undefined || document.mesh.pushKind !== undefined
          : document.mesh.pushTarget !== target.owner ||
            document.mesh.pushKind !== (target.kind === "org" ? "org" : "handle"))
      ) {
        return false;
      }
      for (const binding of bindings) {
        const vault = plan.intended_effects.vaults.find(
          (effect) => effect.rid === binding.vault_rid,
        );
        if (
          vault === undefined ||
          !document.homeVaults.some(
            (home) =>
              uuid7BytesToHex(home.meshRid) === binding.mesh_rid &&
              uuid7BytesToHex(home.vaultRid) === binding.vault_rid &&
              home.vaultName === vault.name,
          )
        ) {
          return false;
        }
      }
      if (plan.subject.kind === "mesh" && document.homeVaults.length !== bindings.length) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function hasExactPlannedVaultIdentity(
  plan: CreationPlanV1,
  planned: CreationPlanV1["intended_effects"]["vaults"][number],
): boolean {
  const binding = plan.intended_effects.topology_bindings.find(
    (entry) => entry.vault_rid === planned.rid,
  );
  try {
    const parsed = parseVaultYon(readFileSync(join(planned.root, ".lyt", "vault.yon"), "utf8"));
    const expectedHomeMeshRid = binding?.mesh_rid ?? null;
    return (
      normalizeRid(parsed.rid) === planned.rid &&
      parsed.name === planned.name &&
      parsed.memscopeRid !== null &&
      normalizeRid(parsed.memscopeRid) === planned.memscope_rid &&
      (expectedHomeMeshRid === null
        ? parsed.homeMesh === null
        : parsed.homeMesh !== null &&
          normalizeRid(parsed.homeMesh.vaultRid) === planned.rid &&
          normalizeRid(parsed.homeMesh.meshRid) === expectedHomeMeshRid &&
          parsed.homeMesh.meshName === plan.intended_effects.mesh.name)
    );
  } catch {
    return false;
  }
}

function normalizeRid(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

function hasExactRegistryMeshMainReplay(
  registryPath: string,
  plan: CreationPlanV1,
  requireGit: boolean,
): boolean {
  if (plan.intended_effects.mesh.kind === "none" || !existsSync(registryPath)) return true;
  const meshRid = plan.intended_effects.mesh.rid.replaceAll("-", "").toLowerCase();
  const db = new BetterSqlite3(registryPath, { readonly: true, fileMustExist: true });
  try {
    const main = db
      .prepare(
        `SELECT lower(hex(v.rid)) AS rid,
                v.path AS path,
                lower(hex(v.home_mesh_rid)) AS home_mesh_rid
           FROM meshes m
           JOIN vaults v ON v.rid = m.main_vault_rid
          WHERE lower(hex(m.rid)) = ?
          LIMIT 1`,
      )
      .get(meshRid) as { rid: string; path: string; home_mesh_rid: string } | undefined;
    return (
      main !== undefined &&
      main.home_mesh_rid === meshRid &&
      plan.intended_effects.vaults.some(
        (vault) =>
          vault.rid === main.rid &&
          normalizeFilesystemPath(vault.root) === normalizeFilesystemPath(main.path) &&
          hasExactPlannedVaultIdentity(plan, vault),
      ) &&
      (!requireGit || isCleanTrackedVaultIdentity(main.path))
    );
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function isCleanTrackedVaultIdentity(root: string): boolean {
  try {
    const status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (status.length !== 0) return false;
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync("git", ["ls-files", "--error-unmatch", "--", ".lyt/vault.yon"], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeFilesystemPath(path: string): string {
  const normalized = resolve(path).replace(/[/\\]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function exactDestinationPolicy(
  observed: DestinationPolicyValue | null,
  plan: CreationPlanV1,
): boolean {
  const source = plan.request.kind === "inherit" ? "mesh-inherited" : "vault-override";
  if (plan.destination.kind === "local") {
    return (
      observed !== null &&
      observed.destinationKind === "local" &&
      observed.targetOwner === null &&
      observed.targetKind === null &&
      observed.source === source
    );
  }
  const target = parseGithubPublicationTarget(plan.destination.target);
  return (
    observed !== null &&
    target !== null &&
    observed.destinationKind === "github" &&
    observed.targetOwner === target.owner &&
    observed.targetKind === target.kind &&
    observed.repositoryName === plan.subject.repositoryName &&
    observed.source === source
  );
}

function allPlannedRegistryStateExists(registryPath: string, plan: CreationPlanV1): boolean {
  if (!existsSync(registryPath)) return false;
  const db = new BetterSqlite3(registryPath, { readonly: true, fileMustExist: true });
  try {
    for (const plannedVault of plan.intended_effects.vaults) {
      const binding = plan.intended_effects.topology_bindings.find(
        (entry) => entry.vault_rid === plannedVault.rid,
      );
      const row = db
        .prepare(
          `SELECT path,
                  CASE WHEN home_mesh_rid IS NULL THEN NULL ELSE lower(hex(home_mesh_rid)) END AS home_mesh_rid
             FROM vaults
            WHERE lower(hex(rid)) = ?
            LIMIT 1`,
        )
        .get(plannedVault.rid) as { path: string; home_mesh_rid: string | null } | undefined;
      if (
        row === undefined ||
        normalizeFilesystemPath(row.path) !== normalizeFilesystemPath(plannedVault.root) ||
        row.home_mesh_rid !== (binding?.mesh_rid ?? null)
      ) {
        return false;
      }
    }
    for (const row of plan.intended_effects.registry_rows) {
      const present =
        row.table === "federation_state"
          ? db
              .prepare("SELECT 1 FROM federation_state WHERE lower(hex(fed_rid)) = ? LIMIT 1")
              .get(row.key)
          : row.table === "meshes"
            ? db.prepare("SELECT 1 FROM meshes WHERE lower(hex(rid)) = ? LIMIT 1").get(row.key)
            : row.table === "vaults"
              ? db.prepare("SELECT 1 FROM vaults WHERE lower(hex(rid)) = ? LIMIT 1").get(row.key)
              : (() => {
                  const [meshRid, vaultRid] = row.key.split(":");
                  return db
                    .prepare(
                      "SELECT 1 FROM mesh_vaults WHERE lower(hex(mesh_rid)) = ? AND lower(hex(vault_rid)) = ? LIMIT 1",
                    )
                    .get(meshRid, vaultRid);
                })();
      if (present === undefined) return false;
    }
    for (const binding of plan.intended_effects.topology_bindings) {
      const present = db
        .prepare(
          "SELECT 1 FROM mesh_vaults WHERE lower(hex(mesh_rid)) = ? AND lower(hex(vault_rid)) = ? AND role = 'home' LIMIT 1",
        )
        .get(binding.mesh_rid, binding.vault_rid);
      if (present === undefined) return false;
      if (binding.role === "main") {
        const main = db
          .prepare(
            "SELECT 1 FROM meshes WHERE lower(hex(rid)) = ? AND lower(hex(main_vault_rid)) = ? LIMIT 1",
          )
          .get(binding.mesh_rid, binding.vault_rid);
        if (main === undefined) return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function isExactCleanCheckpoint(
  plan: CreationPlanV1,
  repositoryRoot: string,
  exactPaths: readonly string[],
): boolean {
  try {
    if (!hasExactPlannedScaffoldPaths(plan, repositoryRoot, exactPaths)) return false;
    const all = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (all.length !== 0) return false;
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync("git", ["ls-files", "--error-unmatch", "--", ...exactPaths], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasExactPlannedScaffoldPaths(
  plan: CreationPlanV1,
  repositoryRoot: string,
  exactPaths: readonly string[],
): boolean {
  const plannedVault = plan.intended_effects.vaults.find(
    (vault) => normalizeFilesystemPath(vault.root) === normalizeFilesystemPath(repositoryRoot),
  );
  if (plannedVault === undefined) return true;
  const scaffoldUniverse = plannedInitialScaffoldPaths({
    name: plannedVault.name,
    template: "obsidian-default",
    starterFigment: true,
  }).map(normalizeRepositoryPath);
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...scaffoldUniverse], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\0")
    .filter((path) => path.length > 0)
    .map(normalizeRepositoryPath)
    .sort();
  const universe = new Set(scaffoldUniverse);
  const expected = exactPaths
    .map(normalizeRepositoryPath)
    .filter((path) => universe.has(path))
    .sort();
  return (
    tracked.length === expected.length && tracked.every((path, index) => path === expected[index])
  );
}

class CreationPlanRefusal extends Error {
  readonly errorCode: string;
  readonly nextAction: string;

  constructor(refusal: Extract<ReturnType<typeof resolveCreationPlanV1>, { kind: "refusal" }>) {
    super(refusal.message);
    this.name = "CreationPlanRefusal";
    this.errorCode = refusal.code;
    this.nextAction = refusal.next_action;
  }
}

async function actorForVaultRequest(
  request: DestinationRequest,
  attemptId: string,
  observer: typeof observeActiveActor,
): Promise<ActiveActorObservation> {
  if (request.kind !== "local") return observer({ attemptId });
  return {
    attempt_id: attemptId,
    observed_at: new Date().toISOString(),
    result: "unknown",
    actor: null,
    evidence_class: "unavailable",
  };
}

async function permissionForVaultRequest(args: {
  request: DestinationRequest;
  actor: ActiveActorObservation;
  inherited: { meshRid: string; policy: DestinationPolicyValue } | undefined;
  repositoryName: string;
  observer: PublicationPermissionObserver;
}) {
  if (args.actor.result !== "verified") return null;
  const targetValue = targetForRequest(args.request, args.actor, args.inherited);
  const target = targetValue === null ? null : parseGithubPublicationTarget(targetValue);
  if (target === null) return null;
  return args.observer({
    capability: "repository-create",
    target: target.value,
    repository: `${target.owner}/${args.repositoryName}`,
    actor: args.actor.actor,
    attemptId: args.actor.attempt_id,
    policyEpoch: 0,
  });
}

function targetForRequest(
  request: DestinationRequest,
  actor: ActiveActorObservation,
  inherited: { policy: DestinationPolicyValue } | undefined,
): string | null {
  if (request.kind === "target") return request.target;
  if (request.kind === "auto" && actor.result === "verified") return `github:user/${actor.actor}`;
  if (
    request.kind === "inherit" &&
    inherited?.policy.destinationKind === "github" &&
    inherited.policy.targetOwner !== null &&
    inherited.policy.targetKind !== null
  ) {
    return `github:${inherited.policy.targetKind}/${inherited.policy.targetOwner}`;
  }
  return null;
}

function initOptionSource(
  command: Command,
  name: string,
): "default" | "config" | "env" | "cli" | "implied" | undefined {
  return command.getOptionValueSource(name) as
    "default" | "config" | "env" | "cli" | "implied" | undefined;
}

function planTargetOwner(plan: CreationPlanV1): string | null {
  if (plan.destination.kind !== "github") return null;
  return parseGithubPublicationTarget(plan.destination.target)?.owner ?? null;
}

interface InitCliOpts {
  path?: string;
  mesh?: string;
  target?: string;
  local?: boolean;
  pushTo?: string;
  pushKind?: string;
  push?: boolean;
  template?: string;
  parent?: string;
  tierHint?: string;
  description?: string;
  askDescription?: boolean;
  topic?: string[];
  starterFigment?: boolean;
  git?: boolean;
  commitInitial?: boolean;
  json?: boolean;
}

export function buildInitJsonPayload(
  result: InitFlowResult,
  displayName: string,
  aliasRecommendation?: VaultAliasRecommendation | null,
) {
  return {
    ok: true,
    vault: {
      name: displayName,
      path: result.vaultPath,
      rid: uuid7BytesToDashedString(result.vaultRid),
      memscopeRid: uuid7BytesToDashedString(result.memscopeRid),
      template: result.template,
      tier: result.tier,
    },
    primingFilesWritten: result.primingFilesWritten,
    git: {
      initialized: result.gitInitialized,
      initialCommitMade: result.initialCommitMade,
    },
    registry: {
      registered: result.registered,
      committed: result.committed,
      unverifiedNote: result.unverifiedNote,
    },
    mesh: result.meshAssignment,
    federation: result.federationSelfHealed,
    publish: buildInitPublishNextStep(result, displayName),
    ...(aliasRecommendation == null ? {} : { aliasRecommendation }),
  };
}

export function formatAliasRecommendationHuman(recommendation: VaultAliasRecommendation): string {
  if (recommendation.action === "already-available") {
    return (
      `Alias available: '@${recommendation.alias}' already points to ` +
      `'${recommendation.canonicalTarget}' (RID ${recommendation.vaultRid}).`
    );
  }
  return (
    `Alias suggestion: '@${recommendation.alias}' is available for ` +
    `'${recommendation.canonicalTarget}' (RID ${recommendation.vaultRid}). ` +
    `Use Lyt's alias command with alias '${recommendation.alias}' and target ` +
    `'${recommendation.canonicalTarget}' if you want to create it.`
  );
}

export function buildInitPublishNextStep(result: InitFlowResult, displayName: string) {
  const command = `lyt sync --vault ${displayName}`;
  const mesh = result.meshAssignment;
  const owner = mesh?.ownCreated === true ? mesh.pushTarget : null;
  if (owner !== null && owner.length > 0) {
    const expectedRepo = `${owner}/${vaultRepoName(displayName)}`;
    return {
      status: "pending-scoped-sync" as const,
      remoteAction: "none" as const,
      command,
      visibility: "private" as const,
      expectedRepo,
      message:
        `No remote action happened. Only the scoped sync remains: run \`${command}\` ` +
        `to create the private online copy ${expectedRepo} and save only this vault.`,
    };
  }
  return {
    status: "local-only-no-push-target" as const,
    remoteAction: "none" as const,
    command,
    visibility: "private" as const,
    expectedRepo: null,
    message:
      `No remote action happened. This mesh has no configured push target, so the vault ` +
      `remains local; configure the mesh before running \`${command}\`.`,
  };
}

function collectTopic(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function resolveDescription(opts: InitCliOpts): Promise<string | undefined> {
  if (opts.description !== undefined && opts.description.length > 0) {
    return opts.description;
  }
  if (opts.askDescription !== true || opts.json === true) {
    return undefined;
  }
  if (process.stdin.isTTY !== true) {
    // Non-TTY (script / agent invocation): don't hang. Skip the prompt.
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Vault description: ");
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } finally {
    rl.close();
  }
}

function emitInitDiagnostic(message: string): void {
  // Human-readable diagnostics never share stdout with the Receipt V1 object.
  // eslint-disable-next-line no-console
  console.error(message);
}

function safeInitFailureDiagnostic(code: string): string {
  const boundedCode = /^[a-z][a-z0-9-]{0,95}$/.test(code) ? code : "vault-init-failed";
  return `lyt vault init failed (${boundedCode}). See the emitted receipt for the recovery action.`;
}

function emitInitReceipt(receipt: unknown): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(receipt));
}

async function emitPersistedInitReceipt(
  attempt: ReceiptAttemptSession,
  receipt: ReceiptV1,
): Promise<void> {
  const warnings = await attempt.finalize(receipt);
  emitInitReceipt(receipt);
  emitReceiptStoreWarnings(warnings);
}

function emitReceiptStoreWarnings(warnings: readonly ReceiptAttemptWarningCode[]): void {
  for (const warning of warnings) {
    emitInitDiagnostic(`lyt vault init warning: ${warning}`);
  }
}
