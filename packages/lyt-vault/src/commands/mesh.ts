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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import BetterSqlite3 from "better-sqlite3";

import { generateMeshCanvasFlow } from "../flows/canvas-mesh.js";
import { meshInitFlow } from "../flows/mesh-init.js";
import {
  deriveCreationOperationIdV1,
  derivePlannedCreationRid,
  plannedMeshPodEffectPathsV1,
  plannedSingleVaultEffectsV1,
  resolveCreationPlanV1,
  withCreationRepositoryEffectsV1,
  type CreationPlanV1,
  type DestinationRequest,
} from "../flows/creation-plan.js";
import { inspectMeshInitPreflight } from "../flows/mesh-init-preflight.js";
import { inspectVaultInitPreflight } from "../flows/vault-init-preflight.js";
import { deriveProvisionalHandle } from "../util/identity.js";
import { normalizeCommanderCreationDestination } from "../op/cli-destination-normalization.js";
import { observeActiveActor, type ActiveActorObservation } from "../op/active-actor-observation.js";
import { parseReceiptV1ForEmission, type ReceiptV1 } from "../op/receipt-v1.js";
import { creationPlanReplayKeyDigest } from "../op/creation-command-receipt.js";
import {
  openReceiptAttempt,
  type OpenReceiptAttemptResult,
  type ReceiptAttemptSession,
  type ReceiptAttemptWarningCode,
} from "../op/receipt-attempt.js";
import {
  CreationMutationFailure,
  creationCheckpointPathDigest,
  creationLocalMutationCount,
  type CreationMutationEvidence,
} from "../op/creation-mutation-journal.js";
import { parseGithubPublicationTarget } from "../util/permission-observation.js";
import { hexToUuid7Bytes, newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import { vaultRepoName } from "../util/federation-paths.js";
import { resolveVaultPath } from "../util/paths.js";
import {
  observePublicationPermission,
  type PublicationPermissionObserver,
} from "../flows/federation/publication-permission.js";
import { meshJoinFlow } from "../flows/mesh-join.js";
import { meshListFlow } from "../flows/mesh-list.js";
import { meshPruneFlow } from "../flows/mesh-prune.js";
import type { DestinationPolicyValue } from "../registry/destination-policy.js";
import { parseVaultYon } from "../yon/parse.js";
import { renderMemscopeYon } from "../yon/memscope.js";
import { hasExactCreationReplayState } from "./init.js";
import { buildMeshAddEdgeSubcommand } from "./add-mesh-edge.js";
import { buildMeshAdoptSubcommand } from "./mesh-adopt.js";
import { buildMeshInfoSubcommand } from "./mesh-info.js";
import { buildMeshSubscribeSubcommand } from "./subscribe.js";
import { buildMeshValidateSubcommand } from "./mesh-validate.js";
import { buildMeshRebuildRollupCommand } from "./mesh-rebuild-rollup.js";
import { buildRebuildMeshRegistryCommand } from "./rebuild-mesh-registry.js";

// v1.B.1 — `lyt mesh init|join|list`. Mirrors the `commands/federation.ts`
// parent-with-subcommands shape so the CLI structure stays uniform across
// the v1.A.0 federation surface and the v1.B.1 mesh surface.
//
// Per Lock 0.3 (SAI-compatible), every subcommand exposes a deterministic
// `--json` mode. Human-readable output mirrors the existing `lyt vault list`
// style.

export interface MeshCommandDependencies {
  observeActor?: typeof observeActiveActor;
  observePermission?: PublicationPermissionObserver;
  inspectPreflight?: typeof inspectMeshInitPreflight;
  meshInit?: typeof meshInitFlow;
  openReceiptAttempt?: (receipt: ReceiptV1) => Promise<OpenReceiptAttemptResult>;
}

export function buildMeshCommand(dependencies: MeshCommandDependencies = {}): Command {
  const cmd = new Command("mesh").description(
    "Manage meshes — named groups of vaults with explicit destination policies. Subcommands: init/join/list, canvas, rebuild-registry, info.",
  );
  cmd.addCommand(buildMeshInitSubcommand(dependencies));
  cmd.addCommand(buildMeshJoinSubcommand());
  cmd.addCommand(buildMeshListSubcommand());
  cmd.addCommand(buildMeshCanvasSubcommand());
  cmd.addCommand(buildRebuildMeshRegistryCommand());
  cmd.addCommand(buildMeshRebuildRollupCommand());
  cmd.addCommand(buildMeshInfoSubcommand());
  cmd.addCommand(buildMeshAddEdgeSubcommand());
  cmd.addCommand(buildMeshValidateSubcommand());
  cmd.addCommand(buildMeshSubscribeSubcommand());
  cmd.addCommand(buildMeshAdoptSubcommand());
  cmd.addCommand(buildMeshPruneSubcommand());
  return cmd;
}

interface MeshPruneCliOpts {
  yes?: boolean;
  json?: boolean;
}

// Inc-2 Phase C (#6) — `lyt mesh prune <name>`. Removes an EMPTY / ORPHAN mesh
// (a mesh with no live homed/subscribed vaults) from the registry — the lingering
// empty rows a junction-safe pod cleanup leaves behind. DESTRUCTIVE + fail-closed:
// mirrors `vault abandon`'s confirm gate. The CLI wires `confirmed` from `--yes`;
// the flow refuses without it (defense-in-depth beneath any future MCP dispatch
// gate). It NEVER touches disk (registry-row-only), so no reparse-point traversal
// occurs; a mesh that still has homed vaults is REFUSED (naming them), never pruned.
function buildMeshPruneSubcommand(): Command {
  return new Command("prune")
    .description(
      "Remove an EMPTY / ORPHAN mesh (no homed vaults) from the registry. Registry-row-only — files and directories are NEVER touched. Refuses a mesh that still has homed vaults. Requires --yes.",
    )
    .argument("<name>", "Registered mesh name (empty/orphan)")
    .option("--yes", "Confirm pruning the mesh")
    .option("--json", "Emit machine-readable JSON")
    .action(async (name: string, opts: MeshPruneCliOpts) => {
      try {
        const result = await meshPruneFlow(name, { confirmed: opts.yes === true });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`Pruned mesh '${result.meshName}' (mesh:${result.meshRidHex}).`);
        // eslint-disable-next-line no-console
        console.log(`  registry row removed; no files or directories were touched.`);
        if (result.removedMeshVaultRows > 0) {
          // eslint-disable-next-line no-console
          console.log(`  cleared ${result.removedMeshVaultRows} dangling mesh_vaults row(s).`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(msg);
        process.exitCode = 1;
      }
    });
}

interface MeshInitCliOpts {
  target?: string;
  local?: boolean;
  pushTo?: string;
  pushKind?: string;
  parent?: string;
  // commander writes `push: false` for the `--no-push` flag (not `noPush`).
  // Same trap as v1.A.0 DO NOT SKIP #5 (federation.ts); fixed inline here.
  push?: boolean;
  git?: boolean;
  commitInitial?: boolean;
  json?: boolean;
}

function buildMeshInitSubcommand(dependencies: MeshCommandDependencies): Command {
  return new Command("init")
    .description(
      "Provision a new mesh + scaffold its main vault ('<name>/main'). Per naming-convention.md, mesh names are bare ('alex', 'younndai', 'marlink'); the main vault is named 'main' automatically.",
    )
    .argument("<name>", "Mesh name (bare; no '/'; slug-safe)")
    .option(
      "--target <github-target>",
      "Destination policy: github:user/<owner> or github:org/<owner>",
    )
    .option("--local", "Persist a local-only destination policy")
    .option(
      "--push-to <gh-target>",
      "GitHub handle or org to push the main vault repo to (defaults to your GH handle when push is enabled)",
    )
    .option("--push-kind <handle|org>", "Push target kind", "handle")
    .option(
      "--parent <existing-mesh>",
      "Parent mesh — the new main vault's parent_vault FK resolves to the parent mesh's main vault rid",
    )
    .option("--no-push", "Skip the initial git push (local commits only)")
    .option("--no-git", "Create the local mesh without initializing Git or a checkpoint")
    .option(
      "--commit-initial",
      "Legacy compatibility flag; initial checkpoints are already automatic",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (name: string, opts: MeshInitCliOpts, command: Command) => {
      const startedAt = new Date().toISOString();
      const attemptId = uuid7BytesToDashedString(newUuidv7Bytes());
      let operationId = uuid7BytesToDashedString(newUuidv7Bytes());
      let logicalKey: unknown = { name, parent: opts.parent ?? null, request: "unresolved" };
      let receiptAttempt: ReceiptAttemptSession | undefined;
      let receiptMeshId: string | undefined;
      let receipt: ReceiptV1;
      try {
        const normalized = normalizeCommanderCreationDestination(opts, {
          getOptionValueSource: (optionName) => cmdOptionSource(command, optionName),
        });
        const repositoryName = vaultRepoName(`${name}/main`);
        const requestedDestinationIntent = {
          target: opts.target ?? null,
          local: opts.local === true,
          pushTo: opts.pushTo ?? null,
          pushKind: opts.pushKind ?? null,
          push: opts.push ?? null,
        };
        const identityRequest: DestinationRequest =
          normalized.kind === "refusal" ? { kind: "local" } : normalized.request;
        const identityScope = [
          `${name}/main`,
          resolveVaultPath(`${name}/main`),
          `parent=${opts.parent ?? ""}`,
          `git=${opts.git !== false}`,
          `commit-initial=${opts.commitInitial === true}`,
          ...(normalized.kind === "refusal"
            ? [`invalid-destination=${JSON.stringify(requestedDestinationIntent)}`]
            : []),
        ].join("\0");
        const logicalOperationId = deriveCreationOperationIdV1({
          request: identityRequest,
          subject: { kind: "mesh", repositoryName },
          scope: identityScope,
        });
        operationId = uuid7BytesToDashedString(hexToUuid7Bytes(logicalOperationId));
        if (normalized.kind === "refusal") {
          logicalKey = {
            name,
            parent: opts.parent ?? null,
            request: { kind: "invalid", destination: requestedDestinationIntent },
            git: opts.git !== false,
            commitInitial: opts.commitInitial === true,
          };
          const opened = await (dependencies.openReceiptAttempt ?? openReceiptAttempt)(
            meshReceipt({
              operationId,
              attemptId,
              startedAt,
              logicalKey,
              status: "no-op",
            }),
          );
          if (opened.kind === "unavailable") {
            receipt = receiptStoreUnavailableMeshReceipt({
              operationId,
              attemptId,
              startedAt,
              logicalKey,
            });
            emitMeshReceiptStoreWarnings(opened.warnings);
          } else {
            receiptAttempt = opened.session;
            receipt = meshReceipt({
              operationId,
              attemptId,
              startedAt,
              logicalKey,
              status: "refused",
              code: normalized.code,
              summary: normalized.message,
              next: normalized.next_action,
            });
          }
        } else {
          logicalKey = {
            name,
            parent: opts.parent ?? null,
            request: normalized.request,
            git: opts.git !== false,
            commitInitial: opts.commitInitial === true,
          };
          receiptMeshId = uuid7BytesToDashedString(
            hexToUuid7Bytes(derivePlannedCreationRid(logicalOperationId, `mesh:${name}`)),
          );
          const opened = await (dependencies.openReceiptAttempt ?? openReceiptAttempt)(
            meshReceipt({
              operationId,
              attemptId,
              startedAt,
              logicalKey,
              status: "no-op",
              meshId: receiptMeshId,
            }),
          );
          if (opened.kind === "unavailable") {
            const unavailableReceipt = parseReceiptV1ForEmission(
              receiptStoreUnavailableMeshReceipt({
                operationId,
                attemptId,
                startedAt,
                logicalKey,
                meshId: receiptMeshId,
              }),
            );
            emitMeshReceiptStoreWarnings(opened.warnings);
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(unavailableReceipt));
            process.exitCode = unavailableReceipt.exit_code;
            return;
          }
          receiptAttempt = opened.session;
          const actor = await actorForRequest(
            normalized.request,
            attemptId,
            dependencies.observeActor,
          );
          const target =
            normalized.request.kind === "target"
              ? parseGithubPublicationTarget(normalized.request.target)
              : normalized.request.kind === "auto" && actor.result === "verified"
                ? parseGithubPublicationTarget(`github:user/${actor.actor}`)
                : null;
          const permission =
            target !== null && actor.result === "verified"
              ? await (dependencies.observePermission ?? observePublicationPermission)({
                  capability: "repository-create",
                  target: target.value,
                  repository: `${target.owner}/${repositoryName}`,
                  actor: actor.actor,
                  attemptId,
                  policyEpoch: 0,
                })
              : null;
          const preflight = await (dependencies.inspectPreflight ?? inspectMeshInitPreflight)({
            name,
          });
          const planned = resolveCreationPlanV1({
            request: normalized.request,
            subject: { kind: "mesh", repositoryName },
            actor,
            intendedEffects: withCreationRepositoryEffectsV1(
              plannedSingleVaultEffectsV1({
                operationId: logicalOperationId,
                pod:
                  preflight.podIdentity.state === "present"
                    ? { kind: "existing", rid: preflight.podIdentity.rid }
                    : { kind: "create", handle: actor.actor ?? deriveProvisionalHandle() },
                mesh: { kind: "create", name },
                vaultName: `${name}/main`,
                vaultRoot: resolveVaultPath(`${name}/main`),
              }),
              preflight.podIdentity.state === "present"
                ? [
                    {
                      repositoryRoot: preflight.podIdentity.repositoryRoot,
                      exactPaths: plannedMeshPodEffectPathsV1(false),
                      boundedPathClasses: [
                        "destination-policy-ledger",
                        "federation-manifest-ledger",
                        "git-metadata",
                      ],
                    },
                  ]
                : [],
            ),
            permission,
          });
          if (planned.kind === "refusal") {
            receipt = meshReceipt({
              operationId,
              attemptId,
              startedAt,
              logicalKey,
              status: "refused",
              meshId: receiptMeshId,
              code: planned.code,
              summary: planned.message,
              next: planned.next_action,
            });
          } else {
            operationId = uuid7BytesToDashedString(
              hexToUuid7Bytes(planned.plan.intended_effects.operation_id),
            );
            const replayMeshRid = preflight.meshExists
              ? exactExistingMeshReplay({
                  name,
                  parent: opts.parent,
                  requireGit: opts.git !== false,
                  registryPath: preflight.registryPath,
                  plan: planned.plan,
                })
              : null;
            if (preflight.meshExists && replayMeshRid === null) {
              receipt = meshReceipt({
                operationId,
                attemptId,
                startedAt,
                logicalKey,
                status: "refused",
                meshId: receiptMeshId,
                code: "creation-replay-unproven",
                summary:
                  "The existing mesh does not prove the same exact, clean local creation request.",
                next: "Inspect the mesh and main vault, then choose an explicit repair or a different mesh name.",
                nextCode: "inspect-existing-mesh",
              });
            } else if (replayMeshRid !== null) {
              receipt = meshReceipt({
                operationId,
                attemptId,
                startedAt,
                logicalKey,
                status: "replayed",
                meshId: receiptMeshId,
              });
            } else {
              if (opts.json !== true) console.error(destinationExplanation(planned.plan));
              const result = await (dependencies.meshInit ?? meshInitFlow)({
                name,
                ...(opts.parent === undefined ? {} : { parent: opts.parent }),
                creation: {
                  destinationRequest: normalized.request,
                  creationPlan: planned.plan,
                  attemptId,
                },
                noGit: opts.git === false,
                commitInitial: opts.commitInitial === true,
              });
              const partial =
                result.checkpoint.status === "failed" || result.checkpoint.status === "partial";
              const m = result.mutations;
              receipt = meshReceipt({
                operationId,
                attemptId,
                startedAt,
                logicalKey,
                status: partial ? "partial" : "success",
                meshId: receiptMeshId,
                local: creationLocalMutationCount(m),
                code: partial ? "checkpoint-failed" : undefined,
                summary: partial ? "Local checkpoint failed after mesh creation." : undefined,
                next: partial ? `lyt sync --vault ${result.mainVault.name}` : undefined,
                nextCode: partial ? "complete-local-checkpoint" : undefined,
                mutations: m,
                commit: result.checkpoint.commitSha,
                destination:
                  result.creationPlan.destination.kind === "github"
                    ? result.creationPlan.destination.target
                    : "local",
                sync: `lyt sync --vault ${result.mainVault.name}`,
              });
            }
          }
        }
      } catch (err) {
        const mutationFailure = err instanceof CreationMutationFailure ? err : null;
        const mutations = mutationFailure?.mutations;
        const local = mutations === undefined ? 0 : creationLocalMutationCount(mutations);
        const summary = mutationFailure?.message ?? "Mesh creation failed.";
        receipt = meshReceipt({
          operationId,
          attemptId,
          startedAt,
          logicalKey,
          status: local > 0 ? "partial" : "failed",
          ...(receiptMeshId === undefined ? {} : { meshId: receiptMeshId }),
          local,
          code: mutationFailure?.code ?? "mesh-init-failed",
          summary,
          next:
            mutationFailure?.nextAction.summary ??
            "Inspect the local mesh state before retrying creation.",
          nextCode: mutationFailure?.nextAction.code ?? "inspect-local-creation",
          retryable: mutationFailure?.retryable ?? true,
          ...(mutations === undefined ? {} : { mutations }),
        });
      }
      // Receipt V1 is the one and only stdout object for every terminal state.
      const terminalReceipt = parseReceiptV1ForEmission(receipt);
      if (receiptAttempt !== undefined) {
        const warnings = await receiptAttempt.finalize(terminalReceipt);
        emitMeshReceiptStoreWarnings(warnings);
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(terminalReceipt));
      if (terminalReceipt.exit_code !== 0) process.exitCode = terminalReceipt.exit_code;
    });
}

function cmdOptionSource(
  command: Command,
  name: string,
): "default" | "config" | "env" | "cli" | "implied" | undefined {
  return command.getOptionValueSource(name) as
    "default" | "config" | "env" | "cli" | "implied" | undefined;
}

async function actorForRequest(
  request: DestinationRequest,
  attemptId: string,
  observer: typeof observeActiveActor = observeActiveActor,
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

function exactExistingMeshReplay(args: {
  name: string;
  parent?: string | undefined;
  requireGit: boolean;
  registryPath: string;
  plan: CreationPlanV1;
}): string | null {
  if (args.plan.intended_effects.mesh.kind !== "create") return null;
  const main = inspectVaultInitPreflight({
    name: `${args.name}/main`,
    meshEnabled: true,
    registryPath: args.registryPath,
  });
  const plannedMain = args.plan.intended_effects.vaults.find(
    (vault) => vault.rid === args.plan.intended_effects.primary_vault_rid,
  );
  if (
    main.mesh === null ||
    main.existingVault === null ||
    plannedMain === undefined ||
    main.mesh.name !== args.name ||
    main.mesh.rid !== args.plan.intended_effects.mesh.rid ||
    main.mesh.mainVaultPath !== plannedMain.root ||
    main.existingVault.rid !== plannedMain.rid ||
    main.existingVault.path !== plannedMain.root ||
    !exactMeshDestinationPolicy(main.mesh.policy, args.plan) ||
    !exactMainVaultDestinationPolicy(main.existingVault.policy, args.plan) ||
    !exactMeshParent(args.registryPath, plannedMain.root, args.parent) ||
    !hasExactPlannedMemscope(plannedMain) ||
    !hasExactCreationReplayState(args.registryPath, args.plan, { requireGit: args.requireGit })
  ) {
    return null;
  }
  return main.mesh.rid;
}

function hasExactPlannedMemscope(
  planned: CreationPlanV1["intended_effects"]["vaults"][number],
): boolean {
  try {
    const vault = parseVaultYon(readFileSync(`${planned.root}/.lyt/vault.yon`, "utf8"));
    if (vault.primaryOwner === null) return false;
    const content = readFileSync(`${planned.root}/.lyt/memscope.yon`, "utf8");
    const docRid = content.match(/^@DOC\s+ver=2\.0\s+\|\s+id=([^\s|]+)/m)?.[1];
    const scopeRid = content.match(/^@MEMSCOPE\s+rid=([^\s|]+)/m)?.[1];
    const appliesToVault = content.match(
      /^@META\s+key=applies_to_vault\s+\|\s+value=([^\s|]+)/m,
    )?.[1];
    if (
      normalizeRid(docRid ?? "") !== planned.memscope_rid ||
      normalizeRid(scopeRid ?? "") !== planned.memscope_rid ||
      normalizeRid(appliesToVault ?? "") !== planned.rid
    ) {
      return false;
    }
    return (
      content ===
      renderMemscopeYon({
        vaultRid: hexToUuid7Bytes(planned.rid),
        vaultName: planned.name,
        scope: {
          rid: hexToUuid7Bytes(planned.memscope_rid),
          scopeLevel: "vault",
          readRoles: [vault.primaryOwner],
          writeRoles: [vault.primaryOwner],
          adminRoles: [vault.primaryOwner],
          defaultView: "private",
        },
        allowExpandToProject: false,
        allowExpandToWorkspace: false,
      })
    );
  } catch {
    return false;
  }
}

function normalizeRid(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

function exactMainVaultDestinationPolicy(
  observed: DestinationPolicyValue | null,
  plan: CreationPlanV1,
): boolean {
  if (plan.destination.kind === "local") {
    return (
      observed !== null &&
      observed.destinationKind === "local" &&
      observed.targetOwner === null &&
      observed.targetKind === null &&
      observed.source === "mesh-inherited"
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
    observed.source === "mesh-inherited"
  );
}

function exactMeshDestinationPolicy(
  observed: DestinationPolicyValue | null,
  plan: CreationPlanV1,
): boolean {
  const source =
    plan.destination.policy_source === "authenticated-default"
      ? "authenticated-default"
      : plan.destination.policy_source === "auto-fallback-local"
        ? "auto-fallback-local"
        : "explicit";
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
    observed.source === source
  );
}

function exactMeshParent(
  registryPath: string,
  mainVaultPath: string,
  parentName: string | undefined,
): boolean {
  try {
    const parsed = parseVaultYon(
      readFileSync(`${mainVaultPath}/.lyt/vault.yon`, "utf8"),
    ).parentVault;
    if (parentName === undefined || parentName.length === 0) return parsed === null;
    const db = new BetterSqlite3(registryPath, { readonly: true, fileMustExist: true });
    try {
      const parent = db
        .prepare(
          `SELECT lower(hex(main_vault_rid)) AS rid
             FROM meshes
            WHERE name = ? AND main_vault_rid IS NOT NULL
            LIMIT 1`,
        )
        .get(parentName) as { rid: string } | undefined;
      return (
        parent !== undefined &&
        parsed !== null &&
        parsed.replaceAll("-", "").toLowerCase() === parent.rid
      );
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function meshReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  logicalKey: unknown;
  logicalReplayKey?: string;
  status: "success" | "no-op" | "replayed" | "partial" | "refused" | "failed";
  meshId?: string;
  local?: number;
  code?: string;
  summary?: string;
  next?: string;
  nextCode?: string;
  retryable?: boolean;
  mutations?: CreationMutationEvidence;
  commit?: string;
  destination?: string;
  sync?: string;
}): ReceiptV1 {
  const refused = args.status === "refused";
  const replayed = args.status === "replayed";
  const failed = args.status === "failed" || args.status === "partial";
  const error =
    failed || refused
      ? {
          code: args.code ?? "mesh-init-failed",
          summary: args.summary ?? "Mesh creation failed.",
          retryable: args.retryable ?? !refused,
        }
      : null;
  return {
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: "mesh-init",
    scope: args.meshId === undefined ? { kind: "system" } : { kind: "mesh", mesh_id: args.meshId },
    timestamps: { started_at: args.startedAt, finished_at: new Date().toISOString() },
    replay: {
      disposition: refused ? "rejected" : replayed ? "replayed" : "new",
      key_digest:
        (args.logicalReplayKey === undefined
          ? undefined
          : creationPlanReplayKeyDigest(args.logicalReplayKey)) ??
        createHash("sha256").update(JSON.stringify(args.logicalKey)).digest("hex"),
    },
    status: args.status,
    exit_code: args.status === "success" || args.status === "no-op" || replayed ? 0 : 2,
    mutations: { local: args.local ?? 0, remote: 0 },
    evidence: {
      before: [],
      after:
        args.mutations === undefined
          ? []
          : [
              {
                kind: "registry-rows",
                subject: "mesh vault membership",
                count: args.mutations.registryRows,
              },
              {
                kind: "topology-bindings",
                subject: "main home membership",
                count: args.mutations.topologyBindings,
              },
              {
                kind: "local-databases",
                subject: "vault derived indexes",
                count: args.mutations.localDatabases,
              },
              {
                kind: "destination-records",
                subject: "mesh and main vault",
                count: args.mutations.destinationPolicyRecords,
              },
              ...(args.mutations.checkpointRepositories.length === 0
                ? []
                : [
                    {
                      kind: "creation-checkpoints",
                      subject: "repository-qualified exact local creation paths",
                      digest: creationCheckpointPathDigest(args.mutations),
                      count: args.mutations.checkpointRepositories.length,
                    },
                  ]),
              ...(args.commit === undefined
                ? []
                : [{ kind: "checkpoint-commit", subject: args.commit }]),
              ...(args.destination === undefined
                ? []
                : [{ kind: "destination", subject: args.destination }]),
              ...(args.sync === undefined ? [] : [{ kind: "next-sync", subject: args.sync }]),
            ],
    },
    next_action:
      args.status === "success" || args.status === "no-op" || replayed
        ? null
        : {
            code:
              args.nextCode ??
              (args.status === "partial" ? "complete-local-checkpoint" : "correct-mesh-init"),
            summary: args.next ?? "Correct the mesh creation request and retry.",
          },
    error,
  };
}

function receiptStoreUnavailableMeshReceipt(args: {
  operationId: string;
  attemptId: string;
  startedAt: string;
  logicalKey: unknown;
  logicalReplayKey?: string;
  meshId?: string;
}): ReceiptV1 {
  return meshReceipt({
    ...args,
    status: "refused",
    code: "receipt-store-unavailable",
    summary: "Mesh creation did not start because its durable receipt could not be opened.",
    next: "Resolve the local receipt-store problem, then retry the same mesh creation.",
    nextCode: "retry-mesh-init",
    retryable: true,
  });
}

function emitMeshReceiptStoreWarnings(warnings: readonly ReceiptAttemptWarningCode[]): void {
  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.error(`lyt mesh init warning: ${warning}`);
  }
}

function destinationExplanation(plan: CreationPlanV1): string {
  const destination = plan.destination.kind === "local" ? "local only" : plan.destination.target;
  return `Destination: ${destination} (${plan.destination.source}); creation remains local and not published.`;
}

interface MeshJoinCliOpts {
  from: string;
  cloneMembers?: boolean;
  json?: boolean;
}

function buildMeshJoinSubcommand(): Command {
  return new Command("join")
    .description(
      "Join an existing mesh from a GitHub source. Clones the main vault's repo, reads .lyt/mesh.yon, registers the mesh locally.",
    )
    .argument("<name>", "Local mesh name (typically matches the remote name)")
    .requiredOption(
      "--from <gh-target>",
      "GitHub handle or org owning the main vault repo (e.g. 'younndai' → github.com/younndai/main)",
    )
    .option(
      "--clone-members",
      "Also clone every @MESH_HOME-listed vault (flag is currently a no-op; cascading clone is not yet wired)",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (name: string, opts: MeshJoinCliOpts) => {
      const result = await meshJoinFlow({
        name,
        from: opts.from,
        cloneMembers: opts.cloneMembers === true,
      });

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              mesh: {
                rid: `mesh:${result.meshRidHex}`,
                rid_hex: result.meshRidHex,
                name: result.meshName,
                push_target: result.pushTarget,
                push_kind: result.pushKind,
              },
              main_vault: {
                rid: `vault:${result.mainVault.ridHex}`,
                rid_hex: result.mainVault.ridHex,
                name: result.mainVault.name,
                path: result.mainVault.path,
              },
              home_vaults_registered: result.homeVaultsRegistered,
              home_vaults_deferred: result.homeVaultsDeferred,
              home_vaults_cloned: result.homeVaultsCloned,
            },
            null,
            2,
          ),
        );
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`Joined mesh '${result.meshName}'`);
      // eslint-disable-next-line no-console
      console.log(`  mesh rid:    mesh:${result.meshRidHex}`);
      // eslint-disable-next-line no-console
      console.log(`  main vault:  ${result.mainVault.name} (vault:${result.mainVault.ridHex})`);
      // eslint-disable-next-line no-console
      console.log(`  path:        ${result.mainVault.path}`);
      // eslint-disable-next-line no-console
      console.log(
        ` homes: ${result.homeVaultsRegistered} registered` +
          `${result.homeVaultsCloned > 0 ? ` (${result.homeVaultsCloned} cloned)` : ""}` +
          `, ${result.homeVaultsDeferred} deferred-clone`,
      );
    });
}

interface MeshCanvasCliOpts {
  mesh?: string;
  nowIso?: string;
  json?: boolean;
}

function buildMeshCanvasSubcommand(): Command {
  return new Command("canvas")
    .description(
      "Render the mesh as an Obsidian Canvas (.canvas) — mesh → vaults → cross-mesh subscriptions. Writes to <mesh-main-vault>/.lyt/canvases/mesh-graph.canvas.",
    )
    .requiredOption("--mesh <name>", "Mesh name (must exist in the local registry)")
    .option("--now-iso <iso>", "Pin the 'now' timestamp for deterministic testing (ISO 8601)")
    .option("--json", "Emit JSON result instead of human-readable output")
    .action(async (opts: MeshCanvasCliOpts) => {
      if (opts.mesh === undefined || opts.mesh.length === 0) {
        emitMeshCanvasError(opts.json === true, {
          error: "missing-mesh",
          message: "--mesh <name> is required.",
        });
        process.exitCode = 1;
        return;
      }
      try {
        const res = await generateMeshCanvasFlow({
          meshName: opts.mesh,
          ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                canvasPath: res.canvasPath,
                meshRid: res.meshRid,
                meshName: res.meshName,
                vaultCount: res.vaultCount,
                crossMeshSubscriptionCount: res.crossMeshSubscriptionCount,
                nodeCount: res.nodeCount,
                edgeCount: res.edgeCount,
                durationMs: res.durationMs,
              },
              null,
              2,
            ),
          );
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Mesh canvas for ${res.meshName} written to ${res.canvasPath} (${res.vaultCount} vaults, ${res.crossMeshSubscriptionCount} subscriptions, ${res.nodeCount} nodes, ${res.edgeCount} edges; ${res.durationMs}ms).`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitMeshCanvasError(opts.json === true, {
          error: "canvas-mesh-error",
          message,
        });
        process.exitCode = 2;
      }
    });
}

function emitMeshCanvasError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt mesh canvas: ${String(body["message"] ?? body["error"])}`);
  }
}

interface MeshListCliOpts {
  json?: boolean;
}

function buildMeshListSubcommand(): Command {
  return new Command("list")
    .description(
      "List meshes the user participates in. ★ marks each mesh's main vault per naming-convention.md.",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: MeshListCliOpts) => {
      const result = await meshListFlow();
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              meshes: result.meshes.map((m) => ({
                rid: `mesh:${m.ridHex}`,
                rid_hex: m.ridHex,
                name: m.name,
                push_target: m.pushTarget,
                push_kind: m.pushKind,
                main_vault:
                  m.mainVault === null
                    ? null
                    : {
                        rid: `vault:${m.mainVault.ridHex}`,
                        rid_hex: m.mainVault.ridHex,
                        name: m.mainVault.name,
                      },
                home_vaults: m.homeVaults.map((v) => ({
                  rid: `vault:${v.ridHex}`,
                  rid_hex: v.ridHex,
                  name: v.name,
                })),
                subscribed_vaults: m.subscribedVaults.map((v) => ({
                  rid: `vault:${v.ridHex}`,
                  rid_hex: v.ridHex,
                  name: v.name,
                })),
              })),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (result.meshes.length === 0) {
        // eslint-disable-next-line no-console
        console.log("No meshes yet. Run 'lyt mesh init <name>' to create one.");
        return;
      }
      for (const m of result.meshes) {
        // eslint-disable-next-line no-console
        console.log(`Mesh '${m.name}' (mesh:${m.ridHex})`);
        if (m.pushTarget !== null) {
          // eslint-disable-next-line no-console
          console.log(`  push target: ${m.pushKind}:${m.pushTarget}`);
        }
        for (const home of m.homeVaults) {
          const marker = m.mainVault !== null && home.ridHex === m.mainVault.ridHex ? "★" : " ";
          // eslint-disable-next-line no-console
          console.log(`  ${marker} ${home.name} (vault:${home.ridHex})`);
        }
        for (const sub of m.subscribedVaults) {
          // eslint-disable-next-line no-console
          console.log(`    ${sub.name} (subscribed; vault:${sub.ridHex})`);
        }
      }
    });
}
