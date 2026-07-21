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

import type { Client } from "@libsql/client";

import { closeOpLog, openOpLog } from "./operation-log.js";
import {
  beginReceiptAttempt,
  beginReceiptAttemptForReplayPlan,
  finalizeReceiptAttempt,
  readReceiptAttemptState,
  resumePendingReceiptAttempt,
  supersedePendingReceiptAttempt,
  type ReceiptAttemptState,
} from "./receipt-repository.js";
import { parseReceiptV1ForEmission, type ReceiptV1 } from "./receipt-v1.js";

export type ReceiptAttemptWarningCode =
  "receipt-store-finalize-failed" | "receipt-store-close-failed";

export interface ReceiptAttemptSession {
  readonly operationId: string;
  readonly attemptId: string;
  readonly startedAt?: string;
  readonly priorTerminalStatus?: ReceiptV1["status"] | null;
  finalize(receipt: ReceiptV1): Promise<readonly ReceiptAttemptWarningCode[]>;
  close?(): Promise<readonly ReceiptAttemptWarningCode[]>;
}

export interface ReopenReceiptAttemptAdapterDependencies extends ReceiptAttemptAdapterDependencies {
  resume?: typeof resumePendingReceiptAttempt;
}

export interface SupersedeReceiptAttemptAdapterDependencies extends ReceiptAttemptAdapterDependencies {
  supersede?: typeof supersedePendingReceiptAttempt;
}

export async function inspectReceiptAttempt(
  attemptId: string,
  dependencies: Pick<ReceiptAttemptAdapterDependencies, "open" | "close"> & {
    readState?: typeof readReceiptAttemptState;
  } = {},
): Promise<ReceiptAttemptState> {
  const open = dependencies.open ?? openOpLog;
  const close = dependencies.close ?? closeOpLog;
  const readState = dependencies.readState ?? readReceiptAttemptState;
  const db = await open();
  try {
    return await readState(db, attemptId);
  } finally {
    await close(db);
  }
}

/** Reattach to one exact pending attempt; never creates or reopens a terminal row. */
export async function reopenReceiptAttempt(
  value: ReceiptV1,
  dependencies: ReopenReceiptAttemptAdapterDependencies = {},
): Promise<OpenReceiptAttemptResult> {
  const receipt = parseReceiptV1ForEmission(value);
  const open = dependencies.open ?? openOpLog;
  const close = dependencies.close ?? closeOpLog;
  const resume = dependencies.resume ?? resumePendingReceiptAttempt;
  const finalize = dependencies.finalize ?? finalizeReceiptAttempt;
  let db: Client;
  try {
    db = await open();
  } catch {
    return Object.freeze({ kind: "unavailable", warnings: [] });
  }
  let resumed: Awaited<ReturnType<typeof resumePendingReceiptAttempt>>;
  try {
    resumed = await resume(db, receipt);
  } catch {
    await close(db).catch(() => undefined);
    return Object.freeze({ kind: "unavailable", warnings: [] });
  }
  let settled = false;
  return Object.freeze({
    kind: "ready" as const,
    session: Object.freeze({
      operationId: resumed.operationId,
      attemptId: resumed.attemptId,
      startedAt: resumed.startedAt,
      async close() {
        if (settled) return Object.freeze([]);
        settled = true;
        try {
          await close(db);
          return Object.freeze([]);
        } catch {
          return Object.freeze(["receipt-store-close-failed" as const]);
        }
      },
      async finalize(terminalReceipt: ReceiptV1) {
        if (settled) return Object.freeze(["receipt-store-finalize-failed" as const]);
        settled = true;
        const warnings: ReceiptAttemptWarningCode[] = [];
        try {
          await finalize(db, {
            ...parseReceiptV1ForEmission(terminalReceipt),
            timestamps: {
              ...terminalReceipt.timestamps,
              started_at: resumed.startedAt,
            },
          });
        } catch {
          warnings.push("receipt-store-finalize-failed");
        }
        try {
          await close(db);
        } catch {
          warnings.push("receipt-store-close-failed");
        }
        return Object.freeze(warnings);
      },
    }),
  });
}

/** Atomically replace one interrupted pending attempt with a fresh resumed attempt. */
export async function supersedeReceiptAttempt(
  interruptedValue: ReceiptV1,
  freshValue: ReceiptV1,
  dependencies: SupersedeReceiptAttemptAdapterDependencies = {},
): Promise<OpenReceiptAttemptResult> {
  const interrupted = parseReceiptV1ForEmission(interruptedValue);
  const fresh = parseReceiptV1ForEmission(freshValue);
  const open = dependencies.open ?? openOpLog;
  const close = dependencies.close ?? closeOpLog;
  const supersede = dependencies.supersede ?? supersedePendingReceiptAttempt;
  const finalize = dependencies.finalize ?? finalizeReceiptAttempt;
  let db: Client;
  try {
    db = await open();
  } catch {
    return Object.freeze({ kind: "unavailable", warnings: [] });
  }
  let resumed: Awaited<ReturnType<typeof supersedePendingReceiptAttempt>>;
  try {
    resumed = await supersede(db, interrupted, fresh);
  } catch {
    await close(db).catch(() => undefined);
    return Object.freeze({ kind: "unavailable", warnings: [] });
  }
  let settled = false;
  return Object.freeze({
    kind: "ready" as const,
    session: Object.freeze({
      operationId: resumed.operationId,
      attemptId: resumed.attemptId,
      startedAt: resumed.startedAt,
      async close() {
        if (settled) return Object.freeze([]);
        settled = true;
        try {
          await close(db);
          return Object.freeze([]);
        } catch {
          return Object.freeze(["receipt-store-close-failed" as const]);
        }
      },
      async finalize(terminalReceipt: ReceiptV1) {
        if (settled) return Object.freeze(["receipt-store-finalize-failed" as const]);
        settled = true;
        const warnings: ReceiptAttemptWarningCode[] = [];
        try {
          await finalize(db, {
            ...parseReceiptV1ForEmission(terminalReceipt),
            timestamps: {
              ...terminalReceipt.timestamps,
              started_at: resumed.startedAt,
            },
          });
        } catch {
          warnings.push("receipt-store-finalize-failed");
        }
        try {
          await close(db);
        } catch {
          warnings.push("receipt-store-close-failed");
        }
        return Object.freeze(warnings);
      },
    }),
  });
}

export type OpenReceiptAttemptResult =
  | Readonly<{ kind: "ready"; session: ReceiptAttemptSession }>
  | Readonly<{
      kind: "unavailable";
      warnings: readonly ReceiptAttemptWarningCode[];
    }>;

export interface ReceiptAttemptAdapterDependencies {
  open?: typeof openOpLog;
  close?: typeof closeOpLog;
  begin?: typeof beginReceiptAttempt;
  finalize?: typeof finalizeReceiptAttempt;
}

/**
 * Open the durable receipt store and append one pending attempt before a
 * caller mutates product state. Repository failures are deliberately reduced
 * to fixed codes so credentials, paths, and raw driver diagnostics never leak
 * into command output.
 */
export async function openReceiptAttempt(
  value: ReceiptV1,
  dependencies: ReceiptAttemptAdapterDependencies = {},
): Promise<OpenReceiptAttemptResult> {
  const receipt = parseReceiptV1ForEmission(value);
  const open = dependencies.open ?? openOpLog;
  const close = dependencies.close ?? closeOpLog;
  const begin = dependencies.begin ?? beginReceiptAttempt;
  const finalize = dependencies.finalize ?? finalizeReceiptAttempt;

  let db: Client;
  try {
    db = await open();
  } catch {
    return Object.freeze({ kind: "unavailable", warnings: [] });
  }

  let begun: Awaited<ReturnType<typeof beginReceiptAttempt>>;
  try {
    begun = await begin(db, receipt);
  } catch {
    const warnings: ReceiptAttemptWarningCode[] = [];
    try {
      await close(db);
    } catch {
      warnings.push("receipt-store-close-failed");
    }
    return Object.freeze({ kind: "unavailable", warnings: Object.freeze(warnings) });
  }

  let settled = false;
  return Object.freeze({
    kind: "ready" as const,
    session: Object.freeze({
      operationId: begun.operationId,
      attemptId: receipt.attempt_id,
      priorTerminalStatus: begun.priorTerminalStatus,
      async close() {
        if (settled) return Object.freeze([]);
        settled = true;
        try {
          await close(db);
          return Object.freeze([]);
        } catch {
          return Object.freeze(["receipt-store-close-failed" as const]);
        }
      },
      async finalize(terminalReceipt: ReceiptV1) {
        if (settled) {
          return Object.freeze([
            "receipt-store-finalize-failed" as const,
          ] satisfies ReceiptAttemptWarningCode[]);
        }
        settled = true;
        const warnings: ReceiptAttemptWarningCode[] = [];
        try {
          await finalize(db, parseReceiptV1ForEmission(terminalReceipt));
        } catch {
          warnings.push("receipt-store-finalize-failed");
        }
        try {
          await close(db);
        } catch {
          warnings.push("receipt-store-close-failed");
        }
        return Object.freeze(warnings);
      },
    }),
  });
}

/** Open an attempt while atomically reusing an operation selected by replay-plan identity. */
export function openReceiptAttemptForReplayPlan(
  value: ReceiptV1,
  dependencies: ReceiptAttemptAdapterDependencies = {},
): Promise<OpenReceiptAttemptResult> {
  return openReceiptAttempt(value, {
    ...dependencies,
    begin: dependencies.begin ?? beginReceiptAttemptForReplayPlan,
  });
}
