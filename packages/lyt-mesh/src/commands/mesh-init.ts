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

import { createHash } from "node:crypto";

import { Command } from "commander";

import {
  CreationMutationFailure,
  creationCheckpointPathDigest,
  creationLocalMutationCount,
  newUuidv7Bytes,
  parseReceiptV1ForEmission,
  uuid7BytesToDashedString,
  type CreationMutationEvidence,
  type ReceiptV1,
} from "@younndai/lyt-vault";

import { meshInitFlow, type MeshInitOptions } from "../flows/mesh-init.js";

export interface MeshInitCommandDependencies {
  meshInit?: typeof meshInitFlow;
}

export function buildMeshInitCommand(dependencies: MeshInitCommandDependencies = {}): Command {
  const cmd = new Command("init");
  cmd
    .description(
      "Stand up a mesh locally from a YON manifest. Validates uniqueness, parent refs, and DAG before local side effects.",
    )
    .requiredOption("--from <manifest.yon>", "Path to the YON manifest file")
    .option("--dry-run", "Preview: list vaults + edges that would be created; touch nothing")
    .option("--only <glob>", "Initialize only vaults matching this glob (e.g., 'cats-eng-*')")
    .option("--no-push", "Compatibility flag; mesh initialization is always local-only")
    .option("--json", "Emit the aggregate Receipt V1 as JSON (the default output)")
    .option(
      "--override <field=value>",
      "Override a single field: '<vault>.<field>=<value>'. Repeatable.",
      collectOverride,
      [] as string[],
    )
    .action(async (opts: MeshInitCliOpts) => {
      const startedAt = new Date().toISOString();
      const operationId = newReceiptId();
      const attemptId = newReceiptId();
      const args: MeshInitOptions = {
        manifestPath: opts.from,
        dryRun: opts.dryRun === true,
        ...(opts.only !== undefined ? { only: opts.only } : {}),
        noPush: opts.push === false,
        overrides: opts.override ?? [],
        attemptId,
      };
      let receipt: ReceiptV1;
      try {
        const result = await (dependencies.meshInit ?? meshInitFlow)(args);
        receipt = receiptForResult(result, args, operationId, startedAt);
      } catch (error) {
        receipt = failedReceipt(args, operationId, attemptId, startedAt, error);
      }

      // Receipt V1 is the command's only stdout emission in every mode.
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(receipt));
      if (receipt.exit_code !== 0) process.exitCode = receipt.exit_code;
    });
  return cmd;
}

interface MeshInitCliOpts {
  from: string;
  dryRun?: boolean;
  only?: string;
  push?: boolean;
  json?: boolean;
  override?: string[];
}

function collectOverride(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function receiptForResult(
  result: Awaited<ReturnType<typeof meshInitFlow>>,
  args: MeshInitOptions,
  operationId: string,
  startedAt: string,
): ReceiptV1 {
  if (!result.ok) {
    return parseReceiptV1ForEmission({
      ...receiptBase(args, operationId, result.attemptId, startedAt),
      replay: { disposition: "rejected", key_digest: replayDigest(args) },
      status: "refused",
      exit_code: 1,
      mutations: { local: 0, remote: 0 },
      evidence: {
        before: [
          {
            kind: "validation-issues",
            subject: "manifest creation batch",
            count: result.issues.length,
          },
        ],
        after: [],
      },
      next_action: {
        code: "correct-creation-input",
        summary: "Correct the manifest creation facts and retry.",
      },
      error: {
        code: result.reason,
        summary: "Mesh creation was refused before mutation.",
        retryable: true,
      },
    });
  }

  const outcome = result.outcome;
  const incompleteCheckpoints = outcome.vaults.filter(
    (vault) => vault.initialized && vault.checkpoint?.status !== "committed",
  ).length;
  const isPartial = !outcome.dryRun && incompleteCheckpoints > 0;
  const status = isPartial ? "partial" : outcome.localMutationCount === 0 ? "no-op" : "success";
  return parseReceiptV1ForEmission({
    ...receiptBase(args, operationId, outcome.attemptId, startedAt),
    replay: { disposition: "new", key_digest: replayDigest(args) },
    status,
    exit_code: isPartial ? 1 : 0,
    mutations: { local: outcome.localMutationCount, remote: 0 },
    evidence: {
      before: [
        {
          kind: "planned-vaults",
          subject: "explicit local creation batch",
          count: outcome.vaults.length,
        },
      ],
      after: [
        ...mutationEvidence(outcome.mutations),
        { kind: "publication-state", subject: "not published", count: outcome.vaults.length },
      ],
    },
    next_action: isPartial
      ? {
          code: "recover-checkpoint",
          summary: "Inspect the local repositories and retry checkpoint recovery.",
        }
      : null,
    error: isPartial
      ? {
          code: "checkpoint-incomplete",
          summary: "One or more local checkpoints did not complete.",
          retryable: true,
        }
      : null,
  });
}

function failedReceipt(
  args: MeshInitOptions,
  operationId: string,
  attemptId: string,
  startedAt: string,
  error: unknown,
): ReceiptV1 {
  const mutationFailure = error instanceof CreationMutationFailure ? error : null;
  const mutations = mutationFailure?.mutations;
  const local = mutations === undefined ? 0 : creationLocalMutationCount(mutations);
  const partial = local > 0;
  return parseReceiptV1ForEmission({
    ...receiptBase(args, operationId, attemptId, startedAt),
    replay: { disposition: "new", key_digest: replayDigest(args) },
    status: partial ? "partial" : "failed",
    exit_code: 1,
    mutations: { local, remote: 0 },
    evidence: { before: [], after: mutations === undefined ? [] : mutationEvidence(mutations) },
    next_action: mutationFailure?.nextAction ?? {
      code: "retry-mesh-init",
      summary: "Inspect local creation state before retrying mesh initialization.",
    },
    error: {
      code: mutationFailure?.code ?? "mesh-init-failed",
      summary: mutationFailure?.message ?? "Mesh initialization failed.",
      retryable: mutationFailure?.retryable ?? true,
    },
  });
}

function mutationEvidence(mutations: CreationMutationEvidence) {
  return [
    {
      kind: "registry-rows",
      subject: "local creation registry rows",
      count: mutations.registryRows,
    },
    {
      kind: "topology-bindings",
      subject: "local mesh topology bindings",
      count: mutations.topologyBindings,
    },
    {
      kind: "local-databases",
      subject: "local derived databases",
      count: mutations.localDatabases,
    },
    {
      kind: "destination-records",
      subject: "local destination policy records",
      count: mutations.destinationPolicyRecords,
    },
    {
      kind: "checkpoint-commits",
      subject: "local creation checkpoints",
      count: mutations.checkpointCommits,
    },
    {
      kind: "checkpoint-paths",
      subject: "exact local creation paths",
      digest: creationCheckpointPathDigest(mutations),
      count: mutations.checkpointPaths.length,
    },
  ];
}

function receiptBase(
  _args: MeshInitOptions,
  operationId: string,
  attemptId: string,
  startedAt: string,
) {
  return {
    schema_id: "lyt.receipt" as const,
    schema_version: { major: 1 as const, minor: 0 as const },
    operation_id: operationId,
    attempt_id: attemptId,
    operation: "mesh-init",
    scope: { kind: "system" as const },
    timestamps: { started_at: startedAt, finished_at: new Date().toISOString() },
  };
}

function replayDigest(args: MeshInitOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        manifestPath: args.manifestPath,
        dryRun: args.dryRun === true,
        only: args.only ?? null,
        noPush: args.noPush === true,
        overrides: args.overrides ?? [],
      }),
    )
    .digest("hex");
}

function newReceiptId(): string {
  return uuid7BytesToDashedString(newUuidv7Bytes());
}
