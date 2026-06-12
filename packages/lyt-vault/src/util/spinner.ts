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

// v1.GP F7 — Claude-style hand-rolled spinner for long/network ops.
//
// Surfaced by the 2026-06-02 dogfooding findings (F7): `lyt init` froze
// silently during gh/network ops with no liveness indicator. This wraps any
// async op in a braille spinner that shows (a) which REAL op is running as a
// single gerund, and (b) a live elapsed-seconds counter — so the handler sees
// the process is alive, not hung.
//
// Design constraints (brief WS3):
// - NO new dependency — hand-rolled with process.stdout writes + a timer.
// - Braille frames ⠋⠙⠹⠸⠼⠴⠦⠧ at ~80ms/frame.
// - Single gerund mapped to the REAL op + live `(2s)` elapsed.
// - Honesty: the word reflects the actual running op (op→word map below).
// - Liveness: on ops >~3s, rotate among 2-3 op-relevant synonyms (never
// off-topic — the synonyms are scoped to THAT op).
// - MANDATORY non-TTY fallback: when !process.stdout.isTTY (piped / CI /
// dumb console), print the label ONCE, no animation, ZERO escape codes.
// Nothing ever renders garbled into a pipe or log.
// - Cursor restored on throw (try/finally + show-cursor on stop).

// Braille spinner frames. 8-frame cycle at ~80ms = a smooth ~640ms rotation.
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
const FRAME_INTERVAL_MS = 80;

// Threshold past which a long op rotates among its synonym set for liveness.
const SYNONYM_ROTATE_AFTER_MS = 3000;
// How often the synonym advances once past the threshold.
const SYNONYM_ROTATE_EVERY_MS = 1500;

// ANSI control sequences. Only ever emitted on a real TTY (guarded below).
const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K`;
const CR = "\r";

// Op → gerund-set map. The FIRST entry is the primary word shown immediately;
// the rest are op-scoped synonyms rotated on >3s ops (brief WS3 — never
// off-topic). Adding a new long op = add a key here.
//
// Per brief op→word map:
// create=Forging · push=Unfurling (→Publishing→Syncing on >3s) ·
// clone=Summoning · git-init/commit=Scaffolding/Committing · index/lanes=
// Weaving · federation rebuild=Crystallizing · adopt-detect probe=Scouting ·
// skills symlink=Linking · agent-manual inject=Inscribing · pod-map gen=
// Mapping · install=Installing.
export type SpinnerOp =
  | "create"
  | "push"
  | "clone"
  | "git-init"
  | "commit"
  | "index"
  | "lanes"
  | "rebuild"
  | "probe"
  | "skills-link"
  | "agent-manual"
  | "pod-map"
  | "install"
  // V-DX-1 — consumer/maintenance command ops (generalize F7 across the
  // command surface). Each gerund stays HONEST to the op the user invoked.
  | "search"
  | "primer"
  | "reindex"
  | "repair"
  | "doctor"
  | "mesh-info"
  | "vault-list"
  | "sync";

const OP_WORDS: Record<SpinnerOp, readonly string[]> = {
  create: ["Forging", "Minting", "Shaping"],
  push: ["Unfurling", "Publishing", "Syncing"],
  clone: ["Summoning", "Fetching", "Pulling"],
  "git-init": ["Scaffolding", "Initialising"],
  commit: ["Committing", "Recording"],
  index: ["Weaving", "Indexing"],
  lanes: ["Weaving", "Sorting"],
  rebuild: ["Crystallizing", "Rebuilding", "Reconciling"],
  probe: ["Scouting", "Probing"],
  "skills-link": ["Linking", "Symlinking"],
  "agent-manual": ["Inscribing", "Injecting"],
  "pod-map": ["Mapping", "Charting"],
  install: ["Installing", "Fetching"],
  // V-DX-1 — see SpinnerOp note above. First word shows immediately; the
  // rest rotate on >3s ops (all scoped to THAT op — never off-topic).
  search: ["Searching", "Querying"],
  primer: ["Priming", "Gathering"],
  reindex: ["Reindexing", "Rebuilding"],
  repair: ["Repairing", "Reconciling"],
  doctor: ["Diagnosing", "Checking"],
  "mesh-info": ["Reading", "Fetching"],
  "vault-list": ["Listing", "Loading"],
  sync: ["Syncing", "Pushing", "Pulling"],
};

// v1.GP F7-followup — single-spinner invariant. A phase-spanning spinner
// (startSpinner) and a per-op spinner (withSpinner) must never animate the
// SAME stream concurrently — two timers fighting over one line + cursor would
// produce a garbled, dueling-clock render. The init orchestration drives a
// phase-spanning spinner around flows whose deep internals ALSO call
// withSpinner (gh/git network ops). When a phase spinner already owns a
// stream, the inner withSpinner defers: it runs fn WITHOUT drawing, leaving
// the outer spinner's honest phase label + whole-init elapsed on screen.
// Keyed by the stream object so independent streams (tests) don't interfere.
//
// CAVEAT (V-DX-1): ONLY startSpinner registers here — a withSpinner does NOT.
// So a withSpinner nested inside ANOTHER withSpinner on the same stream does
// NOT defer (both timers animate → dueling clocks). The V-DX-1 command wraps
// are withSpinner-OUTERS; they stay safe ONLY because their wrapped flows
// never call withSpinner / spinGh / spinGit internally (the gh/git network
// spinners fire sequentially AFTER the wrap resolves, not nested). If a
// wrapped flow ever needs its own internal network spinner, promote the outer
// to startSpinner (which registers here) rather than nesting a withSpinner.
const ACTIVE_PHASE_SPINNERS = new WeakSet<NodeJS.WriteStream>();

export interface WithSpinnerOptions {
  // The real op this spinner represents — selects the gerund + synonym set.
  // Required so the word is HONEST about what's running.
  op: SpinnerOp;
  // Stream override (tests inject a fake; production uses process.stdout).
  stream?: NodeJS.WriteStream;
  // Force the TTY decision (tests). When undefined, derived from stream.isTTY.
  isTty?: boolean;
  // Deterministic clock seam (tests). Returns ms-since-epoch.
  now?: () => number;
}

// Pick the gerund for `op` at `elapsedMs`. Before the rotate threshold, always
// the primary word; past it, advance through the op's synonym set on a fixed
// cadence (wrapping). Pure — unit-testable without timers.
export function spinnerWordForOp(op: SpinnerOp, elapsedMs: number): string {
  const words = OP_WORDS[op];
  if (elapsedMs < SYNONYM_ROTATE_AFTER_MS || words.length <= 1) {
    return words[0]!;
  }
  const steps = Math.floor((elapsedMs - SYNONYM_ROTATE_AFTER_MS) / SYNONYM_ROTATE_EVERY_MS);
  // steps=0 lands on index 1 (first synonym) the moment we cross the
  // threshold, then advances; wrap across the full word list.
  return words[(steps + 1) % words.length]!;
}

// Compose the full spinner line for a frame. Exported for unit tests.
export function renderSpinnerLine(
  frame: string,
  word: string,
  label: string,
  elapsedMs: number,
): string {
  const secs = Math.floor(elapsedMs / 1000);
  const tail = label.length > 0 ? ` ${label}` : "";
  return `${frame} ${word}${tail}…  (${secs}s)`;
}

// Run `fn` while showing a live spinner. Returns fn's resolved value; on
// rejection, the spinner is torn down (cursor restored, line cleared) BEFORE
// the error propagates, so a thrown op never leaves a half-drawn line or a
// hidden cursor.
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  opts: WithSpinnerOptions,
): Promise<T> {
  const stream = opts.stream ?? process.stdout;
  const isTty = opts.isTty ?? stream.isTTY === true;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const primaryWord = OP_WORDS[opts.op][0]!;

  // Defer to an already-active phase-spanning spinner on this stream: run fn
  // WITHOUT drawing so the two timers don't fight over the line/cursor. The
  // outer phase spinner keeps its honest phase label + whole-init elapsed on
  // screen across this inner op. (Non-TTY phase spinners don't register, so a
  // piped run still takes the plain-label branch below.)
  if (ACTIVE_PHASE_SPINNERS.has(stream)) {
    return fn();
  }

  // Non-TTY fallback (MANDATORY): print the label ONCE, plain text, ZERO
  // escape codes. No timer, no cursor codes — nothing that could garble a
  // pipe / CI log. The op still completes; only the animation is suppressed.
  if (!isTty) {
    const tail = label.length > 0 ? ` ${label}` : "";
    stream.write(`${primaryWord}${tail}…\n`);
    return fn();
  }

  let timer: NodeJS.Timeout | undefined;
  let frameIdx = 0;
  let stopped = false;

  const draw = (): void => {
    const elapsedMs = now() - startedAt;
    const frame = BRAILLE_FRAMES[frameIdx % BRAILLE_FRAMES.length]!;
    const word = spinnerWordForOp(opts.op, elapsedMs);
    stream.write(`${CR}${CLEAR_LINE}${renderSpinnerLine(frame, word, label, elapsedMs)}`);
    frameIdx += 1;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    // Clear the spinner line + restore the cursor. Always runs (finally),
    // so an exception cannot leave the cursor hidden or a frame on screen.
    stream.write(`${CR}${CLEAR_LINE}${SHOW_CURSOR}`);
  };

  stream.write(HIDE_CURSOR);
  draw(); // immediate first frame so there's no blank gap before the timer
  timer = setInterval(draw, FRAME_INTERVAL_MS);
  // Don't keep the event loop alive purely for the spinner timer.
  if (typeof timer.unref === "function") timer.unref();

  try {
    return await fn();
  } finally {
    stop();
  }
}

// v1.GP F7-followup — phase-spanning persistent spinner.
//
// `withSpinner` (above) wraps a SINGLE async op. The dogfooding F7-followup
// finding showed `lyt init` runs a chain of mostly-SYNCHRONOUS phases (mesh
// forge, vault scaffold, libSQL writes, git init, pod.yon write) with
// only the 3 gh/git network spawns wrapped — so the indicator started ~3-5s
// late, flashed for 1-2s, then went dark during the surrounding sync work.
//
// Single-threaded Node CANNOT animate frames during a blocking sync call —
// the timer can't fire while the call stack is busy. So this does NOT fake
// progress on a side thread. Instead it spans the WHOLE init with one
// persistent spinner whose LABEL + ELAPSED change at every phase boundary.
// The caller yields (`await new Promise((r) => setImmediate(r))`) between
// phases, which lets the render interval fire AT the boundary — so the label
// and the (Ns) counter visibly advance each phase even though frames may
// micro-stutter inside one heavy sync call (an accepted single-thread limit).
//
// Non-TTY: each phase prints its label ONCE, zero escape codes (same MANDATORY
// fallback contract as withSpinner). Cursor hidden on start, restored on
// stop() AND on any throw — the caller wraps phase-driving in try/finally and
// calls stop() in finally, so an exception never leaves the cursor hidden.

export interface PhaseSpinnerHandle {
  // Switch the spinner to a new phase: selects the honest op gerund + an
  // optional label tail. Redraws immediately (TTY) or prints the label once
  // (non-TTY). Safe to call after stop() (no-op).
  phase(op: SpinnerOp, label?: string): void;
  // Tear down: clear the line + restore the cursor (TTY) — idempotent, so
  // calling it twice (e.g. explicit stop() + a finally) is safe.
  stop(): void;
}

export interface StartSpinnerOptions {
  // Stream override (tests inject a fake; production uses process.stdout).
  stream?: NodeJS.WriteStream;
  // Force the TTY decision (tests). When undefined, derived from stream.isTTY.
  isTty?: boolean;
  // Deterministic clock seam (tests). Returns ms-since-epoch.
  now?: () => number;
}

// Start a persistent phase-spanning spinner. The elapsed `(Ns)` counter runs
// from this call (whole-init elapsed — honest, ticks across phase boundaries).
// The first phase is set by the first `phase()` call; nothing renders until
// then (no op word to be honest about yet).
export function startSpinner(opts: StartSpinnerOptions = {}): PhaseSpinnerHandle {
  const stream = opts.stream ?? process.stdout;
  const isTty = opts.isTty ?? stream.isTTY === true;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  let currentOp: SpinnerOp | undefined;
  let currentLabel = "";
  let timer: NodeJS.Timeout | undefined;
  let frameIdx = 0;
  let stopped = false;
  let cursorHidden = false;

  // Claim the stream so a nested withSpinner (deep inside the flows this
  // spans) defers instead of fighting for the line/cursor. Released in stop().
  ACTIVE_PHASE_SPINNERS.add(stream);

  const draw = (): void => {
    if (currentOp === undefined) return;
    const elapsedMs = now() - startedAt;
    const frame = BRAILLE_FRAMES[frameIdx % BRAILLE_FRAMES.length]!;
    const word = spinnerWordForOp(currentOp, elapsedMs);
    stream.write(`${CR}${CLEAR_LINE}${renderSpinnerLine(frame, word, currentLabel, elapsedMs)}`);
    frameIdx += 1;
  };

  return {
    phase(op: SpinnerOp, label = ""): void {
      if (stopped) return;
      currentOp = op;
      currentLabel = label;

      // Non-TTY: print the phase label ONCE, plain text, ZERO escape codes.
      // No timer, no cursor codes — nothing that could garble a pipe / CI log.
      if (!isTty) {
        const word = OP_WORDS[op][0]!;
        const tail = label.length > 0 ? ` ${label}` : "";
        stream.write(`${word}${tail}…\n`);
        return;
      }

      // TTY: hide the cursor on first phase, draw an immediate frame so the
      // label switch is visible at the boundary, and (re)start the frame timer.
      if (!cursorHidden) {
        stream.write(HIDE_CURSOR);
        cursorHidden = true;
      }
      draw();
      if (timer === undefined) {
        timer = setInterval(draw, FRAME_INTERVAL_MS);
        // Don't keep the event loop alive purely for the spinner timer.
        if (typeof timer.unref === "function") timer.unref();
      }
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      ACTIVE_PHASE_SPINNERS.delete(stream);
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      // Only emit teardown escape codes on a TTY (non-TTY never hid anything).
      if (isTty && cursorHidden) {
        // Clear the spinner line + restore the cursor. Always reachable via
        // the caller's finally, so an exception can't leave the cursor hidden.
        stream.write(`${CR}${CLEAR_LINE}${SHOW_CURSOR}`);
      }
    },
  };
}
