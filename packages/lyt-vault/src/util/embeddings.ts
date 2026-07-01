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

// feat/microrag-semantic — OPTIONAL local dense-embedding module.
//
// Wraps fastembed's BGE-small-en-v1.5 (int8 ONNX, 384-dim, CPU/onnxruntime —
// NO cloud, NO Ollama) behind a lazy `import()` so the package has ZERO hard
// dependency on it. fastembed lives in `optionalDependencies`: if its
// native onnxruntime can't build, `npm install` still succeeds and this module
// reports "unavailable" cleanly — base search degrades to the lexical+keyphrase
// cascade with no error, no crash. The local model is NOT bundled; fastembed
// lazy-fetches it on first `init()` to the cache dir below.
//
// Proven prototype semantics (.scratch/microrag-eval.mts): fastembed's
// `passageEmbed` prepends "passage: ", `queryEmbed` prepends "query: " (the
// asymmetric BGE prefixes) and unit-normalizes every vector, so a dot product
// of two stored vectors IS their cosine similarity (see cosine() below). This
// module reproduces those exact calls — the lift depends on them.
//
// Determinism: BGE int8 ONNX inference is deterministic for a fixed input on a
// fixed model; there is no Date.now / random anywhere on this path, so the same
// text yields the same vector across runs (a test pins this).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchModel } from "./fetch-model.js";

// The dense model: bge-small-en-v1.5, 384-dim, int8-quantized ONNX.
export const EMBEDDING_DIM = 384;
export const EMBEDDING_MODEL_ID = "fast-bge-small-en-v1.5";

// Hard ceiling on the one-time model fetch + ONNX init. A healthy fetch is
// ~30s (download + load); a transient network stall has NO natural bound, and
// `await FlagEmbedding.init(...)` is otherwise unbounded — that is the root
// cause of the 0.9.8 interactive-reindex hang (a stalled download blocked for
// ~700s because nothing capped it; a hang is not a throw, so the try/catch
// could not catch it). On timeout we degrade to { available:false } → the same
// lexical fallback as offline/error. Generous over the ~30s healthy case so a
// slow link / large platform-specific model isn't false-tripped. Overridable
// via LYT_EMBEDDINGS_FETCH_TIMEOUT_MS. <= 0 behaves differently per consumer:
// for the DOWNLOAD idle cap it ALWAYS falls back to
// DEFAULT_EMBEDDINGS_FETCH_TIMEOUT_MS (the cap is always armed → a stalled
// download is always bounded, regardless of any abort signal; the signal is a
// complementary, not a replacement, bound — see fetch-model.ts
// downloadTo/armIdle). For the ONNX-init withTimeout consumer below, <= 0
// disables that cap outright.
export const DEFAULT_EMBEDDINGS_FETCH_TIMEOUT_MS = 180_000;

export function embeddingsFetchTimeoutMs(): number {
  const raw = process.env["LYT_EMBEDDINGS_FETCH_TIMEOUT_MS"];
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_EMBEDDINGS_FETCH_TIMEOUT_MS;
}

// Where fastembed lazy-fetches the one-time local model on first use. Under the user's
// pod home so it is shared across vaults + survives between runs, and is NOT
// inside any vault tree (never committed/synced). Overridable for tests/bench
// via LYT_EMBEDDINGS_CACHE_DIR.
export function embeddingsCacheDir(): string {
  const override = process.env["LYT_EMBEDDINGS_CACHE_DIR"];
  if (override !== undefined && override.length > 0) return override;
  const home = process.env["LYT_HOME"];
  const base = home !== undefined && home.length > 0 ? home : join(homedir(), "lyt");
  return join(base, ".embeddings-cache");
}

// C-1 (build-path fetch gate) — is the local model ALREADY cached locally?
// fastembed treats the model as present when `<cacheDir>/<model>` exists (it
// returns that dir from retrieveModel WITHOUT downloading: fastembed.js
// `modelDir = join(cacheDir, model); if (existsSync(modelDir)) return modelDir`).
// We mirror that exact check so "cache present → build silently (one-time fetch
// already paid)" never re-prompts, and "cache absent → a fetch WOULD happen" is
// detected BEFORE we call loadEmbedder(). Pure fs probe — no model load, no
// network, no throw.
export function modelCachePresent(): boolean {
  try {
    return existsSync(join(embeddingsCacheDir(), EMBEDDING_MODEL_ID));
  } catch {
    return false;
  }
}

// Phase B (F-B.1) — the `semantic-evicted` classifier. Names the distinct
// state "this pod HAS dense vectors in its corpus, BUT the shared model cache is
// absent/evicted" — so a read can embed nothing and silently falls back to
// lexical (the foundation read-gate already guarantees ZERO network on this
// path). This is a PURE, read-only classification: it deletes/clears NOTHING
// (vectors are non-destructive — they stay, ready for re-fusion the moment the
// model is re-fetched). It is the hook the Phase-D nudge engine and a future v1.1
// "smart-moment" nudge read to decide whether to re-offer the one-time fetch;
// this predicate carries NO nudge logic itself. `denseDocCount` is the number of
// vectors gathered for the query (the caller already has it); `modelPresent`
// should come from modelCachePresent(). True ⇔ vectors exist but the model does
// not.
export function semanticEvicted(args: { denseDocCount: number; modelPresent: boolean }): boolean {
  return args.denseDocCount > 0 && !args.modelPresent;
}

// C-1 (release review Major fold) — the CLI interactivity gate for the
// build-path model fetch. Interactivity requires BOTH stdin AND stdout to be a
// TTY (and not --json): the prompt reads `process.stdin`, so a non-TTY STDIN
// (e.g. `lyt reindex < /dev/null`) must NOT be prompted — per the wizard
// convention (a non-TTY STDIN hangs/auto-accepts). Checking stdout alone let a
// redirected-stdin + TTY-stdout invocation through → un-consented local-model fetch.
// Pure boolean — colocated so both `lyt reindex` and `lyt vault rebuild` share
// one definition.
export function isEmbeddingsInteractive(opts: {
  json?: boolean;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
}): boolean {
  return opts.json !== true && opts.stdinTTY === true && opts.stdoutTTY === true;
}

// Minimal structural type for the fastembed `FlagEmbedding` instance we use —
// declared locally so this file type-checks WITHOUT a compile-time dependency
// on the optional `fastembed` package (which may be absent). The dynamic import
// is typed `any` and adapted to this shape.
interface FastEmbedder {
  passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
  queryEmbed(query: string): Promise<number[]>;
}

export interface Embedder {
  // Embed many passages (documents). Returns one unit-normalized Float32 vector
  // per input, in input order. Uses the "passage: " prefix internally.
  embedPassages(texts: readonly string[], onProgress?: (done: number, total: number) => void): Promise<Float32Array[]>;
  // Embed a single query. Uses the "query: " prefix internally.
  embedQuery(query: string): Promise<Float32Array>;
}

// Result of trying to load the embedder: either ready, or a clean "unavailable"
// with a reason (package absent / model fetch failed / runtime error). Callers
// MUST treat `unavailable` as a graceful no-op (fall back to lexical), never an
// error.
export type EmbedderLoad =
  | { available: true; embedder: Embedder }
  | {
      available: false;
      reason: string;
      // Phase E fix-pass (release review R1 FIX 1) — the STRUCTURED fetch-failure
      // signal threaded up from fetchModel, so a consumer can derive an honest
      // terminal phase WITHOUT regex-sniffing the prose `reason`. Present only on a
      // fetch-fail path (model absent + fetch attempted); ABSENT for non-fetch
      // unavailability (fastembed missing, ONNX-init backstop, read-path no-fetch) —
      // a consumer must keep its reason-based fallback for those.
      classification?: "offline" | "stalled" | "locked" | "corrupt" | "error";
    };

// Module-level memo so we init the model AT MOST once per process (the ~init
// cost is paid once; subsequent searches reuse it).
let cached: Promise<EmbedderLoad> | null = null;

// MAJOR fix (release review 2026-06-30, FIX 4 / G1) — synchronous readiness flag: is
// a LIVE embedder memoized in this process RIGHT NOW? Set true when a load
// resolves available:true; cleared wherever the failed-load memo is cleared and in
// __resetEmbedderCache(). It lets search-cascade fuse when the in-RAM embedder is
// still valid even if the on-disk cache was evicted mid-process (a long-lived MCP
// server / agent) — without forcing an async load on the guard path.
let embedderReady = false;

// C-1 / loadEmbedder options. `showDownloadProgress` is now the
// FETCH-ALLOWED opt-in (the VISIBLE-fetch HIL branch: the build path, after the
// handler consents on a TTY, passes true so the one-time model fetch may run).
// Default false preserves the prior silent behavior for every caller that does
// not opt in — and a NON-opted caller (notably the query/read path) must NEVER
// trigger a fetch: owns the fetch in loadEmbedder, gated on this flag, so a
// read with the cache evicted degrades to lexical instead of downloading. The
// query path only loads when vectors already exist (model already present), so
// it never needs to opt in.
export interface LoadEmbedderOpts {
  showDownloadProgress?: boolean;
  // Hard ceiling (ms) on the model fetch + ONNX init. Defaults to
  // embeddingsFetchTimeoutMs(). On timeout, loadEmbedder resolves
  // { available:false } → lexical fallback, instead of awaiting forever. With
  // the real stall-timeout lives in fetchModel (idle/byte cap); this stays
  // as a backstop around FlagEmbedding.init.
  fetchTimeoutMs?: number;
  // Cooperative cancellation threaded into the owned fetch (Phase G). Optional;
  // fastembed's init itself takes no AbortSignal.
  signal?: AbortSignal;
  // Phase E (C6) — download byte-progress for the owned fetch. Threaded
  // straight into fetchModel({ onProgress }); fired during the GCS download with
  // the running (bytesDone, totalBytes). totalBytes is 0 when the server omits
  // content-length → the CLI shows a heartbeat instead of a byte bar. Optional:
  // a non-fetch / cache-present / read path never calls it (no download).
  onProgress?: (bytesDone: number, totalBytes: number) => void;
}

// Race a promise against a timeout. On timeout it REJECTS with a tagged error
// so loadEmbedder's catch degrades to lexical. The underlying init is abandoned,
// not truly aborted (fastembed.init takes no AbortSignal) — but the process no
// longer awaits it, and a background-completed download still populates the
// cache for the next run. timeoutMs <= 0 disables the cap (awaits the original).
function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms (${label}) — degrading to lexical`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// C8 (Phase G sub-gate 2b) — compose an OPTIONAL caller signal with the SIGINT
// controller's signal into ONE signal that aborts when EITHER does. Prefers the
// native AbortSignal.any (Node ≥20.3, within our >=20.9 engine floor); falls back
// to a manual relay controller + abort listeners when it is absent (defensive). If
// only the SIGINT signal exists (no caller signal) it is returned as-is. If a
// source is ALREADY aborted, the composed signal is aborted immediately.
function composeSignals(caller: AbortSignal | undefined, sigint: AbortSignal): AbortSignal {
  if (caller === undefined) return sigint;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([caller, sigint]);
  // Fallback relay: abort the composite when either source aborts.
  const relay = new AbortController();
  if (caller.aborted || sigint.aborted) {
    relay.abort();
    return relay.signal;
  }
  const onAbort = (): void => relay.abort();
  caller.addEventListener("abort", onAbort, { once: true });
  sigint.addEventListener("abort", onAbort, { once: true });
  return relay.signal;
}

// Reset the memo — test seam only (so an absent-fastembed test and an
// available-fastembed test don't bleed into each other).
export function __resetEmbedderCache(): void {
  cached = null;
  embedderReady = false;
}

// MAJOR fix (release review 2026-06-30, FIX 4 / G1) — pure synchronous predicate: is
// a live embedder memoized in-process? True ⇔ a load resolved available:true and
// has not since been cleared. Used by search-cascade's Phase B guard so fusion
// still runs when the embedder is in RAM even after the disk cache is evicted.
export function embedderMemoized(): boolean {
  return embedderReady;
}

// Lazily load + init the local embedder. NEVER throws — any failure (missing
// optional dep, model fetch failure offline, onnxruntime load error) resolves
// to { available: false, reason } so the cascade falls back to lexical cleanly.
export function loadEmbedder(opts: LoadEmbedderOpts = {}): Promise<EmbedderLoad> {
  if (cached !== null) return cached;
  // `showDownloadProgress` doubles as the FETCH-ALLOWED opt-in (see
  // LoadEmbedderOpts): only a consented build path may trigger the owned fetch.
  const fetchAllowed = opts.showDownloadProgress === true;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? embeddingsFetchTimeoutMs();
  const promise = (async (): Promise<EmbedderLoad> => {
    // OWN the fetch. If the model is not yet cached AND a fetch is
    // allowed (consented build path), download it ourselves (atomic temp+rename,
    // idle-stall timeout, single-flight lock) BEFORE handing off to fastembed.
    // A non-ok fetch degrades to lexical. fastembed then finds the cache present
    // and does NOT download. A read path (fetchAllowed=false) never fetches:
    // model absent → unavailable → lexical, no network.
    if (!modelCachePresent()) {
      if (!fetchAllowed) {
        return { available: false, reason: "embedding model not cached (fetch not requested) — lexical fallback" };
      }
      // Phase E (C6) — thread download byte-progress into the owned fetch.
      // fetchModel already exposes onProgress(bytesDone,totalBytes); we only
      // CONSUME it (no fetch-model.ts change). Forwarded only when the caller
      // wired it, so the silent build path stays byte-identical.
      //
      // C8 (Phase G sub-gate 2b) — SIGINT cancellation (≤5s) on the INTERACTIVE
      // fetch path (fetchAllowed ⇔ showDownloadProgress:true). Install a
      // process-level SIGINT handler that aborts a fresh controller; compose it
      // with any caller-supplied opts.signal so EITHER source cancels the owned
      // fetch. Ctrl-C during the GCS download → controller.abort() →
      // downloadTo.finish() returns ~instantly (well within 5s) → control returns,
      // the partial stays in `.tmp-*` for the next-run startupSweep, nothing is
      // published (atomic temp+rename guarantees this). The handler is REMOVED in
      // finally so it never leaks across loadEmbedder calls.
      const sigintController = new AbortController();
      const onSigint = (): void => {
        sigintController.abort();
        // ACKNOWLEDGE (release review 2026-06-30, FIX 2): installing this SIGINT
        // listener suppresses Node's default Ctrl-C exit, so the FIRST Ctrl-C is
        // otherwise silently swallowed — the download cancels and the command
        // continues lexical with nothing telling the user, who must press Ctrl-C
        // AGAIN to actually quit. Emit ONE honest line. STDERR (never stdout — a
        // `--json` consumer reads stdout; don't corrupt it). The handler is installed
        // only on the interactive (showDownloadProgress:true) path, so this fires
        // only interactively. The contract is UNCHANGED — Ctrl-C still cancels the
        // download and continues lexical (plan C8); this only makes it non-silent.
        process.stderr.write(
          "\nDownload cancelled — continuing with lexical search (press Ctrl-C again to quit)\n",
        );
      };
      process.once("SIGINT", onSigint);
      const fetchSignal = composeSignals(opts.signal, sigintController.signal);
      let fetched;
      try {
        fetched = await fetchModel({
          signal: fetchSignal,
          ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
        });
      } finally {
        // Remove the SIGINT handler so it never leaks across calls. process.once
        // auto-removes only AFTER the signal fires; on the common (no-Ctrl-C) path
        // it would otherwise persist, so remove it explicitly here.
        process.removeListener("SIGINT", onSigint);
      }
      if (!fetched.ok) {
        return {
          available: false,
          reason: `embedding model fetch failed (${fetched.classification}): ${fetched.reason}`,
          // FIX 1 — carry the structured classification up so the terminal-phase
          // mapper can honestly label a stall as `timed-out` (not `offline-deferred`).
          classification: fetched.classification,
        };
      }
    }
    let mod: unknown;
    try {
      // Dynamic import of the OPTIONAL dependency. Bare specifier so it resolves
      // against the consumer's installed `fastembed` when present, and throws a
      // module-not-found we catch when it is absent (ARC-D2: base install has no
      // fastembed → this branch returns unavailable, no crash). The package is in
      // optionalDependencies and may genuinely be absent at build AND run time,
      // so the static module resolution is intentionally suppressed — the only
      // contract this file relies on is the runtime structural shape adapted
      // below (FlagEmbedding.init → { passageEmbed, queryEmbed }).
      // @ts-ignore optional dependency — resolved dynamically at runtime; may be absent at build time (base installs) OR present (opt-in), so neither a hard error nor a guaranteed one
      mod = await import("fastembed");
    } catch (err) {
      return {
        available: false,
        reason: `fastembed not installed (optional dependency absent): ${errMsg(err)}`,
      };
    }
    const FlagEmbedding = (mod as { FlagEmbedding?: unknown }).FlagEmbedding as
      | { init(opts: Record<string, unknown>): Promise<FastEmbedder> }
      | undefined;
    const EmbeddingModel = (mod as { EmbeddingModel?: Record<string, string> }).EmbeddingModel;
    if (FlagEmbedding === undefined || EmbeddingModel === undefined) {
      return { available: false, reason: "fastembed module shape unexpected (no FlagEmbedding/EmbeddingModel export)" };
    }
    let instance: FastEmbedder;
    try {
      // our fetch above already populated the cache (when allowed), so
      // fastembed finds `<cacheDir>/<model>` present and does NOT download:
      // showDownloadProgress is forced false (its bar is dead — we own progress
      // now). withTimeout stays as a BACKSTOP around init (ONNX load); the real
      // stall-timeout is in fetchModel.
      instance = await withTimeout(
        FlagEmbedding.init({
          model: EmbeddingModel["BGESmallENV15"] ?? EMBEDDING_MODEL_ID,
          cacheDir: embeddingsCacheDir(),
          maxLength: 512,
          showDownloadProgress: false,
        }),
        fetchTimeoutMs,
        "embedding model ONNX init",
      );
    } catch (err) {
      // Timed out, OR onnxruntime native load failure, disk full, etc. — all
      // degrade to lexical fallback.
      return { available: false, reason: `embedding model init failed: ${errMsg(err)}` };
    }
    return { available: true, embedder: wrap(instance) };
  })();
  // F0.1 — do NOT memoize failures. A long-lived process (MCP server, persistent
  // agent) must retry after a TRANSIENT failure instead of being stuck
  // lexical-only for its whole lifetime. A successful load stays memoized; a
  // failed/timed-out one clears the memo so the next call re-attempts. The memo
  // is set to `promise` now (so concurrent callers share the in-flight load),
  // then cleared iff it resolved unavailable — guarding against a newer load
  // having replaced it in the meantime.
  cached = promise;
  void promise.then(
    (res) => {
      if (res.available) {
        // FIX 4 / G1 — a live embedder is now memoized in-process.
        embedderReady = true;
      } else if (cached === promise) {
        cached = null;
        embedderReady = false;
      }
    },
    () => {
      if (cached === promise) cached = null;
      embedderReady = false;
    },
  );
  return promise;
}

function wrap(instance: FastEmbedder): Embedder {
  return {
    async embedPassages(texts, onProgress): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      const total = texts.length;
      if (total === 0) return out;
      for await (const batch of instance.passageEmbed(texts as string[], 32)) {
        for (const v of batch) out.push(Float32Array.from(v));
        // Phase E fix-pass (release review R2 FIX 3) — clamp at the source so the
        // done ≤ total contract holds by construction, not just at the formatter.
        if (onProgress) onProgress(Math.min(out.length, total), total);
      }
      return out;
    },
    async embedQuery(query): Promise<Float32Array> {
      return Float32Array.from(await instance.queryEmbed(query));
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Cosine similarity of two fastembed vectors. fastembed unit-normalizes every
// vector, so the dot product IS the cosine (verbatim from the prototype). No
// re-normalization here — relying on that invariant is load-bearing for
// reproducing the measured lift.
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

// Pack a Float32Array as a raw little-endian byte buffer for BLOB storage.
// libSQL @0.15.15 has no native vector ops, so we store the raw bytes and do
// brute-force cosine in JS (the prototype's approach) — no F32_BLOB / vector
// extension dependency, works on every libSQL build.
export function vectorToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
}

// Unpack a BLOB (raw little-endian Float32 bytes) back to a Float32Array.
export function blobToVector(blob: Uint8Array | ArrayBuffer): Float32Array {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Copy into an aligned buffer (libSQL may hand back a view with an offset).
  const copy = u8.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
