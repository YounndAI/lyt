/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { createRequire } from "node:module";

import {
  composeManagedManualMarker,
  newUuidv7Bytes,
  openReceiptAttempt,
  parseReceiptV1ForEmission,
  reopenReceiptAttempt,
  uuid7BytesToDashedString,
  type ReceiptV1,
} from "@younndai/lyt-vault";

import type { InstallableProviderObjectV1, InstallProviderV1 } from "./provider-inventory.js";
import { canonicalJson, digestCanonical, UPDATE_PLAN_PACKAGES } from "./update-plan.js";

export type ReconcileObjectDisposition = "already-current" | "planned" | "refused";

export interface ReconcileObjectPlanV1 {
  readonly object_id: string;
  readonly provider_package: string;
  readonly provider_version: string;
  readonly kind: InstallableProviderObjectV1["kind"];
  readonly target_path: string;
  readonly expected_digest: string;
  readonly observed_digest: string | null;
  readonly expected_applied_digest: string;
  readonly trusted_legacy_digests: readonly string[];
  readonly disposition: ReconcileObjectDisposition;
  readonly refusal_code: string | null;
}

export interface InstallReconcilePlanV1 {
  readonly schema_id: "lyt.install-reconcile-plan";
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly operation_id: string;
  readonly plan_digest: string;
  readonly journal_root: string;
  readonly objects: readonly ReconcileObjectPlanV1[];
}

export interface ReconcileJournalV1 {
  readonly schema_id: "lyt.install-reconcile-journal";
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly plan: InstallReconcilePlanV1;
  readonly completed: readonly string[];
  readonly pending: readonly string[];
  readonly refused: readonly string[];
  readonly active_attempt_id: string | null;
  readonly active_started_at: string | null;
  readonly status: "pending" | "complete" | "refused" | "interrupted";
}

export interface InstallReconcileEnvelopeV1 {
  readonly schema_id: "lyt.install-reconcile-result";
  readonly schema_version: Readonly<{ major: 1; minor: 0 }>;
  readonly success: boolean;
  readonly status: "planned" | "success" | "no-op" | "partial" | "refused" | "failed";
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly plan_digest: string;
  readonly plan: InstallReconcilePlanV1;
  readonly mutations: number;
  readonly completed: readonly string[];
  readonly pending: readonly string[];
  readonly refused: readonly string[];
  readonly next_action: string | null;
  readonly receipt: ReceiptV1;
}

export interface ReconcileEngineOptions {
  readonly journalRoot?: string;
  readonly now?: () => Date;
  readonly newAttemptId?: () => string;
  readonly receiptOpen?: typeof openReceiptAttempt;
  readonly receiptReopen?: typeof reopenReceiptAttempt;
  readonly failAfterObject?: string;
  readonly failBeforeJournalAfterObject?: string;
}

export function defaultReconcileJournalRoot(homeDir: string = homedir()): string {
  return join(homeDir, "lyt", ".install-reconcile");
}

export function buildInstallReconcileFailureEnvelopeV1(
  error: unknown,
  options: Pick<ReconcileEngineOptions, "journalRoot" | "now" | "newAttemptId"> = {},
): InstallReconcileEnvelopeV1 {
  const journalRoot = resolve(options.journalRoot ?? defaultReconcileJournalRoot());
  const payload = {
    schema_id: "lyt.install-reconcile-plan" as const,
    schema_version: { major: 1 as const, minor: 0 as const },
    journal_root: journalRoot,
    objects: Object.freeze([]),
  };
  const planDigest = digestCanonical(payload);
  const plan: InstallReconcilePlanV1 = Object.freeze({
    ...payload,
    operation_id: digestToUuidV7(planDigest),
    plan_digest: planDigest,
  });
  const now = options.now?.() ?? new Date();
  return envelopeFromState({
    plan,
    attemptId: options.newAttemptId?.() ?? uuid7BytesToDashedString(newUuidv7Bytes()),
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    disposition: "new",
    completed: [],
    pending: [],
    refused: [],
    mutations: 0,
    dryRun: false,
    failure: error instanceof Error ? error.message : "install-reconcile-failed",
    nextActionOverride: "lyt doctor --json",
  });
}

export function readPackageVersion(packageName: string): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = (require.resolve.paths(packageName) ?? [])
    .map((base) => join(base, ...packageName.split("/"), "package.json"))
    .find((candidate) => existsSync(candidate));
  if (packageJsonPath === undefined) throw new Error("install-provider-package-root-not-found");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error("install-provider-invalid-version");
  return parsed.version;
}

export function prepareInstallReconcilePlanV1(
  providers: readonly InstallProviderV1[],
  options: Pick<ReconcileEngineOptions, "journalRoot"> = {},
): InstallReconcilePlanV1 {
  assertProviderSet(providers);
  const journalRoot = resolve(options.journalRoot ?? defaultReconcileJournalRoot());
  assertPathChainHasNoLinks(journalRoot, true);
  const objects = providers
    .flatMap((provider) => provider.objects)
    .map((object) => inspectProviderObject(object))
    .sort((a, b) => a.object_id.localeCompare(b.object_id));
  const ids = objects.map((object) => object.object_id);
  if (new Set(ids).size !== ids.length) throw new Error("install-provider-duplicate-object");
  const payload = {
    schema_id: "lyt.install-reconcile-plan" as const,
    schema_version: { major: 1 as const, minor: 0 as const },
    journal_root: journalRoot,
    objects,
  };
  const planDigest = digestCanonical(payload);
  const operationId = digestToUuidV7(planDigest);
  return Object.freeze({ ...payload, operation_id: operationId, plan_digest: planDigest });
}

export async function reconcileInstallProvidersV1(
  providers: readonly InstallProviderV1[],
  input: Readonly<{ apply: boolean; resumeOperationId?: string }> = { apply: false },
  options: ReconcileEngineOptions = {},
): Promise<InstallReconcileEnvelopeV1> {
  const now = options.now ?? (() => new Date());
  const newAttemptId = options.newAttemptId ?? (() => uuid7BytesToDashedString(newUuidv7Bytes()));
  const journalRoot = resolve(options.journalRoot ?? defaultReconcileJournalRoot());
  const freshPlan = prepareInstallReconcilePlanV1(providers, { journalRoot });
  let journal: ReconcileJournalV1;
  let plan: InstallReconcilePlanV1;
  if (input.resumeOperationId !== undefined) {
    if (!input.apply) throw new Error("install-reconcile-resume-requires-apply");
    journal = readJournal(journalRoot, input.resumeOperationId);
    plan = journal.plan;
    journal = recoverAppliedObjects(plan, freshPlan, journal);
    assertResumeEnvironment(plan, freshPlan, journal);
  } else {
    plan = freshPlan;
    journal = newJournal(plan);
  }

  const attemptId = journal.active_attempt_id ?? newAttemptId();
  const startedAt = journal.active_started_at ?? now().toISOString();
  if (!input.apply) {
    return envelopeFromState({
      plan,
      attemptId,
      startedAt,
      finishedAt: now().toISOString(),
      disposition: "new",
      completed: plan.objects
        .filter((object) => object.disposition === "already-current")
        .map((object) => object.object_id),
      pending: plan.objects
        .filter((object) => object.disposition === "planned")
        .map((object) => object.object_id),
      refused: plan.objects
        .filter((object) => object.disposition === "refused")
        .map((object) => object.object_id),
      mutations: 0,
      dryRun: true,
    });
  }

  const resumePendingAttempt =
    input.resumeOperationId !== undefined && journal.active_attempt_id !== null;
  const pendingReceipt = baseReceipt({
    plan,
    attemptId,
    startedAt,
    finishedAt: startedAt,
    disposition: input.resumeOperationId === undefined ? "new" : "resumed",
    status: "failed",
    mutations: 0,
    errorCode: "install-reconcile-interrupted",
    nextAction: "resume-install-reconcile",
  });
  const receiptResult = resumePendingAttempt
    ? await (options.receiptReopen ?? reopenReceiptAttempt)(pendingReceipt)
    : await (options.receiptOpen ?? openReceiptAttempt)(pendingReceipt);
  const receiptSession = receiptResult.kind === "ready" ? receiptResult.session : null;
  if (receiptSession === null) {
    return envelopeFromState({
      plan,
      attemptId,
      startedAt,
      finishedAt: now().toISOString(),
      disposition: input.resumeOperationId === undefined ? "new" : "resumed",
      completed: journal.completed,
      pending: journal.pending,
      refused: journal.refused,
      mutations: 0,
      dryRun: false,
      failure: "receipt-store-unavailable",
      nextActionOverride: "lyt doctor --json",
    });
  }
  journal = Object.freeze({
    ...journal,
    active_attempt_id: attemptId,
    active_started_at: startedAt,
    status: "interrupted",
  });
  writeJournal(journalRoot, journal);

  const sourceObjects = new Map(
    providers.flatMap((provider) => provider.objects).map((object) => [object.object_id, object]),
  );
  const completed = new Set(journal.completed);
  const refused = new Set(journal.refused);
  let mutations = 0;
  let failure: string | null = null;
  for (const objectPlan of plan.objects) {
    if (completed.has(objectPlan.object_id) || refused.has(objectPlan.object_id)) continue;
    if (objectPlan.disposition === "already-current") {
      completed.add(objectPlan.object_id);
      continue;
    }
    if (objectPlan.disposition === "refused") {
      refused.add(objectPlan.object_id);
      continue;
    }
    const source = sourceObjects.get(objectPlan.object_id);
    if (source === undefined) {
      failure = "install-provider-object-missing";
      break;
    }
    try {
      revalidateObject(source, objectPlan);
      const staged = stageObject(journalRoot, source);
      applyOneObject(source, staged);
      verifyAppliedObject(source, staged);
      completed.add(objectPlan.object_id);
      mutations += 1;
      if (options.failBeforeJournalAfterObject === objectPlan.object_id) {
        throw new Error("install-reconcile-injected-prejournal-interruption");
      }
      const currentPending = plan.objects
        .map((entry) => entry.object_id)
        .filter((id) => !completed.has(id) && !refused.has(id));
      journal = Object.freeze({
        ...journal,
        completed: Object.freeze([...completed].sort()),
        pending: Object.freeze(currentPending),
        refused: Object.freeze([...refused].sort()),
        status: "interrupted",
      });
      writeJournal(journalRoot, journal);
      if (options.failAfterObject === objectPlan.object_id) {
        throw new Error("install-reconcile-injected-interruption");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "install-reconcile-injected-prejournal-interruption"
      ) {
        throw error;
      }
      failure = error instanceof Error ? error.message : "install-reconcile-apply-failed";
      break;
    }
  }

  const pending = plan.objects
    .map((entry) => entry.object_id)
    .filter((id) => !completed.has(id) && !refused.has(id));
  journal = Object.freeze({
    ...journal,
    completed: Object.freeze([...completed].sort()),
    pending: Object.freeze(pending),
    refused: Object.freeze([...refused].sort()),
    active_attempt_id: failure === null ? null : attemptId,
    active_started_at: failure === null ? null : startedAt,
    status: failure === null ? terminalJournalStatus(pending, [...refused]) : "interrupted",
  });
  writeJournal(journalRoot, journal);
  let envelope = envelopeFromState({
    plan,
    attemptId,
    startedAt,
    finishedAt: now().toISOString(),
    disposition: input.resumeOperationId === undefined ? "new" : "resumed",
    completed: [...completed].sort(),
    pending,
    refused: [...refused].sort(),
    mutations,
    dryRun: false,
    failure,
  });
  if (receiptSession !== null) {
    try {
      const warnings = await receiptSession.finalize(envelope.receipt);
      if (warnings.length > 0) throw new Error("receipt-finalization-warning");
    } catch {
      envelope = envelopeFromState({
        plan,
        attemptId,
        startedAt,
        finishedAt: now().toISOString(),
        disposition: input.resumeOperationId === undefined ? "new" : "resumed",
        completed: [...completed].sort(),
        pending,
        refused: [...refused].sort(),
        mutations,
        dryRun: false,
        failure: "receipt-finalization-failed",
      });
      journal = Object.freeze({
        ...journal,
        active_attempt_id: attemptId,
        active_started_at: startedAt,
        status: "interrupted",
      });
      writeJournal(journalRoot, journal);
      return envelope;
    }
    journal = Object.freeze({
      ...journal,
      active_attempt_id: null,
      active_started_at: null,
      status: terminalJournalStatus(pending, [...refused]),
    });
    writeJournal(journalRoot, journal);
  }
  return envelope;
}

function recoverAppliedObjects(
  sealed: InstallReconcilePlanV1,
  observed: InstallReconcilePlanV1,
  journal: ReconcileJournalV1,
): ReconcileJournalV1 {
  const currentById = new Map(observed.objects.map((object) => [object.object_id, object]));
  const completed = new Set(journal.completed);
  for (const object of sealed.objects) {
    const current = currentById.get(object.object_id);
    if (
      journal.pending.includes(object.object_id) &&
      current?.disposition === "already-current" &&
      current.observed_digest === object.expected_applied_digest
    ) {
      completed.add(object.object_id);
    }
  }
  if (completed.size === journal.completed.length) return journal;
  return Object.freeze({
    ...journal,
    completed: Object.freeze([...completed].sort()),
    pending: Object.freeze(journal.pending.filter((id) => !completed.has(id))),
  });
}

function assertResumeEnvironment(
  sealed: InstallReconcilePlanV1,
  observed: InstallReconcilePlanV1,
  journal: ReconcileJournalV1,
): void {
  const observedById = new Map(observed.objects.map((object) => [object.object_id, object]));
  if (observedById.size !== sealed.objects.length) {
    throw new Error("install-reconcile-destination-drift");
  }
  const completed = new Set(journal.completed);
  for (const expected of sealed.objects) {
    const current = observedById.get(expected.object_id);
    if (
      current === undefined ||
      current.provider_package !== expected.provider_package ||
      current.provider_version !== expected.provider_version ||
      current.kind !== expected.kind ||
      current.target_path !== expected.target_path ||
      current.expected_digest !== expected.expected_digest ||
      canonicalJson(current.trusted_legacy_digests) !==
        canonicalJson(expected.trusted_legacy_digests) ||
      current.expected_applied_digest !== expected.expected_applied_digest ||
      (completed.has(expected.object_id) && current.disposition !== "already-current") ||
      (completed.has(expected.object_id) &&
        current.observed_digest !== expected.expected_applied_digest) ||
      (!completed.has(expected.object_id) &&
        (current.disposition !== expected.disposition ||
          current.observed_digest !== expected.observed_digest))
    ) {
      throw new Error("install-reconcile-destination-drift");
    }
  }
}

function inspectProviderObject(object: InstallableProviderObjectV1): ReconcileObjectPlanV1 {
  assertPathChainHasNoLinks(dirname(object.target_path), true);
  let disposition: ReconcileObjectDisposition = "planned";
  let refusalCode: string | null = null;
  let observedDigest: string | null = null;
  let expectedAppliedDigest = object.expected_digest;
  try {
    const stat = lstatSync(object.target_path);
    if (stat.isSymbolicLink()) {
      if (object.kind === "directory-link") {
        const linked = resolve(dirname(object.target_path), readlinkSync(object.target_path));
        observedDigest = digestPathTree(linked);
        if (observedDigest === object.expected_digest) disposition = "already-current";
        else {
          disposition = "refused";
          refusalCode = "divergent-link";
        }
      } else {
        disposition = "refused";
        refusalCode = "symlink-leaf";
      }
    } else if (object.kind === "directory-link" && stat.isDirectory()) {
      observedDigest = digestPathTree(object.target_path);
      if (observedDigest === object.expected_digest) {
        disposition = "already-current";
      } else {
        disposition = "refused";
        refusalCode = "handler-owned-skill-leaf";
      }
    } else if (object.kind === "marker-file" && stat.isFile()) {
      const current = readFileSync(object.target_path, "utf8");
      const next = replaceOwnedMarker(current, object);
      observedDigest = digestBytes(Buffer.from(current));
      expectedAppliedDigest = digestBytes(Buffer.from(next));
      disposition = next === current ? "already-current" : "planned";
    } else {
      disposition = "refused";
      refusalCode = "unsupported-leaf-type";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return Object.freeze({
    object_id: object.object_id,
    provider_package: object.provider_package,
    provider_version: object.provider_version,
    kind: object.kind,
    target_path: resolve(object.target_path),
    expected_digest: object.expected_digest,
    observed_digest: observedDigest,
    expected_applied_digest: expectedAppliedDigest,
    trusted_legacy_digests: Object.freeze([...object.trusted_legacy_digests].sort()),
    disposition,
    refusal_code: refusalCode,
  });
}

function revalidateObject(
  source: InstallableProviderObjectV1,
  sealed: ReconcileObjectPlanV1,
): void {
  const current = inspectProviderObject(source);
  if (canonicalJson(current) !== canonicalJson(sealed)) {
    throw new Error("install-reconcile-destination-drift");
  }
  if (
    source.kind === "directory-link" &&
    digestPathTree(source.source_path) !== source.expected_digest
  ) {
    throw new Error("install-reconcile-provider-drift");
  }
  if (
    source.kind === "marker-file" &&
    digestBytes(Buffer.from(source.content)) !== source.expected_digest
  ) {
    throw new Error("install-reconcile-provider-drift");
  }
}

function stageObject(root: string, object: InstallableProviderObjectV1): string {
  assertPathChainHasNoLinks(root, true);
  const expectedAppliedDigest = inspectProviderObject(object).expected_applied_digest;
  const objectRoot = join(root, "objects", expectedAppliedDigest);
  assertPathChainHasNoLinks(objectRoot, true);
  const primary = join(objectRoot, object.kind === "directory-link" ? "content" : "content.md");
  mkdirSync(objectRoot, { recursive: true });
  const candidates = [primary, `${primary}.recovery-${expectedAppliedDigest.slice(0, 16)}`];
  for (const staged of candidates) {
    assertPathChainHasNoLinks(staged, true);
    if (!existsSync(staged)) {
      if (object.kind === "directory-link") cpSync(object.source_path, staged, { recursive: true });
      else {
        const existing = existsSync(object.target_path)
          ? readFileSync(object.target_path, "utf8")
          : "";
        writeFileSync(staged, replaceOwnedMarker(existing, object), {
          encoding: "utf8",
          flag: "wx",
        });
      }
    }
    const actual =
      object.kind === "directory-link" ? digestPathTree(staged) : digestBytes(readFileSync(staged));
    if (actual === expectedAppliedDigest) return staged;
  }
  throw new Error("install-reconcile-staging-mismatch");
}

function applyOneObject(object: InstallableProviderObjectV1, staged: string): void {
  assertPathChainHasNoLinks(dirname(object.target_path), true);
  mkdirSync(dirname(object.target_path), { recursive: true });
  if (object.kind === "directory-link") {
    let leaf: ReturnType<typeof lstatSync> | null = null;
    try {
      leaf = lstatSync(object.target_path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (leaf !== null) {
      if (!leaf.isSymbolicLink()) {
        throw new Error("install-reconcile-refuses-existing-skill-leaf");
      }
      const linked = resolve(dirname(object.target_path), readlinkSync(object.target_path));
      try {
        lstatSync(linked);
        throw new Error("install-reconcile-destination-drift");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Detach only the dead link leaf. Never recurse into a reparse point.
      if (platform() === "win32") rmdirSync(object.target_path);
      else unlinkSync(object.target_path);
    }
    symlinkSync(staged, object.target_path, platform() === "win32" ? "junction" : "dir");
    return;
  }
  atomicWriteFile(object.target_path, readFileSync(staged, "utf8"));
}

function verifyAppliedObject(object: InstallableProviderObjectV1, staged: string): void {
  if (object.kind === "directory-link") {
    const linked = resolve(dirname(object.target_path), readlinkSync(object.target_path));
    if (resolve(linked) !== resolve(staged) || digestPathTree(linked) !== object.expected_digest) {
      throw new Error("install-reconcile-verification-failed");
    }
    return;
  }
  if (digestBytes(readFileSync(object.target_path)) !== digestBytes(readFileSync(staged))) {
    throw new Error("install-reconcile-verification-failed");
  }
}

function assertProviderSet(providers: readonly InstallProviderV1[]): void {
  const names = providers.map((provider) => provider.package).sort();
  const expected = [...UPDATE_PLAN_PACKAGES].sort();
  if (canonicalJson(names) !== canonicalJson(expected)) {
    throw new Error("install-provider-exact-seven-required");
  }
  if (new Set(providers.map((provider) => provider.version)).size !== 1) {
    throw new Error("install-provider-version-skew");
  }
  for (const provider of providers) {
    if (
      provider.schema_id !== "lyt.install-provider" ||
      provider.schema_version.major !== 1 ||
      provider.schema_version.minor !== 0 ||
      provider.objects.some(
        (object) =>
          object.provider_package !== provider.package ||
          object.provider_version !== provider.version,
      ) ||
      provider.objects.some(
        (object) =>
          new Set(object.trusted_legacy_digests).size !== object.trusted_legacy_digests.length ||
          object.trusted_legacy_digests.some(
            (digest) => !/^[a-f0-9]{64}$/.test(digest) || digest === object.expected_digest,
          ),
      )
    ) {
      throw new Error("install-provider-invalid-manifest");
    }
  }
}

function replaceOwnedMarker(
  existing: string,
  object: Extract<InstallableProviderObjectV1, { kind: "marker-file" }>,
): string {
  const composed = composeManagedManualMarker(existing, object.content);
  if (composed.status === "malformed") {
    throw new Error("install-reconcile-malformed-managed-marker");
  }
  return composed.result;
}

function newJournal(plan: InstallReconcilePlanV1): ReconcileJournalV1 {
  const pending = plan.objects
    .filter((object) => object.disposition === "planned")
    .map((object) => object.object_id);
  const refused = plan.objects
    .filter((object) => object.disposition === "refused")
    .map((object) => object.object_id);
  return Object.freeze({
    schema_id: "lyt.install-reconcile-journal",
    schema_version: Object.freeze({ major: 1, minor: 0 }),
    plan,
    completed: Object.freeze(
      plan.objects
        .filter((object) => object.disposition === "already-current")
        .map((object) => object.object_id),
    ),
    pending: Object.freeze(pending),
    refused: Object.freeze(refused),
    active_attempt_id: null,
    active_started_at: null,
    status: terminalJournalStatus(pending, refused),
  });
}

function terminalJournalStatus(
  pending: readonly string[],
  refused: readonly string[],
): "pending" | "complete" | "refused" {
  if (pending.length > 0) return "pending";
  return refused.length > 0 ? "refused" : "complete";
}

function journalPath(root: string, operationId: string): string {
  return join(root, "operations", operationId, "journal.json");
}

function writeJournal(root: string, journal: ReconcileJournalV1): void {
  const path = journalPath(root, journal.plan.operation_id);
  assertPathChainHasNoLinks(root, true);
  assertPathChainHasNoLinks(dirname(path), true);
  assertPathChainHasNoLinks(path, true);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function readJournal(root: string, operationId: string): ReconcileJournalV1 {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId))
    throw new Error("install-reconcile-invalid-operation-id");
  const path = journalPath(root, operationId);
  assertPathChainHasNoLinks(root, true);
  assertPathChainHasNoLinks(dirname(path), true);
  assertPathChainHasNoLinks(path, true);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ReconcileJournalV1;
  if (
    !Array.isArray(parsed.plan?.objects) ||
    !Array.isArray(parsed.completed) ||
    !Array.isArray(parsed.pending) ||
    !Array.isArray(parsed.refused)
  ) {
    throw new Error("install-reconcile-journal-tampered");
  }
  const planIds = new Set(parsed.plan?.objects?.map((object) => object.object_id) ?? []);
  const completed = new Set(parsed.completed ?? []);
  const pending = new Set(parsed.pending ?? []);
  const refused = new Set(parsed.refused ?? []);
  const partition = new Set([...completed, ...pending, ...refused]);
  const dispositions = new Map(
    (parsed.plan?.objects ?? []).map((object) => [object.object_id, object.disposition]),
  );
  if (
    parsed.schema_id !== "lyt.install-reconcile-journal" ||
    parsed.schema_version?.major !== 1 ||
    parsed.schema_version?.minor !== 0 ||
    !["pending", "complete", "refused", "interrupted"].includes(parsed.status) ||
    parsed.plan?.schema_id !== "lyt.install-reconcile-plan" ||
    parsed.plan?.schema_version?.major !== 1 ||
    parsed.plan?.schema_version?.minor !== 0 ||
    parsed.plan.operation_id !== operationId ||
    !Array.isArray(parsed.plan.objects) ||
    parsed.plan.objects.length === 0 ||
    planIds.size !== parsed.plan.objects.length ||
    parsed.plan.objects.some((object) => !isReconcileObjectPlanV1(object)) ||
    typeof parsed.plan.journal_root !== "string" ||
    !isAbsolute(parsed.plan.journal_root) ||
    !Array.isArray(parsed.completed) ||
    !Array.isArray(parsed.pending) ||
    !Array.isArray(parsed.refused) ||
    !parsed.completed.every((value) => typeof value === "string") ||
    !parsed.pending.every((value) => typeof value === "string") ||
    !parsed.refused.every((value) => typeof value === "string") ||
    completed.size !== parsed.completed.length ||
    pending.size !== parsed.pending.length ||
    refused.size !== parsed.refused.length ||
    partition.size !== planIds.size ||
    [...partition].some((id) => !planIds.has(id)) ||
    [...completed].some(
      (id) => refused.has(id) || pending.has(id) || dispositions.get(id) === "refused",
    ) ||
    [...pending].some((id) => refused.has(id) || dispositions.get(id) !== "planned") ||
    [...refused].some((id) => dispositions.get(id) !== "refused") ||
    (parsed.active_attempt_id !== null && typeof parsed.active_attempt_id !== "string") ||
    (parsed.active_started_at !== null && typeof parsed.active_started_at !== "string") ||
    (parsed.active_attempt_id === null) !== (parsed.active_started_at === null) ||
    (parsed.status === "interrupted") !== (parsed.active_attempt_id !== null) ||
    (parsed.status === "pending" && (parsed.active_attempt_id !== null || pending.size === 0)) ||
    (parsed.status === "complete" &&
      (parsed.active_attempt_id !== null || pending.size > 0 || refused.size > 0)) ||
    (parsed.status === "refused" &&
      (parsed.active_attempt_id !== null || pending.size > 0 || refused.size === 0)) ||
    parsed.plan.plan_digest !==
      digestCanonical({
        schema_id: parsed.plan.schema_id,
        schema_version: parsed.plan.schema_version,
        journal_root: parsed.plan.journal_root,
        objects: parsed.plan.objects,
      }) ||
    parsed.plan.operation_id !== digestToUuidV7(parsed.plan.plan_digest)
  ) {
    throw new Error("install-reconcile-journal-tampered");
  }
  return parsed;
}

function isReconcileObjectPlanV1(value: unknown): value is ReconcileObjectPlanV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const object = value as Partial<ReconcileObjectPlanV1>;
  const sha256 = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  const refusalConsistent =
    object.disposition === "refused"
      ? typeof object.refusal_code === "string" && object.refusal_code.length > 0
      : object.refusal_code === null;
  return (
    typeof object.object_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(object.object_id) &&
    typeof object.provider_package === "string" &&
    UPDATE_PLAN_PACKAGES.includes(object.provider_package as (typeof UPDATE_PLAN_PACKAGES)[number]) &&
    typeof object.provider_version === "string" &&
    object.provider_version.length > 0 &&
    (object.kind === "directory-link" || object.kind === "marker-file") &&
    typeof object.target_path === "string" &&
    isAbsolute(object.target_path) &&
    sha256(object.expected_digest) &&
    (object.observed_digest === null || sha256(object.observed_digest)) &&
    sha256(object.expected_applied_digest) &&
    Array.isArray(object.trusted_legacy_digests) &&
    object.trusted_legacy_digests.every(sha256) &&
    (object.disposition === "already-current" ||
      object.disposition === "planned" ||
      object.disposition === "refused") &&
    refusalConsistent
  );
}

export function inspectReconcileJournalV1(
  root: string,
  operationId: string,
): Readonly<{
  valid: boolean;
  journal: ReconcileJournalV1 | null;
  error_code: string | null;
}> {
  try {
    return Object.freeze({
      valid: true,
      journal: readJournal(resolve(root), operationId),
      error_code: null,
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      journal: null,
      error_code: safeErrorCode(
        error instanceof Error ? error.message : "install-reconcile-journal-invalid",
      ),
    });
  }
}

function atomicWriteFile(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  assertPathChainHasNoLinks(dirname(path), true);
  assertPathChainHasNoLinks(path, true);
  assertPathChainHasNoLinks(temporary, true);
  writeFileSync(temporary, content, { encoding: "utf8", flag: "w" });
  renameSync(temporary, path);
}

function envelopeFromState(args: {
  plan: InstallReconcilePlanV1;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  disposition: "new" | "resumed";
  completed: readonly string[];
  pending: readonly string[];
  refused: readonly string[];
  mutations: number;
  dryRun: boolean;
  failure?: string | null;
  nextActionOverride?: string | null;
}): InstallReconcileEnvelopeV1 {
  const failure = args.failure ?? null;
  const incomplete = args.pending.length > 0 || args.refused.length > 0 || failure !== null;
  const status = args.dryRun
    ? "planned"
    : incomplete
      ? args.mutations > 0
        ? "partial"
        : args.refused.length > 0
          ? "refused"
          : "failed"
      : args.mutations > 0
        ? "success"
        : "no-op";
  const nextAction =
    args.nextActionOverride ??
    (args.dryRun && (args.pending.length > 0 || args.refused.length > 0)
      ? args.refused.length > 0
        ? "lyt doctor --json"
        : "lyt install reconcile --apply --json"
      : incomplete
        ? args.refused.length > 0 && args.pending.length === 0 && failure === null
          ? "lyt doctor --json"
          : `lyt install reconcile --resume ${args.plan.operation_id} --apply --json`
        : null);
  const receiptStatus = args.dryRun ? "no-op" : status === "planned" ? "no-op" : status;
  const receipt = baseReceipt({
    plan: args.plan,
    attemptId: args.attemptId,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    disposition: status === "refused" ? "rejected" : args.disposition,
    status: receiptStatus,
    mutations: args.mutations,
    errorCode: args.dryRun || !incomplete ? null : (failure ?? "install-reconcile-refused-object"),
    nextAction:
      args.dryRun || !incomplete
        ? null
        : args.refused.length > 0 && args.pending.length === 0 && failure === null
          ? "inspect-install-reconcile"
          : "resume-install-reconcile",
  });
  return Object.freeze({
    schema_id: "lyt.install-reconcile-result",
    schema_version: Object.freeze({ major: 1, minor: 0 }),
    success: !incomplete,
    status,
    operation_id: args.plan.operation_id,
    attempt_id: args.attemptId,
    plan_digest: args.plan.plan_digest,
    plan: args.plan,
    mutations: args.mutations,
    completed: Object.freeze([...args.completed]),
    pending: Object.freeze([...args.pending]),
    refused: Object.freeze([...args.refused]),
    next_action: nextAction,
    receipt,
  });
}

function baseReceipt(args: {
  plan: InstallReconcilePlanV1;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  disposition: "new" | "resumed" | "rejected";
  status: "success" | "no-op" | "partial" | "refused" | "failed";
  mutations: number;
  errorCode: string | null;
  nextAction: string | null;
}): ReceiptV1 {
  return parseReceiptV1ForEmission({
    schema_id: "lyt.receipt",
    schema_version: { major: 1, minor: 0 },
    operation_id: args.plan.operation_id,
    attempt_id: args.attemptId,
    operation: "install-reconcile",
    scope: { kind: "system" },
    timestamps: { started_at: args.startedAt, finished_at: args.finishedAt },
    replay: { disposition: args.disposition, key_digest: args.plan.plan_digest },
    status: args.status,
    exit_code: args.status === "success" || args.status === "no-op" ? 0 : 1,
    mutations: { local: args.mutations, remote: 0 },
    evidence: {
      before: [
        {
          kind: "reconcile-plan",
          subject: "sealed install reconciliation plan",
          digest: args.plan.plan_digest,
        },
      ],
      after: [
        {
          kind: "managed-objects",
          subject: "verified managed destination objects",
          count: args.mutations,
        },
      ],
    },
    next_action:
      args.nextAction === null
        ? null
        : { code: args.nextAction, summary: "Resume the exact install reconciliation operation." },
    error:
      args.errorCode === null
        ? null
        : {
            code: safeErrorCode(args.errorCode),
            summary: "Install reconciliation is incomplete.",
            retryable: true,
          },
  });
}

function safeErrorCode(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return safe.length > 0 ? safe.slice(0, 96) : "install-reconcile-failed";
}

export function assertPathChainHasNoLinks(path: string, includeLeaf: boolean): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const parts = relative(parsed.root, absolute).split(/[\\/]/).filter(Boolean);
  let current = parsed.root;
  const last = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < last; index += 1) {
    current = join(current, parts[index]!);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("install-reconcile-symlink-path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestPathTree(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("install-provider-source-symlink");
  if (stat.isFile()) return digestBytes(readFileSync(path));
  if (!stat.isDirectory()) throw new Error("install-provider-source-type");
  const hash = createHash("sha256");
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    hash.update(name, "utf8");
    hash.update("\0");
    hash.update(digestPathTree(child), "hex");
  }
  return hash.digest("hex");
}

function digestToUuidV7(digest: string): string {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "7";
  chars[16] = ["8", "9", "a", "b"][Number.parseInt(chars[16]!, 16) % 4]!;
  const raw = chars.join("");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}
