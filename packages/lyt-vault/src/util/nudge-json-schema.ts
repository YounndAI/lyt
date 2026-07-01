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

// Phase E Unit 3 — zod schema for the Phase-D discovery-nudge decision-trace.
//
// REUSES the existing Phase-D shape (search-cascade.ts `NudgeDecisionTrace`,
// over the `OfferState` + `NudgeIneligibleReason` taxonomies in
// util/nudge-state.ts) — it does NOT redefine it. The enums below are pulled
// from the SAME source-of-truth unions so a future taxonomy change is caught:
// the schema's enum members are derived from the TS unions, and a compile-time
// assert (the `satisfies` line) fails the build if they drift.

import { z } from "zod";

import type { OfferState, NudgeIneligibleReason } from "./nudge-state.js";

// The four offer-states (single source: util/nudge-state.ts `OfferState`).
const OFFER_STATES = ["not-yet-asked", "asked", "declined", "enabled"] as const;
// The four ineligibility reasons (single source: `NudgeIneligibleReason`).
const INELIGIBLE_REASONS = ["model-present", "disabled", "auto-quiet", "cadence"] as const;

// Compile-time drift guards — BIDIRECTIONAL. The `satisfies` checks catch a
// RENAME or REMOVE (an array member that no longer names a union member fails to
// be assignable). But `satisfies` alone does NOT catch an ADDITION: a new union
// member leaves the existing array still assignable to `readonly Union[]`, so the
// new state would be silently dropped from the `z.enum(...)` and a real emitted
// trace carrying it would fail `.parse` at the consumer. The reverse
// exhaustiveness asserts below close that gap: if the union gains a member NOT in
// the array, `Union extends (typeof ARRAY)[number]` resolves to `never` and the
// `= true` assignment fails to compile. Together the two directions make the
// runtime schema unable to silently drift from the type taxonomy in EITHER way.
const _offerStateGuard = OFFER_STATES satisfies readonly OfferState[];
const _ineligibleGuard = INELIGIBLE_REASONS satisfies readonly NudgeIneligibleReason[];
void _offerStateGuard;
void _ineligibleGuard;

// Reverse (addition-catching) exhaustiveness: an added union member breaks build.
type _OfferStateExhaustive = OfferState extends (typeof OFFER_STATES)[number] ? true : never;
const _offerStateExhaustive: _OfferStateExhaustive = true;
void _offerStateExhaustive;
type _IneligibleExhaustive =
  NudgeIneligibleReason extends (typeof INELIGIBLE_REASONS)[number] ? true : never;
const _ineligibleExhaustive: _IneligibleExhaustive = true;
void _ineligibleExhaustive;

// Mirrors search-cascade.ts `NudgeDecisionTrace` (Phase D Slice 2b, plan C6).
export const NudgeDecisionTraceSchema = z.object({
  eligible: z.boolean(),
  state: z.enum(OFFER_STATES),
  reason: z.enum(INELIGIBLE_REASONS).nullable(),
  declines: z.number().int().nonnegative(),
  daysSince: z.number().nullable(),
  searchesSince: z.number().int().nonnegative(),
  // Release review FIX 7 — set true ONLY when the cadence-counter WRITE threw;
  // omitted on the happy path (so the baseline trace is byte-unchanged).
  persistError: z.boolean().optional(),
});

export type NudgeDecisionTraceJson = z.infer<typeof NudgeDecisionTraceSchema>;
