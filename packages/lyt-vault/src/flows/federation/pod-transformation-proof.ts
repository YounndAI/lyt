/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { z } from "zod";

import { derivePlannedCreationRid } from "../creation-plan.js";
import { runGitReadOnly } from "../../util/git-run.js";
import { hexToUuid7Bytes, uuid7BytesToDashedString } from "../../util/uuid7.js";

export const POD_TRANSFORMATION_PROOF_SCHEMA_ID = "lyt.pod-transformation-proof" as const;
export const POD_TRANSFORMATION_PROOF_SCHEMA_VERSION = 1 as const;
export const POD_GENERATED_LEDGER_NAMESPACES = [
  "aliases",
  "destination-policy",
  "mesh-edges",
  "machines",
  "meshes",
  "subscriptions",
  "vaults",
] as const;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GENERATOR_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const GENERATOR_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$/;
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9._-]+$/;
export const MAX_POD_TRANSFORMATION_PATHS = 256;
export const MAX_POD_TRANSFORMATION_PATH_LENGTH = 512;
export const MAX_POD_TRANSFORMATION_CONTENT_BYTES = 256 * 1024 * 1024;
const MAX_GENERATOR_TEXT = 96;

const digestSchema = z.string().regex(SHA256, "must be a lowercase SHA-256 digest");
const commitSchema = z.string().regex(GIT_COMMIT, "must be a lowercase 40- or 64-hex commit");
const uuidV7Schema = z.string().regex(UUID_V7, "must be a canonical lowercase UUIDv7");
const generatedPathSchema = z
  .string()
  .min(1)
  .max(MAX_POD_TRANSFORMATION_PATH_LENGTH)
  .superRefine((path, context) => {
    if (!isPodGeneratedArtifactPath(path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must name an allowlisted pod-generated artifact",
      });
    }
  });

const proofSchema = z
  .object({
    schema_id: z.literal(POD_TRANSFORMATION_PROOF_SCHEMA_ID),
    schema_version: z.literal(POD_TRANSFORMATION_PROOF_SCHEMA_VERSION),
    generator_id: z.string().min(1).max(MAX_GENERATOR_TEXT).regex(GENERATOR_ID),
    generator_version: z.string().min(1).max(MAX_GENERATOR_TEXT).regex(GENERATOR_VERSION),
    pod_rid: uuidV7Schema,
    operation_id: uuidV7Schema,
    replay_key_digest: digestSchema,
    before_commit: commitSchema,
    after_commit: commitSchema,
    affected_paths: z.array(generatedPathSchema).min(1).max(MAX_POD_TRANSFORMATION_PATHS),
    tree_digest: digestSchema,
    content_digest: digestSchema,
  })
  .strict()
  .superRefine((proof, context) => {
    if (new Set(proof.affected_paths).size !== proof.affected_paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["affected_paths"],
        message: "must contain unique paths",
      });
    }
  })
  .transform((proof) => ({ ...proof, affected_paths: [...proof.affected_paths].sort() }));

export type PodTransformationProofV1 = z.output<typeof proofSchema>;

const corroborationBinding = {
  record_id: uuidV7Schema,
  record_digest: digestSchema,
  pod_rid: uuidV7Schema,
  operation_id: uuidV7Schema,
  replay_key_digest: digestSchema,
  proof_digest: digestSchema,
} as const;

const subjectCorroborationSchema = z
  .object({
    record_kind: z.literal("pod-transformation-subject-v1"),
    ...corroborationBinding,
  })
  .strict();

const ledgerCorroborationSchema = z
  .object({
    record_kind: z.literal("pod-ledger-receipt-v1"),
    ...corroborationBinding,
  })
  .strict();

export type PodTransformationSubjectCorroborationV1 = z.infer<typeof subjectCorroborationSchema>;
export type PodTransformationLedgerCorroborationV1 = z.infer<typeof ledgerCorroborationSchema>;

export interface DerivePodTransformationProofArgs {
  repository_root: string;
  pod_rid: string;
  operation_id: string;
  replay_key_digest: string;
  generator_id: string;
  generator_version: string;
  before_commit: string;
  after_commit: string;
  /** Optional caller claim; when supplied it must equal Git's exact changed set. */
  affected_paths: readonly string[];
}

export interface PodTransformationRecordIds {
  ledger_record_id: string;
  subject_record_id: string;
}

export interface ReceiptBoundPodProvenanceInput {
  proof: unknown;
  expected_proof_digest: unknown;
  subject_evidence: unknown;
  ledger_evidence: unknown;
}

const byteTransitionSchema = z
  .object({
    path: generatedPathSchema,
    before_digest: digestSchema.nullable(),
    after_digest: digestSchema.nullable(),
  })
  .strict()
  .superRefine((transition, context) => {
    if (transition.before_digest === null && transition.after_digest === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must bind at least one byte digest",
      });
    }
  });

export type PodGeneratedByteTransitionV1 = z.infer<typeof byteTransitionSchema>;

export interface DeterministicLegacyPodProvenanceInput {
  generator_version: unknown;
  known_generator_versions: unknown;
  expected: unknown;
  observed: unknown;
  has_contradictions: unknown;
}

export type PodTransformationProvenance =
  "receipt-proven" | "deterministic-legacy-proven" | "ambiguous";

/** Parse, bound, and normalize a proof without retaining arbitrary evidence. */
export function parsePodTransformationProofV1(input: unknown): PodTransformationProofV1 {
  return proofSchema.parse(input);
}

/** Canonical JSON: fixed schema plus recursively sorted object keys and sorted paths. */
export function serializePodTransformationProofV1(input: unknown): string {
  return stableJson(parsePodTransformationProofV1(input));
}

export function digestPodTransformationProofV1(input: unknown): string {
  return createHash("sha256")
    .update(serializePodTransformationProofV1(input), "utf8")
    .digest("hex");
}

/** Stable, distinct UUIDv7 identities owned by the logical operation. */
export function derivePodTransformationRecordIds(operationId: string): PodTransformationRecordIds {
  return {
    ledger_record_id: dashedPlannedRid(operationId, "pod-transformation:ledger"),
    subject_record_id: dashedPlannedRid(operationId, "pod-transformation:subject"),
  };
}

/** Canonical digest for one strict evidence record; stored digests are never trusted. */
export function digestPodTransformationEvidenceRecordV1(input: unknown): string {
  const common = {
    record_id: uuidV7Schema,
    pod_rid: uuidV7Schema,
    operation_id: uuidV7Schema,
    replay_key_digest: digestSchema,
    proof_digest: digestSchema,
  } as const;
  const parsed = z
    .union([
      z.object({ ...common, record_kind: z.literal("pod-transformation-subject-v1") }).strict(),
      z
        .object({
          ...common,
          record_kind: z.literal("pod-ledger-receipt-v1"),
          proof: proofSchema,
        })
        .strict(),
    ])
    .parse(input);
  return createHash("sha256").update(stableJson(parsed), "utf8").digest("hex");
}

interface TreeEntry {
  path: string;
  mode: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

/** Derive exact tree/content evidence from one settled Git commit. */
export async function derivePodTransformationProofV1(
  args: DerivePodTransformationProofArgs,
): Promise<PodTransformationProofV1> {
  const claimed = [...args.affected_paths].sort();
  const normalizedIdentity = parsePodTransformationProofV1({
    schema_id: POD_TRANSFORMATION_PROOF_SCHEMA_ID,
    schema_version: POD_TRANSFORMATION_PROOF_SCHEMA_VERSION,
    generator_id: args.generator_id,
    generator_version: args.generator_version,
    pod_rid: args.pod_rid,
    operation_id: args.operation_id,
    replay_key_digest: args.replay_key_digest,
    before_commit: args.before_commit,
    after_commit: args.after_commit,
    affected_paths: claimed,
    tree_digest: "0".repeat(64),
    content_digest: "0".repeat(64),
  });
  const before = await runGitReadOnly(
    ["rev-parse", "--verify", `${normalizedIdentity.before_commit}^{commit}`],
    {
      cwd: args.repository_root,
      timeoutMs: 120_000,
      maxOutputBytes: 256,
    },
  );
  if (before.stdout.trim() !== normalizedIdentity.before_commit) {
    throw new Error("Pod transformation before commit did not resolve exactly.");
  }
  const commit = await runGitReadOnly(
    ["rev-parse", "--verify", `${normalizedIdentity.after_commit}^{commit}`],
    {
      cwd: args.repository_root,
      timeoutMs: 120_000,
      maxOutputBytes: 256,
    },
  );
  if (commit.stdout.trim() !== normalizedIdentity.after_commit) {
    throw new Error("Pod transformation after commit did not resolve exactly.");
  }
  const parents = await runGitReadOnly(
    ["rev-list", "--parents", "-n", "1", normalizedIdentity.after_commit],
    { cwd: args.repository_root, timeoutMs: 120_000, maxOutputBytes: 512 },
  );
  const lineage = parents.stdout.trim().split(/\s+/u);
  if (
    normalizedIdentity.before_commit === normalizedIdentity.after_commit ||
    lineage.length !== 2 ||
    lineage[0] !== normalizedIdentity.after_commit ||
    lineage[1] !== normalizedIdentity.before_commit
  ) {
    throw new Error("Pod transformation must be one exact direct-parent commit.");
  }
  const changed = await runGitReadOnly(
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      normalizedIdentity.before_commit,
      normalizedIdentity.after_commit,
      "--",
    ],
    { cwd: args.repository_root, timeoutMs: 120_000, maxOutputBytes: 256 * 1024 },
  );
  if (changed.stdoutTruncated === true)
    throw new Error("Pod transformation diff exceeded its bound.");
  const affectedPaths = changed.stdout.split("\0").filter(Boolean).sort();
  if (affectedPaths.length === 0 || affectedPaths.length > MAX_POD_TRANSFORMATION_PATHS) {
    throw new Error("Pod transformation changed-path count is outside the proof bound.");
  }
  if (
    affectedPaths.some(
      (path) =>
        path.length > MAX_POD_TRANSFORMATION_PATH_LENGTH || !isPodGeneratedArtifactPath(path),
    )
  ) {
    throw new Error("Pod transformation changed a path outside the generated-artifact authority.");
  }
  if (
    claimed.length !== affectedPaths.length ||
    claimed.some((path, index) => path !== affectedPaths[index])
  ) {
    throw new Error("Claimed affected paths do not equal Git's exact changed set.");
  }
  const [beforeListing, afterListing] = await Promise.all([
    runGitReadOnly(["ls-tree", "-rz", "--full-tree", normalizedIdentity.before_commit], {
      cwd: args.repository_root,
      timeoutMs: 120_000,
      maxOutputBytes: 4 * 1024 * 1024,
    }),
    runGitReadOnly(["ls-tree", "-rz", "--full-tree", normalizedIdentity.after_commit], {
      cwd: args.repository_root,
      timeoutMs: 120_000,
      maxOutputBytes: 4 * 1024 * 1024,
    }),
  ]);
  if (beforeListing.stdoutTruncated === true || afterListing.stdoutTruncated === true) {
    throw new Error("Pod transformation tree listing exceeded its bound.");
  }
  const beforeEntries = parseTreeEntries(beforeListing.stdout);
  const afterEntries = parseTreeEntries(afterListing.stdout);
  const treeRows: string[] = [];
  const contentRows: string[] = [];
  let contentBytes = 0;
  for (const path of affectedPaths) {
    const beforeEntry = beforeEntries.get(path) ?? null;
    const afterEntry = afterEntries.get(path) ?? null;
    if (beforeEntry === null && afterEntry === null) {
      throw new Error(`Changed path is absent from both transformation trees: ${path}`);
    }
    for (const entry of [beforeEntry, afterEntry]) {
      if (entry !== null && (entry.type !== "blob" || entry.mode === "160000")) {
        throw new Error(`Pod-generated path must resolve to a blob or tombstone: ${path}`);
      }
    }
    if (
      beforeEntry !== null &&
      afterEntry !== null &&
      beforeEntry.mode === afterEntry.mode &&
      beforeEntry.oid === afterEntry.oid
    ) {
      throw new Error(`Git diff reported an unchanged generated path: ${path}`);
    }
    const beforeBytes =
      beforeEntry === null ? null : readBlobBytes(args.repository_root, beforeEntry.oid);
    const afterBytes =
      afterEntry === null ? null : readBlobBytes(args.repository_root, afterEntry.oid);
    contentBytes += (beforeBytes?.length ?? 0) + (afterBytes?.length ?? 0);
    if (contentBytes > MAX_POD_TRANSFORMATION_CONTENT_BYTES) {
      throw new Error("Pod transformation content evidence exceeded its byte bound.");
    }
    treeRows.push(
      `${path}\0before\0${beforeEntry?.mode ?? "tombstone"}\0${beforeEntry?.oid ?? "tombstone"}` +
        `\0after\0${afterEntry?.mode ?? "tombstone"}\0${afterEntry?.oid ?? "tombstone"}`,
    );
    contentRows.push(
      `${path}\0before\0${contentEvidence(beforeBytes)}\0after\0${contentEvidence(afterBytes)}`,
    );
  }
  return parsePodTransformationProofV1({
    ...normalizedIdentity,
    affected_paths: affectedPaths,
    tree_digest: createHash("sha256").update(treeRows.join("\n"), "utf8").digest("hex"),
    content_digest: createHash("sha256").update(contentRows.join("\n"), "utf8").digest("hex"),
  });
}

function contentEvidence(bytes: Buffer | null): string {
  return bytes === null
    ? "tombstone"
    : `${bytes.length}\0${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Receipt evidence authorizes only when both independent records bind the exact proof. */
export function classifyReceiptBoundPodProvenance(
  input: ReceiptBoundPodProvenanceInput,
): PodTransformationProvenance {
  const parsedProof = proofSchema.safeParse(input.proof);
  const expectedDigest = digestSchema.safeParse(input.expected_proof_digest);
  const subject = subjectCorroborationSchema.safeParse(input.subject_evidence);
  const ledger = ledgerCorroborationSchema.safeParse(input.ledger_evidence);
  if (!parsedProof.success || !expectedDigest.success || !subject.success || !ledger.success) {
    return "ambiguous";
  }

  const proof = parsedProof.data;
  const proofDigest = digestPodTransformationProofV1(proof);
  if (proofDigest !== expectedDigest.data) return "ambiguous";
  if (subject.data.record_id === ledger.data.record_id) return "ambiguous";
  if (!corroborates(proof, proofDigest, subject.data)) return "ambiguous";
  if (!corroborates(proof, proofDigest, ledger.data)) return "ambiguous";
  return "receipt-proven";
}

/** Exact legacy replay proof: same owned paths, same before/after bytes, known generator. */
export function classifyDeterministicLegacyPodProvenance(
  input: DeterministicLegacyPodProvenanceInput,
): PodTransformationProvenance {
  if (input.has_contradictions !== false) return "ambiguous";
  const generatorVersion = z
    .string()
    .min(1)
    .max(MAX_GENERATOR_TEXT)
    .regex(GENERATOR_VERSION)
    .safeParse(input.generator_version);
  if (!generatorVersion.success) return "ambiguous";
  const knownVersions = z
    .array(z.string().min(1).max(MAX_GENERATOR_TEXT).regex(GENERATOR_VERSION))
    .min(1)
    .max(32)
    .safeParse(input.known_generator_versions);
  if (!knownVersions.success || new Set(knownVersions.data).size !== knownVersions.data.length) {
    return "ambiguous";
  }
  if (!knownVersions.data.includes(generatorVersion.data)) {
    return "ambiguous";
  }

  const expected = parseTransitions(input.expected);
  const observed = parseTransitions(input.observed);
  if (expected === null || observed === null || expected.size !== observed.size) return "ambiguous";
  for (const [path, expectedTransition] of expected) {
    const observedTransition = observed.get(path);
    if (
      observedTransition === undefined ||
      observedTransition.before_digest !== expectedTransition.before_digest ||
      observedTransition.after_digest !== expectedTransition.after_digest
    ) {
      return "ambiguous";
    }
  }
  return "deterministic-legacy-proven";
}

/** The complete product-neutral path authority for pod-generated repository artifacts. */
export function isPodGeneratedArtifactPath(path: string): boolean {
  if (path === ".gitignore" || path === "identity.yon" || path === "pod.yon") return true;
  if (path.includes("\\") || path.startsWith("/") || path.endsWith("/")) return false;
  const segments = path.split("/");
  if (segments.length < 3 || segments[0] !== "ledger") return false;
  if (!(POD_GENERATED_LEDGER_NAMESPACES as readonly string[]).includes(segments[1]!)) return false;
  return segments
    .slice(2)
    .every((segment) => segment !== "." && segment !== ".." && SAFE_PATH_SEGMENT.test(segment));
}

function corroborates(
  proof: PodTransformationProofV1,
  proofDigest: string,
  evidence: PodTransformationSubjectCorroborationV1 | PodTransformationLedgerCorroborationV1,
): boolean {
  return (
    evidence.pod_rid === proof.pod_rid &&
    evidence.operation_id === proof.operation_id &&
    evidence.replay_key_digest === proof.replay_key_digest &&
    evidence.proof_digest === proofDigest
  );
}

function parseTransitions(values: unknown): Map<string, PodGeneratedByteTransitionV1> | null {
  if (!Array.isArray(values)) return null;
  if (values.length === 0 || values.length > MAX_POD_TRANSFORMATION_PATHS) return null;
  const result = new Map<string, PodGeneratedByteTransitionV1>();
  for (const value of values) {
    const parsed = byteTransitionSchema.safeParse(value);
    if (!parsed.success || result.has(parsed.data.path)) return null;
    result.set(parsed.data.path, parsed.data);
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseTreeEntries(raw: string): Map<string, TreeEntry> {
  const result = new Map<string, TreeEntry>();
  for (const record of raw.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(record);
    if (match === null) throw new Error("Git returned a malformed tree entry.");
    const entry = {
      mode: match[1]!,
      type: match[2]! as TreeEntry["type"],
      oid: match[3]!,
      path: match[4]!,
    };
    if (result.has(entry.path)) throw new Error("Git returned a duplicate tree path.");
    result.set(entry.path, entry);
  }
  return result;
}

function readBlobBytes(repositoryRoot: string, oid: string): Buffer {
  return execFileSync("git", ["cat-file", "blob", oid], {
    cwd: repositoryRoot,
    encoding: "buffer",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_POD_TRANSFORMATION_CONTENT_BYTES + 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
}

function dashedPlannedRid(operationId: string, label: string): string {
  return uuid7BytesToDashedString(hexToUuid7Bytes(derivePlannedCreationRid(operationId, label)));
}
