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
// cascade with no error, no crash. The ~23MB model is NOT bundled; fastembed
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

// The dense model: bge-small-en-v1.5, 384-dim, int8-quantized ONNX.
export const EMBEDDING_DIM = 384;
export const EMBEDDING_MODEL_ID = "fast-bge-small-en-v1.5";

// Where fastembed lazy-fetches the ~23MB model on first use. Under the user's
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

// C-1 (build-path fetch gate) — is the ~23MB model ALREADY cached locally?
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

// C-1 (release review Major fold) — the CLI interactivity gate for the
// build-path model fetch. Interactivity requires BOTH stdin AND stdout to be a
// TTY (and not --json): the prompt reads `process.stdin`, so a non-TTY STDIN
// (e.g. `lyt reindex < /dev/null`) must NOT be prompted — per the wizard
// convention (a non-TTY STDIN hangs/auto-accepts). Checking stdout alone let a
// redirected-stdin + TTY-stdout invocation through → un-consented ~23MB fetch.
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
  | { available: false; reason: string };

// Module-level memo so we init the model AT MOST once per process (the ~init
// cost is paid once; subsequent searches reuse it).
let cached: Promise<EmbedderLoad> | null = null;

// C-1 — loadEmbedder options. `showDownloadProgress` surfaces fastembed's
// download bar (the VISIBLE-fetch HIL branch: the build path, after the handler
// consents on a TTY, passes true so the one-time ~23MB fetch isn't silent).
// Default false preserves the prior silent behavior for every caller that does
// not opt in (notably the query path, which only loads when vectors already
// exist — i.e. the model was already fetched, so there is nothing to show).
export interface LoadEmbedderOpts {
  showDownloadProgress?: boolean;
}

// Reset the memo — test seam only (so an absent-fastembed test and an
// available-fastembed test don't bleed into each other).
export function __resetEmbedderCache(): void {
  cached = null;
}

// Lazily load + init the local embedder. NEVER throws — any failure (missing
// optional dep, model fetch failure offline, onnxruntime load error) resolves
// to { available: false, reason } so the cascade falls back to lexical cleanly.
export function loadEmbedder(opts: LoadEmbedderOpts = {}): Promise<EmbedderLoad> {
  if (cached !== null) return cached;
  const showDownloadProgress = opts.showDownloadProgress === true;
  cached = (async (): Promise<EmbedderLoad> => {
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
      instance = await FlagEmbedding.init({
        model: EmbeddingModel["BGESmallENV15"] ?? EMBEDDING_MODEL_ID,
        cacheDir: embeddingsCacheDir(),
        maxLength: 512,
        // C-1 — VISIBLE fetch on the consented build path (the HIL branch
        // passes showDownloadProgress:true so the one-time ~23MB download is
        // shown, never silent). Every other caller keeps the prior silent
        // default (false) — notably the query path, which only loads when the
        // model is already cached (vectors present), so it has nothing to show.
        showDownloadProgress,
      });
    } catch (err) {
      // Offline + model not yet cached, onnxruntime native load failure, disk
      // full, etc. — all degrade to lexical fallback.
      return { available: false, reason: `embedding model init failed: ${errMsg(err)}` };
    }
    return { available: true, embedder: wrap(instance) };
  })();
  return cached;
}

function wrap(instance: FastEmbedder): Embedder {
  return {
    async embedPassages(texts, onProgress): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      const total = texts.length;
      if (total === 0) return out;
      for await (const batch of instance.passageEmbed(texts as string[], 32)) {
        for (const v of batch) out.push(Float32Array.from(v));
        if (onProgress) onProgress(out.length, total);
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
