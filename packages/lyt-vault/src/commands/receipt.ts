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

import { openOpLogReadOnly } from "../op/operation-log.js";
import {
  OpLogReceiptSchemaRequiredError,
  OpLogUpgradeRequiredError,
} from "../op/operation-log-migrations.js";
import {
  listReceiptAttemptSummaries,
  queryReceiptAttempts,
  type ReceiptAttemptSummary,
} from "../op/receipt-repository.js";
import type { ReceiptV1 } from "../op/receipt-v1.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// SEE ALSO: op/receipt-v1.ts, op/receipt-repository.ts — operation ids accept
// historical UUIDv7 and deterministic UUIDv8; attempt ids stay UUIDv7.
const UUID_V7_OR_V8 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RECEIPT_STATUSES = new Set<ReceiptV1["status"]>([
  "success",
  "no-op",
  "replayed",
  "refused",
  "partial",
  "failed",
]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type ReceiptInspectionResult =
  | {
      schema_id: "lyt.receipt-inspection";
      schema_version: { major: 1; minor: 0 };
      status: "found";
      operation_id: string;
      attempt_id?: string;
      receipts: ReceiptV1[];
    }
  | {
      schema_id: "lyt.receipt-inspection";
      schema_version: { major: 1; minor: 0 };
      status: "not-found" | "invalid-request" | "unavailable";
      operation_id?: string;
      attempt_id?: string;
      error: { code: string; summary: string };
      next_action: { code: string; summary: string };
    };

type ReceiptListResult = {
  schema_id: "lyt.receipt-inspection";
  schema_version: { major: 1; minor: 0 };
  status: "found" | "invalid-request" | "unavailable";
  limit: number;
  receipts: ReceiptAttemptSummary[];
  error?: { code: string; summary: string };
  next_action?: { code: string; summary: string };
};

type ReceiptShowOpts = { attempt?: string; json?: boolean };
type ReceiptListOpts = { operation?: string; status?: string; limit?: string; json?: boolean };

function inspectionError(
  code: string,
  summary: string,
  next: string,
  ids: { operationId?: string; attemptId?: string } = {},
): Extract<ReceiptInspectionResult, { status: "not-found" | "invalid-request" | "unavailable" }> {
  return {
    schema_id: "lyt.receipt-inspection",
    schema_version: { major: 1, minor: 0 },
    status: code.startsWith("receipt-store-")
      ? "unavailable"
      : code === "receipt-not-found" || code === "receipt-attempt-not-found"
        ? "not-found"
        : "invalid-request",
    ...(ids.operationId === undefined ? {} : { operation_id: ids.operationId }),
    ...(ids.attemptId === undefined ? {} : { attempt_id: ids.attemptId }),
    error: { code, summary },
    next_action: { code: "correct-receipt-query", summary: next },
  };
}

function isUuid7(value: string): boolean {
  return UUID_V7.test(value);
}

function isUuid7OrV8(value: string): boolean {
  return UUID_V7_OR_V8.test(value);
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_LIMIT ? parsed : null;
}

function emit(value: ReceiptInspectionResult | ReceiptListResult, json: boolean | undefined): void {
  if (json === true) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(value));
    return;
  }
  if (value.status !== "found") {
    // eslint-disable-next-line no-console
    console.log(
      `${value.error?.code ?? "receipt-query-failed"}: ${value.error?.summary ?? "Receipt inspection failed."}`,
    );
    return;
  }
  if ("receipts" in value && value.receipts.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No terminal receipts found.");
    return;
  }
  for (const receipt of value.receipts) {
    if ("schema_id" in receipt) {
      const mutations = receipt.mutations;
      // eslint-disable-next-line no-console
      console.log(
        `${receipt.status} ${receipt.operation} operation=${receipt.operation_id} ` +
          `attempt=${receipt.attempt_id} finished=${receipt.timestamps.finished_at} ` +
          `mutations=local:${mutations.local},remote:${mutations.remote}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `${receipt.status} ${receipt.operation} operation=${receipt.operationId} ` +
          `attempt=${receipt.attemptId} finished=${receipt.finishedAt ?? "pending"}`,
      );
    }
  }
}

function storeUnavailable(error: unknown): { code: string; summary: string } {
  if (error instanceof OpLogUpgradeRequiredError) {
    return {
      code: "receipt-store-upgrade-required",
      summary: "The receipt store was created by a newer Lyt version.",
    };
  }
  if (error instanceof OpLogReceiptSchemaRequiredError) {
    return {
      code: "receipt-store-migration-required",
      summary: "The receipt store does not yet contain the Receipt V1 schema.",
    };
  }
  return { code: "receipt-store-unavailable", summary: "The receipt store could not be read." };
}

export function buildReceiptCommand(): Command {
  const command = new Command("receipt").description(
    "Inspect bounded, machine-local terminal operation receipts.",
  );
  command
    .command("show")
    .description("Show terminal receipts for one operation, optionally one attempt.")
    .argument("<operation-id>", "Operation UUIDv7 or UUIDv8")
    .option("--attempt <attempt-id>", "Restrict to one attempt UUIDv7")
    .option("--json", "Emit Receipt V1 evidence as JSON")
    .action(async (operationId: string, opts: ReceiptShowOpts) => {
      if (!isUuid7OrV8(operationId)) {
        emit(
          inspectionError(
            "invalid-operation-id",
            "The operation identifier must be a UUIDv7 or UUIDv8.",
            "Provide an operation UUIDv7 or UUIDv8 from a prior Receipt V1.",
          ),
          opts.json,
        );
        return;
      }
      if (opts.attempt !== undefined && !isUuid7(opts.attempt)) {
        emit(
          inspectionError(
            "invalid-attempt-id",
            "The attempt identifier must be a UUIDv7.",
            "Provide an attempt UUIDv7 from a prior Receipt V1.",
            { operationId, attemptId: opts.attempt },
          ),
          opts.json,
        );
        return;
      }
      let opened;
      try {
        opened = await openOpLogReadOnly();
        if (opened.kind === "missing") {
          emit(
            inspectionError(
              "receipt-store-missing",
              "No receipt store exists on this machine.",
              "Run a receipt-producing Lyt operation, then retry.",
              { operationId },
            ),
            opts.json,
          );
          return;
        }
        const result = await queryReceiptAttempts(opened.client, {
          operationId,
          ...(opts.attempt === undefined ? {} : { attemptId: opts.attempt }),
          limit: 1,
        });
        if (!result.operationKnown) {
          emit(
            inspectionError(
              "receipt-not-found",
              "No operation receipt exists for this operation identifier.",
              "Check the operation identifier and retry.",
              { operationId },
            ),
            opts.json,
          );
          return;
        }
        if (result.attempts.length === 0) {
          emit(
            inspectionError(
              "receipt-attempt-not-found",
              "No terminal receipt exists for the requested operation attempt.",
              "Check the attempt identifier or list this operation's terminal attempts.",
              { operationId, ...(opts.attempt === undefined ? {} : { attemptId: opts.attempt }) },
            ),
            opts.json,
          );
          return;
        }
        emit(
          {
            schema_id: "lyt.receipt-inspection",
            schema_version: { major: 1, minor: 0 },
            status: "found",
            operation_id: operationId,
            ...(opts.attempt === undefined ? {} : { attempt_id: opts.attempt }),
            receipts: result.attempts,
          },
          opts.json,
        );
      } catch (error) {
        const unavailable = storeUnavailable(error);
        emit(
          inspectionError(
            unavailable.code,
            unavailable.summary,
            "Run a compatible mutating Lyt command to initialize or migrate the receipt store.",
            { operationId, ...(opts.attempt === undefined ? {} : { attemptId: opts.attempt }) },
          ),
          opts.json,
        );
      } finally {
        if (opened?.kind === "open") opened.close();
      }
    });
  command
    .command("list")
    .description("List up to 100 terminal receipt summaries (default 20).")
    .option("--operation <slug>", "Filter by operation slug")
    .option("--status <status>", "Filter by terminal receipt status")
    .option("--limit <n>", "Maximum receipts to return (1-100; default 20)")
    .option("--json", "Emit a JSON receipt summary")
    .action(async (opts: ReceiptListOpts) => {
      const limit = parseLimit(opts.limit);
      if (
        limit === null ||
        (opts.operation !== undefined && !OPERATION_SLUG.test(opts.operation)) ||
        (opts.status !== undefined && !RECEIPT_STATUSES.has(opts.status as ReceiptV1["status"]))
      ) {
        emit(
          {
            schema_id: "lyt.receipt-inspection",
            schema_version: { major: 1, minor: 0 },
            status: "invalid-request",
            limit: DEFAULT_LIMIT,
            receipts: [],
            error: {
              code: "invalid-receipt-filter",
              summary: "Receipt list filters or limit are invalid.",
            },
            next_action: {
              code: "correct-receipt-query",
              summary:
                "Use an operation slug, a supported terminal status, and a limit from 1 to 100.",
            },
          },
          opts.json,
        );
        return;
      }
      let opened;
      try {
        opened = await openOpLogReadOnly();
        if (opened.kind === "missing") {
          emit(
            {
              schema_id: "lyt.receipt-inspection",
              schema_version: { major: 1, minor: 0 },
              status: "unavailable",
              limit,
              receipts: [],
              error: {
                code: "receipt-store-missing",
                summary: "No receipt store exists on this machine.",
              },
              next_action: {
                code: "initialize-receipt-store",
                summary: "Run a receipt-producing Lyt operation, then retry.",
              },
            },
            opts.json,
          );
          return;
        }
        const receipts = await listReceiptAttemptSummaries(opened.client, {
          ...(opts.operation === undefined ? {} : { operation: opts.operation }),
          ...(opts.status === undefined ? {} : { status: opts.status as ReceiptV1["status"] }),
          limit,
        });
        emit(
          {
            schema_id: "lyt.receipt-inspection",
            schema_version: { major: 1, minor: 0 },
            status: "found",
            limit,
            receipts,
          },
          opts.json,
        );
      } catch (error) {
        const unavailable = storeUnavailable(error);
        emit(
          {
            schema_id: "lyt.receipt-inspection",
            schema_version: { major: 1, minor: 0 },
            status: "unavailable",
            limit,
            receipts: [],
            error: unavailable,
            next_action: {
              code: "initialize-receipt-store",
              summary:
                "Run a compatible mutating Lyt command to initialize or migrate the receipt store.",
            },
          },
          opts.json,
        );
      } finally {
        if (opened?.kind === "open") opened.close();
      }
    });
  return command;
}
