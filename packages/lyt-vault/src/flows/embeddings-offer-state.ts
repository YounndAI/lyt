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

// Phase D Slice 2a — the idempotent-offer-surface RESOLVER (option (c)).
//
// Reads the pod-global nudge-state singleton ONCE (ensureNudgeState) and
// snapshots it through deriveOfferState into the PINNED, synchronous
// `() => OfferState` closure shape the offer surfaces expect:
//   • embeddings-offer.ts `embeddingsOfferGate.askedState` (the init offer), and
//   • rebuild-vault.ts `embeddingsBuildGate.askedStateFn` (the rebuild gate).
// Both consult the SAME state, so the user is offered AT MOST ONCE per
// decision-epoch regardless of entry point.
//
// This RESOLVER deliberately lives in a SEPARATE module from embeddings-offer.ts
// so that file stays clean of any nudge-state import/symbol — the Phase-C
// "inert seam" invariant (no-persistence-in-the-offer-gate, enforced by
// embeddings-offer.test.ts) is preserved. A caller with NO registry db simply
// does not call this; the gate then uses its inert default (() => "not-yet-
// asked") and Phase-C behavior is unchanged.

import type { Client } from "@libsql/client";

import { modelCachePresent } from "../util/embeddings.js";
import { ensureNudgeState } from "../registry/nudge-state-repo.js";
import { deriveOfferState, type OfferState } from "../util/nudge-state.js";

// Resolve the shared offer-state into a pinned `() => OfferState` snapshot
// closure. modelPresent is injectable for tests; production reads
// modelCachePresent(). The snapshot is taken at resolve-time (the gate's
// decision is a single point in the same invocation), so a synchronous closure
// is correct.
export async function resolveAskedState(
  db: Client,
  opts?: { modelPresentFn?: () => boolean },
): Promise<() => OfferState> {
  const modelPresent = (opts?.modelPresentFn ?? modelCachePresent)();
  const state = await ensureNudgeState(db, { modelPresent });
  const verdict = deriveOfferState(state, modelPresent);
  return () => verdict;
}
