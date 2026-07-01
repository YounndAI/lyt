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

// owned-fetch foundation (plan 2026-06-30 Phases 0.1 / A / E-spike / G).
//
// fastembed's own download (`downloadFileFromGCS` → `decompressToCache`) has NO
// timeout, NO stall detection, NO atomic rename (it writes the tar in-place and
// extracts in-place), and NO single-flight lock — a stalled GCS fetch hung the
// 0.9.8 interactive reindex for ~700s. This module OWNS the fetch instead: it
// streams the model tarball to a TEMP dir under the cache root, aborts on an
// idle/stall timeout, decompresses, then ATOMICALLY renames the extracted
// `<model>/` into place. Because fastembed treats `<cacheDir>/<model>` existing
// as "already downloaded" (retrieveModel returns it WITHOUT downloading), once
// WE populate that path fastembed never touches the network — we are the fetch.
//
// The contract: fetchModel NEVER throws. Every failure mode (offline, stalled,
// locked, corrupt, generic error) is returned as a discriminated result so the
// caller degrades to lexical search cleanly. The atomic rename makes "final
// path exists" inherently mean "complete" (plan F-G.1) — a half-written model is
// never visible at the final path, so no external checksum is needed (fastembed
// publishes none anyway).

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pid } from "node:process";

import {
  DEFAULT_EMBEDDINGS_FETCH_TIMEOUT_MS,
  EMBEDDING_MODEL_ID,
  embeddingsCacheDir,
  embeddingsFetchTimeoutMs,
  modelCachePresent,
} from "./embeddings.js";

// The GCS host fastembed downloads from (confirmed in fastembed.js
// downloadFileFromGCS: `https://storage.googleapis.com/qdrant-fastembed/<model>.tar.gz`).
// Overridable via LYT_EMBEDDINGS_MODEL_URL_BASE — a TEST SEAM so unit tests can
// point the fetch at a local mock HTTP server instead of the network. The base
// is suffixed with `/<model>.tar.gz`.
const DEFAULT_MODEL_URL_BASE = "https://storage.googleapis.com/qdrant-fastembed";

// MAJOR-security fix (release review 2026-06-30): the LYT_EMBEDDINGS_MODEL_URL_BASE
// override + the http→httpGet transport switch are a TEST SEAM ONLY. Left live in
// production they would be a plaintext-downgrade + arbitrary-host primitive (any
// process that can set the env var redirects the model fetch to an attacker host,
// over cleartext). They are honored ONLY under a test signal (vitest sets VITEST;
// NODE_ENV=test). In production this returns false → the override is ignored and
// the transport is https-only by construction (see request() below).
function testSeamEnabled(): boolean {
  return process.env["VITEST"] !== undefined || process.env["NODE_ENV"] === "test";
}

export function modelUrlBase(): string {
  if (testSeamEnabled()) {
    const override = process.env["LYT_EMBEDDINGS_MODEL_URL_BASE"];
    if (override !== undefined && override.length > 0) return override.replace(/\/+$/, "");
  }
  // Production: always the hardcoded https GCS default; the override is ignored.
  return DEFAULT_MODEL_URL_BASE;
}

// Honest User-Agent for the owned model fetch (Phase H #4). We identify as
// `lyt/<version>` instead of spoofing a browser (`Mozilla/5.0`) — aligns the
// never-phone-home / honest-consent posture: the fetch announces itself truthfully.
// Computed ONCE at module scope. The version read is defensive: a missing/corrupt
// package.json must never crash the fetch util, so it falls back to a bare `lyt`.
// Read inline (util must not depend on flows/) using the same createRequire idiom
// as src/cli.ts; fetch-model.ts is in src/util/, so package.json is two levels up.
const MODEL_FETCH_UA: string = (() => {
  try {
    const version = (
      createRequire(import.meta.url)("../../package.json") as { version?: string }
    ).version;
    if (typeof version === "string" && version.length > 0) return `lyt/${version}`;
  } catch {
    /* fall through to bare UA */
  }
  return "lyt";
})();

function modelTarUrl(model: string): string {
  return `${modelUrlBase()}/${model}.tar.gz`;
}

// How long a held lock is allowed to be before we treat it as stale and reclaim
// it (the holder crashed without releasing). The threshold COUPLES to the idle
// cap: max(10min, idleCap*2). This gives HEADROOM over a SINGLE idle-cap window
// — a progressing fetch can legitimately run longer than one idle window — which
// closes the common case (a flat 10min would let a sibling reclaim the lock of a
// long-but-still-active fetch when the env-tunable idle cap exceeds 10min,
// defeating single-flight: two concurrent downloads). It is NOT a total-wall-time
// bound: the idle cap bounds inter-byte GAPS, not total download wall-time, and
// the lock timestamp is written once at acquire and never refreshed mid-fetch —
// so a fetch that legitimately dribbles (resets the idle timer on each chunk)
// beyond 2*idleCap of total runtime can STILL be reclaimed by a sibling. That
// residual is non-corrupting (the atomic publish-by-rename means two concurrent
// downloads cannot poison the final path) and self-healing; the COMPLETE fix
// (refresh the lock timestamp mid-fetch) is deferred to a later sub-gate.
function staleLockMs(): number {
  return Math.max(10 * 60 * 1000, embeddingsFetchTimeoutMs() * 2);
}

// How long to wait to ACQUIRE the lock before giving up and returning
// classification:"locked" (the caller degrades to lexical, another lyt process
// is fetching). Polled.
const LOCK_ACQUIRE_TIMEOUT_MS = 30 * 1000;
const LOCK_POLL_MS = 250;

export type FetchModelResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      classification: "offline" | "stalled" | "locked" | "corrupt" | "error";
    };

export interface FetchModelOpts {
  // Byte-progress callback. totalBytes is 0 when the server omits content-length.
  onProgress?: (bytesDone: number, totalBytes: number) => void;
  // Cooperative cancellation. Threaded through for Phase G (SIGINT/CLI) — this
  // module only honors it as an abort signal; it does NOT build the full
  // cancellation flow.
  signal?: AbortSignal;
}

function lockPath(cacheDir: string): string {
  return join(cacheDir, ".fetch.lock");
}

// Is a process with this PID alive? `process.kill(pid, 0)` throws ESRCH when the
// process is gone, EPERM when it exists but we can't signal it (still alive).
function pidAlive(targetPid: number): boolean {
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  try {
    process.kill(targetPid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

// True if an existing lockfile is stale (holder dead OR older than staleLockMs())
// and may be reclaimed. A malformed lockfile is treated as stale.
function lockIsStale(file: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // Vanished between checks — treat as reclaimable.
    return true;
  }
  let lockPid = NaN;
  let lockTime = NaN;
  try {
    const parsed = JSON.parse(raw) as { pid?: number; iso?: string };
    lockPid = typeof parsed.pid === "number" ? parsed.pid : NaN;
    lockTime = parsed.iso !== undefined ? Date.parse(parsed.iso) : NaN;
  } catch {
    return true; // malformed → stale
  }
  if (!Number.isNaN(lockPid) && !pidAlive(lockPid)) return true;
  if (!Number.isNaN(lockTime) && Date.now() - lockTime > staleLockMs()) return true;
  return false;
}

// Result of trying to acquire the single-flight lock. MAJOR fix (release review
// 2026-06-30, FIX 3): distinguish a genuine acquire-TIMEOUT (lock held by a live
// sibling past the deadline → classification "locked") from a real lock-WRITE
// failure (EACCES/ENOSPC/EROFS/ENOENT etc. → classification "error" with the
// errno). The prior boolean collapsed both to false, so a write failure produced a
// false "locked" concurrency diagnostic.
interface LockAcquireResult {
  acquired: boolean;
  // Set ONLY when the acquire failed because the lockfile WRITE itself errored
  // with a non-EEXIST code (not a timeout, not an abort). Drives the "error"
  // classification + the real errno.
  error?: NodeJS.ErrnoException;
}

// Acquire the single-flight lock. `acquired:true` on success; `acquired:false`
// with no `error` on acquire-timeout or abort; `acquired:false` with `error` on a
// real write failure. Uses an exclusive create (`wx`) so two racing processes
// can't both win; reclaims a stale lock then retries.
async function acquireLock(cacheDir: string, signal?: AbortSignal): Promise<LockAcquireResult> {
  const file = lockPath(cacheDir);
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  const payload = JSON.stringify({ pid, iso: new Date().toISOString() });
  for (;;) {
    if (signal?.aborted === true) return { acquired: false };
    try {
      writeFileSync(file, payload, { flag: "wx" });
      return { acquired: true };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") {
        // A real write failure (EACCES/ENOSPC/EROFS/ENOENT, cacheDir gone, …) —
        // NOT a concurrency condition. Surface the errno so fetchModel reports
        // classification "error", not the false "locked".
        return { acquired: false, error: e };
      }
      // Lock held — reclaim if stale, else wait.
      if (lockIsStale(file)) {
        try {
          unlinkSync(file);
          // Reclaim succeeded → retry the exclusive create IMMEDIATELY (fast-path,
          // no poll delay): we now own the slot the dead holder vacated.
          continue;
        } catch {
          // BUSY-SPIN FIX (Phase G sub-gate 2a): the unlink FAILED — the stale lock
          // is un-removable (e.g. `.fetch.lock` is a directory, or a Windows handle
          // holds it open). The prior code hit `continue` here with NO delay AND
          // bypassing the deadline check below, so a PERMANENTLY-unremovable stale
          // lock spun the loop at 100% CPU, UNBOUNDED (not capped by
          // LOCK_ACQUIRE_TIMEOUT_MS). Mirror the live-holder path: POLL (delay) and
          // honor the deadline so the acquire eventually TIMES OUT (→ "locked") instead
          // of spinning forever. The successful-reclaim fast-path above keeps its
          // immediate retry — only this failed-unlink case needs the delay+deadline.
          if (Date.now() >= deadline) return { acquired: false };
          await delay(LOCK_POLL_MS, signal);
          continue;
        }
      }
      if (Date.now() >= deadline) return { acquired: false };
      await delay(LOCK_POLL_MS, signal);
    }
  }
}

// Release the single-flight lock on the way out. ATOMIC-READ-SAFE (+[B], release review
// 2026-06-30) — the SIBLING CLASS of the refreshLock torn-read fixed in 8095e52. The
// prior read-then-unlink read the lock, checked ownership (pid), then unlinked — but a
// concurrent atomic refresh/reclaim (refreshLock's temp+rename, or a sibling's stale
// reclaim) landing between the read and the parse could surface a torn/partial body that
// throws in JSON.parse. The prior code's broad catch then SWALLOWED that throw and skipped
// the unlink — so a transient torn read of OUR OWN live lock could leak it (never released),
// leaving a stale lock a sibling must later reclaim. Fix: tolerate a torn/parse-failed read
// WITHOUT misclassifying — retry the read-and-parse a couple of times so a momentary torn
// read (the rename window is sub-millisecond) resolves to a COMPLETE body, and unlink ONLY
// when we cleanly parse a body holding OUR pid. A body holding a FOREIGN pid (a sibling
// reclaimed) is left untouched — never steal the sibling's slot — matching refreshLock's
// pid-guard. A genuinely vanished lock (ENOENT) is already released → nothing to do.
function releaseLock(cacheDir: string): void {
  const file = lockPath(cacheDir);
  // A torn read is transient (the temp→lock rename is atomic + sub-ms); a few retries
  // settle it to a complete body. We never unlink on an unprovable-ownership read.
  const MAX_READ_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt += 1) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      // ENOENT → the lock is already gone (released/reclaimed): nothing to do.
      // Any other read error → best-effort, leave it.
      void err;
      return;
    }
    let parsedPid: number | undefined;
    try {
      parsedPid = (JSON.parse(raw) as { pid?: number }).pid;
    } catch {
      // Torn/partial/malformed body — do NOT unlink (we cannot prove ownership; unlinking
      // here could delete a lock a concurrent writer is mid-installing). Retry the read to
      // catch the post-rename complete body; if it never settles, leave the lock.
      continue;
    }
    // Foreign pid → a sibling reclaimed; leave it. Only WE may release OUR lock.
    if (parsedPid !== pid) return;
    try {
      unlinkSync(file);
    } catch {
      // Vanished/removed between read and unlink, or un-removable — best-effort, fine to leave.
    }
    return;
  }
}

// Deferred-C (Phase G sub-gate 2b) — refresh the lock TIMESTAMP mid-fetch so a
// slow-but-PROGRESSING download whose TOTAL wall-time exceeds staleLockMs()
// (without ever tripping the idle cap) is NOT deemed stale and reclaimed by a
// sibling. acquireLock writes the lock ts ONCE at acquire and never refreshes it;
// this rewrites the lockfile with a fresh `iso` so the age-branch of lockIsStale()
// keeps measuring from the LAST progress tick, not the original acquire time.
//
// PID-GUARD (load-bearing): rewrite ONLY if the lockfile still holds OUR pid. If a
// sibling already reclaimed (the age branch fired before this refresh) the lock now
// holds a FOREIGN pid — clobbering it would steal the sibling's slot and defeat
// single-flight. In that case we no-op (best-effort, like releaseLock). A
// vanished/malformed lock also no-ops. Called THROTTLED from the progress path (see
// fetchModel) so it writes at most ~once per staleLockMs()/3, not on every chunk.
function refreshLock(cacheDir: string): void {
  try {
    const file = lockPath(cacheDir);
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    // Foreign pid → a sibling reclaimed; do NOT clobber. Only WE may refresh OUR lock.
    if (parsed.pid !== pid) return;
    // ATOMIC REWRITE (release review 2026-06-30, FIX 1): the prior in-place
    // writeFileSync(file, …) was a truncate-then-write — non-atomic. A sibling's
    // lockIsStale() doing readFileSync()+JSON.parse() could read the file MID-WRITE,
    // get a torn/partial body, throw in JSON.parse, and treat the lock as malformed →
    // stale → reclaim OUR LIVE lock. Write the new payload to a temp file in the SAME
    // dir, then renameSync(tmp, file): a same-volume FILE-over-FILE rename atomically
    // replaces the destination on BOTH POSIX and Windows (MOVEFILE_REPLACE_EXISTING),
    // so a sibling always reads either the OLD complete lock or the NEW complete lock —
    // never torn. Unique temp name (pid-scoped) so concurrent refreshers don't collide;
    // best-effort temp cleanup on failure.
    const tmp = `${file}.${pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ pid, iso: new Date().toISOString() }));
      renameSync(tmp, file);
    } catch {
      // Rewrite failed — best-effort cleanup of the orphaned temp, then leave the
      // existing (complete) lock untouched.
      try {
        unlinkSync(tmp);
      } catch {
        // temp may not exist / be removable — fine to leave.
      }
    }
  } catch {
    // Best-effort — a missing/foreign/malformed lock is fine to leave untouched.
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
    if (signal !== undefined) {
      const onAbort = (): void => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// Remove orphaned artifacts from a prior aborted run before fetching: a stray
// `<cacheDir>/<model>.tar.gz` and any `<cacheDir>/.tmp-*` temp dirs. Best-effort:
// on Windows a file may still be held open by a dying process → swallow
// EBUSY/EPERM and continue (the NEXT sweep will get it). The lock is NOT swept
// here — acquireLock owns stale-lock reclaim.
function startupSweep(cacheDir: string): void {
  try {
    const strayTar = join(cacheDir, `${EMBEDDING_MODEL_ID}.tar.gz`);
    if (existsSync(strayTar)) safeRm(strayTar);
  } catch {
    // ignore
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".tmp-")) {
      safeRm(join(cacheDir, name));
    }
  }
}

// Best-effort recursive remove; swallows EBUSY/EPERM/ENOENT so a Windows-held
// handle defers cleanup to the next-run sweep instead of failing the fetch.
function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Deferred to the next startup sweep (Windows held the file open).
  }
}

// Classify a download/network error into the result taxonomy.
function classifyNetworkError(err: unknown): "offline" | "stalled" | "error" {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENETUNREACH") {
    return "offline";
  }
  if (/stall|idle|timed? ?out|ETIMEDOUT|aborted/i.test(msg) || code === "ETIMEDOUT") {
    return "stalled";
  }
  return "error";
}

interface DownloadOutcome {
  ok: boolean;
  // "corrupt" added for FIX 1a (byte-completeness): a short body (advertised
  // content-length not met) is a corrupt download, surfaced from the finish
  // handler.
  classification?: "offline" | "stalled" | "error" | "corrupt";
  reason?: string;
}

// Stream the tarball to tarPath. Aborts when NO bytes arrive for idleCapMs (the
// real failure mode — a stalled connection, not a slow one). A slow-but-
// progressing download resets the idle timer on every chunk and is never
// tripped. Follows up to a small number of 3xx redirects defensively.
function downloadTo(
  url: string,
  tarPath: string,
  idleCapMs: number,
  opts: FetchModelOpts,
): Promise<DownloadOutcome> {
  return new Promise<DownloadOutcome>((resolve) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let bytesDone = 0;
    let totalBytes = 0;
    const fileStream = createWriteStream(tarPath);
    let activeReq: ReturnType<typeof httpsGet> | undefined;

    const cleanupTimer = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const finish = (outcome: DownloadOutcome): void => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      try {
        activeReq?.destroy();
      } catch {
        // ignore
      }
      try {
        fileStream.destroy();
      } catch {
        // ignore
      }
      resolve(outcome);
    };

    const onAbort = (): void => {
      finish({ ok: false, classification: "stalled", reason: "aborted via signal" });
    };
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        finish({ ok: false, classification: "stalled", reason: "aborted before start" });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Resolve the effective idle cap. The download idle cap is ALWAYS armed:
    // idleCapMs <= 0 no longer disables it at all — it always falls back to
    // DEFAULT_EMBEDDINGS_FETCH_TIMEOUT_MS so a stalled download is always
    // bounded (a stalled connection would otherwise hang forever — the exact
    // failure this module exists to kill). The abort signal (opts.signal, wired
    // via addEventListener("abort", onAbort) above) is an ADDITIONAL,
    // COMPLEMENTARY bound — the caller can cancel sooner — never a replacement
    // for the idle cap.
    const effectiveIdleCapMs = idleCapMs <= 0 ? DEFAULT_EMBEDDINGS_FETCH_TIMEOUT_MS : idleCapMs;

    const armIdle = (): void => {
      cleanupTimer();
      if (effectiveIdleCapMs <= 0) return; // unreachable: idle cap is always armed (idleCap<=0 → default)
      idleTimer = setTimeout(() => {
        finish({
          ok: false,
          classification: "stalled",
          reason: `download stalled — no bytes for ${effectiveIdleCapMs}ms`,
        });
      }, effectiveIdleCapMs);
      if (idleTimer.unref !== undefined) idleTimer.unref();
    };

    let redirects = 0;
    const MAX_REDIRECTS = 5;

    const request = (target: string): void => {
      // Pick the transport by protocol so the LYT_EMBEDDINGS_MODEL_URL_BASE test
      // seam can point at a local plain-http mock server. MAJOR-security fix
      // (release review 2026-06-30): httpGet (cleartext) is selectable ONLY under the
      // test signal; in production this is ALWAYS httpsGet regardless of the URL —
      // the fetch is https-only by construction, so no plaintext downgrade exists.
      const getFn = testSeamEnabled() && target.startsWith("http://") ? httpGet : httpsGet;
      activeReq = getFn(target, { headers: { "User-Agent": MODEL_FETCH_UA } }, (response) => {
        const status = response.statusCode ?? 0;
        // Defensive 3xx handling — follow Location.
        if (status >= 300 && status < 400 && response.headers.location !== undefined) {
          response.resume(); // drain
          if (redirects >= MAX_REDIRECTS) {
            finish({ ok: false, classification: "error", reason: `too many redirects (${redirects})` });
            return;
          }
          redirects += 1;
          const next = new URL(response.headers.location, target).toString();
          request(next);
          return;
        }
        if (status !== 200) {
          response.resume();
          finish({ ok: false, classification: "error", reason: `unexpected HTTP ${status}` });
          return;
        }
        totalBytes = Number.parseInt(response.headers["content-length"] ?? "0", 10);
        if (!Number.isFinite(totalBytes) || totalBytes < 0) totalBytes = 0;
        armIdle();
        response.on("data", (chunk: Buffer) => {
          bytesDone += chunk.length;
          armIdle();
          if (opts.onProgress) {
            try {
              opts.onProgress(bytesDone, totalBytes);
            } catch {
              // a throwing progress callback must not break the download
            }
          }
        });
        response.on("error", (err) => {
          finish({ ok: false, classification: classifyNetworkError(err), reason: errMsg(err) });
        });
        response.pipe(fileStream);
      });
      activeReq.on("error", (err) => {
        finish({ ok: false, classification: classifyNetworkError(err), reason: errMsg(err) });
      });
    };

    fileStream.on("finish", () => {
      // The write stream finished flushing all piped bytes. CRITICAL fix
      // (release review 2026-06-30, FIX 1a — byte-completeness): "finish" fires when
      // the socket CLOSES, which includes a server that hangs up early. If a
      // content-length was advertised and we received FEWER bytes, the tarball is
      // truncated — a partial gzip that may still extract some files (the poisoned-
      // model path). Reject it here as corrupt so it is never published. When the
      // server omitted content-length (totalBytes===0) we can't byte-check; the
      // sentinel validation before the atomic rename (FIX 1b) is the backstop.
      if (totalBytes > 0 && bytesDone < totalBytes) {
        finish({
          ok: false,
          classification: "corrupt",
          reason: `incomplete download: ${bytesDone}/${totalBytes} bytes`,
        });
        return;
      }
      finish({ ok: true });
    });
    fileStream.on("error", (err) => {
      finish({ ok: false, classification: "error", reason: errMsg(err) });
    });

    // Arm the idle timer immediately so a server that accepts the connection but
    // never sends headers/bytes still trips the stall cap.
    armIdle();
    request(url);
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// CRITICAL fix (release review 2026-06-30, FIX 1b) — the files fastembed actually
// reads from `<model>/` (confirmed in fastembed.js loadTokenizer + init): the four
// JSON config files, plus the ONNX weights (init's `defaultModelName` is
// `model_optimized.onnx` for BGE-small; we require >=1 `*.onnx` rather than pin one
// exact name, so a weights-filename change can't false-fail). Returns the list of
// required files MISSING from `dir` (empty ⇒ complete). A truncated/partial
// extraction is caught here before the atomic publish.
const SENTINEL_JSON_FILES = [
  "tokenizer.json",
  "config.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
] as const;

function missingSentinelFiles(dir: string): string[] {
  const missing: string[] = [];
  for (const f of SENTINEL_JSON_FILES) {
    if (!existsSync(join(dir, f))) missing.push(f);
  }
  let hasOnnx = false;
  try {
    hasOnnx = readdirSync(dir).some((name) => name.toLowerCase().endsWith(".onnx"));
  } catch {
    hasOnnx = false;
  }
  if (!hasOnnx) missing.push("*.onnx");
  return missing;
}

// Own the embedding-model fetch. NEVER throws. On success the model lives at
// `<cacheDir>/<model>/` (atomically published) so a subsequent
// `FlagEmbedding.init({ model, cacheDir })` finds it present and does NOT
// download. See the module header for the full contract.
export async function fetchModel(opts: FetchModelOpts = {}): Promise<FetchModelResult> {
  const cacheDir = embeddingsCacheDir();
  const model = EMBEDDING_MODEL_ID;
  const idleCapMs = embeddingsFetchTimeoutMs();

  // Ensure the cache root exists (lock + temp + final all live under it).
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    return { ok: false, classification: "error", reason: `cannot create cache dir: ${errMsg(err)}` };
  }

  // Fast exit: already published (another process won, or a prior run).
  if (modelCachePresent()) return { ok: true };

  const lock = await acquireLock(cacheDir, opts.signal);
  if (!lock.acquired) {
    // MAJOR fix (release review 2026-06-30, FIX 3): a real lock-WRITE failure is an
    // "error" with its errno; "locked" is reserved for the genuine acquire-timeout
    // (a live sibling held the lock past the deadline).
    if (lock.error !== undefined) {
      return {
        ok: false,
        classification: "error",
        reason: `lock write failed (${lock.error.code ?? "unknown"}): ${errMsg(lock.error)}`,
      };
    }
    return {
      ok: false,
      classification: "locked",
      reason: "waiting for another lyt process to finish fetching the model timed out — continuing with lexical search",
    };
  }

  // From here a single-flight winner owns the fetch; release in finally.
  let tempDir: string | undefined;
  try {
    // Re-check under the lock: the holder we waited behind may have finished.
    if (modelCachePresent()) return { ok: true };

    // Sweep orphans from prior aborted runs (best-effort).
    startupSweep(cacheDir);

    if (opts.signal?.aborted === true) {
      return { ok: false, classification: "stalled", reason: "aborted before fetch" };
    }

    // Per-attempt temp dir under the cache root (same volume → atomic rename).
    const rand = Math.random().toString(36).slice(2, 10);
    tempDir = join(cacheDir, `.tmp-${model}-${pid}-${rand}`);
    mkdirSync(tempDir, { recursive: true });

    const tarPath = join(tempDir, `${model}.tar.gz`);

    // Deferred-C (Phase G sub-gate 2b) — wrap onProgress so every progress tick MAY
    // refresh the lock ts, but actually rewrites the lockfile at most ~once per
    // staleLockMs()/3 (throttle). This keeps a long-but-progressing download's lock
    // fresh so a sibling cannot reclaim it on the AGE branch mid-fetch, WITHOUT a
    // lockfile write on every chunk. The user's onProgress (if any) is always called;
    // a throwing onProgress must NOT break the download, so the call is guarded here
    // exactly as downloadTo's own data-handler guards it (the inner try/catch around
    // opts.onProgress) — belt-and-suspenders since this wrapper is the one passed down.
    const refreshIntervalMs = Math.max(1, Math.floor(staleLockMs() / 3));
    // FIRST-REFRESH TIMING (release review 2026-06-30, FIX 3): the lock's on-disk ts was
    // stamped at acquireLock time; the gap since (the under-lock re-check + startupSweep's
    // fs walk + mkdir) is otherwise added to the worst-case-to-first-refresh budget —
    // unbounded if startupSweep is slow on a temp-backlog box. Re-stamp the lock fresh
    // HERE (right before the download begins) and seed lastRefreshAt to the SAME instant,
    // decoupling first-refresh timing from the acquire→download gap. The progress-path
    // throttle below is unchanged.
    refreshLock(cacheDir);
    let lastRefreshAt = Date.now();
    const userOnProgress = opts.onProgress;
    const fetchOpts: FetchModelOpts = {
      ...opts,
      onProgress: (bytesDone: number, totalBytes: number): void => {
        const now = Date.now();
        if (now - lastRefreshAt >= refreshIntervalMs) {
          lastRefreshAt = now;
          refreshLock(cacheDir);
        }
        if (userOnProgress !== undefined) {
          try {
            userOnProgress(bytesDone, totalBytes);
          } catch {
            // a throwing progress callback must not break the download
          }
        }
      },
    };
    const dl = await downloadTo(modelTarUrl(model), tarPath, idleCapMs, fetchOpts);
    if (!dl.ok) {
      return {
        ok: false,
        classification: dl.classification ?? "error",
        reason: dl.reason ?? "download failed",
      };
    }

    // Sanity: the tar must be non-empty before we spend time extracting.
    try {
      if (statSync(tarPath).size === 0) {
        return { ok: false, classification: "corrupt", reason: "downloaded tarball is empty" };
      }
    } catch (err) {
      return { ok: false, classification: "corrupt", reason: `tarball missing after download: ${errMsg(err)}` };
    }

    // C8 (Phase G sub-gate 2b) — abort guard for the ONE non-cancellable step.
    // tar.x itself takes no AbortSignal, so it cannot be interrupted mid-extract;
    // that residual is ACCEPTED/best-effort (a synthetic/real model extraction is
    // fast — well within the ≤5s cancellation window). But if the signal already
    // fired during the download (Ctrl-C on the interactive path), do NOT even START
    // extraction: bail here so nothing is published. The temp is swept in finally;
    // the atomic temp+rename means a partial extract is never visible at the final
    // path regardless.
    //
    // Read `aborted` into a fresh local: `opts.signal` is not reassigned, so TS's
    // control-flow narrowing from the pre-fetch guard above (:586) would otherwise
    // treat `opts.signal.aborted` as still-false here — but it legitimately flips to
    // true during the awaited download. The local read defeats that stale narrowing.
    const abortedBeforeExtract = opts.signal?.aborted ?? false;
    if (abortedBeforeExtract) {
      return { ok: false, classification: "stalled", reason: "aborted before extract" };
    }

    // Decompress into the temp dir → produces `<tempDir>/<model>/`, mirroring
    // fastembed's decompressToCache layout (tar.x with cwd = the dir).
    const extractDir = tempDir;
    try {
      const tar = await import("tar");
      await tar.x({ file: tarPath, cwd: extractDir });
    } catch (err) {
      return { ok: false, classification: "corrupt", reason: `decompress failed: ${errMsg(err)}` };
    }

    const extractedModelDir = join(extractDir, model);
    if (!existsSync(extractedModelDir)) {
      return {
        ok: false,
        classification: "corrupt",
        reason: `tarball did not contain expected '${model}/' directory`,
      };
    }

    // CRITICAL fix (release review 2026-06-30, FIX 1b — sentinel validation): the
    // dir-existence check above proves the tar produced a `<model>/` dir, NOT that
    // it contains the files fastembed will actually read. A block-aligned truncated
    // tar extracts PARTIALLY (some files, not all) yet still produces the dir — and
    // the atomic rename would then publish a poisoned model that never self-heals.
    // Verify the exact file set fastembed.js loadTokenizer/init reads BEFORE the
    // rename: the four JSON config files + the ONNX weights (default
    // `model_optimized.onnx`; we require at least one `*.onnx` to stay robust to the
    // weights filename). Any missing → corrupt; the temp is swept in finally,
    // nothing is published.
    const missing = missingSentinelFiles(extractedModelDir);
    if (missing.length > 0) {
      return {
        ok: false,
        classification: "corrupt",
        reason: `extracted model incomplete: missing ${missing.join(", ")}`,
      };
    }

    // Atomic publish: rename the extracted model dir into the final path. ONLY
    // on full success → "final path exists" inherently means complete (F-G.1).
    const finalDir = join(cacheDir, model);
    if (existsSync(finalDir)) {
      // A concurrent process published first (we hold the lock, so this is a
      // prior-run remnant or a same-process re-entry). Discard temp, report ok.
      return { ok: true };
    }
    try {
      renameSync(extractedModelDir, finalDir);
    } catch (err) {
      // Lost the publish race (EEXIST/ENOTEMPTY) → another writer won; ok.
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EEXIST" || code === "ENOTEMPTY") && modelCachePresent()) {
        return { ok: true };
      }
      return { ok: false, classification: "error", reason: `atomic publish failed: ${errMsg(err)}` };
    }

    return { ok: true };
  } catch (err) {
    // Belt-and-suspenders: nothing above should throw, but the contract is
    // NEVER-throw, so any escape degrades cleanly.
    return { ok: false, classification: "error", reason: `unexpected fetch error: ${errMsg(err)}` };
  } finally {
    if (tempDir !== undefined) safeRm(tempDir);
    releaseLock(cacheDir);
  }
}
