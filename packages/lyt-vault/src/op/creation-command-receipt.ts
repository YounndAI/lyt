/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

import { createHash } from "node:crypto";

import { parseReceiptV1ForEmission, type ReceiptV1 } from "./receipt-v1.js";
import { creationLocalMutationCount } from "./creation-mutation-journal.js";
import type { CreationCheckpointEvidence } from "./creation-mutation-journal.js";
import type { VaultAliasRecommendation } from "../flows/alias-recommendation.js";

export interface CreationReceiptEvidence {
  registryRows?: number;
  topologyBindings?: number;
  localDatabases?: number;
  filesystemWrites?: number;
  destinationPolicyRecords?: number;
  failureLogRecords?: number;
  checkpointCommits?: number;
  checkpointPaths?: readonly string[];
  checkpointRepositories?: readonly CreationCheckpointEvidence[];
  destination?: string;
  scopedSync?: string;
  checkpointCommit?: string | null;
  childReplayKeys?: readonly string[];
  editorLocalWritePaths?: readonly string[];
  aliasRecommendation?: VaultAliasRecommendation;
}

export function creationReceiptLocalMutationCount(
  evidence: CreationReceiptEvidence | undefined,
): number {
  if (evidence === undefined) return 0;
  return creationLocalMutationCount({
    registryRows: evidence.registryRows ?? 0,
    topologyBindings: evidence.topologyBindings ?? 0,
    localDatabases: evidence.localDatabases ?? 0,
    filesystemWrites: evidence.filesystemWrites ?? 0,
    destinationPolicyRecords: evidence.destinationPolicyRecords ?? 0,
    failureLogRecords: evidence.failureLogRecords ?? 0,
    checkpointCommits: evidence.checkpointCommits ?? 0,
    checkpointRepositories: [...(evidence.checkpointRepositories ?? [])],
    checkpointPaths: [...(evidence.checkpointPaths ?? [])],
  });
}

/**
 * Receipt v1 stores a bare SHA-256 digest, while a creation plan identifies
 * that same immutable logical intent as `sha256:<digest>`.
 */
export function creationPlanReplayKeyDigest(logicalReplayKey: string): string {
  const digest = logicalReplayKey.replace(/^sha256:/i, "");
  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new Error("Creation plan logical replay key is not a SHA-256 digest.");
  }
  return digest;
}

export function makeCreationCommandReceipt(args: {
  operation: "vault-init" | "cli-parse";
  operationId: string;
  attemptId: string;
  startedAt: string;
  logicalKey: unknown;
  /** Exact immutable creation-plan identity when planning succeeded. */
  logicalReplayKey?: string;
  status: "success" | "no-op" | "replayed" | "refused" | "partial" | "failed";
  replayDisposition?: "new" | "replayed" | "resumed" | "rejected";
  scope?: { kind: "vault"; vault_id: string } | { kind: "system" };
  evidence?: CreationReceiptEvidence;
  error?: { code: string; summary: string; retryable: boolean };
  next?: { code: string; summary: string };
  exitCode?: number;
}): ReceiptV1 {
  const local = creationReceiptLocalMutationCount(args.evidence);
  const rejected = args.status === "refused";
  const checkpointPaths = args.evidence?.checkpointPaths ?? [];
  const checkpointRepositories = args.evidence?.checkpointRepositories ?? [];
  const after: ReceiptV1["evidence"]["after"] = [];

  const mutationFacts = {
    registryRows: args.evidence?.registryRows ?? 0,
    topologyBindings: args.evidence?.topologyBindings ?? 0,
    localDatabases: args.evidence?.localDatabases ?? 0,
    filesystemWrites: args.evidence?.filesystemWrites ?? 0,
    destinationPolicyRecords: args.evidence?.destinationPolicyRecords ?? 0,
    failureLogRecords: args.evidence?.failureLogRecords ?? 0,
    checkpointCommits: args.evidence?.checkpointCommits ?? 0,
  };
  if (Object.values(mutationFacts).some((count) => count > 0)) {
    after.push({
      kind: "mutation-summary",
      subject: "bounded local creation mutation classes",
      count: Object.values(mutationFacts).reduce((sum, count) => sum + count, 0),
      digest: digestJson(mutationFacts),
    });
  }
  if (checkpointRepositories.length > 0 || checkpointPaths.length > 0) {
    const repositories =
      checkpointRepositories.length > 0
        ? checkpointRepositories
        : [{ repositoryRoot: "legacy-unqualified", paths: [...checkpointPaths] }];
    after.push({
      kind: "checkpoint-set",
      subject: "repository-qualified exact creation checkpoints",
      count: repositories.length,
      digest: digestJson(repositories),
    });
  }
  if (args.evidence?.destination) {
    after.push({ kind: "destination", subject: args.evidence.destination });
  }
  if (args.evidence?.scopedSync) {
    after.push({ kind: "next-sync", subject: args.evidence.scopedSync });
  }
  const editorLocalWritePaths = [...(args.evidence?.editorLocalWritePaths ?? [])].sort();
  if (editorLocalWritePaths.length > 0) {
    after.push({
      kind: "editor-local-write-set",
      subject: editorLocalWritePaths.join(", "),
      count: editorLocalWritePaths.length,
      digest: digestJson(editorLocalWritePaths),
    });
  }
  const childReplayKeys = args.evidence?.childReplayKeys ?? [];
  if (childReplayKeys.length > 0) {
    after.push({
      kind: "creation-children",
      subject: "bound child creation plans",
      count: childReplayKeys.length,
      digest: digestJson([...childReplayKeys].sort()),
    });
  }
  if (args.evidence?.aliasRecommendation !== undefined) {
    after.push({
      kind: "alias-recommendation",
      subject: "vault alias recommendation",
    });
  }

  const receipt: ReceiptV1 = {
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.operationId,
    attempt_id: args.attemptId,
    operation: args.operation,
    scope: args.scope ?? { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: new Date().toISOString() },
    replay: {
      disposition: args.replayDisposition ?? (rejected ? "rejected" : "new"),
      key_digest:
        (args.logicalReplayKey === undefined
          ? undefined
          : creationPlanReplayKeyDigest(args.logicalReplayKey)) ??
        createHash("sha256").update(JSON.stringify(args.logicalKey)).digest("hex"),
    },
    status: args.status,
    exit_code:
      args.exitCode ??
      (args.status === "success" || args.status === "no-op" || args.status === "replayed" ? 0 : 2),
    mutations: { local, remote: 0 },
    evidence: { before: [], after },
    ...(args.evidence?.aliasRecommendation === undefined
      ? {}
      : {
          recommendations: [
            {
              kind: "vault-alias" as const,
              action: args.evidence.aliasRecommendation.action,
              alias: args.evidence.aliasRecommendation.alias,
              canonical_target: args.evidence.aliasRecommendation.canonicalTarget,
              vault_rid: args.evidence.aliasRecommendation.vaultRid,
              reason: args.evidence.aliasRecommendation.reason,
              argv: [...args.evidence.aliasRecommendation.argv],
            },
          ],
        }),
    next_action: args.next ?? null,
    error: args.error ?? null,
  };
  return parseReceiptV1ForEmission(receipt);
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
