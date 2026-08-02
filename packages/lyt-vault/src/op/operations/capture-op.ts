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

// Increment 1 · Phase A.3 — the `capture` Operation (the clean-undo END of the
// reversibility taxonomy).
//
// Wraps the EXISTING knowledge-capture pattern-run (patternRunFlow) — it adds no
// new write mechanic (mechanical-first: `lyt capture` already works with no
// agent); it wraps that write in the Operation spine so preview / undo / receipt
// come for free. A capture's horizon is always `local` (a written figment, never
// pushed), so its inverse is `clean-undo` — and it carries the executable
// `delete-figment` action (D) so `lyt undo` can reverse it in a fresh process
// from the op-log alone.
//
// The op-log discipline (A.2): enqueue-BEFORE-apply (a durable pending row
// exists before the write mutates), then an OUTCOME UPDATE with the ACTUAL
// relPath + the executable inverse once the write resolved the path.

import { relative, sep } from "node:path";

import type { Client } from "@libsql/client";

import {
  patternRunFlow,
  type PatternRunArgs,
  type PatternRunResult,
} from "../../flows/pattern-run.js";
import { appendPendingOp, markOpAborted, markOpApplied } from "../operation-log.js";
import {
  assertFigmentIndexed,
  assertFileBytes,
  combineVerifications,
  makeReceipt,
} from "../receipt.js";
import type { Inverse, Operation, Preview, Receipt, SyncHorizon } from "../operation.js";

/** The capture's user-facing inputs (a thin pass-through to the pattern-run). */
export interface CaptureInput {
  vaultName: string;
  /** The thought/title being captured — used for the logline + preview summary. */
  title: string;
  slug?: string;
  /** Vault-relative destination dir override (fail-closed downstream). */
  dir?: string;
  /** Ceremony vars (title/purpose/topic/tags/…) forwarded to the template. */
  vars?: Record<string, string>;
}

/** Injectable seams — defaults are the production wiring; tests inject fakes. */
export interface CaptureOperationDeps {
  /** The pod-level op-log (A.2). Caller owns its lifecycle. */
  opLogDb: Client;
  /** The write mechanic — defaults to patternRunFlow (the real capture ceremony). */
  runCapture?: (args: PatternRunArgs) => Promise<PatternRunResult>;
  /** ISO clock — defaults to wall time. Injected in tests for determinism. */
  now?: () => string;
  /**
   * Optional audit sink (op-audit.ts `recordOperationAudit`). WIRED by the CLI's
   * `captureThroughOp` (firewall-C1/a review finding fix-pass): on a successful capture it
   * records an `op.capture` entry into the vault's audit ledger, targeting the
   * written figment. Best-effort by contract — the sink swallows its own errors so
   * a capture never fails on an audit hiccup. Omitted → no op-level audit entry
   * (e.g. the `already-existed` no-op path never calls it). Injected in unit tests.
   */
  audit?: (
    op: Operation,
    receipt: Receipt,
    ctx: { vaultPath: string; relPath: string },
  ) => Promise<void>;
}

export class CaptureOperation implements Operation {
  readonly kind = "capture";
  // A capture is local-only — a written figment is never pushed. The horizon is
  // known and fixed before apply(), so it does not change post-apply.
  readonly horizon: SyncHorizon = "local";

  // Set once apply() has resolved the written path — powers inverse()/undo.
  private applied: { vaultPath: string; relPath: string } | null = null;

  // The underlying pattern-run result, exposed after apply() so a CLI caller can
  // render the same output it always did (filePath, indexDeferred/indexNote,
  // alreadyExisted) — the Operation adds the op-log write, not a new output shape.
  lastResult: PatternRunResult | null = null;

  constructor(
    private readonly input: CaptureInput,
    private readonly deps: CaptureOperationDeps,
  ) {}

  // Zero-mutation description of what apply() would do. The exact on-disk path is
  // resolved by the pattern-run at apply time (no dry-run seam today), so preview
  // states the intent — title + destination vault — which is what `lyt undo
  // --preview`'s counterpart needs the human to confirm.
  async preview(): Promise<Preview> {
    return {
      summary: `Capture "${this.input.title}" into ${this.input.vaultName}.`,
      details: {
        title: this.input.title,
        vault: this.input.vaultName,
        ...(this.input.dir !== undefined ? { dir: this.input.dir } : {}),
      },
    };
  }

  async apply(): Promise<Receipt> {
    const now = this.deps.now ?? isoNow;
    const run = this.deps.runCapture ?? patternRunFlow;

    // ENQUEUE-BEFORE-APPLY. The path isn't known until the write resolves it, so
    // the pending row carries an empty planned fileSet + a class-only inverse;
    // markOpApplied writes back the actual relPath + executable inverse.
    const opId = await appendPendingOp(
      this.deps.opLogDb,
      { kind: this.kind, horizon: this.horizon, fileSet: [], inverse: { class: "clean-undo" } },
      now(),
    );

    let r: PatternRunResult;
    try {
      r = await run({
        patternName: "knowledge-capture",
        verbId: "capture",
        vaultName: this.input.vaultName,
        // This operation already enqueued the reversible capture row above.
        // Suppress patternRunFlow's generic non-undoable barrier so the capture
        // itself remains the latest applied action.
        recordOperation: false,
        ...(this.input.slug !== undefined ? { slug: this.input.slug } : {}),
        ...(this.input.dir !== undefined ? { dir: this.input.dir } : {}),
        vars: this.input.vars ?? {},
      });
    } catch (err) {
      // The write was REFUSED/failed (mandatory-field refusal, frozen vault,
      // write-gate, missing pattern) AFTER the pending row was durably enqueued.
      // Finalize it as `aborted` so it neither shadows a real undoable op nor
      // lingers as a phantom `pending` the recovery path would try to recover
      // (release review R2). Best-effort — never mask the original write error.
      try {
        await markOpAborted(
          this.deps.opLogDb,
          opId,
          `The capture was not completed: ${errMsg(err)}`,
          now(),
        );
      } catch {
        /* keep the original write error as the thrown one */
      }
      throw err;
    }

    this.lastResult = r;
    const relPath = relative(r.vaultPath, r.filePath).split(sep).join("/");

    // A capture onto a path that ALREADY existed wrote nothing — so it is NOT
    // undoable (a delete-figment inverse would remove a figment the user did not
    // just create). Finalize it `aborted`, not `applied`: a no-op must not shadow
    // the real undoable op beneath it (release review). `this.applied` stays
    // null so inverse() reflects the no-op.
    if (r.alreadyExisted) {
      await markOpAborted(
        this.deps.opLogDb,
        opId,
        "That note already existed, so there's nothing new to undo.",
        now(),
      );
      return makeReceipt({
        applied: false,
        verified: assertFileBytes(r.vaultPath, relPath).verified,
        logline: `"${this.input.title}" was already saved.`,
        horizon: this.horizon,
        envelope: { relPath, vault: r.vaultName, alreadyExisted: true },
      });
    }

    this.applied = { vaultPath: r.vaultPath, relPath };

    // Per-verb verification (SC-A4): the bytes are on disk AND the figment is in
    // the index. A deferred index (capture-index never-throws) yields verified
    // false — reported honestly, never asserted from the verb.
    const verified = combineVerifications([
      assertFileBytes(r.vaultPath, relPath),
      await assertFigmentIndexed(r.vaultPath, relPath),
    ]).verified;

    const inverse: Inverse = {
      class: "clean-undo",
      action: { type: "delete-figment", vaultPath: r.vaultPath, relPath },
    };
    await markOpApplied(
      this.deps.opLogDb,
      opId,
      { horizon: this.horizon, inverse, fileSet: [relPath] },
      now(),
    );

    const receipt = makeReceipt({
      applied: true,
      verified,
      logline: this.logline(),
      horizon: this.horizon,
      envelope: { relPath, vault: r.vaultName },
    });
    if (this.deps.audit !== undefined)
      await this.deps.audit(this, receipt, { vaultPath: r.vaultPath, relPath });
    return receipt;
  }

  // Computed from the (post-apply) horizon: a local capture is clean-undo, and
  // carries the executable delete-figment action once applied. Before apply the
  // path is unknown → class-only (no action).
  inverse(): Inverse {
    if (this.applied === null) return { class: "clean-undo" };
    return {
      class: "clean-undo",
      action: {
        type: "delete-figment",
        vaultPath: this.applied.vaultPath,
        relPath: this.applied.relPath,
      },
    };
  }

  logline(): string {
    return `Saved the note "${this.input.title}".`;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
