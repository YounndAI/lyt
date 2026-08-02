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

import { z } from "zod";

/** The only receipt identity emitted by this implementation. */
export const RECEIPT_V1_SCHEMA_ID = "lyt.receipt";
export const RECEIPT_V1_MAJOR = 1;
export const RECEIPT_V1_MINOR = 0;
export const RECEIPT_V1_TIMESTAMP_MAX_LENGTH = 64;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// SEE ALSO: receipt-repository.ts, commands/receipt.ts,
// flows/federation/pod-transformation-proof.ts — deterministic creation
// identities are UUIDv8; historical persisted identities remain UUIDv7.
const UUID_V7_OR_V8 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const FORBIDDEN_KEY =
  /(?:^|[-_])(?:auth|authorization|token|secret|password|credential|cookie|(?:api|access|private)[-_]?key|session(?:[-_]?id)?|jwt|stderr|stdout|argv|header)(?:$|[-_])/i;
const CREDENTIAL_SHAPED_KEY =
  /(?:^|[-_])(?:github_pat_|gh[oprsu]_+|sk_(?:live|test)_|pk_(?:live|test)_|npm_|akia[0-9a-z]{16})(?=$|[-_a-z0-9])/i;
const PROTOTYPE_POLLUTION_KEY = /^(?:__proto__|constructor|prototype)$/i;
const FORBIDDEN_CONTENT =
  /(?:bearer\s+\S+|(?:auth(?:orization)?|token|secret|password|(?:api|access|private)[-_]?key|cookie|session(?:[-_]?id)?|jwt)\s*[:=]|(?:authorization|set-cookie|proxy-authorization)\s*:|-----begin [a-z ]+-----|gh[oprsu]_[a-z0-9]+|github_pat_[a-z0-9_]+|npm_[a-z0-9]+|akia[0-9a-z]{16}|\b(?:raw\s+)?(?:stderr|stdout)\b|\bstack trace\b|\b(?:eacces|eperm|enoent|enotdir|eexist)\s*:\s*|(?:^|\n)(?:fatal|error|warning):|\bat\s+.+\(.+:\d+:\d+\))/i;
const MAX_TEXT_LENGTH = 512;
const MAX_EVIDENCE_PER_SIDE = 8;
const MAX_RECEIPT_DIAGNOSTIC_DEPTH = 8;
const MAX_RECEIPT_DIAGNOSTIC_COUNT = 1_000_000;

const uuidV7 = z.string().regex(UUID_V7, "must be a UUIDv7");
const uuidV7OrV8 = z.string().regex(UUID_V7_OR_V8, "must be a UUIDv7 or UUIDv8");
const slug = z.string().min(1).max(96).regex(SLUG, "must be a lowercase slug");
const aliasName = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "must be a lowercase alias");

function safeText(value: string, ctx: z.RefinementCtx): void {
  if (FORBIDDEN_CONTENT.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "receipt text may not contain secret or raw diagnostic material",
    });
  }
}

const safeTextSchema = z.string().min(1).max(MAX_TEXT_LENGTH).superRefine(safeText);

export function receiptSafeTextOrFallback(value: string, fallback: string): string {
  if (safeTextSchema.safeParse(value).success) return value;
  if (safeTextSchema.safeParse(fallback).success) return fallback;
  return "Operation did not complete.";
}
const recommendationTarget = z
  .string()
  .min(1)
  .max(MAX_TEXT_LENGTH)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/u, "must not contain control characters");

function strictObject<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, "strict"> {
  return z.object(shape).strict();
}

function consumerObject<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, "strip"> {
  // Consumers deliberately discard fields newer writers add. Producers use the
  // strict counterpart so an emission cannot silently drift from this contract.
  return z.object(shape).strip();
}

function schemaVersionShape(
  object: <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T, "strict" | "strip">,
  major: z.ZodType<number>,
  minor: z.ZodType<number>,
) {
  return {
    schema_id: z.literal(RECEIPT_V1_SCHEMA_ID),
    schema_version: object({
      major,
      minor,
    }),
  };
}

function scopeShape(
  object: <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T, "strict" | "strip">,
) {
  return z.discriminatedUnion("kind", [
    object({ kind: z.literal("pod"), pod_id: uuidV7OrV8 }),
    object({ kind: z.literal("mesh"), mesh_id: uuidV7OrV8 }),
    object({ kind: z.literal("vault"), vault_id: uuidV7OrV8 }),
    object({ kind: z.literal("release"), release_id: uuidV7 }),
    object({ kind: z.literal("system") }),
  ]);
}

function evidenceShape(
  object: <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T, "strict" | "strip">,
) {
  return object({
    kind: slug,
    subject: safeTextSchema,
    digest: z.string().regex(SHA256, "must be a SHA-256 digest").optional(),
    count: z.number().int().nonnegative().max(1_000_000).optional(),
  });
}

function aliasRecommendationShape(
  object: <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T, "strict" | "strip">,
) {
  return object({
    kind: z.literal("vault-alias"),
    action: z.enum(["create", "already-available"]),
    alias: aliasName,
    canonical_target: recommendationTarget,
    vault_rid: uuidV7OrV8,
    reason: z.enum(["bare-leaf-collision", "long-qualified-address"]),
    argv: z.array(recommendationTarget).max(4),
  }).superRefine((recommendation, ctx) => {
    const expected = ["lyt", "alias", recommendation.alias, recommendation.canonical_target];
    if (
      (recommendation.action === "create" &&
        (recommendation.argv.length !== expected.length ||
          recommendation.argv.some((value, index) => value !== expected[index]))) ||
      (recommendation.action === "already-available" && recommendation.argv.length !== 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["argv"],
        message: "must be the exact alias argument vector, or empty when already available",
      });
    }
  });
}

function containsForbiddenKey(value: unknown, path: readonly (string | number)[] = []): boolean {
  if (Array.isArray(value))
    return value.some((nested, index) => containsForbiddenKey(nested, [...path, index]));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const trustedAliasArgv = key === "argv" && path.length === 2 && path[0] === "recommendations";
    return (
      (!trustedAliasArgv && isUnsafeDiagnosticKey(key)) ||
      containsForbiddenKey(nested, [...path, key])
    );
  });
}

function containsForbiddenMaterial(
  value: unknown,
  path: readonly (string | number)[] = [],
): boolean {
  if (typeof value === "string") {
    const trustedAliasValue =
      path.length >= 3 &&
      path[0] === "recommendations" &&
      (path[2] === "canonical_target" || path[2] === "argv");
    return !trustedAliasValue && FORBIDDEN_CONTENT.test(value);
  }
  if (Array.isArray(value))
    return value.some((nested, index) => containsForbiddenMaterial(nested, [...path, index]));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    containsForbiddenMaterial(nested, [...path, key]),
  );
}

export type RedactedReceiptInput = {
  /** Fixed category only; it never contains a foreign constructor or key name. */
  type: "array" | "object" | "primitive";
  /** Root item/property count, bounded so hostile inputs cannot inflate diagnostics. */
  count: number;
  /** Structural nesting depth observed without reading accessors. */
  depth: number;
  /** True when traversal reached a safety boundary or the input could not be inspected. */
  truncated: boolean;
  /** Fixed marker: foreign input names and values are deliberately omitted. */
  redacted: true;
};

function redactReceiptInput(value: unknown): RedactedReceiptInput {
  // Rejected foreign input crosses a hard diagnostic boundary. Its schema is
  // deliberately fixed: never project foreign keys or values, even when a key
  // looks harmless. Descriptors avoid invoking attacker-controlled accessors.
  if (!value || typeof value !== "object") {
    return { type: "primitive", count: 0, depth: 0, truncated: false, redacted: true };
  }

  const isArray = Array.isArray(value);
  const visited = new WeakSet<object>();
  let truncated = false;

  const inspect = (current: object, currentDepth: number): number => {
    if (currentDepth >= MAX_RECEIPT_DIAGNOSTIC_DEPTH || visited.has(current)) {
      truncated = true;
      return currentDepth;
    }
    visited.add(current);

    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      truncated = true;
      return currentDepth;
    }

    let deepest = currentDepth;
    for (const descriptor of Object.values(descriptors)) {
      if (
        descriptor &&
        "value" in descriptor &&
        descriptor.value &&
        typeof descriptor.value === "object"
      ) {
        deepest = Math.max(deepest, inspect(descriptor.value, currentDepth + 1));
      }
    }
    return deepest;
  };

  let count = 0;
  try {
    count = isArray ? (value as unknown[]).length : Reflect.ownKeys(value).length;
  } catch {
    truncated = true;
  }
  if (count > MAX_RECEIPT_DIAGNOSTIC_COUNT) {
    count = MAX_RECEIPT_DIAGNOSTIC_COUNT;
    truncated = true;
  }

  return {
    type: isArray ? "array" : "object",
    count,
    depth: inspect(value, 0),
    truncated,
    redacted: true,
  };
}

function isUnsafeDiagnosticKey(key: string): boolean {
  return (
    FORBIDDEN_KEY.test(key) || CREDENTIAL_SHAPED_KEY.test(key) || PROTOTYPE_POLLUTION_KEY.test(key)
  );
}

function receiptShape(
  object: <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T, "strict" | "strip">,
  major: z.ZodType<number>,
  minor: z.ZodType<number>,
) {
  const Evidence = evidenceShape(object);
  const AliasRecommendation = aliasRecommendationShape(object);
  return object({
    ...schemaVersionShape(object, major, minor),
    operation_id: uuidV7OrV8,
    attempt_id: uuidV7,
    operation: slug,
    scope: scopeShape(object),
    timestamps: object({
      started_at: z.string().max(RECEIPT_V1_TIMESTAMP_MAX_LENGTH).datetime({ offset: true }),
      finished_at: z.string().max(RECEIPT_V1_TIMESTAMP_MAX_LENGTH).datetime({ offset: true }),
    }),
    replay: object({
      disposition: z.enum(["new", "replayed", "resumed", "rejected"]),
      key_digest: z.string().regex(SHA256, "must be a SHA-256 digest"),
    }),
    status: z.enum(["success", "no-op", "replayed", "refused", "partial", "failed"]),
    exit_code: z.number().int().min(0).max(255),
    mutations: object({
      local: z.number().int().nonnegative(),
      remote: z.number().int().nonnegative(),
    }),
    evidence: object({
      before: z.array(Evidence).max(MAX_EVIDENCE_PER_SIDE),
      after: z.array(Evidence).max(MAX_EVIDENCE_PER_SIDE),
    }),
    recommendations: z.array(AliasRecommendation).max(4).optional(),
    next_action: object({
      code: slug,
      summary: safeTextSchema,
    }).nullable(),
    error: object({
      code: slug,
      summary: safeTextSchema,
      retryable: z.boolean(),
    }).nullable(),
  }).superRefine((receipt, ctx) => {
    const totalMutations = receipt.mutations.local + receipt.mutations.remote;
    const successLike =
      receipt.status === "success" || receipt.status === "no-op" || receipt.status === "replayed";

    if (Date.parse(receipt.timestamps.finished_at) < Date.parse(receipt.timestamps.started_at)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timestamps", "finished_at"],
        message: "must not precede started_at",
      });
    }
    if (receipt.operation_id === receipt.attempt_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attempt_id"],
        message: "must be distinct from operation_id",
      });
    }
    if (
      successLike &&
      (receipt.exit_code !== 0 || receipt.error !== null || receipt.next_action !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "success, no-op, and replayed receipts require exit 0 with no error or next action",
      });
    }
    const cleanTerminal =
      receipt.error === null && receipt.next_action === null && receipt.exit_code === 0;
    const newOrResumed =
      receipt.replay.disposition === "new" || receipt.replay.disposition === "resumed";

    if (receipt.status === "success" && (!newOrResumed || totalMutations === 0 || !cleanTerminal)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "success requires a new or resumed attempt, at least one mutation, and exit 0 with no error or next action",
      });
    }
    if (receipt.status === "no-op" && (!newOrResumed || totalMutations !== 0 || !cleanTerminal)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "no-op requires a new or resumed attempt, zero mutations, and exit 0 with no error or next action",
      });
    }
    if (
      receipt.status === "replayed" &&
      (receipt.replay.disposition !== "replayed" || totalMutations !== 0 || !cleanTerminal)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "replayed requires replay disposition, zero mutations, and exit 0 with no error or next action",
      });
    }
    if (
      receipt.status === "refused" &&
      (receipt.replay.disposition !== "rejected" ||
        totalMutations !== 0 ||
        receipt.error === null ||
        receipt.next_action === null ||
        receipt.exit_code === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "refused requires rejected disposition, zero mutations, a structured error, a next action, and a non-zero exit code",
      });
    }
    if (
      receipt.status === "failed" &&
      (!newOrResumed || totalMutations !== 0 || receipt.error === null || receipt.exit_code === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "failed requires a new or resumed attempt, zero mutations, a structured error, and a non-zero exit code",
      });
    }
    if (
      receipt.status === "partial" &&
      (!newOrResumed ||
        totalMutations === 0 ||
        receipt.error === null ||
        receipt.next_action === null ||
        receipt.exit_code === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "partial requires a new or resumed attempt, mutations, a structured error, a next action, and a non-zero exit code",
      });
    }
    if (containsForbiddenKey(receipt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "receipt may not contain secret or raw diagnostic keys",
      });
    }
  });
}

/** Exact producer contract: no unknown fields and exactly Receipt V1.0. */
export const ReceiptV1ProducerSchema = receiptShape(
  strictObject,
  z.literal(RECEIPT_V1_MAJOR),
  z.literal(RECEIPT_V1_MINOR),
);
/** Consumer contract: accepts any additive V1 minor and strips unknown fields. */
export const ReceiptV1ConsumerSchema = receiptShape(
  consumerObject,
  z.literal(RECEIPT_V1_MAJOR),
  z.number().int().nonnegative(),
);

export type ReceiptV1 = z.infer<typeof ReceiptV1ProducerSchema>;

export type UnsupportedReceiptSchema = {
  status: "unsupported-receipt-schema";
  success: false;
  raw: RedactedReceiptInput;
};

export type InvalidReceipt = {
  status: "invalid-receipt";
  success: false;
  raw: RedactedReceiptInput;
  issues: ReceiptValidationIssue[];
};

/** Redacted, deterministic metadata for a rejected foreign receipt. */
export type ReceiptValidationIssue = {
  code: "invalid-receipt-field";
  path: ReadonlyArray<string | number>;
  message: "receipt field is invalid";
};

export type ReceiptV1Consumption =
  | { status: "accepted"; success: boolean; receipt: z.infer<typeof ReceiptV1ConsumerSchema> }
  | UnsupportedReceiptSchema
  | InvalidReceipt;

function redactValidationIssues(issues: readonly z.ZodIssue[]): ReceiptValidationIssue[] {
  // Zod enum issues retain the received value. Foreign receipt data is attacker
  // controlled, so consumer errors expose only deterministic field metadata.
  return issues.map((issue) => ({
    code: "invalid-receipt-field",
    path: issue.path,
    message: "receipt field is invalid",
  }));
}

/** Validate the exact, sealed Receipt V1 shape before putting it on stdout. */
export function parseReceiptV1ForEmission(value: unknown): ReceiptV1 {
  return ReceiptV1ProducerSchema.parse(value);
}

/**
 * Read a receipt from another process or a durable journal without turning an
 * unknown schema into a success. Same-major additions are intentionally ignored.
 */
export function consumeReceiptV1(value: unknown): ReceiptV1Consumption {
  const schemaId =
    value && typeof value === "object" ? (value as Record<string, unknown>).schema_id : undefined;
  const version =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).schema_version
      : undefined;
  const major =
    version && typeof version === "object" ? (version as Record<string, unknown>).major : undefined;

  if (schemaId !== RECEIPT_V1_SCHEMA_ID || major !== RECEIPT_V1_MAJOR) {
    return { status: "unsupported-receipt-schema", success: false, raw: redactReceiptInput(value) };
  }

  if (containsForbiddenKey(value) || containsForbiddenMaterial(value)) {
    return {
      status: "invalid-receipt",
      success: false,
      raw: redactReceiptInput(value),
      issues: [{ code: "invalid-receipt-field", message: "receipt field is invalid", path: [] }],
    };
  }

  const parsed = ReceiptV1ConsumerSchema.safeParse(value);
  if (!parsed.success) {
    return {
      status: "invalid-receipt",
      success: false,
      raw: redactReceiptInput(value),
      issues: redactValidationIssues(parsed.error.issues),
    };
  }
  return {
    status: "accepted",
    success:
      parsed.data.status === "success" ||
      parsed.data.status === "no-op" ||
      parsed.data.status === "replayed",
    receipt: parsed.data,
  };
}
