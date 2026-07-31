/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  closeRegistry,
  deriveLocalWritable,
  getVaultByName,
  inventoryVaultFiles,
  loadLytIgnorePolicy,
  newUuidv7Bytes,
  normalizeVaultSubtree,
  openRegistry,
  uuid7BytesToDashedString,
  type VaultFileClassification,
  type VaultFilesInventory,
} from "@younndai/lyt-vault";

export type MutationPreviewOperation = "backfill" | "reconcile";
export type MutationReceiptLifecycle =
  | "previewed"
  | "applying"
  | "completed"
  | "refused-before-write"
  | "partial";

export interface MutationPreviewCandidate {
  path: string;
  preimageSha256: string;
  plannedMutations: string[];
}

export interface MutationPreviewPlan {
  schema: "lyt.mutation-preview";
  version: 1;
  id: string;
  operation: MutationPreviewOperation;
  createdAt: string;
  expiresAt: string;
  vault: { rid: string; name: string };
  scope: string;
  push: boolean;
  ignorePolicy: {
    exists: boolean;
    sha256: string;
    bytesBase64: string;
  };
  inventoryDigest: string;
  candidateCount: number;
  exclusionCount: number;
  exclusionCounts: Partial<Record<VaultFileClassification, number>>;
  pendingRemovalCount: number;
  unindexedCount: number;
  reindexRequired: boolean;
  reindexScope: "vault" | null;
  candidates: MutationPreviewCandidate[];
}

export interface MutationPreviewReceipt {
  plan: MutationPreviewPlan;
  seal: { algorithm: "sha256"; digest: string };
  lifecycle: {
    state: MutationReceiptLifecycle;
    startedAt: string | null;
    finishedAt: string | null;
    completedCandidates: string[];
    untouchedCandidates: string[];
    error: string | null;
  };
}

export interface MutationApplySession {
  getReceipt(): MutationPreviewReceipt;
  inventory: VaultFilesInventory;
  completed: string[];
  revalidateBeforeMutation(): Promise<void>;
  markCandidateCompleted(path: string): void;
  markMutationStarted(): void;
  complete(): void;
  fail(error: unknown): void;
}

const RECEIPT_TTL_MS = 30 * 60 * 1000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptDir(vaultPath: string, create: boolean): string {
  const rootStat = lstatSync(vaultPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("preview receipt store requires a real registered vault root");
  }
  const lytDir = join(vaultPath, ".lyt");
  const lytStat = lstatSync(lytDir);
  if (lytStat.isSymbolicLink() || !lytStat.isDirectory()) {
    throw new Error("preview receipt store requires a real .lyt directory");
  }
  const directory = join(lytDir, "mutation-previews");
  if (!existsSync(directory)) {
    if (!create) throw new Error("preview receipt store does not exist");
    mkdirSync(directory);
  }
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("preview receipt store may not be a reparse point");
  }
  return directory;
}

function receiptPath(vaultPath: string, id: string, createDirectory: boolean): string {
  if (!UUID_V7.test(id)) throw new Error("preview receipt id must be a UUIDv7");
  return join(receiptDir(vaultPath, createDirectory), `${id}.json`);
}

function sealPlan(plan: MutationPreviewPlan): string {
  return sha256(JSON.stringify(plan));
}

function atomicWriteReceipt(vaultPath: string, receipt: MutationPreviewReceipt): void {
  const path = receiptPath(vaultPath, receipt.plan.id, true);
  const directory = receiptDir(vaultPath, true);
  const temp = join(directory, `.${receipt.plan.id}.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify(receipt, null, 2)}\n`;
  if (existsSync(path)) {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error("preview receipt target must remain a regular file");
    }
  }
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx");
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error("preview receipt store changed type before replace");
    }
    if (existsSync(path)) {
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new Error("preview receipt target changed type before replace");
      }
    }
    renameSync(temp, path);
    if (readFileSync(path, "utf8") !== payload) {
      throw new Error("preview receipt post-write verification failed");
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort close of this exact owned descriptor */
      }
    }
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function loadReceipt(vaultPath: string, id: string): MutationPreviewReceipt {
  const path = receiptPath(vaultPath, id, false);
  if (!existsSync(path)) throw new Error(`preview receipt not found: ${id}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("preview receipt must be a regular file");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as MutationPreviewReceipt;
  if (
    parsed?.plan?.schema !== "lyt.mutation-preview" ||
    parsed.plan.version !== 1 ||
    parsed.plan.id !== id ||
    parsed.seal?.algorithm !== "sha256" ||
    parsed.seal.digest !== sealPlan(parsed.plan)
  ) {
    throw new Error(`preview receipt is malformed or its seal does not match: ${id}`);
  }
  return parsed;
}

function exclusionCounts(inventory: VaultFilesInventory): Partial<Record<VaultFileClassification, number>> {
  const counts: Partial<Record<VaultFileClassification, number>> = {};
  for (const entry of inventory.entries) {
    if (entry.classification === "figment") continue;
    counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
  }
  return counts;
}

function candidatesFromInventory(inventory: VaultFilesInventory): MutationPreviewCandidate[] {
  return inventory.entries
    .filter((entry) => entry.frontmatterMutationCandidate)
    .map((entry) => {
      if (entry.contentSha256 === null) {
        throw new Error(`frontmatter candidate has no readable preimage: ${entry.path}`);
      }
      return {
        path: entry.path,
        preimageSha256: entry.contentSha256,
        plannedMutations: [...entry.missingFields],
      };
    });
}

export async function createMutationPreview(args: {
  operation: MutationPreviewOperation;
  vault: string;
  subtree?: string;
  push: boolean;
  now?: Date;
}): Promise<MutationPreviewReceipt> {
  const now = args.now ?? new Date();
  const inventory = await inventoryVaultFiles(args.vault, args.subtree);
  const policy = loadLytIgnorePolicy(inventory.vault.path);
  if (policy.sha256 !== inventory.ignorePolicy.sha256) {
    throw new Error(".lytignore changed while the preview inventory was being created");
  }
  const candidates = candidatesFromInventory(inventory);
  const id = uuid7BytesToDashedString(newUuidv7Bytes());
  const reindexRequired =
    args.operation === "reconcile" &&
    (candidates.length > 0 ||
      inventory.totals.pendingRemovals > 0 ||
      inventory.entries.some((entry) => entry.classification === "figment" && !entry.indexed));
  const plan: MutationPreviewPlan = {
    schema: "lyt.mutation-preview",
    version: 1,
    id,
    operation: args.operation,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS).toISOString(),
    vault: { rid: inventory.vault.rid, name: inventory.vault.name },
    scope: normalizeVaultSubtree(args.subtree),
    push: args.push,
    ignorePolicy: {
      exists: policy.exists,
      sha256: policy.sha256,
      bytesBase64: policy.bytes.toString("base64"),
    },
    inventoryDigest: inventory.inventoryDigest,
    candidateCount: candidates.length,
    exclusionCount: inventory.totals.excluded,
    exclusionCounts: exclusionCounts(inventory),
    pendingRemovalCount: inventory.totals.pendingRemovals,
    unindexedCount: inventory.entries.filter(
      (entry) => entry.classification === "figment" && !entry.indexed,
    ).length,
    reindexRequired,
    reindexScope: reindexRequired ? "vault" : null,
    candidates,
  };
  const receipt: MutationPreviewReceipt = {
    plan,
    seal: { algorithm: "sha256", digest: sealPlan(plan) },
    lifecycle: {
      state: "previewed",
      startedAt: null,
      finishedAt: null,
      completedCandidates: [],
      untouchedCandidates: candidates.map((candidate) => candidate.path),
      error: null,
    },
  };
  atomicWriteReceipt(inventory.vault.path, receipt);
  return receipt;
}

async function loadRegisteredVault(vaultName: string): Promise<{
  name: string;
  path: string;
  rid: string;
  localWritable: boolean;
  reason: string;
}> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, vaultName);
    if (vault === null) throw new Error(`No vault registered with name '${vaultName}'.`);
    const verdict = await deriveLocalWritable(vault, db);
    return {
      name: vault.name,
      path: vault.path,
      rid: vault.ridHex,
      localWritable: verdict.localWritable,
      reason: verdict.reason,
    };
  } finally {
    await closeRegistry(db);
  }
}

function sameCandidates(
  expected: readonly MutationPreviewCandidate[],
  actual: readonly MutationPreviewCandidate[],
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export async function prepareMutationApply(args: {
  operation: MutationPreviewOperation;
  vault: string;
  subtree?: string;
  push: boolean;
  receiptId: string;
  now?: Date;
}): Promise<MutationApplySession> {
  const registered = await loadRegisteredVault(args.vault);
  let receipt = loadReceipt(registered.path, args.receiptId);
  const refuse = (message: string): never => {
    if (receipt.lifecycle.state === "previewed") {
      receipt = {
        ...receipt,
        lifecycle: {
          ...receipt.lifecycle,
          state: "refused-before-write",
          finishedAt: (args.now ?? new Date()).toISOString(),
          error: message,
        },
      };
      atomicWriteReceipt(registered.path, receipt);
    }
    throw new Error(message);
  };
  if (receipt.lifecycle.state !== "previewed") {
    throw new Error(`preview receipt cannot be reused from state ${receipt.lifecycle.state}`);
  }
  if (Date.parse(receipt.plan.expiresAt) <= (args.now ?? new Date()).getTime()) {
    refuse("preview receipt expired; create a new preview");
  }
  if (
    receipt.plan.operation !== args.operation ||
    receipt.plan.vault.rid !== registered.rid ||
    receipt.plan.vault.name !== registered.name ||
    receipt.plan.scope !== normalizeVaultSubtree(args.subtree) ||
    receipt.plan.push !== args.push
  ) {
    refuse("preview receipt does not match this exact operation, vault, scope, and push intent");
  }
  if (!registered.localWritable) {
    refuse(`vault is not locally writable: ${registered.reason}`);
  }
  const inventory = await inventoryVaultFiles(registered.name, args.subtree);
  const policy = loadLytIgnorePolicy(inventory.vault.path);
  const actualCandidates = candidatesFromInventory(inventory);
  if (
    policy.exists !== receipt.plan.ignorePolicy.exists ||
    policy.sha256 !== receipt.plan.ignorePolicy.sha256 ||
    policy.bytes.toString("base64") !== receipt.plan.ignorePolicy.bytesBase64 ||
    inventory.inventoryDigest !== receipt.plan.inventoryDigest ||
    !sameCandidates(receipt.plan.candidates, actualCandidates)
  ) {
    refuse("vault inventory, .lytignore, or candidate preimages changed; create a new preview");
  }

  receipt = {
    ...receipt,
    lifecycle: {
      ...receipt.lifecycle,
      state: "applying",
      startedAt: (args.now ?? new Date()).toISOString(),
      error: null,
    },
  };
  atomicWriteReceipt(registered.path, receipt);
  const completed: string[] = [];
  let mutationStarted = false;
  const persist = (state: MutationReceiptLifecycle, error: string | null): void => {
    const completedSet = new Set(completed);
    receipt = {
      ...receipt,
      lifecycle: {
        ...receipt.lifecycle,
        state,
        finishedAt: state === "applying" ? null : new Date().toISOString(),
        completedCandidates: [...completed],
        untouchedCandidates: receipt.plan.candidates
          .map((candidate) => candidate.path)
          .filter((path) => !completedSet.has(path)),
        error,
      },
    };
    atomicWriteReceipt(registered.path, receipt);
  };
  const revalidateBeforeMutation = async (): Promise<void> => {
    const live = await inventoryVaultFiles(registered.name, args.subtree);
    const livePolicy = loadLytIgnorePolicy(registered.path);
    const liveCandidates = candidatesFromInventory(live);
    if (
      livePolicy.exists !== receipt.plan.ignorePolicy.exists ||
      livePolicy.sha256 !== receipt.plan.ignorePolicy.sha256 ||
      livePolicy.bytes.toString("base64") !== receipt.plan.ignorePolicy.bytesBase64 ||
      live.inventoryDigest !== receipt.plan.inventoryDigest ||
      !sameCandidates(receipt.plan.candidates, liveCandidates)
    ) {
      throw new Error("vault changed after apply preparation; create a new preview");
    }
  };
  return {
    getReceipt: () => receipt,
    inventory,
    completed,
    revalidateBeforeMutation,
    markCandidateCompleted(path: string): void {
      if (!receipt.plan.candidates.some((candidate) => candidate.path === path)) {
        throw new Error(`mutation wrote an unplanned candidate: ${path}`);
      }
      if (!completed.includes(path)) completed.push(path);
      persist("applying", null);
    },
    markMutationStarted(): void {
      mutationStarted = true;
    },
    complete(): void {
      persist("completed", null);
    },
    fail(error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      persist(completed.length > 0 || mutationStarted ? "partial" : "refused-before-write", message);
    },
  };
}
