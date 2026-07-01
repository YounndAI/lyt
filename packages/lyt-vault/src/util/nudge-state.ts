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

// Phase D — pod-global discovery nudge engine, PURE POLICY LAYER.
//
// This module is the unit-testable heart of the nudge engine: every decision
// (eligibility, cadence, decline-counting, auto-quiet, the never-flag) is a
// PURE function of an in-memory state snapshot + inputs. It performs NO I/O —
// the registry.db row is read/written by registry/nudge-state-repo.ts, which
// hydrates a `NudgeState` from the singleton row, calls these functions, and
// persists the result. Keeping the policy pure is what lets the cadence /
// counting / auto-quiet rules (plan C5) be exercised without a DB.
//
// The user-facing derived state is `asked | declined | enabled` (the plan's
// "idempotent offer surface" state shape). It is COMPUTED from the row + the
// model-present probe — see deriveOfferState — so all three offer surfaces
// (init offer, rebuild gate, first-search nudge) read ONE coherent verdict.

// The mutable persisted shape (mirrors the embeddings_nudge_state singleton row,
// minus the PK). All timestamps are ISO-8601 strings; `lastAskAt === null` means
// the user has never been surfaced an ask.
export interface NudgeState {
  schemaVersion: number;
  searchesSinceAsk: number;
  lastAskAt: string | null;
  explicitDeclineCount: number;
  disabled: boolean;
}

// The current row-shape version stamped into a freshly-seeded singleton.
export const NUDGE_STATE_SCHEMA_VERSION = 1;

// Auto-quiet threshold: after this many EXPLICIT declines the engine goes
// silent permanently (same end-state as the hard never-flag, reached
// organically). SEE ALSO: nudge-state-repo.ts (no duplicate literal — the repo
// imports this) and the plan C5 ("auto-quiet after 3 explicit declines").
export const AUTO_QUIET_DECLINE_THRESHOLD = 3;

// Cadence: minimum days between two surfaced asks. The plan C5 pins "cadence
// ~7 days AND ≥1 search since last ask".
export const NUDGE_CADENCE_DAYS = 7;
// Milliseconds per day — the single source for the cadence arithmetic. EXPORTED
// (release review FIX 5) so search-cascade.ts imports it instead of redefining a
// duplicate `MS_PER_DAY_CASCADE` (per the repo's coupled-constant directive —
// one value, one home). SEE ALSO: search-cascade.ts (imports this; no local
// MS_PER_DAY duplicate).
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The user-facing derived offer-state consumed by all three offer surfaces.
//  - "enabled"   — the local model is present (semantic is set up) → never nudge.
//  - "declined"  — auto-quieted (≥3 explicit declines) OR the hard never-flag.
//  - "asked"     — asked before but within the quiet window (cadence not yet due).
//  - "not-yet-asked" — never surfaced an ask, model absent, free to offer.
export type OfferState = "not-yet-asked" | "asked" | "declined" | "enabled";

// The coherent INITIAL singleton row (plan C10). The seeded row is the SAME
// pristine shape regardless of whether the model is present — zero counters,
// never asked, not disabled. The present/absent distinction is NOT stored: it
// lives in deriveOfferState (which short-circuits to "enabled" while the model
// is present), so an existing-model pod (0.9.8 user upgrading to 0.9.9 with
// semantic already built) is NEVER re-asked from zero, and the counters are
// pristine for the day the model is (ever) evicted. (release review FIX 6: the
// former `modelPresent` arg was dead — both branches returned the identical row
// — so it is dropped along with the wasted modelCachePresent() probe on the seed
// path; the live present/absent verdict is computed at read time, not seed time.)
export function coherentInitRow(): NudgeState {
  return {
    schemaVersion: NUDGE_STATE_SCHEMA_VERSION,
    searchesSinceAsk: 0,
    lastAskAt: null,
    explicitDeclineCount: 0,
    disabled: false,
  };
}

// Derive the user-facing offer-state from the stored row + the live model probe.
// modelPresent dominates: a present model is always "enabled" (already set up,
// nothing to offer) regardless of stored counters.
//
// EVICTION SEMANTICS (release review FIX 8): the verdict is computed from the LIVE
// modelPresent probe each call, so the present→evicted transition is handled
// transparently — a user who ENABLED semantic (model present → "enabled") then
// lost the cache (eviction → modelPresent now false) falls back to "asked" /
// "not-yet-asked" / "declined" purely as a function of the stored counters. On a
// SUCCESSFUL `model fetch` those counters are reset to a clean slate (last_ask_at
// stamped, searches reset, explicit_decline_count cleared — see model.ts
// runFetch), so a later re-offer after eviction is NOT suppressed by declines the
// user made BEFORE they ever enabled. A `disabled` (hard never-flag) user stays
// "declined" / silent through any eviction — never is never.
export function deriveOfferState(state: NudgeState, modelPresent: boolean): OfferState {
  if (modelPresent) return "enabled";
  if (state.disabled || state.explicitDeclineCount >= AUTO_QUIET_DECLINE_THRESHOLD) {
    return "declined";
  }
  if (state.lastAskAt === null) return "not-yet-asked";
  return "asked";
}

// Why the nudge did NOT fire (null `reason` ⇔ eligible). `model-present` ⇒ the
// capability is already set up; `disabled` ⇒ hard never-flag; `auto-quiet` ⇒
// ≥AUTO_QUIET_DECLINE_THRESHOLD explicit declines; `cadence` ⇒ within the quiet
// window (or no search since the last ask). This is the SINGLE source of the
// ineligibility taxonomy — search-cascade.ts consumes it for its trace instead
// of re-implementing the decision order (release review FIX 5).
export type NudgeIneligibleReason = "model-present" | "disabled" | "auto-quiet" | "cadence";

// THE single eligibility decision (release review FIX 5). PURE: a function of the
// row, the model-present probe, and the current time. Returns BOTH the boolean
// verdict and the classified reason (null ⇔ eligible) so `isEligible` and the
// cascade's decision-trace share ONE source of truth — the decision order is
// defined here exactly once. Eligible ⇔ all hold:
//  - model absent (never nudge for a capability you already have),
//  - not disabled and below the auto-quiet decline threshold,
//  - cadence due: never asked, OR ≥NUDGE_CADENCE_DAYS since the last ask AND
//    ≥1 search recorded since that ask (no nag without intervening intent).
export function classifyEligibility(
  state: NudgeState,
  modelPresent: boolean,
  now: Date,
): { eligible: boolean; reason: NudgeIneligibleReason | null } {
  if (modelPresent) return { eligible: false, reason: "model-present" };
  if (state.disabled) return { eligible: false, reason: "disabled" };
  if (state.explicitDeclineCount >= AUTO_QUIET_DECLINE_THRESHOLD) {
    return { eligible: false, reason: "auto-quiet" };
  }
  if (state.lastAskAt === null) return { eligible: true, reason: null }; // never asked
  if (state.searchesSinceAsk < 1) return { eligible: false, reason: "cadence" };
  const elapsedMs = now.getTime() - new Date(state.lastAskAt).getTime();
  if (elapsedMs < NUDGE_CADENCE_DAYS * MS_PER_DAY) return { eligible: false, reason: "cadence" };
  return { eligible: true, reason: null };
}

// Eligibility — should the agent surface a nudge right now? Thin wrapper over
// classifyEligibility (the one source of truth) returning just the boolean.
export function isEligible(args: {
  state: NudgeState;
  modelPresent: boolean;
  now: Date;
}): boolean {
  return classifyEligibility(args.state, args.modelPresent, args.now).eligible;
}

// Record that a search happened — bumps the cadence counter only. PURE: returns a
// NEW state, never mutates. The counter is what gates "≥1 search since last ask";
// it is reset to 0 by recordAsked when an ask is surfaced.
export function recordSearch(state: NudgeState): NudgeState {
  return { ...state, searchesSinceAsk: state.searchesSinceAsk + 1 };
}

// Record that an ask was SURFACED to the user — stamps last_ask_at to `now` and
// resets searches_since_ask to 0 so the next ask needs a fresh ≥1-search-since
// interval. This is `nudge --asked`. PURE.
export function recordAsked(state: NudgeState, now: Date): NudgeState {
  return { ...state, lastAskAt: now.toISOString(), searchesSinceAsk: 0 };
}

// Record an EXPLICIT decline — increments the decline counter. This is the ONLY
// path that touches explicit_decline_count. A skip / non-response / timeout is
// NOT a decline and MUST NOT call this (it would corrupt the auto-quiet count and
// freeze the user out early). PURE. Crossing AUTO_QUIET_DECLINE_THRESHOLD makes
// deriveOfferState/isEligible go silent organically — no separate flag write.
export function recordDecline(state: NudgeState): NudgeState {
  return { ...state, explicitDeclineCount: state.explicitDeclineCount + 1 };
}

// Record the hard "never ask again" flag (`nudge --never`). PURE. Idempotent.
export function recordNever(state: NudgeState): NudgeState {
  return { ...state, disabled: true };
}
