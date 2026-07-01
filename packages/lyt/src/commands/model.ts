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
import { Command } from "commander";

import {
  bumpDeclineCount,
  clearDeclineCount,
  closeRegistry,
  deriveOfferState,
  ensureNudgeState,
  loadEmbedder,
  markAsked,
  markNever,
  modelCachePresent,
  openRegistry,
  type NudgeState,
} from "@younndai/lyt-vault";

// Phase D Slice 2a — `lyt model` verbs that drive the pod-global nudge
// engine. SYMMETRIC by design (plan F-D.1): the agent relay needs a verb for
// EVERY cadence transition so it can keep the shared state coherent without
// touching the DB itself.
//
//   lyt model fetch          — the affirmative path: kick the owned model fetch
//                              (loadEmbedder showDownloadProgress:true → the
//                              consented fetch entry). On success the model is
//                              present → deriveOfferState short-circuits to
//                              "enabled" → the nudge goes quiet. This IS the
//                              re-ask re-opener: a fresh `model fetch` is one of
//                              the only two events that may re-surface the offer
//                              after a decline (the other is a major-version
//                              event), per the plan's re-ask policy.
//   lyt model nudge --asked  — recordAsked (stamps last_ask_at, resets the
//                              searches-since counter). The agent calls this
//                              when it SURFACES the offer to the user.
//   lyt model nudge --decline— recordDecline (explicit no → increments the
//                              decline counter; 3 → auto-quiet organically).
//   lyt model nudge --never  — recordNever (hard off; "never ask again").
//   lyt model nudge --status — read-only: print the row + derived OfferState.
//
// Each mutating verb routes through the ATOMIC column-scoped repo mutator
// (markAsked/bumpDeclineCount/markNever — release review FIX 1) against the
// singleton row, never the non-atomic ensure→pure-fn→save read-modify-write that
// could lose an update when the agent's `search --json` counter-bump interleaves
// with a `nudge --decline`. The policy + the registry seam are owned by
// @younndai/lyt-vault; this command is a thin CLI adapter.

// The four nudge verbs as a discriminated input. Exactly one is dispatched.
export type NudgeVerb = "asked" | "decline" | "never" | "status";

// Apply a nudge verb against an OPEN registry db, returning the resulting state.
// PURE orchestration: ensure → pure-fn → save (for the mutating verbs), or a
// read-only ensure (for `status`). No I/O beyond the injected db; no model load.
// This is the unit-testable core the CLI action wraps. `now` is injectable for
// deterministic last_ask_at assertions; defaults to the wall clock.
export async function applyNudgeVerb(
  db: Client,
  verb: NudgeVerb,
  now: Date = new Date(),
): Promise<NudgeState> {
  if (verb === "status") return ensureNudgeState(db); // read-only — never writes.
  // Atomic, column-scoped mutators (release review FIX 1) — each ensures the row
  // then UPDATEs only its own column(s), so concurrent writers don't clobber.
  if (verb === "asked") return markAsked(db, now.toISOString());
  if (verb === "decline") return bumpDeclineCount(db);
  return markNever(db);
}

// Apply the affirmative `model fetch` resolution against an OPEN registry db.
// The OWNED fetch itself (loadEmbedder) is performed by the caller and its
// outcome passed in; this records the resolution: a fetch counts as a resolved
// ask (markAsked stamps last_ask_at + resets the search counter atomically), so
// the nudge goes quiet. On a successful fetch the model becomes present →
// deriveOfferState short-circuits to "enabled". `now` injectable for tests.
//
// `opts.clearDeclines` (release review FIX 8) — when true, ALSO reset
// explicit_decline_count to 0 (a clean slate). The caller (runFetch) passes this
// ONLY on a verified-SUCCESSFUL fetch, so a later cache-eviction re-offer isn't
// suppressed by declines the user made BEFORE they ever enabled. Defaults false,
// so direct callers (the agent-relay test) that record a bare resolution keep the
// decline history intact.
export async function applyModelFetchResolution(
  db: Client,
  now: Date = new Date(),
  opts?: { clearDeclines?: boolean },
): Promise<NudgeState> {
  const asked = await markAsked(db, now.toISOString());
  if (opts?.clearDeclines === true) return clearDeclineCount(db);
  return asked;
}

// Render the singleton row + the derived offer-state as a stable, agent-readable
// block. Used by `nudge --status` (and after each mutating verb so the agent can
// observe the new state without a second call).
export function renderState(state: NudgeState, modelPresent: boolean): string {
  const derived = deriveOfferState(state, modelPresent);
  return [
    `model:                ${modelPresent ? "present (semantic ready)" : "absent (lexical only)"}`,
    `offer-state:          ${derived}`,
    `searches-since-ask:   ${state.searchesSinceAsk}`,
    `last-ask-at:          ${state.lastAskAt ?? "(never)"}`,
    `explicit-declines:    ${state.explicitDeclineCount}`,
    `disabled (never):     ${state.disabled}`,
    `schema-version:       ${state.schemaVersion}`,
  ].join("\n");
}

function emit(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

// `lyt model fetch` — the affirmative path. Kicks the OWNED model fetch (the
// consented entry: loadEmbedder with showDownloadProgress:true). On success the
// model becomes present, which makes deriveOfferState/isEligible go quiet (a
// present model is always "enabled"). We also stamp recordAsked so the row
// reflects that the offer cycle resolved (last_ask_at set, counter reset) — the
// nudge counts this as resolved regardless of the on-disk cache timing.
async function runFetch(): Promise<void> {
  emit("Fetching the one-time local model (nothing leaves your machine)…");
  const load = await loadEmbedder({ showDownloadProgress: true });
  const db = await openRegistry();
  try {
    // release review FIX 3 — gate the resolution on ACTUAL success. The fetch only
    // counts as a resolved ask when it genuinely succeeded (model loaded AND on
    // disk). A FAILED/offline fetch must NOT stamp last_ask_at or reset the
    // counter — doing so would masquerade as resolved and quiet the nudge, so the
    // user would never be re-nudged. On failure we leave the cadence untouched.
    const present = modelCachePresent();
    const succeeded = load.available && present;
    let next: NudgeState;
    if (succeeded) {
      // SUCCESS — record the resolution (stamp + reset) AND clear the decline
      // counter (release review FIX 8) so a later eviction re-offer isn't suppressed
      // by pre-enable declines.
      next = await applyModelFetchResolution(db, new Date(), { clearDeclines: true });
      emit("✓ Semantic search enabled — the one-time local model is ready.");
    } else {
      // FAILURE — do NOT stamp asked, do NOT reset the counter; just read the
      // current (untouched) state so the user is re-nudged normally next time.
      next = await ensureNudgeState(db);
      emit(
        "ℹ Couldn't enable semantic right now — search works (lexical). " +
          "Try again anytime with `lyt model fetch`.",
      );
      if (!load.available && load.reason !== undefined) emit(`  (${load.reason})`);
    }
    emit("");
    emit(renderState(next, present));
  } finally {
    await closeRegistry(db);
  }
}

// `lyt model nudge --asked|--decline|--never|--status`. Exactly one flag.
async function runNudge(opts: {
  asked?: boolean;
  decline?: boolean;
  never?: boolean;
  status?: boolean;
}): Promise<void> {
  const chosen = [opts.asked, opts.decline, opts.never, opts.status].filter(Boolean).length;
  if (chosen !== 1) {
    throw new Error(
      "specify exactly one: --asked, --decline, --never, or --status.",
    );
  }
  const verb: NudgeVerb =
    opts.asked === true
      ? "asked"
      : opts.decline === true
        ? "decline"
        : opts.never === true
          ? "never"
          : "status";

  const db = await openRegistry();
  try {
    const next = await applyNudgeVerb(db, verb);
    emit(renderState(next, modelCachePresent()));
  } finally {
    await closeRegistry(db);
  }
}

// `lyt model` parent — semantic-model lifecycle + the pod-global nudge cadence
// verbs. Top-level (like search / primer / reindex) because its mental model is
// pod-wide (the model is ONE shared pod-level artifact).
export function buildModelCommand(): Command {
  const model = new Command("model").description(
    "Semantic search model: fetch the one-time local model and drive the pod-global discovery nudge (fetch | nudge).",
  );

  model
    .command("fetch")
    .description(
      "Fetch the one-time local semantic-search model (nothing leaves your machine) and mark the discovery nudge resolved.",
    )
    .action(async () => {
      try {
        await runFetch();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`lyt model fetch: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  model
    .command("nudge")
    .description(
      "Drive the pod-global discovery-nudge state: --asked (offer surfaced) · --decline (explicit no) · --never (hard off) · --status (inspect, read-only).",
    )
    .option("--asked", "Record that the offer was surfaced to the user (stamps last-ask, resets the search counter)")
    .option("--decline", "Record an EXPLICIT decline (increments the decline counter; 3 → auto-quiet)")
    .option("--never", "Hard 'never ask again' (disables the nudge permanently)")
    .option("--status", "Print the nudge row + derived offer-state (read-only)")
    .action(async (opts: { asked?: boolean; decline?: boolean; never?: boolean; status?: boolean }) => {
      try {
        await runNudge(opts);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`lyt model nudge: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  return model;
}
