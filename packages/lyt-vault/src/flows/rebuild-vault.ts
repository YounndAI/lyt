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

// Lane V Phase 0 (0.5 / CLI gap C3) — `lyt vault rebuild` flow.
//
// One per-vault umbrella that rebuilds ALL content-tier caches in the correct
// order: lanes → arcs → fts → rollup. Distinct from `lyt vault rebuild-index`
// (C4: that DROPs + recreates the DB schema — destructive; this rebuilds
// CONTENT from the markdown SoT into the existing schema). Composes the four
// existing single-tier flows behind the open-once registry seam (v1.A.5 CR-B1):
// open the registry once here, thread it through every sub-flow.
//
// Order rationale: rollup reads each vault's `lanes` cache (rebuild-rollup.ts
// readVaultKeywords), so lanes MUST precede rollup; arcs + fts are independent.

import type { Client } from "@libsql/client";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName } from "../registry/repo.js";
import { healLytDbIfCorrupt } from "../registry/vault-db.js";
import { enforceNotFrozen } from "../util/freeze-check.js";
import { rebuildLanesFlow, type RebuildLanesResult } from "./rebuild-lanes.js";
import { rebuildArcsFlow, type RebuildArcsResult } from "./rebuild-arcs.js";
import { rebuildFtsFlow, type RebuildFtsResult } from "./rebuild-fts.js";
import { rebuildRollupFlow, type RebuildRollupResult } from "./rebuild-rollup.js";
import {
  rebuildKeyphrasesFlow,
  type RebuildKeyphrasesResult,
} from "./rebuild-keyphrases.js";
import {
  rebuildEmbeddingsFlow,
  type RebuildEmbeddingsResult,
} from "./rebuild-embeddings.js";
import { embeddingsEnabled } from "../util/config.js";
import { modelCachePresent as defaultModelCachePresent } from "../util/embeddings.js";
import type { EmbeddingsBuildPhase } from "../util/embeddings-progress.js";
import { walkVaultFigmentFiles } from "./upsert-fts-cache.js";
import { resolveAskedState } from "./embeddings-offer-state.js";
import { markAsked } from "../registry/nudge-state-repo.js";
import type { OfferState } from "../util/nudge-state.js";

export interface RebuildVaultArgs {
  // Registered vault name.
  vault: string;
  // Lane clustering threshold passthrough (default = rebuild-lanes default).
  threshold?: number;
  // Open-once seam (v1.A.5 CR-B1). When supplied the caller owns lifecycle.
  registryDb?: Client;
  // Deterministic timestamp override threaded to lanes/arcs/rollup.
  nowIso?: string;
  // C-1 (build-path model-fetch gate) — interactivity signal for the
  // embeddings build path ONLY. DEFAULT-undefined = NON-INTERACTIVE (the
  // hang-safe default): when the local model is absent the build NEVER prompts
  // and NEVER auto-fetches — it skips the embeddings build, degrades to lexical
  // cleanly, and emits a one-line hint. Set true ONLY from a verified TTY entry
  // point (the `lyt reindex` / `lyt vault rebuild` CLI on an interactive
  // terminal) so the build path may PROMPT the handler and, on consent, fetch
  // visibly. The self-heal rebuild leaves this unset → never fetches on a
  // search. See embeddingsBuildGate() below for the full tree.
  embeddingsInteractive?: boolean;
  // Test seams for the build-gate (so a focused test can exercise the tree
  // without a TTY, a real model, or a real download). `promptConfirm` stands in
  // for the handler's [Y/n]; `modelCachePresentFn` overrides the fs probe.
  promptConfirm?: (question: string) => Promise<boolean>;
  modelCachePresentFn?: () => boolean;
  // Phase E Unit 2 — optional embeddings-build progress reporter. The
  // reindex/rebuild CLI passes this on an interactive TTY (NEVER under --json /
  // non-TTY) to drive the spinner's phase labels (fetch → index → ready /
  // offline-deferred / timed-out) + live download/embed lines. Threaded straight
  // into the embeddings build gate; inert/undefined for every other caller.
  embeddingsProgress?: EmbeddingsBuildProgress;
}

// Phase E Unit 2 — the embeddings-build progress reporter. Human-stdout
// surface only (the CLI suppresses it under --json/non-TTY by not passing it).
// All callbacks optional: a caller can take just the phase transitions, or also
// the live download/embed lines.
export interface EmbeddingsBuildProgress {
  // Phase transition (fetch → index → ready / offline-deferred / timed-out).
  onPhase?: (phase: EmbeddingsBuildPhase) => void;
  // Model-download byte-progress (only on a consented fetch; model absent).
  onDownload?: (bytesDone: number, totalBytes: number) => void;
  // Embed-loop progress ("embedding N/M").
  onEmbed?: (done: number, total: number) => void;
}

export interface RebuildVaultResult {
  vaultName: string;
  lanes: RebuildLanesResult;
  arcs: RebuildArcsResult;
  fts: RebuildFtsResult;
  rollup: RebuildRollupResult;
  // feat/keyphrase-boost — per-doc keyphrase cache (full-walk, same cadence as
  // lanes/arcs/fts). Powers the cascade's β·keyphraseMatch rerank boost.
  keyphrases: RebuildKeyphrasesResult;
  // feat/microrag-semantic — per-doc dense-vector cache. ONLY built when
  // embeddings are enabled (config/env) AND the local model is available
  // (ARC-D2); null otherwise (the common base-pod case — no embeddings, no
  // model, no error). Powers `lyt search --semantic` confidence-gated fusion.
  embeddings: RebuildEmbeddingsResult | null;
  // Track C Wave 3 F15 — when the vault's lyt.db was corrupt at entry, the
  // path it was quarantined to (rebuild then proceeded on a fresh schema);
  // null on the healthy path.
  indexQuarantinedTo: string | null;
  durationMs: number;
}

export async function rebuildVaultFlow(args: RebuildVaultArgs): Promise<RebuildVaultResult> {
  const startedAt = Date.now();
  const callerSupplied = args.registryDb !== undefined;
  const registryDb = args.registryDb ?? (await openRegistry());
  const { vault } = args;
  const nowIso = args.nowIso;

  try {
    // F15 — probe-open the vault's lyt.db before any tier rebuild; a corrupt
    // file is quarantined + recreated so `lyt reindex` IS the remedy instead
    // of choking on the same SQLITE_NOTADB the user is trying to escape.
    const vaultRow = await getVaultByName(registryDb, vault);
    if (vaultRow === null) {
      throw new Error(`rebuild: no vault registered with name '${vault}'.`);
    }
    // hardening pass (fix-pass): the F13 chokepoint — closes the freeze-divergence
    // pair (`lyt rebuild-index` REFUSED frozen while `lyt reindex` proceeded
    // through this flow). Covers reindexFlow, repair --apply's index heal,
    // and the L3 self-heals (search-cascade filters frozen vaults out of its
    // stale-heal targets so reads stay open and degrade gracefully).
    await enforceNotFrozen(vaultRow.path, vaultRow.name);
    const heal = await healLytDbIfCorrupt(vaultRow.path, nowIso);

    const lanes = await rebuildLanesFlow({
      vault,
      registryDb,
      ...(nowIso !== undefined ? { nowIso } : {}),
      ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
    });
    const arcs = await rebuildArcsFlow({
      vault,
      registryDb,
      ...(nowIso !== undefined ? { nowIso } : {}),
    });
    // rebuild-fts also refreshes figment_edges + figment_meta (Lane V 0.3/0.4).
    const fts = await rebuildFtsFlow({ vault, registryDb });
    // feat/keyphrase-boost — rebuild the per-doc keyphrase cache. Independent of
    // lanes/arcs/fts (its own full-walk); placed after fts so the searchable
    // corpus and the keyphrase corpus refresh together. Full-walk only — the
    // incremental per-write path is deferred (see rebuild-keyphrases.ts header).
    const keyphrases = await rebuildKeyphrasesFlow({ vault, registryDb });
    // feat/microrag-semantic + C-1 — build the per-doc dense-vector cache,
    // gated by embeddingsBuildGate() (the handler-ratified prompt+visible-fetch
    // decision tree). With default-ON embeddings the BUILD path can otherwise
    // SILENTLY download a one-time local model on a fresh `lyt reindex` / a 0-hit
    // search's self-heal — the M2 vector-build UX blocker. The gate decides
    // skip / build-silently / prompt-then-visible-fetch / non-interactive-skip
    // per the tree (see embeddingsBuildGate). rebuildEmbeddingsFlow still
    // self-degrades to a clean no-op if the model fails to load.
    const embeddings = await embeddingsBuildGate({
      vault,
      vaultPath: vaultRow.path,
      registryDb,
      ...(args.embeddingsInteractive !== undefined
        ? { interactive: args.embeddingsInteractive }
        : {}),
      ...(args.promptConfirm !== undefined ? { promptConfirm: args.promptConfirm } : {}),
      ...(args.modelCachePresentFn !== undefined
        ? { modelCachePresentFn: args.modelCachePresentFn }
        : {}),
      ...(args.embeddingsProgress !== undefined
        ? { progress: args.embeddingsProgress }
        : {}),
    });
    const rollup = await rebuildRollupFlow({
      vault,
      registryDb,
      ...(nowIso !== undefined ? { nowIso } : {}),
    });

    return {
      vaultName: lanes.vaultName,
      lanes,
      arcs,
      fts,
      rollup,
      keyphrases,
      embeddings,
      indexQuarantinedTo: heal.quarantinedTo,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!callerSupplied) await closeRegistry(registryDb);
  }
}

// C-1 — the build-path model-fetch decision tree (handler-ratified:
// "prompt + visible fetch (HIL)"). Decides WHETHER the build path fetches +
// builds embeddings, and returns the RebuildEmbeddingsResult (or null when the
// embeddings build is skipped entirely). The five branches, in order:
//
//   1. Embeddings DISABLED (config/env false) → skip (return null). Unchanged.
//   2. No note files in the vault → skip (return null); do NOT load the model.
//      (upsert-embeddings-cache also guards this, but checking HERE means we
//      never even reach the prompt/fetch decision for an empty vault.)
//   3. Model cache ALREADY present locally → build SILENTLY (the one-time fetch
//      was already paid; never re-prompt). showDownloadProgress stays false.
//   4. Model ABSENT + INTERACTIVE TTY → PROMPT the handler. YES → build with a
//      VISIBLE download (showDownloadProgress:true). NO → skip (return null),
//      lexical-only, no hang.
//   5. Model ABSENT + NON-INTERACTIVE (no TTY / MCP / --json / self-heal /
//      --no-confirm) → NEVER prompt, NEVER auto-fetch → skip (return null),
//      degrade to lexical, emit a one-line hint that semantic is available via
//      an explicit interactive build.
//
// The interactivity signal is the caller's `embeddingsInteractive` (default
// false = non-interactive = hang-safe). The self-heal rebuild leaves it unset,
// so a search never triggers a fetch.
interface EmbeddingsBuildGateArgs {
  vault: string;
  vaultPath: string;
  registryDb: Client;
  interactive?: boolean;
  promptConfirm?: (question: string) => Promise<boolean>;
  modelCachePresentFn?: () => boolean;
  // Phase D Slice 2a — the idempotent-offer-surface seam. The PINNED
  // synchronous OfferState verdict (option (c)): this gate is the THIRD offer
  // surface (alongside the init offer + the first-search nudge) and consults the
  // SAME pod-global nudge-state, so the user is offered AT MOST ONCE per
  // decision-epoch regardless of entry point. A "declined" verdict (3 explicit
  // declines OR the hard never-flag) suppresses this prompt; "enabled" likewise
  // (defensive — Branch 3 already short-circuits a present model). Injectable
  // for tests; defaults to resolving over this gate's own registryDb. The
  // resolution is async, so the gate awaits it ONCE before the prompt branch.
  askedStateFn?: () => Promise<() => OfferState>;
  // Phase E Unit 2 — the progress reporter from the CLI (human-stdout TUI).
  // Drives phase labels (fetch/index/ready/offline-deferred/timed-out) + live
  // download/embed lines. Inert when absent.
  progress?: EmbeddingsBuildProgress;
}

const EMBEDDINGS_BUILD_PROMPT =
  "Semantic search needs a one-time local model. Build the semantic index now? [Y/n]";

const EMBEDDINGS_NONINTERACTIVE_HINT =
  "ℹ Semantic search is available but its one-time local model isn't downloaded yet. " +
  "Run `lyt reindex` on an interactive terminal to fetch it and build the semantic index " +
  "(search works now, lexical-only).";

export async function embeddingsBuildGate(
  args: EmbeddingsBuildGateArgs,
): Promise<RebuildEmbeddingsResult | null> {
  // Branch 1 — embeddings disabled. Skip entirely (the OFF path is unchanged).
  if (!embeddingsEnabled()) return null;

  // Branch 2 — no notes → nothing to embed; never load/fetch the model.
  if (walkVaultFigmentFiles(args.vaultPath).length === 0) return null;

  const modelCachePresent = args.modelCachePresentFn ?? defaultModelCachePresent;

  // Branch 3 — model already cached → build silently (one-time fetch paid).
  // No fetch phase (the model is present) — straight to index → ready.
  if (modelCachePresent()) {
    return runEmbeddingsBuild(args, { fetch: false });
  }

  // Model is ABSENT below here — a build WOULD fetch the one-time local model.
  const interactive = args.interactive === true;
  if (!interactive) {
    // Branch 5 — non-interactive (incl. the self-heal path): NEVER fetch.
    // Skip, degrade to lexical, emit the one-line hint.
    emitHint(EMBEDDINGS_NONINTERACTIVE_HINT);
    return null;
  }

  // Branch 3.5 (Phase D Slice 2a — idempotent offer surface, option (c)).
  // Consult the SAME pod-global nudge-state the init offer + first-search nudge
  // read, so this rebuild gate offers AT MOST ONCE per decision-epoch. A
  // "declined" verdict (3 explicit declines OR the hard never-flag) — or the
  // defensive "enabled" — SUPPRESSES the prompt: skip to lexical with the same
  // hint, never re-nag. "not-yet-asked"/"asked" (within the quiet window) fall
  // through to the prompt as before. Resolution is async + read-once; default
  // resolves over this gate's registryDb, injectable for tests.
  const resolveAsked = args.askedStateFn ?? (() => resolveAskedState(args.registryDb));
  const askedState = await resolveAsked();
  const verdict = askedState();
  if (verdict === "declined" || verdict === "enabled") {
    emitHint(EMBEDDINGS_NONINTERACTIVE_HINT);
    return null;
  }

  // Branch 4 — interactive TTY + model absent → PROMPT. Reuse the repo's
  // confirm primitive (ReadlinePromptHandler.confirm shape) via the injected
  // promptConfirm; default to a real readline confirm when not supplied.
  //
  // release review FIX 4(b) — this rebuild gate is a REAL offer surface (not an
  // ambient hint), so SURFACING the prompt stamps the pod-global ask (atomic
  // markAsked) against this gate's own registryDb. The same 7-day cadence +
  // auto-quiet then govern the rebuild offer too, whether the user accepts or
  // declines. Best-effort: a stamp failure never blocks the build decision.
  try {
    await markAsked(args.registryDb, new Date().toISOString());
  } catch {
    // never block the rebuild on a cadence-stamp write.
  }
  const confirm = args.promptConfirm ?? defaultReadlineConfirm;
  let consented: boolean;
  try {
    consented = await confirm(EMBEDDINGS_BUILD_PROMPT);
  } catch {
    // A prompt failure (e.g. stdin closed mid-prompt) degrades to skip, never
    // hangs and never fetches.
    emitHint(EMBEDDINGS_NONINTERACTIVE_HINT);
    return null;
  }
  if (!consented) {
    // NO → lexical-only, no fetch, no hang.
    return null;
  }
  // YES → VISIBLE fetch (showDownloadProgress:true) + build, with the fetch
  // phase label surfaced (model is absent here → a download WILL happen).
  return runEmbeddingsBuild(args, { fetch: true });
}

// Phase E Unit 2 — run the embeddings build with phase reporting. Drives
// the progress reporter's phase transitions around rebuildEmbeddingsFlow and
// threads the live download/embed callbacks. `fetch` is true when the model is
// absent (a download will happen → emit the `fetch` phase first); false when the
// cache is present (straight to `index`). The terminal phase is derived from the
// build result: ran → ready; unavailable with a timeout reason → timed-out;
// otherwise → offline-deferred. All reporting is inert when no reporter wired.
async function runEmbeddingsBuild(
  args: EmbeddingsBuildGateArgs,
  opts: { fetch: boolean },
): Promise<RebuildEmbeddingsResult> {
  const progress = args.progress;
  if (opts.fetch) progress?.onPhase?.("fetch");
  else progress?.onPhase?.("index");

  const res = await rebuildEmbeddingsFlow({
    vault: args.vault,
    registryDb: args.registryDb,
    ...(opts.fetch ? { showDownloadProgress: true } : {}),
    ...(progress?.onDownload !== undefined ? { onDownloadProgress: progress.onDownload } : {}),
    ...(progress?.onEmbed !== undefined ? { onProgress: progress.onEmbed } : {}),
  });

  // Once the fetch resolved (model now present), the embed loop is the `index`
  // phase. Only meaningful on the fetch path (Branch 3 already started at index).
  if (opts.fetch && res.available) progress?.onPhase?.("index");

  // Terminal phase from the result.
  if (res.ran) {
    progress?.onPhase?.("ready");
  } else if (!res.available) {
    progress?.onPhase?.(deriveUnavailableTerminalPhase(res));
  }
  return res;
}

// Phase E fix-pass (release review R1 FIX 1) — derive the honest terminal phase
// for an UNAVAILABLE embeddings-build result. Prefer the STRUCTURED classification
// when present (a real fetch stall is `stalled` → `timed-out`, NOT the dishonest
// `offline-deferred`; every other fetch class — offline/locked/error/corrupt — is
// `offline-deferred`). When classification is ABSENT (non-fetch unavailability:
// fastembed missing, or the ONNX-init backstop that THROWS "timed out"), fall back
// to the reason-regex — that path legitimately catches the init-backstop timeout
// and must not regress. Exported pure so FIX 1 can be pinned by a unit test (the
// untested mapping is exactly why the bug slipped).
export function deriveUnavailableTerminalPhase(
  res: Pick<RebuildEmbeddingsResult, "classification" | "reason">,
): "timed-out" | "offline-deferred" {
  if (res.classification !== undefined) {
    return res.classification === "stalled" ? "timed-out" : "offline-deferred";
  }
  const timedOut = res.reason !== undefined && /timed out|timeout/i.test(res.reason);
  return timedOut ? "timed-out" : "offline-deferred";
}

function emitHint(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(msg);
}

// Default interactive confirm — mirrors ReadlinePromptHandler.confirm (the
// repo's existing prompt primitive) for a [Y/n] default-yes question, but as a
// one-shot so rebuild-vault need not depend on the wizard module. Reads one
// line from stdin; empty/Enter accepts the default (yes), else y/yes → true.
async function defaultReadlineConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = (await rl.question(`${question} `)).trim().toLowerCase();
    if (raw.length === 0) return true; // default-yes ([Y/n])
    return raw === "y" || raw === "yes";
  } finally {
    rl.close();
  }
}
