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

import type { CheckResult } from "./flows/doctor.js";
import type { Operation, Receipt } from "./op/operation.js";

/** The completed operation and its already-produced receipt, including verification failures. */
export interface AfterOperationEvent {
  operation: Operation;
  receipt: Receipt;
}

/** Optional callback invoked after an Operation returns any receipt. */
export type AfterOperationHook = (event: AfterOperationEvent) => void | Promise<void>;

/**
 * Distinguishes a post-operation callback failure from an Operation failure.
 * The completed receipt is retained so callers never need to retry blindly.
 */
export class AfterOperationHookError extends Error {
  readonly operation: Operation;
  readonly receipt: Receipt;

  constructor(event: AfterOperationEvent, cause: unknown) {
    super("afterOperation callback failed after the Operation produced a receipt", { cause });
    this.name = "AfterOperationHookError";
    this.operation = event.operation;
    this.receipt = event.receipt;
  }
}

/** Optional source of additional rows for a caller-composed doctor report. */
export type DoctorChecksHook = () => readonly CheckResult[] | Promise<readonly CheckResult[]>;

/**
 * Small, caller-supplied lifecycle callbacks for programmatic Lyt composition.
 *
 * Lyt does not discover or persist hooks. The embedding caller owns their
 * lifetime and failure policy. An afterOperation error rejects with
 * AfterOperationHookError, which retains the completed receipt; callbacks never
 * rewrite or roll back an Operation receipt.
 */
export interface LytLifecycleHooks {
  afterOperation?: AfterOperationHook | undefined;
  doctorChecks?: DoctorChecksHook | undefined;
}

/** Apply an Operation and notify the caller only after its receipt exists. */
export async function applyOperation(
  operation: Operation,
  hooks: Pick<LytLifecycleHooks, "afterOperation"> = {},
): Promise<Receipt> {
  const receipt = await operation.apply();
  if (hooks.afterOperation) {
    try {
      await hooks.afterOperation({ operation, receipt });
    } catch (cause) {
      throw new AfterOperationHookError({ operation, receipt }, cause);
    }
  }
  return receipt;
}
