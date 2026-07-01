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

// Phase D — registry.db accessor for the pod-global nudge-state singleton.
// This is the ONLY I/O seam for the nudge engine: it hydrates a NudgeState from
// the embeddings_nudge_state row (migration 007) for the READ path, and persists
// the COUNTER/FLAG mutations through ATOMIC, column-scoped SQL UPDATEs.
//
// ATOMIC WRITES (release review FIX 1 — MAJOR race). The original write path was
// readRow → pure-fn (recordSearch/recordDecline/…) → writeRow(full-row UPSERT).
// That read-modify-write is NON-ATOMIC: two interleaving writers (e.g. an agent
// `search --json` bumping the search counter while `nudge --decline` increments
// the decline counter) each read the same row, mutate their own copy, and the
// second full-row write CLOBBERS the first writer's column — a lost update.
// The mutating verbs below are now single atomic `UPDATE … SET col = col ± 1`
// (or `SET col = ?`) statements, so concurrent writers touching DIFFERENT
// columns never lose each other's update, and same-column bumps serialize at the
// SQL level. The PURE functions in util/nudge-state.ts are KEPT for the derive /
// eligibility READS + unit tests; only the WRITE path moved to atomic SQL.
//
// SINGLETON: the table holds exactly one row (PK pinned to 1 by a CHECK). On
// first access ensureNudgeState seeds the coherent initial row (plan C10). Each
// atomic mutator calls ensureNudgeState FIRST so the row exists before the
// column-scoped UPDATE runs (an UPDATE on an absent row is a silent no-op).

import type { Client } from "@libsql/client";

import { coherentInitRow, type NudgeState } from "../util/nudge-state.js";

const SINGLETON_ID = 1;

function rowToState(row: Record<string, unknown>): NudgeState {
  const lastAsk = row["last_ask_at"];
  return {
    schemaVersion: Number(row["schema_version"]),
    searchesSinceAsk: Number(row["searches_since_ask"]),
    lastAskAt: lastAsk === null || lastAsk === undefined ? null : String(lastAsk),
    explicitDeclineCount: Number(row["explicit_decline_count"]),
    disabled: Number(row["disabled"]) === 1,
  };
}

async function readRow(db: Client): Promise<NudgeState | null> {
  const res = await db.execute({
    sql: "SELECT schema_version, searches_since_ask, last_ask_at, explicit_decline_count, disabled FROM embeddings_nudge_state WHERE id = ?",
    args: [SINGLETON_ID],
  });
  const row = res.rows[0];
  if (row === undefined) return null;
  return rowToState(row as unknown as Record<string, unknown>);
}

// Idempotent write of the full singleton (UPSERT on the pinned PK).
async function writeRow(db: Client, state: NudgeState): Promise<void> {
  await db.execute({
    sql: `INSERT INTO embeddings_nudge_state
            (id, schema_version, searches_since_ask, last_ask_at, explicit_decline_count, disabled)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            schema_version = excluded.schema_version,
            searches_since_ask = excluded.searches_since_ask,
            last_ask_at = excluded.last_ask_at,
            explicit_decline_count = excluded.explicit_decline_count,
            disabled = excluded.disabled`,
    args: [
      SINGLETON_ID,
      state.schemaVersion,
      state.searchesSinceAsk,
      state.lastAskAt,
      state.explicitDeclineCount,
      state.disabled ? 1 : 0,
    ],
  });
}

// Read the singleton, seeding the coherent initial row on first access (plan
// C10). The seeded row is the SAME pristine shape regardless of the model probe
// (release review FIX 6: coherentInitRow no longer takes `modelPresent`, and the
// wasted modelCachePresent() probe on the seed path is gone — the present/absent
// distinction is computed at READ time by deriveOfferState, not stamped at seed
// time). The `opts.modelPresent` parameter is RETAINED (ignored) for caller/test
// compatibility — every existing caller that passed it still type-checks and the
// seeded row is identical either way.
export async function ensureNudgeState(
  db: Client,
  _opts?: { modelPresent?: boolean },
): Promise<NudgeState> {
  const existing = await readRow(db);
  if (existing !== null) return existing;
  const seeded = coherentInitRow();
  await writeRow(db, seeded);
  return seeded;
}

// Persist a full NudgeState (UPSERT on the pinned PK). RETAINED for the read /
// derive path and for tests that seed a known row (recordDecline/recordNever →
// saveNudgeState). NOT the hot mutation path — concurrent counter/flag mutations
// MUST go through the atomic column-scoped mutators below (release review FIX 1), not
// through readRow→pure-fn→saveNudgeState, which is the non-atomic lost-update
// pattern the atomic mutators exist to replace.
export async function saveNudgeState(db: Client, state: NudgeState): Promise<void> {
  await writeRow(db, state);
}

// ---------------------------------------------------------------------------
// Atomic column-scoped mutators (release review FIX 1). Each ensures the singleton
// row exists, then runs a SINGLE UPDATE touching ONLY its own column(s). They
// return the post-write NudgeState (a fresh read) so callers/tests can observe
// the result. Concurrent mutators on DIFFERENT columns never clobber; same-column
// increments serialize at the SQL engine.
// ---------------------------------------------------------------------------

// `recordSearch` write path — atomically bump the cadence counter by 1.
export async function bumpSearchCounter(db: Client): Promise<NudgeState> {
  await ensureNudgeState(db);
  await db.execute({
    sql: "UPDATE embeddings_nudge_state SET searches_since_ask = searches_since_ask + 1 WHERE id = ?",
    args: [SINGLETON_ID],
  });
  return (await readRow(db))!;
}

// `recordDecline` write path — atomically bump the explicit-decline counter by 1.
export async function bumpDeclineCount(db: Client): Promise<NudgeState> {
  await ensureNudgeState(db);
  await db.execute({
    sql: "UPDATE embeddings_nudge_state SET explicit_decline_count = explicit_decline_count + 1 WHERE id = ?",
    args: [SINGLETON_ID],
  });
  return (await readRow(db))!;
}

// `recordAsked` write path — atomically stamp last_ask_at to `nowIso` and reset
// searches_since_ask to 0 in ONE statement (both columns belong to the same
// "an ask was surfaced" event, so they move together atomically).
export async function markAsked(db: Client, nowIso: string): Promise<NudgeState> {
  await ensureNudgeState(db);
  await db.execute({
    sql: "UPDATE embeddings_nudge_state SET last_ask_at = ?, searches_since_ask = 0 WHERE id = ?",
    args: [nowIso, SINGLETON_ID],
  });
  return (await readRow(db))!;
}

// `recordNever` write path — atomically set the hard never-flag.
export async function markNever(db: Client): Promise<NudgeState> {
  await ensureNudgeState(db);
  await db.execute({
    sql: "UPDATE embeddings_nudge_state SET disabled = 1 WHERE id = ?",
    args: [SINGLETON_ID],
  });
  return (await readRow(db))!;
}

// Clear the explicit-decline counter (release review FIX 8). Called on a SUCCESSFUL
// `model fetch` so a clean-slate state isn't suppressed by pre-enable declines if
// the cache is later evicted. Atomic, column-scoped.
export async function clearDeclineCount(db: Client): Promise<NudgeState> {
  await ensureNudgeState(db);
  await db.execute({
    sql: "UPDATE embeddings_nudge_state SET explicit_decline_count = 0 WHERE id = ?",
    args: [SINGLETON_ID],
  });
  return (await readRow(db))!;
}
