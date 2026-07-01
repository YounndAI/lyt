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

// Phase C (C4, F-C.1) — the INTERACTIVE-ONLY embeddings offer at init.
//
// Lifts the model-present → inform → NEUTRAL+RECOMMEND offer into the
// interactive init paths only (the no-flag → wizard route, and `--custom`),
// gated by isEmbeddingsInteractive. The rebuild path's embeddingsBuildGate
// (rebuild-vault.ts) owns the *reindex*-time decision; this gate owns the
// *init*-time pre-fetch so a fresh pod can have its one-time local model ready
// before the first search — without ever prompting in a non-interactive
// invocation (--auto / --json / CI / non-TTY), which defers silently to the
// first-search nudge (Phase D).
//
// Contract:
//   • Model cache ALREADY present → no offer (nothing to fetch).
//   • Not interactive (isEmbeddingsInteractive false) → no offer; defer to the
//     Phase-D first-search nudge. --auto is non-interactive BY DEFINITION
//     (F-C.1): it passes json:false but stdin/stdout TTY are irrelevant because
//     the --auto path never CALLS this gate at all.
//   • Absent + interactive → NEUTRAL framing that RECOMMENDS enabling; accept →
//     trigger the owned fetch (loadEmbedder showDownloadProgress:true → the
//     fetchModel path); decline → brief "enable later" hint (no persistence).
//
// COPY DISCIPLINE (hard rule, F-F.1): every user-facing string about the model
// says "a one-time local model" — NEVER a size word. Enforced repo-wide by
// no-model-size-claims.test.ts (Phase F).

import { isEmbeddingsInteractive, loadEmbedder, modelCachePresent } from "../util/embeddings.js";

// NEUTRAL + RECOMMEND framing. Neutral (states the tradeoff plainly, no dark
// pattern) and recommends enabling IN WORDS ("Recommended: yes") — but does NOT
// preselect. Each prompt handler renders its own y/n affordance with NO default,
// so consent is an affirmative `y`/`yes` keypress; a bare Enter does NOT enable
// (no accidental network model fetch). NO size word — "one-time local" only.
export const EMBEDDINGS_OFFER_PROMPT =
  "Concept search finds notes by meaning (one-time local setup, nothing leaves " +
  "your machine). Recommended: yes. Enable now?";

// Shown on DECLINE — brief, names the exact re-enable verb. No persistence is
// written here (Phase D owns the decline-state nudge).
export const EMBEDDINGS_OFFER_DECLINE_HINT =
  "ℹ No problem — search works now (lexical). Enable semantic anytime with `lyt model fetch`.";

// Shown after a successful accept+fetch.
export const EMBEDDINGS_OFFER_FETCHED =
  "✓ Semantic search enabled — the one-time local model is ready.";

// Shown when accept was given but the owned fetch did not complete (offline /
// stalled / locked). Non-fatal: init continues, semantic is simply not enabled
// yet; the same `lyt model fetch` re-enable verb applies.
export const EMBEDDINGS_OFFER_FETCH_FAILED =
  "ℹ Couldn't fetch the one-time local model right now — search works (lexical). " +
  "Try again anytime with `lyt model fetch`.";

export type EmbeddingsOfferOutcome =
  // No offer was presented. `reason` distinguishes already-present from
  // suppressed-non-interactive (and the Phase-D already-resolved seam) so
  // callers/tests can assert the gate's decision.
  | { offered: false; reason: "already-present" | "non-interactive" | "already-resolved" }
  // Offered + the handler declined. No fetch, no persistence.
  | { offered: true; accepted: false }
  // Offered + accepted; `fetched` reports whether the owned fetch succeeded.
  | { offered: true; accepted: true; fetched: boolean };

export interface EmbeddingsOfferArgs {
  // The init invocation's --json flag (false on the interactive wizard/custom
  // paths). Threaded into isEmbeddingsInteractive.
  json?: boolean;
  // TTY signals — default to the live process descriptors; injectable for tests.
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  // Confirm primitive (ReadlinePromptHandler.confirm shape) — returns the
  // handler's yes/no. Injectable for tests; a throw (stdin closed) is treated as
  // a decline (never hangs, never fetches).
  promptConfirm: (question: string) => Promise<boolean>;
  // Line emitter (console.log shape) for the hint/result lines. Injectable.
  emit: (line: string) => void;
  // Test seams — override the cache probe + the owned fetch so the path is
  // exercised without a real model download.
  modelCachePresentFn?: () => boolean;
  fetchModelFn?: () => Promise<boolean>;
  // Phase-D forward-compat seam. Pod-global asked/declined/enabled state.
  // Defaults to () => 'not-yet-asked' (inert) until Phase D's registry.db
  // nudge-state table exists. When it returns anything other than
  // 'not-yet-asked', the offer is suppressed (the user already resolved this).
  askedState?: () => "not-yet-asked" | "asked" | "declined" | "enabled";
  // release review FIX 4(b) — invoked EXACTLY when this gate actually SURFACES
  // the prompt to the user (a real offer, not an ambient hint). The CALLER wires
  // this to stamp the pod-global ask (markAsked) so the init/wizard offer shares
  // the same cadence + auto-quiet as the other surfaces. Kept as an OPAQUE
  // callback so this module imports NO nudge-state symbol (the Phase-C inert-seam
  // invariant — embeddings-offer.ts must stay clean of registry/nudge code). A
  // caller with no db simply omits it → the inert-seam default path keeps its
  // "no persistence" behavior. Best-effort: a throw here is swallowed so it can
  // never derail the offer.
  onSurfaced?: () => Promise<void> | void;
}

// The owned-fetch default: loadEmbedder with showDownloadProgress:true is the
// CONSENTED fetch entry (it runs fetchModel on the gated path, then loads). We
// only care whether the model became available — init has no notes to index
// yet, so this is a pure pre-fetch. Returns true iff the model is now usable.
async function defaultFetchModel(): Promise<boolean> {
  const load = await loadEmbedder({ showDownloadProgress: true });
  return load.available;
}

// Run the interactive-only embeddings offer. Pure orchestration over injected
// seams (no direct process.stdout writes), so it is fully unit-testable.
export async function embeddingsOfferGate(
  args: EmbeddingsOfferArgs,
): Promise<EmbeddingsOfferOutcome> {
  const modelPresent = (args.modelCachePresentFn ?? modelCachePresent)();

  // Model already cached → nothing to fetch; never offer.
  if (modelPresent) {
    return { offered: false, reason: "already-present" };
  }

  // Phase-D forward-compat seam. Inert by default (() => "not-yet-asked"): the
  // offer proceeds exactly as before. Once Phase D wires the registry.db
  // nudge-state table, a non-"not-yet-asked" verdict means the user already
  // resolved this pod-globally (asked / declined / enabled) → suppress.
  const state = (args.askedState ?? (() => "not-yet-asked"))();
  if (state !== "not-yet-asked") {
    return { offered: false, reason: "already-resolved" };
  }

  // Gate on the shared interactivity predicate (not-json AND stdin TTY AND
  // stdout TTY). A non-interactive caller (CI / --json / piped) gets NO offer —
  // it defers silently to the Phase-D first-search nudge.
  const interactive = isEmbeddingsInteractive({
    json: args.json,
    stdinTTY: args.stdinTTY,
    stdoutTTY: args.stdoutTTY,
  });
  if (!interactive) {
    return { offered: false, reason: "non-interactive" };
  }

  // Absent + interactive → we are about to SURFACE a real offer. Stamp the ask
  // via the injected onSurfaced callback (release review FIX 4(b)) BEFORE prompting,
  // so the cadence advances whether the user accepts, declines, or the prompt
  // throws (stdin closed) — surfacing the offer IS the ask. Best-effort + opaque
  // (this module holds no nudge-state symbol — inert-seam invariant).
  if (args.onSurfaced !== undefined) {
    try {
      await args.onSurfaced();
    } catch {
      // never derail the offer on a cadence-stamp failure.
    }
  }

  // NEUTRAL+RECOMMEND prompt.
  let consented: boolean;
  try {
    consented = await args.promptConfirm(EMBEDDINGS_OFFER_PROMPT);
  } catch {
    // A prompt failure (stdin closed mid-prompt) degrades to a decline — never
    // hangs, never fetches. Show the same enable-later hint.
    args.emit(EMBEDDINGS_OFFER_DECLINE_HINT);
    return { offered: true, accepted: false };
  }

  if (!consented) {
    // DECLINE → brief enable-later hint. No persistence, no registry.db write.
    // Phase D: persist explicit-decline → registry.db nudge-state (table built in Phase D)
    args.emit(EMBEDDINGS_OFFER_DECLINE_HINT);
    return { offered: true, accepted: false };
  }

  // ACCEPT → trigger the owned fetch (reuses loadEmbedder/fetch-model.ts).
  const fetchFn = args.fetchModelFn ?? defaultFetchModel;
  let fetched: boolean;
  try {
    fetched = await fetchFn();
  } catch {
    // The owned fetch is contracted never to throw, but stay non-fatal either
    // way — init continues, semantic just isn't enabled yet.
    fetched = false;
  }
  args.emit(fetched ? EMBEDDINGS_OFFER_FETCHED : EMBEDDINGS_OFFER_FETCH_FAILED);
  return { offered: true, accepted: true, fetched };
}
