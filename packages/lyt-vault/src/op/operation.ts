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

// Increment 1 · Phase A.2 — the Operation interface (the safe-write spine's
// organizing contract).
//
// Per the charter this is an ORGANIZING interface, NOT a magic undo primitive.
// Every later write flow (Phase B's MCP tools + receipts) wraps an `Operation`
// so preview / undo / receipt come for free. Phase A proves the spine on the two
// ENDS of the reversibility taxonomy: `capture` (clean-undo) and `sync`
// (honest none). It builds every op as a deterministic, handler-runnable verb
// (mechanical-first) — no agent re-implements the mechanic.
//
// The load-bearing honesty rule (from the cross-examine): the horizon and the
// inverse are READ BACK FROM WHAT ACTUALLY HAPPENED, never asserted from the
// verb. A `capture` is clean-undo because its bytes are local; a `sync` is
// `none` ONLY once the push has actually landed — a push that committed but
// failed to reach the remote is `committed-not-pushed` → still clean-undo. See
// `horizon` timing below.

/**
 * Where an Operation's effects have reached — the fact that governs which
 * inverse is honestly possible.
 *
 * TIMING: for a local-only op (capture) the horizon is known and fixed before
 * `apply()`. For a networked op (sync) the horizon is the INTENDED value before
 * `apply()` and the ACTUAL value after — computed from the real push result, so
 * a half-landed push is never mislabelled. Always read `horizon` (and call
 * `inverse()`) AFTER `apply()` for a truthful answer.
 */
export type SyncHorizon =
  | "local" // effects are local-only (uncommitted / committed-not-pushed) — reversible. First exercised: A.3 capture.
  | "committed-not-pushed" // committed locally, push did NOT land — reset the local commit. First exercised: A.4 sync partial-success.
  | "pushed" // effects reached the remote — a local undo cannot un-share them. First exercised: A.4 sync.
  | "pulled"; // effects came FROM the remote into local. First exercised: Increment 2.

/**
 * A typed, self-describing reversal command carried by a `clean-undo` inverse.
 * The op-log is a reversible-command log, and reversal context is inherently
 * op-specific and variadic (a capture needs a path; a future rename needs two;
 * a multi-file op needs a set) — so it lives in the typed inverse payload, not
 * a fixed op-log column. `lyt undo` (A.3) dispatches on `type`. Open union:
 * new op kinds add a variant, no op-log schema change (D, cross-examine 2026-07-06).
 */
export type UndoAction = {
  type: "delete-figment"; // reverse a capture: remove the written figment + de-index it.
  vaultPath: string;
  relPath: string; // vault-relative POSIX.
};

/**
 * How an Operation can be reversed — computed into three HONEST classes. The
 * `compensating` middle class is designed but deliberately UNEXERCISED in Phase A
 * (open validation debt inherited by Phases B/C); Phase A proves only the two
 * ends (`clean-undo` via capture, `none` via a pushed sync).
 *
 * `clean-undo` optionally carries the executable `action`: a concrete applied
 * Operation fills it (so `lyt undo` can reverse in a fresh process from the
 * op-log alone); the deterministic `defaultInverseForHorizon` classification
 * leaves it absent (class-only — no reversal recorded yet).
 */
export type Inverse =
  | { class: "clean-undo"; action?: UndoAction } // fully + safely reversible by resetting local state.
  | { class: "compensating"; note: string } // reversible only by a NEW forward op; `note` explains, in plain language.
  | { class: "none"; reason: string }; // not reversible — `reason` is plain-language, NEVER a git/gh noun.

/**
 * What `apply()` WOULD do, with ZERO mutation. `summary` is plain-language (the
 * charter's "no decision the human can't answer" — e.g. `lyt undo --preview`
 * turns a silent LIFO guess into a confirmable fact). `details` is optional
 * structured context (e.g. the path + frontmatter a capture would write).
 */
export interface Preview {
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * The verified result of `apply()`. `verified` is per-verb, checked against REAL
 * state (capture = file-bytes on disk + the figment index row; sync = the actual
 * push result) — a forced mismatch flips it to `false` (SC-A4). `envelope` leaves
 * room for the Phase-B agent (machine-readable) receipt so B doesn't retrofit.
 */
export interface Receipt {
  applied: boolean;
  verified: boolean;
  logline: string;
  /** The horizon actually reached (read back post-apply). */
  horizon: SyncHorizon;
  envelope?: Record<string, unknown>;
}

/**
 * The organizing interface every in-scope write flows through. Deterministic and
 * handler-runnable (mechanical-first, SC-A6): `lyt capture … && lyt undo` works
 * at a bare terminal with no agent.
 */
export interface Operation {
  /** Stable verb identity — e.g. "capture" | "sync" | "undo". */
  readonly kind: string;
  /**
   * Best-known horizon: the INTENDED horizon before `apply()`, the ACTUAL horizon
   * after (read back from what happened). Used by the op-log's pre-apply entry
   * and by `inverse()`.
   */
  readonly horizon: SyncHorizon;
  /** Describe what `apply()` would do — MUST NOT mutate anything. */
  preview(): Promise<Preview>;
  /** Perform the effect and return a verified Receipt (updates `horizon` to actual). */
  apply(): Promise<Receipt>;
  /** How this op can be reversed — computed from the (post-apply) horizon + args. */
  inverse(): Inverse;
  /** One-line plain-language sentence for the op-log + audit ledger (maps onto recordAudit). */
  logline(): string;
}

/**
 * The honest DEFAULT inverse for a horizon — a deterministic, no-LLM mapping
 * (mechanical-first). Ops may override with op-specific reason/note strings, but
 * the CLASS is fixed by where the effects reached:
 *   local / committed-not-pushed → clean-undo (local state is resettable)
 *   pushed / pulled              → none        (a local undo can't touch the remote)
 * `compensating` is never a default — an op must opt into it deliberately.
 */
export function defaultInverseForHorizon(horizon: SyncHorizon): Inverse {
  switch (horizon) {
    case "local":
    case "committed-not-pushed":
      return { class: "clean-undo" };
    case "pushed":
      return {
        class: "none",
        reason: "This change is already saved to your online copy, so it can't be undone here.",
      };
    case "pulled":
      return {
        class: "none",
        reason: "This came from your online copy, so there's nothing local to undo.",
      };
  }
}
