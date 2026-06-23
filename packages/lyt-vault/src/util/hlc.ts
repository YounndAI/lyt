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

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLytHome } from "./paths.js";

// Fed-v2 convergence-hardening (Slice 1a) — a small Hybrid Logical Clock.
//
// WHY: the alias rail is a `name → one rid` REGISTER (last-writer-wins per
// name), NOT an OR-Set. A register needs a TOTAL, monotone merge order so two
// disjoint writer shards can be reconciled into ONE winner per name without a
// global coordinator. Wall-clock alone cannot do this — clocks skew across
// machines, so a `Date.now()` from a fast machine would always beat a slow one
// regardless of causal order. An HLC (Lamport, 2014 — "Logical Physical
// Clocks") tracks `(wallMs, counter)`: it follows wall-clock when it advances,
// and bumps the logical `counter` when it does not, so the clock NEVER goes
// backwards even under skew, while staying close to real time for humans.
//
// This is the merge key for the alias register. `compareHlc` + the writerId
// tiebreak (compareHlcStamped) give a strict total order, so two writers that
// stamp the "same" instant still order deterministically and never collide.

export interface Hlc {
  // Physical component: a wall-clock reading in epoch millis (Date.now()).
  wallMs: number;
  // Logical component: monotonic tiebreak within the same wallMs. Resets to 0
  // whenever wallMs advances; increments when it does not.
  counter: number;
}

// Advance a clock by one tick. Standard HLC send/local event rule against the
// last-seen clock:
//   now = Date.now()
//   if now > prev.wallMs  → {wallMs: now, counter: 0}     (wall-clock advanced)
//   else                  → {wallMs: prev.wallMs, counter: prev.counter + 1}
// The `else` branch is the anti-skew guard: if the wall-clock did NOT advance
// past the last-seen reading (it stalled, or it jumped BACKWARDS), the clock
// still moves forward via the logical counter — it can never regress.
export function nextHlc(prevSeen: Hlc | null): Hlc {
  const now = Date.now();
  if (prevSeen === null) {
    return { wallMs: now, counter: 0 };
  }
  if (now > prevSeen.wallMs) {
    return { wallMs: now, counter: 0 };
  }
  // now <= prev.wallMs — wall-clock stalled or went backwards. Hold the
  // (greater-or-equal) prior wallMs and bump the logical counter so the new
  // clock strictly dominates the prior one in the total order.
  return { wallMs: prevSeen.wallMs, counter: prevSeen.counter + 1 };
}

// Partial order over the physical+logical pair: (wallMs, counter) lexicographic.
// Returns <0 if a<b, >0 if a>b, 0 if equal on BOTH components. NOTE: equal here
// means "same logical instant" — two DIFFERENT writers can produce equal Hlc
// values; use compareHlcStamped for the writerId-broken TOTAL order.
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}

// The TOTAL order over (wallMs, counter, writerId, seq). writerId breaks an
// exact (wallMs, counter) tie across DIFFERENT writers; `seq` — a per-writer
// strictly-monotonic counter persisted under the SAME lock as the clock — is
// the FINAL never-collide tiebreaker so two writes from the SAME writer that
// somehow stamp an identical (hlc, writerId) (e.g. two concurrent same-machine
// processes that raced the persisted high-water mark before the lock serialised
// them) STILL order deterministically. With (wallMs, counter, writerId, seq)
// the merge key is provably collision-proof: two distinct writes can never tie.
//
// `seq` is OPTIONAL on the inputs: a legacy record / pinned-clock test that
// carries no seq is treated as seq=0, so the order stays well-defined for mixed
// records. writerId is compared lexicographically (the stable UUIDv7 shard id).
export function compareHlcStamped(
  a: { hlc: Hlc; writerId: string; seq?: number },
  b: { hlc: Hlc; writerId: string; seq?: number },
): number {
  const byClock = compareHlc(a.hlc, b.hlc);
  if (byClock !== 0) return byClock;
  if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
  const aSeq = a.seq ?? 0;
  const bSeq = b.seq ?? 0;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}

// Compact serialization: `wallMs.counter` (e.g. `1718900000000.5`). The dot is
// a safe separator — both components are non-negative integers, so the string
// is parseable and lexicographic-free (we always parse → numbers → compareHlc).
// Stored in the @ALIAS record's `hlc` field and in the per-writer clock file.
export function serializeHlc(hlc: Hlc): string {
  return `${hlc.wallMs}.${hlc.counter}`;
}

// Parse `wallMs.counter`. Returns null on any malformed input (caller treats a
// null as "no clock" — re-mints from now). Defensive: only the FIRST dot
// splits, both halves must be non-negative integers.
export function parseHlc(raw: string): Hlc | null {
  const trimmed = raw.trim();
  const dot = trimmed.indexOf(".");
  if (dot < 0) return null;
  const wallStr = trimmed.slice(0, dot);
  const counterStr = trimmed.slice(dot + 1);
  if (!/^\d+$/.test(wallStr) || !/^\d+$/.test(counterStr)) return null;
  const wallMs = Number(wallStr);
  const counter = Number(counterStr);
  if (!Number.isSafeInteger(wallMs) || !Number.isSafeInteger(counter)) return null;
  return { wallMs, counter };
}

// ---- Monotonic per-writer persistence (the anti-skew guard across restarts) ----
//
// The writer keeps a SINGLE last-emitted HLC, persisted machine-locally next to
// writer.yon (same dir + same dependency-free permissive read/write pattern).
// `stampNext` loads it, advances via nextHlc, persists the new clock, and
// returns it — so the emitted clock is monotone NOT just within a process but
// ACROSS process restarts. Without this, a fresh process would start from
// `Date.now()` and a backwards wall-clock jump could re-emit a clock the writer
// already used; persisting the high-water mark forecloses that.

const HLC_DOC_ID = "lyt-hlc";

// Machine-local HLC high-water-mark file. Co-located with writer.yon under
// getLytHome() so a test isolates via LYT_HOME and it is never inside a pod
// repo working tree (it is per-writer state, never git-synced).
export function getHlcPath(): string {
  return join(getLytHome(), "hlc.yon");
}

// Permissive parse — pulls the serialized clock from the first `@HLC` line. The
// stored form is `clock=wallMs.counter`. Returns null when absent/empty/malformed
// (caller starts from null → nextHlc seeds from now).
export function parseHlcYon(rawFile: string): Hlc | null {
  const line = rawFile.split(/\r?\n/).find((l) => l.startsWith("@HLC "));
  if (line === undefined) return null;
  const m = line.match(/\bclock=([^\s|]+)/);
  if (m === null || m[1] === undefined || m[1].length === 0) return null;
  return parseHlc(m[1]);
}

// Permissive parse — pulls the per-writer monotonic `seq` from the first `@HLC`
// line (`seq=<n>`). Returns 0 when absent/malformed (a legacy file written
// before seq existed has no `seq=` token → fresh writers start at 0).
export function parseSeqYon(rawFile: string): number {
  const line = rawFile.split(/\r?\n/).find((l) => l.startsWith("@HLC "));
  if (line === undefined) return 0;
  const m = line.match(/\bseq=(\d+)/);
  if (m === null || m[1] === undefined) return 0;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function renderHlcYon(hlc: Hlc, seq: number): string {
  return (
    `@DOC ver=2.0 | id=${HLC_DOC_ID} | domain=yai.lyt\n` +
    `\n` +
    `@HLC clock=${serializeHlc(hlc)} | seq=${seq}\n`
  );
}

// Load the persisted high-water mark (or null if none/unreadable).
export function loadPersistedHlc(path?: string): Hlc | null {
  const p = path ?? getHlcPath();
  if (!existsSync(p)) return null;
  try {
    return parseHlcYon(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Load the persisted per-writer seq high-water mark (0 if none/unreadable).
export function loadPersistedSeq(path?: string): number {
  const p = path ?? getHlcPath();
  if (!existsSync(p)) return 0;
  try {
    return parseSeqYon(readFileSync(p, "utf8"));
  } catch {
    return 0;
  }
}

function persistHlc(hlc: Hlc, seq: number, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderHlcYon(hlc, seq), "utf8");
}

// A stamped clock: the HLC merge key + the per-writer monotonic `seq` (the final
// collision-proof tiebreaker). Both are written into the @ALIAS record so the
// fold's total order is (wallMs, counter, writerId, seq).
export interface StampedClock {
  hlc: Hlc;
  seq: number;
}

export interface StampNextOpts {
  // The MAX hlc this writer has OBSERVED across all synced shards (its own +
  // every foreign writer's). The HLC RECEIVE RULE: a write must dominate not
  // just this writer's local clock but everything it has already seen, else a
  // lagging-wall-clock machine could stamp BELOW a remote it already observed
  // and its causally-later write would LOSE the fold. Computed by the flow
  // (which already enumerates the shards) and threaded down. Omit → null (the
  // pure local-clock behaviour, e.g. a non-alias caller with nothing observed).
  observedMaxHlc?: Hlc | null;
  // Test seam — the per-writer HLC clock-file path (defaults to getHlcPath()).
  path?: string;
}

// ---- Cross-process lock (serialise the load→tick→persist read-modify-write) ----
//
// Two same-machine processes (e.g. an automator run + a user session) can both
// load the same persisted high-water mark, tick it, and emit the SAME
// (hlc, writerId) — a merge-key collision the fold would have to break by
// shard-walk order (non-deterministic). We make the whole read-modify-write
// MUTUALLY EXCLUSIVE with an O_EXCL lockfile next to the clock file (mirrors the
// ledger writer's fs-only atomicity discipline — no new npm dependency). The
// `seq` tiebreaker (incremented under THIS lock) is the belt-and-braces final
// guarantee even if a lock ever fails to hold.

const LOCK_SUFFIX = ".lock";
const LOCK_MAX_RETRIES = 100;
const LOCK_RETRY_SLEEP_MS = 5;

// Busy-wait sleep (sync) — stampNext is a synchronous API on a fs-only path; a
// short bounded spin is acceptable for a low-frequency (alias) write. Bounded by
// LOCK_MAX_RETRIES so it can never spin unboundedly.
function sleepSyncMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait
  }
}

// Acquire an exclusive lock by O_EXCL-creating `<path>.lock`. Bounded retry; on
// exhaustion we STEAL the lock (a crashed holder left a stale lockfile — better
// to proceed than to wedge every future stamp). Returns the lock path to release.
function acquireHlcLock(path: string): string {
  const lockPath = `${path}${LOCK_SUFFIX}`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt += 1) {
    try {
      // 'wx' = O_CREAT | O_EXCL — fails if the lockfile already exists, so only
      // ONE process holds it at a time.
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return lockPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      sleepSyncMs(LOCK_RETRY_SLEEP_MS);
    }
  }
  // Retries exhausted — assume a crashed holder left a stale lock; steal it.
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // ignore — best effort
  }
  const fd = openSync(lockPath, "w");
  closeSync(fd);
  return lockPath;
}

function releaseHlcLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // ignore — best effort; a leftover lockfile is stolen on next contention.
  }
}

// Advance + persist the writer's clock by one tick and return it, paired with a
// strictly-monotonic per-writer `seq`. The returned (hlc, writerId, seq) is the
// merge key written into the @ALIAS record.
//
// Monotone across process restarts (loads the persisted high-water mark first),
// against wall-clock regression (nextHlc's else-branch bumps the counter), AND —
// the RECEIVE RULE — against a lagging local clock that has nonetheless OBSERVED
// a higher remote hlc: the seed is the MAX of (local HWM, observedMaxHlc), so
// nextHlc strictly dominates BOTH. The whole load→tick→persist is serialised by
// a cross-process lockfile so two same-machine processes never race the HWM, and
// `seq` is the final never-collide tiebreaker.
//
// `writerId` is accepted so callers thread the SAME id they use for the shard
// dir, keeping the stamped clock and the shard owner aligned (the total order's
// writerId tiebreak).
export function stampNext(_writerId: string, opts?: StampNextOpts): StampedClock {
  const p = opts?.path ?? getHlcPath();
  const observedMaxHlc = opts?.observedMaxHlc ?? null;
  const lockPath = acquireHlcLock(p);
  try {
    const localHwm = loadPersistedHlc(p);
    // RECEIVE RULE: seed = MAX(local HWM, observedMaxHlc). nextHlc strictly
    // dominates its argument, so the new stamp dominates BOTH the local clock AND
    // everything observed in synced shards → a causally-later write always wins.
    let seed = localHwm;
    if (observedMaxHlc !== null) {
      seed = seed === null || compareHlc(observedMaxHlc, seed) > 0 ? observedMaxHlc : seed;
    }
    const next = nextHlc(seed);
    const seq = loadPersistedSeq(p) + 1;
    persistHlc(next, seq, p);
    return { hlc: next, seq };
  } finally {
    releaseHlcLock(lockPath);
  }
}
