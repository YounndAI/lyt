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

/** Attempt-scoped evidence for the durable creation boundaries Lyt owns. */
export interface CreationMutationEvidence {
  registryRows: number;
  topologyBindings: number;
  localDatabases: number;
  filesystemWrites: number;
  destinationPolicyRecords: number;
  failureLogRecords: number;
  checkpointCommits: number;
  /** Repository-qualified checkpoint evidence; this is the authoritative form. */
  checkpointRepositories: CreationCheckpointEvidence[];
  /** @deprecated Flattened compatibility view. Never use it for identity or digests. */
  checkpointPaths: string[];
}

export interface CreationCheckpointEvidence {
  repositoryRoot: string;
  paths: string[];
  commitSha?: string;
  beforeCommitSha?: string;
  clean?: boolean;
}

export interface CreationMutationDelta {
  registryRows?: number;
  topologyBindings?: number;
  localDatabases?: number;
  filesystemWrites?: number;
  destinationPolicyRecords?: number;
  failureLogRecords?: number;
  checkpointCommits?: number;
  checkpointPaths?: readonly string[];
  checkpointRepositories?: readonly CreationCheckpointEvidence[];
}

export interface CreationRecoveryAction {
  code: string;
  summary: string;
}

export interface CreationMutationFailureOptions {
  code: string;
  summary: string;
  nextAction: CreationRecoveryAction;
  retryable?: boolean;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

export function emptyCreationMutationEvidence(): CreationMutationEvidence {
  return {
    registryRows: 0,
    topologyBindings: 0,
    localDatabases: 0,
    filesystemWrites: 0,
    destinationPolicyRecords: 0,
    failureLogRecords: 0,
    checkpointCommits: 0,
    checkpointRepositories: [],
    checkpointPaths: [],
  };
}

/**
 * Mutable only inside one creation attempt. Callers record a class immediately
 * after its durable boundary returns; snapshots are detached and immutable by
 * convention so command adapters cannot accidentally rewrite history.
 */
export class CreationMutationJournal {
  readonly attemptId: string;
  readonly #evidence = emptyCreationMutationEvidence();
  readonly #checkpointPaths = new Set<string>();
  readonly #checkpointRepositories = new Map<string, CreationCheckpointEvidence>();

  constructor(attemptId: string) {
    this.attemptId = attemptId;
  }

  record(delta: CreationMutationDelta): void {
    this.#evidence.registryRows += nonnegativeInteger(delta.registryRows ?? 0, "registryRows");
    this.#evidence.topologyBindings += nonnegativeInteger(
      delta.topologyBindings ?? 0,
      "topologyBindings",
    );
    this.#evidence.localDatabases += nonnegativeInteger(
      delta.localDatabases ?? 0,
      "localDatabases",
    );
    this.#evidence.filesystemWrites += nonnegativeInteger(
      delta.filesystemWrites ?? 0,
      "filesystemWrites",
    );
    this.#evidence.destinationPolicyRecords += nonnegativeInteger(
      delta.destinationPolicyRecords ?? 0,
      "destinationPolicyRecords",
    );
    this.#evidence.failureLogRecords += nonnegativeInteger(
      delta.failureLogRecords ?? 0,
      "failureLogRecords",
    );
    this.#evidence.checkpointCommits += nonnegativeInteger(
      delta.checkpointCommits ?? 0,
      "checkpointCommits",
    );
    for (const path of delta.checkpointPaths ?? []) {
      if (path.length > 0) this.#checkpointPaths.add(path);
    }
    for (const repository of delta.checkpointRepositories ?? []) {
      const root = repository.repositoryRoot.trim();
      if (root.length === 0) continue;
      const previous = this.#checkpointRepositories.get(root);
      this.#checkpointRepositories.set(root, {
        repositoryRoot: root,
        paths: [...new Set([...(previous?.paths ?? []), ...repository.paths])].sort(),
        ...(repository.commitSha === undefined && previous?.commitSha === undefined
          ? {}
          : { commitSha: repository.commitSha ?? previous?.commitSha }),
        ...(repository.beforeCommitSha === undefined && previous?.beforeCommitSha === undefined
          ? {}
          : { beforeCommitSha: repository.beforeCommitSha ?? previous?.beforeCommitSha }),
        ...(repository.clean === undefined && previous?.clean === undefined
          ? {}
          : { clean: repository.clean ?? previous?.clean }),
      });
    }
  }

  snapshot(): CreationMutationEvidence {
    return {
      ...this.#evidence,
      checkpointRepositories: [...this.#checkpointRepositories.values()].sort((a, b) =>
        a.repositoryRoot.localeCompare(b.repositoryRoot),
      ),
      checkpointPaths: [...this.#checkpointPaths].sort(),
    };
  }
}

/** A typed failure that carries only bounded creation evidence, never raw diagnostics. */
export class CreationMutationFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly nextAction: CreationRecoveryAction;
  readonly mutations: CreationMutationEvidence;

  constructor(
    options: CreationMutationFailureOptions,
    mutations: CreationMutationEvidence,
    cause?: unknown,
  ) {
    super(options.summary, cause === undefined ? undefined : { cause });
    this.name = "CreationMutationFailure";
    this.code = options.code;
    this.retryable = options.retryable ?? true;
    this.nextAction = options.nextAction;
    this.mutations = cloneCreationMutationEvidence(mutations);
  }
}

export function asCreationMutationFailure(
  error: unknown,
  journal: CreationMutationJournal,
  options: CreationMutationFailureOptions,
): CreationMutationFailure {
  if (error instanceof CreationMutationFailure) {
    const combined = new CreationMutationJournal(journal.attemptId);
    combined.record(journal.snapshot());
    combined.record(error.mutations);
    return new CreationMutationFailure(
      {
        code: error.code,
        summary: error.message,
        nextAction: error.nextAction,
        retryable: error.retryable,
      },
      combined.snapshot(),
      error,
    );
  }
  return new CreationMutationFailure(options, journal.snapshot(), error);
}

export function creationLocalMutationCount(evidence: CreationMutationEvidence): number {
  return (
    evidence.registryRows +
    evidence.topologyBindings +
    evidence.localDatabases +
    evidence.filesystemWrites +
    evidence.destinationPolicyRecords +
    evidence.failureLogRecords +
    evidence.checkpointCommits
  );
}

export function creationCheckpointPathDigest(evidence: CreationMutationEvidence): string {
  return createHash("sha256").update(JSON.stringify(evidence.checkpointRepositories)).digest("hex");
}

export function cloneCreationMutationEvidence(
  evidence: CreationMutationEvidence,
): CreationMutationEvidence {
  return {
    registryRows: nonnegativeInteger(evidence.registryRows, "registryRows"),
    topologyBindings: nonnegativeInteger(evidence.topologyBindings, "topologyBindings"),
    localDatabases: nonnegativeInteger(evidence.localDatabases, "localDatabases"),
    filesystemWrites: nonnegativeInteger(evidence.filesystemWrites, "filesystemWrites"),
    destinationPolicyRecords: nonnegativeInteger(
      evidence.destinationPolicyRecords,
      "destinationPolicyRecords",
    ),
    failureLogRecords: nonnegativeInteger(evidence.failureLogRecords, "failureLogRecords"),
    checkpointCommits: nonnegativeInteger(evidence.checkpointCommits, "checkpointCommits"),
    checkpointRepositories: evidence.checkpointRepositories.map((repository) => ({
      repositoryRoot: repository.repositoryRoot,
      paths: [...new Set(repository.paths)].sort(),
      ...(repository.commitSha === undefined ? {} : { commitSha: repository.commitSha }),
      ...(repository.beforeCommitSha === undefined
        ? {}
        : { beforeCommitSha: repository.beforeCommitSha }),
      ...(repository.clean === undefined ? {} : { clean: repository.clean }),
    })),
    checkpointPaths: [
      ...new Set(evidence.checkpointPaths.filter((path) => path.length > 0)),
    ].sort(),
  };
}
