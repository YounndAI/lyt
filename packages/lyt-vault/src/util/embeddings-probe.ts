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

// Wall-3 native-crash containment — a ONE-TIME, per-session, OUT-OF-PROCESS
// capability probe for the native embeddings path.
//
// THE PROBLEM. loadEmbedder loads onnxruntime/fastembed IN-PROCESS
// (`import("fastembed")` → `FlagEmbedding.init` → an ONNX InferenceSession).
// That native addon can HARD-CRASH the whole process with a SIGSEGV (exit 139 on
// POSIX, 0xC0000005 / 3221225477 on Windows) the instant it loads on a bad
// platform — missing AVX, a missing VC++ redist / glibc, a corrupt DLL, or an
// onnxruntime/OOM fault. A SIGSEGV is NOT a JS throw: it bypasses the
// try/catch + withTimeout in loadEmbedder entirely and takes down the CLI / MCP
// server. It is stranger-reachable: `lyt init` interactively RECOMMENDS enabling
// embeddings, and after that one consent every default `lyt search` / `reindex`
// loads native in-process, silently.
//
// THE CONTAINMENT. Before the FIRST in-process native init in a session, spawn a
// disposable child process that performs the SAME minimal native init + a
// 1-token embed. If the child crashes (non-zero exit / death by signal — esp.
// 139 / SIGSEGV), times out, or can't be spawned at all, we mark native
// embeddings UNAVAILABLE for the session and NEVER load native in-process —
// loadEmbedder falls through to its existing `{ available: false }` → lexical
// contract. If the child exits 0, the platform is proven capable and loadEmbedder
// proceeds to load in-process exactly as before. The outcome is memoized so the
// probe spawns AT MOST once per process.
//
// FAIL-TO-LEXICAL, NEVER CRASH (documented choice). Every non-success outcome —
// a genuine native crash, a timeout, OR a probe INFRA error (can't resolve
// fastembed, can't spawn the child, spawn-level ENOENT) — resolves to
// `available: false`. We would rather degrade a capable box to lexical on a
// spurious infra hiccup than risk crashing the process by loading native
// unprobed. The probe NEVER throws.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { execPath } from "node:process";
import { pathToFileURL } from "node:url";

import { EMBEDDING_MODEL_ID, embeddingsCacheDir } from "./embeddings.js";

// Default hard ceiling on the whole probe (child ONNX init + 1-token embed). The
// model is already cached whenever loadEmbedder reaches the probe, so a healthy
// init is a few seconds; 15s is generous headroom before we give up and degrade
// to lexical, while bounding the first-search stall on a hanging child.
// Overridable via LYT_EMBEDDINGS_PROBE_TIMEOUT_MS. <= 0 disables the cap (awaits
// the child indefinitely — the child's own exit is then the only bound; used
// mainly by tests).
export const DEFAULT_EMBEDDINGS_PROBE_TIMEOUT_MS = 15_000;

export function embeddingsProbeTimeoutMs(): number {
  const raw = process.env["LYT_EMBEDDINGS_PROBE_TIMEOUT_MS"];
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_EMBEDDINGS_PROBE_TIMEOUT_MS;
}

// The result of the capability probe. `available:true` ⇔ a child proved the
// native path loads + embeds without crashing. `available:false` ⇔ any crash /
// timeout / infra failure — treat as "no native embeddings this session".
export interface NativeProbeResult {
  available: boolean;
  reason: string;
  // INTERNAL memoization hint — NOT part of the available/reason contract that
  // loadEmbedder consumes. `true` marks a TRANSIENT / infra outcome (spawn
  // throw/EAGAIN, child `error` event, timeout, abort) that must NOT be
  // permanently memoized: a later probeNativeEmbeddings() call re-spawns and
  // retries. Omitted/false marks a STABLE-platform outcome (available, signal
  // death, non-zero exit, fastembed-unresolvable) that IS memoized once per
  // process. See probeNativeEmbeddings.
  transient?: boolean;
}

export interface ProbeOptions {
  // Hard ceiling (ms) on the probe. Defaults to embeddingsProbeTimeoutMs().
  timeoutMs?: number;
  // Cooperative cancellation — if the signal aborts we kill the child and resolve
  // unavailable (fail-to-lexical). Threaded from loadEmbedder's own signal.
  signal?: AbortSignal;
  // TEST SEAM — override how the probe child is started. Given the ESM source
  // string + the child env, returns a ChildProcess. The default spawns
  // `process.execPath --input-type=module` and pipes the source into stdin. A
  // test injects a spawner that produces a child which exits 139 / dies by
  // SIGSEGV / SIGABRT / never exits, WITHOUT a real onnxruntime crash — so the
  // RED-PROVE (parent survives a crashing child) needs no bad platform.
  spawnChild?: (source: string, env: NodeJS.ProcessEnv) => ChildProcess;
  // TEST SEAM — override the resolved fastembed module path. `null` forces the
  // "fastembed unresolvable" branch (→ unavailable, no spawn). When omitted the
  // path is resolved via createRequire against this module.
  fastembedPath?: string | null;
}

// Resolve the on-disk path of the OPTIONAL `fastembed` package WITHOUT loading it
// — `require.resolve` returns the entry path as a string and does NOT execute the
// module, so this is safe to call in-process before the probe (it cannot trigger
// the native load / crash). Resolves against THIS module's location, the same
// context loadEmbedder's `import("fastembed")` resolves from, so the child probes
// the exact module the parent would later load. Returns null when fastembed is
// absent (base install) → the probe reports unavailable with no spawn.
function resolveFastembedPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve("fastembed");
  } catch {
    return null;
  }
}

// The ESM source the probe child runs. It imports the SAME fastembed the parent
// resolved (passed as a file:// URL via env to dodge cross-platform quoting),
// does the minimal `FlagEmbedding.init` + a 1-token embed, and exits 0 on
// success. A native SIGSEGV during the import / init / embed kills the child by
// signal (or a Windows access-violation exit code) — which the parent reads as a
// crash. Any JS-level failure exits non-zero. Nothing is printed to stdout.
const PROBE_CHILD_SOURCE = `
const feUrl = process.env.LYT_PROBE_FASTEMBED_URL;
const cacheDir = process.env.LYT_PROBE_CACHE_DIR;
const model = process.env.LYT_PROBE_MODEL;
try {
  const mod = await import(feUrl);
  const FlagEmbedding = mod.FlagEmbedding;
  const EmbeddingModel = mod.EmbeddingModel;
  if (!FlagEmbedding || !EmbeddingModel) {
    process.stderr.write("fastembed shape unexpected");
    process.exit(3);
  }
  const inst = await FlagEmbedding.init({
    model: EmbeddingModel.BGESmallENV15 || model,
    cacheDir,
    maxLength: 512,
    showDownloadProgress: false,
  });
  // Minimal 1-token embed — exercises the native inference path, not just load.
  for await (const _batch of inst.passageEmbed(["x"], 1)) { break; }
  process.exit(0);
} catch (err) {
  try { process.stderr.write(String((err && err.message) || err)); } catch (_e) {}
  process.exit(2);
}
`;

// Default child starter: spawn node reading the probe module from stdin. stdout
// is ignored (the probe is signal/exit-code driven); stderr is captured for the
// failure reason. A stdin write can EPIPE if the child died instantly — guarded.
function defaultSpawnChild(source: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(execPath, ["--input-type=module"], {
    env,
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  if (child.stdin !== null) {
    child.stdin.on("error", () => {
      // Child exited before consuming stdin — the exit handler owns the outcome.
    });
    try {
      child.stdin.write(source);
      child.stdin.end();
    } catch {
      // Best-effort; the exit/error handler still resolves the probe.
    }
  }
  return child;
}

// Run the probe ONCE. Never throws; always resolves a NativeProbeResult.
function runProbe(opts: ProbeOptions): Promise<NativeProbeResult> {
  return new Promise<NativeProbeResult>((resolve) => {
    const fastembedPath =
      opts.fastembedPath !== undefined ? opts.fastembedPath : resolveFastembedPath();
    if (fastembedPath === null) {
      resolve({
        available: false,
        reason: "fastembed not resolvable (optional dependency absent) — lexical fallback",
      });
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    let stderr = "";

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
    };
    const done = (result: NativeProbeResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const killChild = (): void => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // best-effort
      }
    };
    function onAbort(): void {
      killChild();
      done({ available: false, reason: "native embeddings probe aborted — lexical fallback", transient: true });
    }

    // Already-aborted caller → never spawn.
    if (opts.signal?.aborted === true) {
      done({ available: false, reason: "native embeddings probe aborted before start — lexical fallback", transient: true });
      return;
    }

    const starter = opts.spawnChild ?? defaultSpawnChild;
    try {
      // Build the child env INSIDE the try so a sync throw from any of
      // pathToFileURL / embeddingsCacheDir() / EMBEDDING_MODEL_ID resolves
      // available:false instead of rejecting the Promise executor — the probe
      // NEVER throws (documented invariant; loadEmbedder awaits it outside a
      // try). Treated as a transient infra error → not permanently memoized.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LYT_PROBE_FASTEMBED_URL: pathToFileURL(fastembedPath).href,
        LYT_PROBE_CACHE_DIR: embeddingsCacheDir(),
        LYT_PROBE_MODEL: EMBEDDING_MODEL_ID,
      };
      child = starter(PROBE_CHILD_SOURCE, env);
    } catch (err) {
      // INFRA error: could not build env / even spawn the child. Documented
      // choice: degrade to lexical, never crash. Transient → not memoized.
      done({ available: false, reason: `native embeddings probe could not spawn (${errMsg(err)}) — lexical fallback`, transient: true });
      return;
    }

    const timeoutMs = opts.timeoutMs ?? embeddingsProbeTimeoutMs();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killChild();
        // TIMEOUT is a transient/infra outcome (a one-off hanging child), NOT a
        // stable-platform crash → resolve unavailable but do not memoize.
        done({
          available: false,
          reason: `native embeddings probe timed out after ${timeoutMs}ms — lexical fallback`,
          transient: true,
        });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    if (opts.signal !== undefined) opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += String(chunk);
    });
    // A spawn-level failure (e.g. execPath ENOENT) surfaces as an "error" event,
    // NOT an exit — infra error → fail-to-lexical.
    child.on("error", (err) => {
      // A child `error` event (e.g. spawn-level ENOENT/EAGAIN) is a transient
      // infra outcome, NOT a stable-platform crash → resolve unavailable but do
      // not memoize; a later call re-spawns and retries.
      done({ available: false, reason: `native embeddings probe child error (${errMsg(err)}) — lexical fallback`, transient: true });
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        done({ available: true, reason: "native embeddings probe ok" });
        return;
      }
      // Non-zero exit OR death by signal ⇒ the native path is NOT safe to load
      // in-process. A SIGSEGV shows as signal="SIGSEGV" (POSIX) or a non-zero
      // access-violation code (Windows: 3221225477); both land here.
      const how = signal !== null ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const detail = stderr.trim().length > 0 ? `: ${stderr.trim().slice(0, 200)}` : "";
      done({
        available: false,
        reason: `native embeddings probe crashed/failed (${how})${detail} — lexical fallback`,
      });
    });
  });
}

// Per-process memo — a STABLE outcome spawns AT MOST once per session. A native
// crash is a stable platform property (a missing AVX / bad DLL does not heal
// within a run) and `available:true` is likewise stable, so both are cached and
// a probe on every search re-spawns nothing. But a TRANSIENT outcome (spawn
// throw/EAGAIN, child `error` event, timeout, abort) is NOT cached — same spirit
// as loadEmbedder's F0.1 "don't memoize a transient failure": a one-off infra
// hiccup must not permanently strand a capable box on lexical. probeNativeEmbeddings
// clears this memo when runProbe reports `transient:true`.
let cachedProbe: Promise<NativeProbeResult> | null = null;

// TEST SEAM — a forced probe outcome. When set, probeNativeEmbeddings resolves it
// immediately without spawning, so a test can drive loadEmbedder's probe-fail →
// lexical branch deterministically. Cleared with __setForcedProbe(null).
let forcedProbe: NativeProbeResult | null = null;

// Is a test runner active? Under vitest the DEFAULT probe is a no-op PASS
// (available:true) so (a) the out-of-process child never escapes vitest's
// in-process `vi.mock("fastembed")` and (b) we don't spawn a node child on every
// embeddings test. A probe-specific test opts INTO the real logic by passing an
// explicit `spawnChild`/`fastembedPath` or by setting __setForcedProbe.
function inTestEnv(): boolean {
  // Gate on the VITEST marker ONLY — a production deployment that happens to set
  // NODE_ENV=test must NOT silently skip the crash-safety probe.
  return process.env["VITEST"] !== undefined;
}

/**
 * One-time per-session native-embeddings capability probe. Resolves
 * `available:true` only when a child process proved the native path loads and
 * embeds without crashing; every crash / timeout / infra failure resolves
 * `available:false` (fail-to-lexical). Memoized: spawns at most once per process.
 */
export function probeNativeEmbeddings(opts: ProbeOptions = {}): Promise<NativeProbeResult> {
  if (forcedProbe !== null) return Promise.resolve(forcedProbe);
  if (cachedProbe !== null) return cachedProbe;
  // Test-env default: skip the real spawn unless a test explicitly wired the
  // probe seams.
  if (inTestEnv() && opts.spawnChild === undefined && opts.fastembedPath === undefined) {
    cachedProbe = Promise.resolve({
      available: true,
      reason: "native embeddings probe skipped (test environment default)",
    });
    return cachedProbe;
  }
  // Memoize ONLY genuine, stable-platform outcomes (available / signal death /
  // non-zero exit / fastembed-unresolvable). A TRANSIENT or infra outcome (spawn
  // throw/EAGAIN, child `error` event, timeout, abort) resolves available:false
  // but clears the memo so a later call re-spawns and retries — a one-off hiccup
  // must not strand a long-lived MCP server on lexical for the whole process.
  const pending: Promise<NativeProbeResult> = runProbe(opts).then((res) => {
    if (res.transient === true && cachedProbe === pending) cachedProbe = null;
    return res;
  });
  cachedProbe = pending;
  return pending;
}

// Reset the per-process memo — test seam only.
export function __resetNativeProbeCache(): void {
  cachedProbe = null;
  forcedProbe = null;
}

// Force a probe outcome (or clear with null) — test seam only. Also clears the
// memo so the forced value takes effect on the next call.
export function __setForcedProbe(result: NativeProbeResult | null): void {
  forcedProbe = result;
  cachedProbe = null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
