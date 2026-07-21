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
import type { Client } from "@libsql/client";
import {
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";

import { destinationPolicyKey } from "../registry/destination-policy.js";
import { listFederationStates } from "../registry/federation-state.js";
import {
  openRegistryReadOnly,
  resolveVaultSnapshotReadOnly,
  type ResolveVaultSnapshotResult,
  type VaultSnapshot,
} from "../registry/read-only-client.js";
import { gitUrlToCoordinate } from "../registry/vault-addressing.js";
import {
  openReceiptAttempt,
  reopenReceiptAttempt,
  type OpenReceiptAttemptResult,
} from "../op/receipt-attempt.js";
import { observeActiveActor } from "../op/active-actor-observation.js";
import { openOpLogReadOnly } from "../op/operation-log.js";
import {
  findPendingReceiptAttemptForOperation,
  queryReceiptAttempts,
} from "../op/receipt-repository.js";
import { parseReceiptV1ForEmission, type ReceiptV1 } from "../op/receipt-v1.js";
import {
  runGitLocalMutation,
  runGitReadOnly,
  runGitReadOnlyRaw,
  type GitRunResult,
} from "../util/git-run.js";
import type { PermissionObservation } from "../util/permission-observation.js";
import { newUuidv7Bytes, uuid7BytesToDashedString } from "../util/uuid7.js";
import { observePublicationPermission } from "./federation/publication-permission.js";
import {
  observeLocalPodGitState,
  type LocalPodGitStateObservation,
} from "./federation/pod-git-state.js";
import {
  observePodRemoteState,
  type PodRemoteStateObservation,
} from "./federation/pod-remote-state.js";
import {
  getPublicationAttemptLockPath,
  readObservedDestinationPolicyWinnersReadOnly,
} from "./federation/destination-policy-ledger.js";
import { withDestinationPolicyLock } from "./federation/destination-policy-lock.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const UUIDV7 = /^[a-f0-9]{8}-?[a-f0-9]{4}-?7[a-f0-9]{3}-?[89ab][a-f0-9]{3}-?[a-f0-9]{12}$/u;
const MAX_DECLARED_MACHINES = 128;
const MAX_MACHINE_ID_LENGTH = 128;
const MAX_MACHINE_RECEIPT_COUNT = 1_000_000;
const MAX_MACHINE_RECEIPT_FILE_BYTES = 64 * 1024;
const MAX_MACHINE_RECEIPT_AGE_MS = 5 * 60_000;
export const EDITOR_LOCALIZATION_PLAN_MAX_BYTES = 1024 * 1024;
const MAX_RECEIPT_PLAN_PATH_LENGTH = 384;
const MAX_EDITOR_PATHS = 10_000;
const MAX_EDITOR_PATH_BYTES = 4_096;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_GITIGNORE_BYTES = 1024 * 1024;
const MAX_EDITOR_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EDITOR_TREE_BYTES = 64 * 1024 * 1024;
const MAX_EDITOR_DIRECTORIES = 10_000;
const MAX_EDITOR_DEPTH = 64;
const GIT_TIMEOUT_MS = 30_000;
const IGNORE_PROBE = ".obsidian/__lyt_localization_probe__";
const IGNORE_SUFFIX = Buffer.from("/.obsidian/\n/.obsidian/**\n", "utf8");

export const EDITOR_LOCALIZATION_MACHINE_EVIDENCE_LABEL = "handler_declared_roster" as const;

export type EditorLocalizationMachineReceiptV1 =
  | Readonly<{
      machine_id: string;
      disposition: "observed";
      digest: string;
      count: number;
      observed_at: string;
    }>
  | Readonly<{
      machine_id: string;
      disposition: "absent";
      absence_receipt_digest: string;
      observed_at: string;
    }>;

export interface EditorLocalizationMachineStateV1 {
  readonly machine_id: string;
  readonly state: "observed" | "absent" | "unavailable";
  readonly digest: string | null;
  readonly count: number;
}

export type EditorLocalizationEligibilityReason =
  | "target-unresolved"
  | "target-not-active"
  | "target-shared"
  | "target-subscribed"
  | "target-orphan"
  | "legacy-authority-ambiguous"
  | "origin-mismatch"
  | "workspace-dirty"
  | "workspace-staged"
  | "operation-in-progress"
  | "graph-ahead"
  | "graph-behind"
  | "graph-diverged"
  | "graph-detached"
  | "authority-unknown"
  | "remote-unavailable"
  | "reparse-point"
  | "observation-incomplete"
  | "machine-receipt-unavailable";

export type EditorLocalizationEligibility =
  | Readonly<{ disposition: "eligible"; reason: null }>
  | Readonly<{ disposition: "handler-approval-required"; reason: null }>
  | Readonly<{ disposition: "apply-unavailable"; reason: "machine-receipt-unavailable" }>
  | Readonly<{ disposition: "refused"; reason: EditorLocalizationEligibilityReason }>;

export interface EditorLocalizationMachineEvidenceV1 {
  readonly label: typeof EDITOR_LOCALIZATION_MACHINE_EVIDENCE_LABEL;
  readonly declared_count: number;
  readonly receipt_count: number;
  readonly machines: readonly EditorLocalizationMachineStateV1[];
  readonly digest: string;
}

export interface EditorLocalizationBeforeV1 {
  readonly gitignore_present: boolean;
  readonly gitignore_size: number;
  readonly gitignore_digest: string;
  readonly tracked_editor_path_count: number;
  readonly tracked_editor_pathset_digest: string;
  readonly editor_tree_file_count: number;
  readonly editor_tree_size: number;
  readonly editor_tree_digest: string;
}

export interface EditorLocalizationPlanV1 {
  readonly schema: "lyt.editor-localization-plan";
  readonly version: 1;
  readonly operation: "editor-localization-apply";
  readonly target: Readonly<{
    vault_id: string;
    canonical_name: string;
    path: string;
    status: VaultSnapshot["status"];
    source: VaultSnapshot["source"];
    home_mesh_id: string | null;
    destination_kind: VaultSnapshot["destination"]["kind"];
    destination_source: VaultSnapshot["destination"]["source"];
    destination_target: string | null;
    destination_target_kind: VaultSnapshot["destination"]["targetKind"];
    destination_repository: string | null;
    git_url: string | null;
  }>;
  readonly git: Readonly<{
    branch_ref: string | null;
    head_sha: string | null;
    upstream_ref: string | null;
    graph: LocalPodGitStateObservation["graph"];
    remote: PodRemoteStateObservation["remote"] | null;
    remote_graph: PodRemoteStateObservation["graph"] | null;
  }>;
  readonly authority: Readonly<{
    kind: "verified-push" | "local-no-origin" | "unknown";
    repository: string | null;
    policy_epoch: number | null;
  }>;
  readonly machine_evidence: EditorLocalizationMachineEvidenceV1;
  readonly before: EditorLocalizationBeforeV1;
  readonly eligibility: EditorLocalizationEligibility;
  readonly plan_digest: string;
}

export interface PrepareEditorLocalizationArgs {
  readonly target: string;
  readonly declared_machines: readonly string[];
  readonly machine_receipts: readonly EditorLocalizationMachineReceiptV1[];
  readonly registry_path?: string;
  readonly plan_path?: string;
}

export type PrepareEditorLocalizationResult =
  | Readonly<{ kind: "prepared"; plan: EditorLocalizationPlanV1; receipt: ReceiptV1 }>
  | Readonly<{
      kind: "refused";
      reason:
        | EditorLocalizationEligibilityReason
        | "plan-output-unavailable"
        | "receipt-store-unavailable";
      receipt?: ReceiptV1;
    }>;

export type InspectEditorLocalizationResult =
  | Readonly<{ kind: "prepared"; plan: EditorLocalizationPlanV1 }>
  | Readonly<{
      kind: "refused";
      reason: EditorLocalizationEligibilityReason;
    }>;

export interface ObserveEditorLocalizationMachineReceiptArgs {
  readonly target: string;
  readonly machine_id: string;
  readonly registry_path?: string;
}

export type ObserveEditorLocalizationMachineReceiptResult =
  | Readonly<{ kind: "observed"; receipt: EditorLocalizationMachineReceiptV1 }>
  | Readonly<{
      kind: "refused";
      reason: "target-unresolved" | "reparse-point" | "observation-incomplete";
    }>;

export interface ApplyEditorLocalizationArgs {
  readonly plan: unknown;
  readonly plan_digest: string;
  readonly declared_machines: readonly string[];
  readonly machine_receipts: readonly EditorLocalizationMachineReceiptV1[];
  readonly handler_approval?: Readonly<{ approved: true; plan_digest: string }>;
  readonly registry_path?: string;
}

/** Parse one Handler-declared machine receipt; extra keys and loose values are refused. */
export function parseEditorLocalizationMachineReceiptV1(
  value: unknown,
): EditorLocalizationMachineReceiptV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("machine receipt must be a plain object");
  }
  const candidate = value as Record<string, unknown>;
  enumValue(candidate.disposition, ["observed", "absent"], "machine_receipt.disposition");
  if (candidate.disposition === "observed") {
    objectExact(
      value,
      ["machine_id", "disposition", "digest", "count", "observed_at"],
      "machine receipt",
    );
    machineId(candidate.machine_id, "machine_receipt.machine_id");
    digest(candidate.digest, "machine_receipt.digest");
    count(candidate.count, MAX_MACHINE_RECEIPT_COUNT, "machine_receipt.count");
    timestamp(candidate.observed_at, "machine_receipt.observed_at");
  } else {
    objectExact(
      value,
      ["machine_id", "disposition", "absence_receipt_digest", "observed_at"],
      "machine receipt",
    );
    machineId(candidate.machine_id, "machine_receipt.machine_id");
    digest(candidate.absence_receipt_digest, "machine_receipt.absence_receipt_digest");
    timestamp(candidate.observed_at, "machine_receipt.observed_at");
  }
  return deepFreeze(value as EditorLocalizationMachineReceiptV1);
}

/** Read strict receipt files for one explicit Handler-declared roster. */
export function readEditorLocalizationMachineEvidenceFilesV1(
  declaredMachines: readonly string[],
  requestedPaths: readonly string[],
): Pick<PrepareEditorLocalizationArgs, "declared_machines" | "machine_receipts"> {
  const declared = parseDeclaredMachines(declaredMachines);
  if (requestedPaths.length > declared.length) throw new Error("too many machine receipts");
  const declaredSet = new Set(declared);
  const seenPaths = new Set<string>();
  const seenMachines = new Set<string>();
  const receipts: EditorLocalizationMachineReceiptV1[] = [];
  for (const requestedPath of requestedPaths) {
    const target = resolve(requestedPath);
    if (seenPaths.has(target)) throw new Error("duplicate machine receipt path");
    seenPaths.add(target);
    assertSafeReadFilePath(target);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_MACHINE_RECEIPT_FILE_BYTES) {
      throw new Error("invalid machine receipt file");
    }
    const receipt = parseEditorLocalizationMachineReceiptV1(
      JSON.parse(readFileSync(target, "utf8")),
    );
    if (!declaredSet.has(receipt.machine_id) || seenMachines.has(receipt.machine_id)) {
      throw new Error("machine receipt does not match the declared roster");
    }
    seenMachines.add(receipt.machine_id);
    receipts.push(receipt);
  }
  receipts.sort((left, right) => compareMachineIds(left.machine_id, right.machine_id));
  return deepFreeze({ declared_machines: declared, machine_receipts: receipts });
}

interface EditorLocalizationMachineReceiptObservationDependencies {
  resolveTarget(
    target: string,
    registryPath: string | undefined,
  ): Promise<ResolveVaultSnapshotResult>;
  now(): Date;
}

const productionMachineReceiptObservationDependencies: EditorLocalizationMachineReceiptObservationDependencies =
  {
    resolveTarget: (target, registryPath) =>
      resolveVaultSnapshotReadOnly(
        target,
        registryPath === undefined ? undefined : { path: registryPath },
      ),
    now: () => new Date(),
  };

/** Observe one local vault's editor tree without Git, network, discovery, or mutation. */
export async function observeEditorLocalizationMachineReceiptV1(
  args: ObserveEditorLocalizationMachineReceiptArgs,
): Promise<ObserveEditorLocalizationMachineReceiptResult> {
  return observeEditorLocalizationMachineReceiptV1WithDependencies(
    args,
    productionMachineReceiptObservationDependencies,
  );
}

/** @internal Pure/dependency seam for the scoped doctor receipt emission mode. */
export async function observeEditorLocalizationMachineReceiptV1WithDependencies(
  args: ObserveEditorLocalizationMachineReceiptArgs,
  dependencies: EditorLocalizationMachineReceiptObservationDependencies,
): Promise<ObserveEditorLocalizationMachineReceiptResult> {
  try {
    machineId(args.machine_id, "machine receipt machine_id");
    const target = await dependencies.resolveTarget(args.target, args.registry_path);
    if (target.kind !== "resolved") return { kind: "refused", reason: "target-unresolved" };
    assertNoReparsePoints(target.vault.path);
    const editorRoot = join(resolve(target.vault.path), ".obsidian");
    const tree = digestEditorTree(target.vault.path);
    const observedAt = dependencies.now().toISOString();
    const receipt: EditorLocalizationMachineReceiptV1 = existsSync(editorRoot)
      ? {
          machine_id: args.machine_id,
          disposition: "observed",
          digest: tree.digest,
          count: tree.count,
          observed_at: observedAt,
        }
      : {
          machine_id: args.machine_id,
          disposition: "absent",
          absence_receipt_digest: tree.digest,
          observed_at: observedAt,
        };
    return { kind: "observed", receipt: parseEditorLocalizationMachineReceiptV1(receipt) };
  } catch (error) {
    return {
      kind: "refused",
      reason: error instanceof ReparsePointError ? "reparse-point" : "observation-incomplete",
    };
  }
}

/** Write one immutable, bounded plan artifact without following path reparses. */
export function writeEditorLocalizationPlanFileV1(
  requestedPath: string,
  plan: EditorLocalizationPlanV1,
): string {
  const target = boundedPlanPath(requestedPath);
  assertSafePlanFilePath(target, false);
  if (existsSync(target)) throw new Error("plan output already exists");
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  if (bytes.length > EDITOR_LOCALIZATION_PLAN_MAX_BYTES) {
    throw new Error("plan output exceeds bound");
  }
  const tmp = join(dirname(target), `.${parsePath(target).base}.${process.pid}.${Date.now()}.tmp`);
  assertSafePlanFilePath(tmp, false);
  try {
    writeFileSync(tmp, bytes, { flag: "wx" });
    renameSync(tmp, target);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  return target;
}

/** Read and validate one immutable, bounded plan artifact without following path reparses. */
export function readEditorLocalizationPlanFileV1(requestedPath: string): EditorLocalizationPlanV1 {
  const target = boundedPlanPath(requestedPath);
  assertSafePlanFilePath(target, true);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > EDITOR_LOCALIZATION_PLAN_MAX_BYTES) {
    throw new Error("invalid plan file");
  }
  return parseEditorLocalizationPlanV1(JSON.parse(readFileSync(target, "utf8")));
}

/** @internal */
export interface EditorLocalizationGitRunner {
  read(
    args: readonly string[],
    options: { cwd: string; stdin?: Uint8Array },
  ): Promise<GitRunResult>;
  readRaw(args: readonly string[], options: { cwd: string }): Promise<GitRunResult>;
  mutate(
    args: readonly string[],
    options: { cwd: string; stdin?: Uint8Array },
  ): Promise<GitRunResult>;
}

/** @internal */
export interface EditorLocalizationObservedContext {
  target: ResolveVaultSnapshotResult;
  local: LocalPodGitStateObservation | null;
  remote: PodRemoteStateObservation | null;
  permission: PermissionObservation | null;
  policyEpoch: number | null;
}

/** @internal */
export interface EditorLocalizationDependencies {
  observe(
    target: string,
    registryPath: string | undefined,
    attemptId: string,
  ): Promise<EditorLocalizationObservedContext>;
  git: EditorLocalizationGitRunner;
  open(receipt: ReceiptV1): Promise<OpenReceiptAttemptResult>;
  reopen(receipt: ReceiptV1): Promise<OpenReceiptAttemptResult>;
  prepareProof(planDigest: string, vaultId: string): Promise<boolean>;
  completedApply(operationId: string): Promise<boolean>;
  findPending(
    operationId: string,
  ): Promise<Readonly<{ attemptId: string; startedAt: string }> | null>;
  newAttemptId(): string;
  now(): Date;
  withLock<T>(path: string, action: () => Promise<T>): Promise<T>;
}

/** Parse the complete runtime contract; extra keys and loose/coerced values are refused. */
export function parseEditorLocalizationPlanV1(value: unknown): EditorLocalizationPlanV1 {
  objectExact(
    value,
    [
      "schema",
      "version",
      "operation",
      "target",
      "git",
      "authority",
      "machine_evidence",
      "before",
      "eligibility",
      "plan_digest",
    ],
    "plan",
  );
  const plan = value as Record<string, unknown>;
  literal(plan.schema, "lyt.editor-localization-plan", "plan.schema");
  literal(plan.version, 1, "plan.version");
  literal(plan.operation, "editor-localization-apply", "plan.operation");
  parseTarget(plan.target);
  parseGit(plan.git);
  parseAuthority(plan.authority);
  parseMachineEvidence(plan.machine_evidence);
  parseBefore(plan.before);
  parseEligibility(plan.eligibility);
  digest(plan.plan_digest, "plan.plan_digest");
  const parsed = deepFreeze(value as unknown as EditorLocalizationPlanV1);
  if (digestPlan(parsed) !== parsed.plan_digest)
    throw new Error("plan.plan_digest does not seal the exact plan");
  return parsed;
}

export async function prepareEditorLocalizationPlanV1(
  args: PrepareEditorLocalizationArgs,
): Promise<PrepareEditorLocalizationResult> {
  return prepareEditorLocalizationPlanV1WithDependencies(args, productionDependencies);
}

/** Read-only diagnostic: observes and seals eligibility without writing a Receipt or target state. */
export async function inspectEditorLocalizationV1(
  args: PrepareEditorLocalizationArgs,
): Promise<InspectEditorLocalizationResult> {
  return inspectEditorLocalizationV1WithDependencies(args, productionDependencies);
}

/** @internal Test seam; intentionally omitted from the package barrel. */
export async function prepareEditorLocalizationPlanV1WithDependencies(
  args: PrepareEditorLocalizationArgs,
  dependencies: EditorLocalizationDependencies,
): Promise<PrepareEditorLocalizationResult> {
  const inspected = await inspectEditorLocalizationV1WithDependencies(args, dependencies);
  if (inspected.kind !== "prepared") return inspected;
  const plan = inspected.plan;
  let planPath: string | undefined;
  try {
    planPath = args.plan_path === undefined ? undefined : boundedPlanPath(args.plan_path);
  } catch {
    return { kind: "refused", reason: "plan-output-unavailable" };
  }
  const invocationAttemptId = dependencies.newAttemptId();
  try {
    return await dependencies.withLock(localizationLockPath(plan.target.vault_id), async () => {
      const operationId = uuidFromDigest(`prepare:${plan.plan_digest}`);
      let pendingAttempt: Readonly<{ attemptId: string; startedAt: string }> | null;
      try {
        await dependencies.prepareProof(plan.plan_digest, plan.target.vault_id);
        pendingAttempt = await dependencies.findPending(operationId);
      } catch {
        return { kind: "refused" as const, reason: "receipt-store-unavailable" as const };
      }
      const attemptId = pendingAttempt?.attemptId ?? invocationAttemptId;
      let proof: ReceiptV1;
      let opened: OpenReceiptAttemptResult;
      try {
        proof = prepareProofReceipt(plan, dependencies.now(), attemptId, planPath);
        opened =
          pendingAttempt === null
            ? await dependencies.open(proof)
            : await dependencies.reopen(proof);
      } catch {
        return { kind: "refused" as const, reason: "receipt-store-unavailable" as const };
      }
      if (opened.kind !== "ready")
        return { kind: "refused" as const, reason: "receipt-store-unavailable" as const };
      let terminal = proof;
      if (planPath !== undefined) {
        try {
          writeEditorLocalizationPlanFileV1(planPath, plan);
        } catch {
          terminal = prepareProofReceipt(
            plan,
            dependencies.now(),
            attemptId,
            planPath,
            "plan-output-unavailable",
          );
        }
      }
      const warnings = await opened.session.finalize(terminal);
      if (warnings.length > 0)
        return { kind: "refused" as const, reason: "receipt-store-unavailable" as const };
      if (terminal.status === "refused") {
        return {
          kind: "refused" as const,
          reason: (terminal.error?.code ?? "receipt-store-unavailable") as
            EditorLocalizationEligibilityReason | "plan-output-unavailable",
          receipt: terminal,
        };
      }
      return { kind: "prepared" as const, plan, receipt: terminal };
    });
  } catch {
    return { kind: "refused", reason: "receipt-store-unavailable" };
  }
}

/** @internal Read-only diagnostic seam; intentionally omitted from the package barrel. */
export async function inspectEditorLocalizationV1WithDependencies(
  args: PrepareEditorLocalizationArgs,
  dependencies: EditorLocalizationDependencies,
): Promise<InspectEditorLocalizationResult> {
  const invocationAttemptId = dependencies.newAttemptId();
  let context: EditorLocalizationObservedContext;
  let paths: readonly Buffer[];
  let before: EditorLocalizationBeforeV1;
  try {
    context = await dependencies.observe(args.target, args.registry_path, invocationAttemptId);
    if (context.target.kind !== "resolved") return { kind: "refused", reason: "target-unresolved" };
    assertNoReparsePoints(context.target.vault.path);
    paths = await trackedEditorPaths(context.target.vault.path, dependencies.git);
    before = captureBefore(context.target.vault.path, paths);
  } catch (error) {
    return {
      kind: "refused",
      reason: error instanceof ReparsePointError ? "reparse-point" : "observation-incomplete",
    };
  }
  const machineEvidence = machineEvidenceSummary(
    args.declared_machines,
    args.machine_receipts,
    dependencies.now(),
  );
  const eligibility = deriveEligibility(context, machineEvidence);
  const vault = context.target.vault;
  const body = {
    schema: "lyt.editor-localization-plan" as const,
    version: 1 as const,
    operation: "editor-localization-apply" as const,
    target: {
      vault_id: dashedUuid(vault.rid),
      canonical_name: vault.canonicalName,
      path: resolve(vault.path),
      status: vault.status,
      source: vault.source,
      home_mesh_id: vault.homeMesh === null ? null : dashedUuid(vault.homeMesh.rid),
      destination_kind: vault.destination.kind,
      destination_source: vault.destination.source,
      destination_target: vault.destination.target,
      destination_target_kind: vault.destination.targetKind,
      destination_repository: vault.destination.repositoryName,
      git_url: vault.gitUrl,
    },
    git: {
      branch_ref: context.local?.evidence.branch_ref ?? null,
      head_sha: context.local?.evidence.head_sha ?? null,
      upstream_ref: context.local?.evidence.upstream_ref ?? null,
      graph: context.local?.graph ?? null,
      remote: context.remote?.remote ?? null,
      remote_graph: context.remote?.graph ?? null,
    },
    authority: authoritySnapshot(vault, context.permission, context.policyEpoch),
    machine_evidence: machineEvidence,
    before,
    eligibility,
  };
  const plan = parseEditorLocalizationPlanV1({ ...body, plan_digest: digestStable(body) });
  return { kind: "prepared", plan };
}

export async function applyEditorLocalizationPlanV1(
  args: ApplyEditorLocalizationArgs,
): Promise<ReceiptV1> {
  return applyEditorLocalizationPlanV1WithDependencies(args, productionDependencies);
}

/** @internal Test seam; intentionally omitted from the package barrel. */
export async function applyEditorLocalizationPlanV1WithDependencies(
  args: ApplyEditorLocalizationArgs,
  dependencies: EditorLocalizationDependencies,
): Promise<ReceiptV1> {
  let plan: EditorLocalizationPlanV1;
  try {
    plan = parseEditorLocalizationPlanV1(args.plan);
  } catch {
    return unsealedRefusal(args.plan_digest, dependencies.now());
  }
  if (args.plan_digest !== plan.plan_digest || !SHA256.test(args.plan_digest)) {
    return refusal(plan, "plan-seal-mismatch", dependencies.now());
  }
  const lockPath = localizationLockPath(plan.target.vault_id);
  try {
    assertNoReparsePoints(plan.target.path);
    return await dependencies.withLock(lockPath, () => applyUnderLock(args, plan, dependencies));
  } catch (error) {
    return refusal(
      plan,
      error instanceof ReparsePointError ? "reparse-point" : "localization-lock-unavailable",
      dependencies.now(),
    );
  }
}

async function applyUnderLock(
  args: ApplyEditorLocalizationArgs,
  plan: EditorLocalizationPlanV1,
  dependencies: EditorLocalizationDependencies,
): Promise<ReceiptV1> {
  const operationId = uuidFromDigest(`operation:${plan.plan_digest}`);
  let completed: boolean;
  let prior: Readonly<{ attemptId: string; startedAt: string }> | null;
  try {
    completed = await dependencies.completedApply(operationId);
    prior = await dependencies.findPending(operationId);
  } catch {
    return refusal(plan, "receipt-store-unavailable", dependencies.now());
  }
  const attemptId = prior?.attemptId ?? dependencies.newAttemptId();
  let pending: ReceiptV1;
  let opened: OpenReceiptAttemptResult;
  try {
    pending = makeReceipt(plan, operationId, attemptId, dependencies.now(), "no-op", 0, undefined);
    opened = prior === null ? await dependencies.open(pending) : await dependencies.reopen(pending);
  } catch {
    return refusal(plan, "receipt-store-unavailable", dependencies.now());
  }
  if (opened.kind !== "ready")
    return refusal(plan, "receipt-store-unavailable", dependencies.now());
  let prepareProofAvailable: boolean;
  try {
    prepareProofAvailable = await dependencies.prepareProof(plan.plan_digest, plan.target.vault_id);
  } catch {
    return finalizeFailClosed(
      opened,
      makeReceipt(
        plan,
        operationId,
        attemptId,
        dependencies.now(),
        "refused",
        0,
        "receipt-store-unavailable",
      ),
    );
  }
  if (!prepareProofAvailable) {
    return finalizeFailClosed(
      opened,
      makeReceipt(
        plan,
        operationId,
        attemptId,
        dependencies.now(),
        "refused",
        0,
        "prepare-proof-unavailable",
      ),
    );
  }
  if (plan.eligibility.disposition === "refused") {
    return finalizeFailClosed(
      opened,
      makeReceipt(
        plan,
        operationId,
        attemptId,
        dependencies.now(),
        "refused",
        0,
        plan.eligibility.reason,
      ),
    );
  }
  if (plan.eligibility.disposition === "apply-unavailable") {
    return finalizeFailClosed(
      opened,
      makeReceipt(
        plan,
        operationId,
        attemptId,
        dependencies.now(),
        "refused",
        0,
        "machine-receipt-unavailable",
      ),
    );
  }
  if (
    plan.eligibility.disposition === "handler-approval-required" &&
    (args.handler_approval?.approved !== true ||
      args.handler_approval.plan_digest !== plan.plan_digest)
  ) {
    return finalizeFailClosed(
      opened,
      makeReceipt(
        plan,
        operationId,
        attemptId,
        dependencies.now(),
        "refused",
        0,
        "handler-approval-required",
      ),
    );
  }

  let context: EditorLocalizationObservedContext;
  let paths: readonly Buffer[];
  let before: EditorLocalizationBeforeV1;
  try {
    context = await dependencies.observe(plan.target.canonical_name, args.registry_path, attemptId);
    if (context.target.kind !== "resolved") throw new Error("unresolved");
    assertNoReparsePoints(plan.target.path);
    paths = await trackedEditorPaths(plan.target.path, dependencies.git);
    before = captureBefore(plan.target.path, paths);
  } catch {
    return finalizeFailClosed(
      opened,
      makeReceipt(plan, operationId, attemptId, dependencies.now(), "refused", 0, "target-drift"),
    );
  }
  const machine = machineEvidenceSummary(
    args.declared_machines,
    args.machine_receipts,
    dependencies.now(),
  );
  if (completed) {
    if (stableJson(machine) !== stableJson(plan.machine_evidence)) {
      return finalizeFailClosed(
        opened,
        makeReceipt(
          plan,
          operationId,
          attemptId,
          dependencies.now(),
          "refused",
          0,
          "machine-receipt-drift",
        ),
      );
    }
    if (!sameCompletedState(plan, context, before, machine)) {
      return finalizeFailClosed(
        opened,
        makeReceipt(plan, operationId, attemptId, dependencies.now(), "refused", 0, "target-drift"),
      );
    }
    return finalizeFailClosed(
      opened,
      makeReceipt(plan, operationId, attemptId, dependencies.now(), "replayed", 0, undefined),
    );
  }
  const exactState = sameCriticalState(plan, context, before, machine);
  const resumableState = prior !== null && sameResumableState(plan, context, before, machine);
  if (!exactState && !resumableState) {
    return finalizeFailClosed(
      opened,
      makeReceipt(plan, operationId, attemptId, dependencies.now(), "refused", 0, "target-drift"),
    );
  }

  const root = plan.target.path;
  const gitignorePath = join(root, ".gitignore");
  let gitignoreMutations =
    resumableState && before.gitignore_digest !== plan.before.gitignore_digest ? 1 : 0;
  let indexMutations =
    resumableState && before.tracked_editor_path_count === 0
      ? plan.before.tracked_editor_path_count
      : 0;
  let gitignoreAfterDigest = before.gitignore_digest;
  try {
    assertSafeWritePath(root, gitignorePath);
    const ignoredBefore = await isObsidianIgnored(root, dependencies.git);
    if (!ignoredBefore) {
      const existing = existsSync(gitignorePath)
        ? readBoundedFile(gitignorePath, MAX_GITIGNORE_BYTES)
        : Buffer.alloc(0);
      const prefix =
        existing.length === 0 || existing.at(-1) === 0x0a
          ? existing
          : Buffer.concat([existing, Buffer.from("\n")]);
      writeFileSync(gitignorePath, Buffer.concat([prefix, IGNORE_SUFFIX]), {
        flag: existsSync(gitignorePath) ? "w" : "wx",
      });
      gitignoreMutations = Math.max(gitignoreMutations, 1);
    }
    gitignoreAfterDigest = sha256(readBoundedFile(gitignorePath, MAX_GITIGNORE_BYTES));
    if (!(await isObsidianIgnored(root, dependencies.git))) throw new Error("ignore-not-effective");
    if (paths.length > 0) {
      const stdin = Buffer.concat(paths.flatMap((path) => [path, Buffer.from([0])]));
      const result = await dependencies.git.mutate(
        [
          "--literal-pathspecs",
          "rm",
          "--cached",
          "-r",
          "--ignore-unmatch",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { cwd: root, stdin },
      );
      if (result.code !== 0) throw new Error("index-mutation-failed");
      indexMutations += paths.length;
      if (result.stderrTruncated === true) throw new Error("index-mutation-failed");
    }
    const remaining = await trackedEditorPaths(root, dependencies.git);
    const after = captureBefore(root, remaining);
    if (
      remaining.length !== 0 ||
      after.editor_tree_digest !== before.editor_tree_digest ||
      after.editor_tree_size !== before.editor_tree_size ||
      after.editor_tree_file_count !== before.editor_tree_file_count ||
      !(await isObsidianIgnored(root, dependencies.git))
    )
      throw new Error("verification-failed");
    const terminal = makeReceipt(
      plan,
      operationId,
      attemptId,
      dependencies.now(),
      gitignoreMutations + indexMutations > 0 ? "success" : "no-op",
      gitignoreMutations + indexMutations,
      undefined,
      before,
      after,
      gitignoreMutations,
      indexMutations,
    );
    return finalizeFailClosed(opened, terminal);
  } catch {
    const terminal = makeReceipt(
      plan,
      operationId,
      attemptId,
      dependencies.now(),
      gitignoreMutations + indexMutations > 0 ? "partial" : "failed",
      gitignoreMutations + indexMutations,
      "localization-apply-failed",
      before,
      undefined,
      gitignoreMutations,
      indexMutations,
      gitignoreAfterDigest,
    );
    return finalizeFailClosed(opened, terminal);
  }
}

async function finalizeFailClosed(
  opened: Extract<OpenReceiptAttemptResult, { kind: "ready" }>,
  receipt: ReceiptV1,
): Promise<ReceiptV1> {
  const warnings = await opened.session.finalize(receipt);
  if (warnings.length === 0) return receipt;
  return parseReceiptV1ForEmission({
    ...receipt,
    status: receipt.mutations.local > 0 ? "partial" : "failed",
    exit_code: 2,
    next_action: {
      code: "inspect-receipt-store",
      summary: "Receipt finalization failed; inspect the durable operation log before retrying.",
    },
    error: { code: "receipt-finalization-failed", summary: warnings.join(","), retryable: true },
  });
}

function deriveEligibility(
  context: EditorLocalizationObservedContext,
  machine: EditorLocalizationMachineEvidenceV1,
): EditorLocalizationEligibility {
  if (context.target.kind !== "resolved") return refused("target-unresolved");
  const vault = context.target.vault;
  if (vault.status !== "active") return refused("target-not-active");
  if (vault.source === "shared") return refused("target-shared");
  if (vault.source === "subscribed") return refused("target-subscribed");
  if (vault.homeMesh === null) return refused("target-orphan");
  if (vault.destination.source === "legacy-derived") return refused("legacy-authority-ambiguous");
  if (machine.declared_count === 0 || machine.receipt_count !== machine.declared_count)
    return { disposition: "apply-unavailable", reason: "machine-receipt-unavailable" };
  const local = context.local;
  if (
    local === null ||
    local.repository !== "present" ||
    local.refusal_reason !== null ||
    local.workspace === null ||
    local.operation === null ||
    local.graph === null
  )
    return refused("observation-incomplete");
  if (local.workspace === "staged" || local.evidence.staged_entries > 0)
    return refused("workspace-staged");
  if (local.workspace !== "clean") return refused("workspace-dirty");
  if (local.operation !== "normal") return refused("operation-in-progress");
  if (isExplicitLocalNoOrigin(vault))
    return local.graph === "no-upstream"
      ? { disposition: "handler-approval-required", reason: null }
      : refused(graphReason(local.graph));
  if (!originMatches(vault)) return refused("origin-mismatch");
  if (local.graph !== "equal") return refused(graphReason(local.graph));
  if (
    context.remote === null ||
    context.remote.check !== "complete" ||
    context.remote.remote !== "reachable"
  )
    return refused("remote-unavailable");
  if (context.remote.graph !== "equal")
    return refused(
      context.remote.graph === null ? "remote-unavailable" : graphReason(context.remote.graph),
    );
  if (!permissionMatches(vault, context.permission, context.policyEpoch))
    return refused("authority-unknown");
  return { disposition: "eligible", reason: null };
}

function sameCriticalState(
  plan: EditorLocalizationPlanV1,
  context: EditorLocalizationObservedContext,
  before: EditorLocalizationBeforeV1,
  machine: EditorLocalizationMachineEvidenceV1,
): boolean {
  return (
    sameSealedIdentity(plan, context, machine) &&
    stableJson(before) === stableJson(plan.before) &&
    deriveEligibility(context, machine).disposition === plan.eligibility.disposition
  );
}

function sameResumableState(
  plan: EditorLocalizationPlanV1,
  context: EditorLocalizationObservedContext,
  before: EditorLocalizationBeforeV1,
  machine: EditorLocalizationMachineEvidenceV1,
): boolean {
  const pathsetIsOriginal =
    before.tracked_editor_path_count === plan.before.tracked_editor_path_count &&
    before.tracked_editor_pathset_digest === plan.before.tracked_editor_pathset_digest;
  const pathsetIsLocalized = before.tracked_editor_path_count === 0;
  const gitignoreIsOriginal =
    before.gitignore_present === plan.before.gitignore_present &&
    before.gitignore_size === plan.before.gitignore_size &&
    before.gitignore_digest === plan.before.gitignore_digest;
  const gitignoreIsLocalized =
    before.gitignore_present &&
    readBoundedFile(join(plan.target.path, ".gitignore"), MAX_GITIGNORE_BYTES)
      .subarray(-IGNORE_SUFFIX.length)
      .equals(IGNORE_SUFFIX);
  const expectedStagedEntries = pathsetIsLocalized ? plan.before.tracked_editor_path_count : 0;
  const expectedNonStagedEntries = gitignoreIsOriginal ? 0 : gitignoreIsLocalized ? 1 : -1;
  const workspaceIsExactLocalizationState =
    context.local !== null &&
    expectedNonStagedEntries >= 0 &&
    context.local.evidence.staged_entries === expectedStagedEntries &&
    context.local.evidence.untracked_entries + context.local.evidence.unstaged_tracked_entries ===
      expectedNonStagedEntries &&
    context.local.evidence.status_entries === expectedStagedEntries + expectedNonStagedEntries;
  return (
    sameSealedIdentity(plan, context, machine) &&
    context.local !== null &&
    context.local.repository === "present" &&
    context.local.refusal_reason === null &&
    context.local.operation === "normal" &&
    before.editor_tree_file_count === plan.before.editor_tree_file_count &&
    before.editor_tree_size === plan.before.editor_tree_size &&
    before.editor_tree_digest === plan.before.editor_tree_digest &&
    (pathsetIsOriginal || pathsetIsLocalized) &&
    (gitignoreIsOriginal || gitignoreIsLocalized) &&
    workspaceIsExactLocalizationState
  );
}

function sameCompletedState(
  plan: EditorLocalizationPlanV1,
  context: EditorLocalizationObservedContext,
  before: EditorLocalizationBeforeV1,
  machine: EditorLocalizationMachineEvidenceV1,
): boolean {
  const gitignoreIsOriginal =
    before.gitignore_present === plan.before.gitignore_present &&
    before.gitignore_size === plan.before.gitignore_size &&
    before.gitignore_digest === plan.before.gitignore_digest;
  const gitignoreIsLocalized =
    before.gitignore_present &&
    readBoundedFile(join(plan.target.path, ".gitignore"), MAX_GITIGNORE_BYTES)
      .subarray(-IGNORE_SUFFIX.length)
      .equals(IGNORE_SUFFIX);
  const expectedStagedEntries = plan.before.tracked_editor_path_count;
  const expectedNonStagedEntries = gitignoreIsOriginal ? 0 : 1;
  return (
    sameSealedIdentity(plan, context, machine) &&
    context.local !== null &&
    context.local.repository === "present" &&
    context.local.refusal_reason === null &&
    context.local.operation === "normal" &&
    before.editor_tree_file_count === plan.before.editor_tree_file_count &&
    before.editor_tree_size === plan.before.editor_tree_size &&
    before.editor_tree_digest === plan.before.editor_tree_digest &&
    before.tracked_editor_path_count === 0 &&
    gitignoreIsLocalized &&
    context.local.evidence.staged_entries === expectedStagedEntries &&
    context.local.evidence.untracked_entries + context.local.evidence.unstaged_tracked_entries ===
      expectedNonStagedEntries &&
    context.local.evidence.status_entries === expectedStagedEntries + expectedNonStagedEntries
  );
}

function sameSealedIdentity(
  plan: EditorLocalizationPlanV1,
  context: EditorLocalizationObservedContext,
  machine: EditorLocalizationMachineEvidenceV1,
): boolean {
  if (context.target.kind !== "resolved") return false;
  const vault = context.target.vault;
  const currentAuthority = authoritySnapshot(vault, context.permission, context.policyEpoch);
  return (
    dashedUuid(vault.rid) === plan.target.vault_id &&
    resolve(vault.path) === plan.target.path &&
    vault.canonicalName === plan.target.canonical_name &&
    vault.status === plan.target.status &&
    vault.source === plan.target.source &&
    (vault.homeMesh === null ? null : dashedUuid(vault.homeMesh.rid)) ===
      plan.target.home_mesh_id &&
    stableJson(vault.destination) ===
      stableJson({
        kind: plan.target.destination_kind,
        source: plan.target.destination_source,
        target: plan.target.destination_target,
        targetKind: plan.target.destination_target_kind,
        repositoryName: plan.target.destination_repository,
      }) &&
    vault.gitUrl === plan.target.git_url &&
    context.local !== null &&
    context.local.evidence.branch_ref === plan.git.branch_ref &&
    context.local.evidence.head_sha === plan.git.head_sha &&
    context.local.evidence.upstream_ref === plan.git.upstream_ref &&
    context.local.graph === plan.git.graph &&
    (context.remote?.remote ?? null) === plan.git.remote &&
    (context.remote?.graph ?? null) === plan.git.remote_graph &&
    stableJson(currentAuthority) === stableJson(plan.authority) &&
    stableJson(machine) === stableJson(plan.machine_evidence)
  );
}

async function observeProductionContext(
  target: string,
  registryPath: string | undefined,
  attemptId: string,
): Promise<EditorLocalizationObservedContext> {
  const resolvedTarget = await resolveVaultSnapshotReadOnly(
    target,
    registryPath === undefined ? undefined : { path: registryPath },
  );
  if (resolvedTarget.kind !== "resolved")
    return {
      target: resolvedTarget,
      local: null,
      remote: null,
      permission: null,
      policyEpoch: null,
    };
  const vault = resolvedTarget.vault;
  const local = await observeLocalPodGitState(vault.path);
  const remote =
    local.repository === "present" && local.refusal_reason === null
      ? await observePodRemoteState({ repository_path: vault.path, local })
      : null;
  if (vault.destination.source === "legacy-derived")
    return { target: resolvedTarget, local, remote, permission: null, policyEpoch: null };
  if (isExplicitLocalNoOrigin(vault))
    return { target: resolvedTarget, local, remote, permission: null, policyEpoch: null };
  const opened = openRegistryReadOnly(
    registryPath === undefined ? undefined : { path: registryPath },
  );
  if (opened.kind === "missing")
    return { target: resolvedTarget, local, remote, permission: null, policyEpoch: null };
  try {
    const states = await listFederationStates(opened.client as unknown as Client);
    if (states.length !== 1)
      return { target: resolvedTarget, local, remote, permission: null, policyEpoch: null };
    const winner = readObservedDestinationPolicyWinnersReadOnly(states[0]!.fedRidHex).get(
      destinationPolicyKey("vault", vault.rid),
    );
    if (
      winner === undefined ||
      winner.state !== "active" ||
      winner.destinationKind !== "github" ||
      winner.targetOwner === null ||
      winner.targetKind === null ||
      winner.repositoryName === null
    ) {
      return { target: resolvedTarget, local, remote, permission: null, policyEpoch: null };
    }
    const repository = `${winner.targetOwner}/${winner.repositoryName}`;
    const actor = await observeActiveActor({ attemptId });
    const permission =
      actor.result === "verified"
        ? await observePublicationPermission({
            capability: "repository-push",
            target: `github:${winner.targetKind}/${winner.targetOwner.toLowerCase()}`,
            repository,
            actor: actor.actor,
            attemptId,
            policyEpoch: winner.policyEpoch ?? 0,
          })
        : null;
    return {
      target: resolvedTarget,
      local,
      remote,
      permission,
      policyEpoch: winner.policyEpoch ?? 0,
    };
  } finally {
    opened.close();
  }
}

function authoritySnapshot(
  vault: VaultSnapshot,
  permission: PermissionObservation | null,
  policyEpoch: number | null,
): EditorLocalizationPlanV1["authority"] {
  if (isExplicitLocalNoOrigin(vault))
    return { kind: "local-no-origin", repository: null, policy_epoch: null };
  return permissionMatches(vault, permission, policyEpoch)
    ? { kind: "verified-push", repository: permission!.repository, policy_epoch: policyEpoch }
    : { kind: "unknown", repository: permission?.repository ?? null, policy_epoch: policyEpoch };
}

function permissionMatches(
  vault: VaultSnapshot,
  permission: PermissionObservation | null,
  policyEpoch: number | null,
): boolean {
  if (
    permission === null ||
    policyEpoch === null ||
    permission.policy_epoch !== policyEpoch ||
    permission.capability !== "repository-push" ||
    permission.result !== "verified" ||
    permission.evidence_class !== "repository-push" ||
    permission.actor === null ||
    vault.destination.target === null ||
    vault.destination.targetKind === null ||
    vault.destination.repositoryName === null
  )
    return false;
  return (
    permission.target ===
      `github:${vault.destination.targetKind}/${vault.destination.target.toLowerCase()}` &&
    permission.repository.toLowerCase() ===
      `${vault.destination.target}/${vault.destination.repositoryName}`.toLowerCase()
  );
}

function isExplicitLocalNoOrigin(vault: VaultSnapshot): boolean {
  return (
    vault.destination.kind === "local" &&
    vault.destination.source !== null &&
    vault.destination.source !== "legacy-derived" &&
    vault.gitUrl === null
  );
}

function originMatches(vault: VaultSnapshot): boolean {
  if (
    vault.gitUrl === null ||
    vault.destination.target === null ||
    vault.destination.repositoryName === null
  )
    return false;
  return (
    gitUrlToCoordinate(vault.gitUrl) ===
    `github.com/${vault.destination.target.toLowerCase()}/${vault.destination.repositoryName.toLowerCase()}`
  );
}

function graphReason(
  graph: NonNullable<LocalPodGitStateObservation["graph"]>,
): EditorLocalizationEligibilityReason {
  return graph === "ahead"
    ? "graph-ahead"
    : graph === "behind"
      ? "graph-behind"
      : graph === "diverged"
        ? "graph-diverged"
        : graph === "detached-HEAD"
          ? "graph-detached"
          : "authority-unknown";
}

function refused(reason: EditorLocalizationEligibilityReason): EditorLocalizationEligibility {
  return { disposition: "refused", reason };
}

function machineEvidenceSummary(
  declared: readonly string[],
  receipts: readonly EditorLocalizationMachineReceiptV1[],
  now: Date,
): EditorLocalizationMachineEvidenceV1 {
  let canonicalDeclared: readonly string[];
  try {
    canonicalDeclared = parseDeclaredMachines(declared);
  } catch {
    canonicalDeclared = [];
  }
  let byMachine: ReadonlyMap<string, EditorLocalizationMachineReceiptV1> | null = null;
  try {
    const parsedReceipts = receipts.map(parseEditorLocalizationMachineReceiptV1);
    const candidate = new Map(
      parsedReceipts.map((receipt) => [receipt.machine_id, receipt] as const),
    );
    if (
      candidate.size !== parsedReceipts.length ||
      parsedReceipts.some((receipt) => !canonicalDeclared.includes(receipt.machine_id))
    ) {
      throw new Error("machine receipt does not match declared roster");
    }
    byMachine = candidate;
  } catch {
    byMachine = null;
  }
  const machines = canonicalDeclared.map((machineId): EditorLocalizationMachineStateV1 => {
    const receipt = byMachine?.get(machineId);
    if (receipt === undefined || !freshTimestamp(receipt.observed_at, now)) {
      return { machine_id: machineId, state: "unavailable", digest: null, count: 0 };
    }
    return receipt.disposition === "observed"
      ? {
          machine_id: machineId,
          state: "observed",
          digest: receipt.digest,
          count: receipt.count,
        }
      : {
          machine_id: machineId,
          state: "absent",
          digest: receipt.absence_receipt_digest,
          count: 0,
        };
  });
  return {
    label: EDITOR_LOCALIZATION_MACHINE_EVIDENCE_LABEL,
    declared_count: machines.length,
    receipt_count: machines.filter((machine) => machine.state !== "unavailable").length,
    machines,
    digest: digestStable(machines),
  };
}

function parseDeclaredMachines(declared: readonly string[]): readonly string[] {
  if (
    declared.length === 0 ||
    declared.length > MAX_DECLARED_MACHINES ||
    new Set(declared).size !== declared.length
  ) {
    throw new Error("declared machine roster invalid");
  }
  for (const machine of declared) {
    machineId(machine, "declared machine");
  }
  return Object.freeze([...declared].sort(compareMachineIds));
}

function compareMachineIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function freshTimestamp(value: string, now: Date): boolean {
  const then = Date.parse(value);
  return (
    Number.isFinite(then) &&
    then <= now.getTime() + 30_000 &&
    now.getTime() - then <= MAX_MACHINE_RECEIPT_AGE_MS
  );
}

async function trackedEditorPaths(
  root: string,
  git: EditorLocalizationGitRunner,
): Promise<readonly Buffer[]> {
  const result = await git.readRaw(["ls-files", "-z"], { cwd: root });
  if (
    result.code !== 0 ||
    result.stdoutTruncated === true ||
    result.stderrTruncated === true ||
    result.stdoutRaw === undefined
  )
    throw new Error("editor-path-observation-failed");
  const raw = Buffer.from(result.stdoutRaw);
  if (raw.length > MAX_GIT_OUTPUT_BYTES || (raw.length > 0 && raw.at(-1) !== 0))
    throw new Error("editor-path-observation-malformed");
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    const record = raw.subarray(start, index);
    start = index + 1;
    if (record.length === 0 || record.length > MAX_EDITOR_PATH_BYTES)
      throw new Error("editor-path-observation-invalid");
    if (
      record.equals(Buffer.from(".obsidian")) ||
      record.subarray(0, 10).equals(Buffer.from(".obsidian/"))
    )
      records.push(Buffer.from(record));
  }
  if (records.length > MAX_EDITOR_PATHS) throw new Error("editor-path-observation-invalid");
  records.sort(Buffer.compare);
  for (let index = 1; index < records.length; index += 1)
    if (records[index]!.equals(records[index - 1]!))
      throw new Error("editor-path-observation-invalid");
  return records;
}

function captureBefore(root: string, paths: readonly Buffer[]): EditorLocalizationBeforeV1 {
  const gitignore = join(root, ".gitignore");
  const bytes = existsSync(gitignore)
    ? readBoundedFile(gitignore, MAX_GITIGNORE_BYTES)
    : Buffer.alloc(0);
  const tree = digestEditorTree(root);
  return {
    gitignore_present: existsSync(gitignore),
    gitignore_size: bytes.length,
    gitignore_digest: sha256(bytes),
    tracked_editor_path_count: paths.length,
    tracked_editor_pathset_digest: digestByteRecords(paths),
    editor_tree_file_count: tree.count,
    editor_tree_size: tree.size,
    editor_tree_digest: tree.digest,
  };
}

function digestEditorTree(root: string): { count: number; size: number; digest: string } {
  const editorRoot = join(root, ".obsidian");
  const hash = createHash("sha256");
  let count = 0;
  let size = 0;
  let directories = 0;
  if (!existsSync(editorRoot)) return { count, size, digest: hash.digest("hex") };
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_EDITOR_DEPTH || ++directories > MAX_EDITOR_DIRECTORIES)
      throw new Error("editor-tree-bound-exceeded");
    const remainingEntryBudget = MAX_EDITOR_DIRECTORIES - directories + MAX_EDITOR_PATHS - count;
    for (const entry of readBoundedSortedEntries(directory, remainingEntryBudget)) {
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new ReparsePointError();
      const rel = relative(editorRoot, absolute).split(sep).join("/");
      hash.update(Buffer.from(rel));
      hash.update(Buffer.from([0]));
      if (stat.isDirectory()) {
        hash.update(Buffer.from("d\0"));
        walk(absolute, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_EDITOR_FILE_BYTES)
        throw new Error("editor-tree-bound-exceeded");
      count += 1;
      size += stat.size;
      if (count > MAX_EDITOR_PATHS || size > MAX_EDITOR_TREE_BYTES)
        throw new Error("editor-tree-bound-exceeded");
      hash.update(Buffer.from(`f\0${stat.size}\0`));
      hash.update(readFileSync(absolute));
      hash.update(Buffer.from([0]));
    }
  };
  walk(editorRoot, 0);
  return { count, size, digest: hash.digest("hex") };
}

function readBoundedSortedEntries(directory: string, remainingEntryBudget: number): Dirent[] {
  const entries: Dirent[] = [];
  const opened = opendirSync(directory);
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      if (entries.length >= remainingEntryBudget) throw new Error("editor-tree-bound-exceeded");
      entries.push(entry);
    }
  } finally {
    opened.closeSync();
  }
  return entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  );
}

function assertNoReparsePoints(root: string): void {
  const canonical = resolve(root);
  if (!isAbsolute(canonical)) throw new ReparsePointError();
  const parsed = parsePath(canonical);
  let current = parsed.root;
  for (const component of canonical.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new ReparsePointError();
  }
  const editor = join(canonical, ".obsidian");
  if (existsSync(editor)) {
    if (lstatSync(editor).isSymbolicLink()) throw new ReparsePointError();
    digestEditorTree(canonical);
  }
  const gitignore = join(canonical, ".gitignore");
  if (existsSync(gitignore) && lstatSync(gitignore).isSymbolicLink()) throw new ReparsePointError();
}

class ReparsePointError extends Error {}

function assertSafeReadFilePath(target: string): void {
  if (!isAbsolute(target)) throw new Error("machine receipt path must resolve absolutely");
  const parsed = parsePath(target);
  let current = parsed.root;
  for (const component of target.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
      throw new Error("machine receipt path is missing or contains a reparse point");
    }
  }
}

function boundedPlanPath(requestedPath: string): string {
  const target = resolve(requestedPath);
  if (
    target.length === 0 ||
    target.length > MAX_RECEIPT_PLAN_PATH_LENGTH ||
    Buffer.byteLength(target, "utf8") > MAX_RECEIPT_PLAN_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(target)
  ) {
    throw new Error("plan path exceeds the receipt-safe bound");
  }
  return target;
}

function assertSafePlanFilePath(target: string, requireLeaf: boolean): void {
  if (!isAbsolute(target)) throw new Error("plan path must resolve absolutely");
  const parsed = parsePath(target);
  let current = parsed.root;
  const parts = target.slice(parsed.root.length).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    const leaf = index === parts.length - 1;
    if (!existsSync(current)) {
      if (leaf && !requireLeaf) return;
      throw new Error("plan path parent is missing");
    }
    if (lstatSync(current).isSymbolicLink()) throw new Error("plan path contains a reparse point");
  }
}

function assertSafeWritePath(root: string, target: string): void {
  const canonicalRoot = resolve(root);
  const canonicalTarget = resolve(target);
  const rel = relative(canonicalRoot, canonicalTarget);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("editor-write-path-escapes-target");
  let current = canonicalRoot;
  for (const part of rel.split(sep)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ReparsePointError();
    current = join(current, part);
  }
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ReparsePointError();
}

async function isObsidianIgnored(root: string, git: EditorLocalizationGitRunner): Promise<boolean> {
  const gitignore = join(root, ".gitignore");
  if (
    !existsSync(gitignore) ||
    !readBoundedFile(gitignore, MAX_GITIGNORE_BYTES)
      .subarray(-IGNORE_SUFFIX.length)
      .equals(IGNORE_SUFFIX)
  )
    return false;
  const result = await git.read(["check-ignore", "--no-index", "-q", "--", IGNORE_PROBE], {
    cwd: root,
  });
  if (
    result.stdoutTruncated === true ||
    result.stderrTruncated === true ||
    ![0, 1].includes(result.code)
  )
    throw new Error("ignore-observation-failed");
  return result.code === 0;
}

function readBoundedFile(path: string, limit: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit) throw new Error("file-bound-exceeded");
  return readFileSync(path);
}

async function hasPrepareProof(planDigest: string, vaultId: string): Promise<boolean> {
  const opened = await openOpLogReadOnly();
  if (opened.kind === "missing") return false;
  try {
    const operationId = uuidFromDigest(`prepare:${planDigest}`);
    const found = await queryReceiptAttempts(opened.client, {
      operationId,
      operation: "editor-localization-prepare",
      status: "no-op",
      limit: 1,
    });
    const receipt = found.attempts[0];
    return (
      receipt !== undefined &&
      receipt.replay.key_digest === planDigest &&
      receipt.scope.kind === "vault" &&
      receipt.scope.vault_id === vaultId
    );
  } finally {
    opened.close();
  }
}

async function hasCompletedApply(operationId: string): Promise<boolean> {
  const opened = await openOpLogReadOnly();
  if (opened.kind === "missing") return false;
  try {
    for (const status of ["success", "no-op", "replayed"] as const) {
      const found = await queryReceiptAttempts(opened.client, {
        operationId,
        operation: "editor-localization-apply",
        status,
        limit: 1,
      });
      if (found.attempts.length === 1) return true;
    }
    return false;
  } finally {
    opened.close();
  }
}

async function findPendingAttempt(
  operationId: string,
): Promise<Readonly<{ attemptId: string; startedAt: string }> | null> {
  const opened = await openOpLogReadOnly();
  if (opened.kind === "missing") return null;
  try {
    return await findPendingReceiptAttemptForOperation(opened.client, operationId);
  } finally {
    opened.close();
  }
}

function prepareProofReceipt(
  plan: EditorLocalizationPlanV1,
  now: Date,
  attemptId: string,
  planPath?: string,
  forcedReason?: "plan-output-unavailable",
): ReceiptV1 {
  const operationId = uuidFromDigest(`prepare:${plan.plan_digest}`);
  const refusalReason =
    forcedReason ??
    (plan.eligibility.disposition === "refused" ||
    plan.eligibility.disposition === "apply-unavailable"
      ? plan.eligibility.reason
      : null);
  const refused = refusalReason !== null;
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: operationId,
    attempt_id: attemptId,
    operation: "editor-localization-prepare",
    scope: { kind: "vault", vault_id: plan.target.vault_id },
    timestamps: { started_at: now.toISOString(), finished_at: now.toISOString() },
    replay: {
      disposition: refused ? "rejected" : "new",
      key_digest: plan.plan_digest,
    },
    status: refused ? "refused" : "no-op",
    exit_code: refused ? 2 : 0,
    mutations: { local: 0, remote: 0 },
    evidence: {
      before: [
        {
          kind: "localization-plan",
          subject: planPath ?? "in-memory-plan",
          digest: plan.plan_digest,
        },
        {
          kind: "localization-eligibility",
          subject: plan.eligibility.disposition,
          count: plan.machine_evidence.receipt_count,
        },
        ...receiptMachineEvidence(plan.machine_evidence),
      ],
      after: [],
    },
    next_action: refused ? prepareCorrectiveNextAction(plan, refusalReason) : null,
    error: refused
      ? {
          code: refusalReason,
          summary:
            refusalReason === "machine-receipt-unavailable"
              ? "Declared machine evidence is unavailable."
              : refusalReason === "plan-output-unavailable"
                ? "The immutable plan artifact could not be written."
                : "Current target state is not eligible for editor localization.",
          retryable: true,
        }
      : null,
  });
}

function prepareCorrectiveNextAction(
  plan: EditorLocalizationPlanV1,
  reason: EditorLocalizationEligibilityReason | "plan-output-unavailable",
): NonNullable<ReceiptV1["next_action"]> {
  if (reason === "machine-receipt-unavailable") {
    const missingMachine = plan.machine_evidence.machines.find(
      (machine) => machine.state === "unavailable",
    )?.machine_id;
    return {
      code: missingMachine === undefined ? "declare-machine-roster" : "collect-machine-receipt",
      summary:
        missingMachine === undefined
          ? `lyt doctor --target 'editor-localization:${plan.target.canonical_name}' --declared-machine '<machine-id>' --json`
          : `lyt doctor --target 'editor-localization:${plan.target.canonical_name}' --emit-machine-receipt --declared-machine '${missingMachine.replaceAll("'", "''")}' --json --out '.\\editor-localization-machine-receipt.json'`,
    };
  }
  if (reason === "plan-output-unavailable") {
    return {
      code: "choose-new-plan-path",
      summary: `lyt repair --target editor-localization:${plan.target.canonical_name} --dry-run --plan-out <new-plan.json> --declared-machine <id> [--machine-receipt <file>] --json`,
    };
  }
  return {
    code: "correct-target-state",
    summary: `lyt doctor --target editor-localization:${plan.target.canonical_name} --declared-machine <id> [--machine-receipt <file>] --json`,
  };
}

function makeReceipt(
  plan: EditorLocalizationPlanV1,
  operationId: string,
  attemptId: string,
  now: Date,
  status: "success" | "no-op" | "replayed" | "refused" | "partial" | "failed",
  localMutations: number,
  code?: string,
  before?: EditorLocalizationBeforeV1,
  after?: EditorLocalizationBeforeV1,
  gitignoreMutations = 0,
  indexMutations = 0,
  gitignoreAfterDigest?: string,
): ReceiptV1 {
  const success = status === "success" || status === "no-op" || status === "replayed";
  const machineEvidence = receiptMachineEvidence(plan.machine_evidence);
  const mutationEvidence = [
    {
      kind: "gitignore-mutation",
      subject: "effective .obsidian ignore bytes",
      digest:
        gitignoreAfterDigest ??
        after?.gitignore_digest ??
        before?.gitignore_digest ??
        plan.before.gitignore_digest,
      count: gitignoreMutations,
    },
    {
      kind: "git-index-mutation",
      subject: "raw .obsidian path records removed from the index",
      digest: indexMutations > 0 ? plan.before.tracked_editor_pathset_digest : digestStable([]),
      count: indexMutations,
    },
    {
      kind: "localization-mutations",
      subject: `gitignore=${gitignoreMutations};index=${indexMutations}`,
      count: localMutations,
    },
  ];
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: operationId,
    attempt_id: attemptId,
    operation: "editor-localization-apply",
    scope: { kind: "vault", vault_id: plan.target.vault_id },
    timestamps: { started_at: now.toISOString(), finished_at: now.toISOString() },
    replay: {
      disposition: status === "replayed" ? "replayed" : status === "refused" ? "rejected" : "new",
      key_digest: digestStable({
        operation: "editor-localization-apply",
        plan_digest: plan.plan_digest,
      }),
    },
    status,
    exit_code: success ? 0 : 2,
    mutations: { local: localMutations, remote: 0 },
    evidence: {
      before:
        before === undefined
          ? machineEvidence
          : [
              {
                kind: "editor-tree",
                subject: "exact .obsidian working bytes",
                digest: before.editor_tree_digest,
                count: before.editor_tree_file_count,
              },
              {
                kind: "git-index",
                subject: "tracked .obsidian raw path records",
                digest: before.tracked_editor_pathset_digest,
                count: before.tracked_editor_path_count,
              },
              ...machineEvidence,
            ],
      after:
        after === undefined
          ? mutationEvidence
          : [
              {
                kind: "editor-tree",
                subject: "exact .obsidian working bytes",
                digest: after.editor_tree_digest,
                count: after.editor_tree_file_count,
              },
              {
                kind: "git-index",
                subject: "tracked .obsidian raw path records",
                digest: after.tracked_editor_pathset_digest,
                count: after.tracked_editor_path_count,
              },
              ...mutationEvidence,
            ],
    },
    next_action: success ? null : applyCorrectiveNextAction(plan, code),
    error: success
      ? null
      : {
          code: code ?? "editor-localization-failed",
          summary: "Editor-state localization did not complete.",
          retryable: true,
        },
  });
}

function applyCorrectiveNextAction(
  plan: EditorLocalizationPlanV1,
  code: string | undefined,
): NonNullable<ReceiptV1["next_action"]> {
  if (code === "machine-receipt-drift" || code === "target-drift") {
    return {
      code: "prepare-new-plan",
      summary: `lyt repair --target editor-localization:${plan.target.canonical_name} --dry-run --plan-out <new-plan.json> --declared-machine <id> [--machine-receipt <file>] --json`,
    };
  }
  return {
    code: "inspect-localization-state",
    summary: `lyt doctor --target editor-localization:${plan.target.canonical_name} --declared-machine <id> [--machine-receipt <file>] --json`,
  };
}

function receiptMachineEvidence(machine: EditorLocalizationMachineEvidenceV1): Array<{
  kind: string;
  subject: string;
  digest: string;
  count: number;
}> {
  return (["observed", "absent", "unavailable"] as const).flatMap((state) => {
    const summaries = machine.machines.filter((entry) => entry.state === state);
    return summaries.length === 0
      ? []
      : [
          {
            kind: `machine-${state}`,
            subject: `${EDITOR_LOCALIZATION_MACHINE_EVIDENCE_LABEL} ${state}`,
            digest: digestStable(summaries),
            count: summaries.length,
          },
        ];
  });
}

function refusal(plan: EditorLocalizationPlanV1, code: string, now: Date): ReceiptV1 {
  return makeReceipt(
    plan,
    uuidFromDigest(`operation:${plan.plan_digest}`),
    uuidFromDigest(`refusal:${plan.plan_digest}:${code}`),
    now,
    "refused",
    0,
    code,
  );
}

function unsealedRefusal(planDigest: string, now: Date): ReceiptV1 {
  const safeDigest = SHA256.test(planDigest) ? planDigest : sha256(Buffer.from(planDigest));
  const placeholder = {
    schema: "lyt.editor-localization-plan",
    version: 1,
    operation: "editor-localization-apply",
    target: {
      vault_id: "018f1d74-8c2a-7c3a-8d19-000000000001",
      canonical_name: "invalid",
      path: resolve("."),
      status: "active",
      source: "own",
      home_mesh_id: "018f1d74-8c2a-7c3a-8d19-000000000002",
      destination_kind: "local",
      destination_source: "vault-override",
      destination_target: null,
      destination_target_kind: null,
      destination_repository: null,
      git_url: null,
    },
    git: {
      branch_ref: null,
      head_sha: null,
      upstream_ref: null,
      graph: "no-upstream",
      remote: null,
      remote_graph: null,
    },
    authority: { kind: "local-no-origin", repository: null, policy_epoch: null },
    machine_evidence: {
      label: EDITOR_LOCALIZATION_MACHINE_EVIDENCE_LABEL,
      declared_count: 0,
      receipt_count: 0,
      machines: [],
      digest: digestStable([]),
    },
    before: {
      gitignore_present: false,
      gitignore_size: 0,
      gitignore_digest: sha256(Buffer.alloc(0)),
      tracked_editor_path_count: 0,
      tracked_editor_pathset_digest: digestStable([]),
      editor_tree_file_count: 0,
      editor_tree_size: 0,
      editor_tree_digest: sha256(Buffer.alloc(0)),
    },
    eligibility: { disposition: "refused", reason: "observation-incomplete" },
    plan_digest: safeDigest,
  } as EditorLocalizationPlanV1;
  return refusal(placeholder, "plan-schema-invalid", now);
}

function parseTarget(value: unknown): void {
  objectExact(
    value,
    [
      "vault_id",
      "canonical_name",
      "path",
      "status",
      "source",
      "home_mesh_id",
      "destination_kind",
      "destination_source",
      "destination_target",
      "destination_target_kind",
      "destination_repository",
      "git_url",
    ],
    "plan.target",
  );
  const v = value as Record<string, unknown>;
  uuid(v.vault_id, "target.vault_id");
  boundedString(v.canonical_name, 1, 512, "target.canonical_name");
  boundedString(v.path, 1, 4096, "target.path");
  enumValue(v.status, ["active", "frozen", "deleted"], "target.status");
  enumValue(v.source, ["own", "subscribed", "shared"], "target.source");
  if (v.home_mesh_id !== null) uuid(v.home_mesh_id, "target.home_mesh_id");
  enumValue(v.destination_kind, ["github", "local", "unconfigured"], "target.destination_kind");
  nullableEnum(
    v.destination_source,
    ["mesh-inherited", "vault-override", "local-explicit", "legacy-derived"],
    "target.destination_source",
  );
  nullableString(v.destination_target, 512, "target.destination_target");
  nullableEnum(v.destination_target_kind, ["user", "org"], "target.destination_target_kind");
  nullableString(v.destination_repository, 512, "target.destination_repository");
  nullableString(v.git_url, 2048, "target.git_url");
}
function parseGit(value: unknown): void {
  objectExact(
    value,
    ["branch_ref", "head_sha", "upstream_ref", "graph", "remote", "remote_graph"],
    "plan.git",
  );
  const v = value as Record<string, unknown>;
  nullableString(v.branch_ref, 1024, "git.branch_ref");
  nullableString(v.head_sha, 128, "git.head_sha");
  nullableString(v.upstream_ref, 1024, "git.upstream_ref");
  nullableEnum(
    v.graph,
    ["equal", "ahead", "behind", "diverged", "no-upstream", "detached-HEAD"],
    "git.graph",
  );
  nullableEnum(v.remote, ["reachable", "unreachable-or-unknown", "deleted"], "git.remote");
  nullableEnum(
    v.remote_graph,
    ["equal", "ahead", "behind", "diverged", "no-upstream", "detached-HEAD"],
    "git.remote_graph",
  );
}
function parseAuthority(value: unknown): void {
  objectExact(value, ["kind", "repository", "policy_epoch"], "plan.authority");
  const v = value as Record<string, unknown>;
  enumValue(v.kind, ["verified-push", "local-no-origin", "unknown"], "authority.kind");
  nullableString(v.repository, 1024, "authority.repository");
  if (
    v.policy_epoch !== null &&
    (!Number.isSafeInteger(v.policy_epoch) || (v.policy_epoch as number) < 0)
  )
    throw new Error("authority.policy_epoch invalid");
}
function parseMachineEvidence(value: unknown): void {
  objectExact(
    value,
    ["label", "declared_count", "receipt_count", "machines", "digest"],
    "plan.machine_evidence",
  );
  const v = value as Record<string, unknown>;
  literal(v.label, EDITOR_LOCALIZATION_MACHINE_EVIDENCE_LABEL, "machine_evidence.label");
  count(v.declared_count, MAX_DECLARED_MACHINES, "machine_evidence.declared_count");
  count(v.receipt_count, MAX_DECLARED_MACHINES, "machine_evidence.receipt_count");
  digest(v.digest, "machine_evidence.digest");
  if (!Array.isArray(v.machines) || v.machines.length > MAX_DECLARED_MACHINES) {
    throw new Error("machine_evidence.machines invalid");
  }
  let priorMachineId: string | null = null;
  let receiptCount = 0;
  for (const machine of v.machines) {
    objectExact(machine, ["machine_id", "state", "digest", "count"], "machine evidence state");
    const state = machine as Record<string, unknown>;
    machineId(state.machine_id, "machine_evidence.machine_id");
    enumValue(state.state, ["observed", "absent", "unavailable"], "machine_evidence.state");
    count(state.count, MAX_MACHINE_RECEIPT_COUNT, "machine_evidence.count");
    const machineIdValue = state.machine_id as string;
    if (priorMachineId !== null && compareMachineIds(priorMachineId, machineIdValue) >= 0) {
      throw new Error("machine_evidence.machines must be canonical and unique");
    }
    priorMachineId = machineIdValue;
    if (state.state === "observed") {
      digest(state.digest, "machine_evidence.digest");
      receiptCount += 1;
    } else if (state.state === "absent") {
      digest(state.digest, "machine_evidence.digest");
      literal(state.count, 0, "machine_evidence.count");
      receiptCount += 1;
    } else {
      literal(state.digest, null, "machine_evidence.digest");
      literal(state.count, 0, "machine_evidence.count");
    }
  }
  literal(v.declared_count, v.machines.length, "machine_evidence.declared_count");
  literal(v.receipt_count, receiptCount, "machine_evidence.receipt_count");
  literal(v.digest, digestStable(v.machines), "machine_evidence.digest");
}
function parseBefore(value: unknown): void {
  objectExact(
    value,
    [
      "gitignore_present",
      "gitignore_size",
      "gitignore_digest",
      "tracked_editor_path_count",
      "tracked_editor_pathset_digest",
      "editor_tree_file_count",
      "editor_tree_size",
      "editor_tree_digest",
    ],
    "plan.before",
  );
  const v = value as Record<string, unknown>;
  if (typeof v.gitignore_present !== "boolean") throw new Error("before.gitignore_present invalid");
  count(v.gitignore_size, MAX_GITIGNORE_BYTES, "before.gitignore_size");
  digest(v.gitignore_digest, "before.gitignore_digest");
  count(v.tracked_editor_path_count, MAX_EDITOR_PATHS, "before.tracked_editor_path_count");
  digest(v.tracked_editor_pathset_digest, "before.tracked_editor_pathset_digest");
  count(v.editor_tree_file_count, MAX_EDITOR_PATHS, "before.editor_tree_file_count");
  count(v.editor_tree_size, MAX_EDITOR_TREE_BYTES, "before.editor_tree_size");
  digest(v.editor_tree_digest, "before.editor_tree_digest");
}
function parseEligibility(value: unknown): void {
  objectExact(value, ["disposition", "reason"], "plan.eligibility");
  const v = value as Record<string, unknown>;
  enumValue(
    v.disposition,
    ["eligible", "handler-approval-required", "apply-unavailable", "refused"],
    "eligibility.disposition",
  );
  if (v.reason !== null && typeof v.reason !== "string")
    throw new Error("eligibility.reason invalid");
  if (
    (v.disposition === "eligible" || v.disposition === "handler-approval-required") &&
    v.reason !== null
  )
    throw new Error("eligibility.reason invalid");
  if (v.disposition === "apply-unavailable" && v.reason !== "machine-receipt-unavailable")
    throw new Error("eligibility.reason invalid");
  if (v.disposition === "refused")
    enumValue(
      v.reason,
      [
        "target-unresolved",
        "target-not-active",
        "target-shared",
        "target-subscribed",
        "target-orphan",
        "legacy-authority-ambiguous",
        "origin-mismatch",
        "workspace-dirty",
        "workspace-staged",
        "operation-in-progress",
        "graph-ahead",
        "graph-behind",
        "graph-diverged",
        "graph-detached",
        "authority-unknown",
        "remote-unavailable",
        "reparse-point",
        "observation-incomplete",
        "machine-receipt-unavailable",
      ],
      "eligibility.reason",
    );
}

function objectExact(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be a plain object`);
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (stableJson(actual) !== stableJson(expected))
    throw new Error(`${label} has unknown or missing keys`);
}
function literal(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} invalid`);
}
function enumValue(value: unknown, values: readonly unknown[], label: string): void {
  if (!values.includes(value)) throw new Error(`${label} invalid`);
}
function nullableEnum(value: unknown, values: readonly unknown[], label: string): void {
  if (value !== null) enumValue(value, values, label);
}
function boundedString(value: unknown, min: number, max: number, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    /[\u0000]/u.test(value)
  )
    throw new Error(`${label} invalid`);
}
function machineId(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MACHINE_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label} invalid`);
}
function timestamp(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`${label} invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`${label} invalid`);
}
function nullableString(value: unknown, max: number, label: string): void {
  if (value !== null) boundedString(value, 1, max, label);
}
function count(value: unknown, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
    throw new Error(`${label} invalid`);
}
function digest(value: unknown, label: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} invalid`);
}
function uuid(value: unknown, label: string): void {
  if (typeof value !== "string" || !UUIDV7.test(value)) throw new Error(`${label} invalid`);
}

function digestPlan(plan: EditorLocalizationPlanV1): string {
  const { plan_digest: _digest, ...body } = plan;
  return digestStable(body);
}
function digestByteRecords(records: readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(String(record.length));
    hash.update(Buffer.from([0]));
    hash.update(record);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}
function digestStable(value: unknown): string {
  return sha256(Buffer.from(stableJson(value), "utf8"));
}
function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object")
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
function uuidFromDigest(value: string): string {
  const hex = sha256(Buffer.from(value));
  const variant = (8 + (Number.parseInt(hex[16]!, 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function localizationLockPath(vaultId: string): string {
  return getPublicationAttemptLockPath(`editor-localization:vault:${dashedUuid(vaultId)}`);
}
function dashedUuid(value: string): string {
  const hex = value.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(hex) || hex[12] !== "7") throw new Error("value is not UUIDv7");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const productionGitRunner: EditorLocalizationGitRunner = {
  read: (args, options) =>
    runGitReadOnly(args, {
      cwd: options.cwd,
      stdin: options.stdin,
      allowFailure: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    }),
  readRaw: (args, options) =>
    runGitReadOnlyRaw(args, {
      cwd: options.cwd,
      allowFailure: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    }),
  mutate: (args, options) =>
    runGitLocalMutation(args, {
      cwd: options.cwd,
      stdin: options.stdin,
      allowFailure: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    }),
};

const productionDependencies: EditorLocalizationDependencies = {
  observe: observeProductionContext,
  git: productionGitRunner,
  open: openReceiptAttempt,
  reopen: reopenReceiptAttempt,
  prepareProof: hasPrepareProof,
  completedApply: hasCompletedApply,
  findPending: findPendingAttempt,
  newAttemptId: () => uuid7BytesToDashedString(newUuidv7Bytes()),
  now: () => new Date(),
  withLock: (path, action) =>
    withDestinationPolicyLock(path, action, {
      acquireTimeoutMs: 5_000,
      subject: `editor-localization:${path}`,
    }),
};
