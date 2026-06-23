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
import { walkVaultMarkdownFiles } from "./upsert-fts-cache.js";

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
  // hang-safe default): when the ~23MB model is absent the build NEVER prompts
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
    // SILENTLY download a ~23MB model on a fresh `lyt reindex` / a 0-hit
    // search's self-heal — the M2 vector-build UX blocker. The gate decides
    // skip / build-silently / prompt-then-visible-fetch / non-interactive-skip
    // per the tree (see embeddingsBuildGate). rebuildEmbeddingsFlow still
    // self-degrades to a clean no-op if the model fails to load (ARC-D2).
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
}

const EMBEDDINGS_BUILD_PROMPT =
  "Semantic search needs a one-time ~23MB model download. Build the semantic index now? [Y/n]";

const EMBEDDINGS_NONINTERACTIVE_HINT =
  "ℹ Semantic search is available but its ~23MB model isn't downloaded yet. " +
  "Run `lyt reindex` on an interactive terminal to fetch it and build the semantic index " +
  "(search works now, lexical-only).";

export async function embeddingsBuildGate(
  args: EmbeddingsBuildGateArgs,
): Promise<RebuildEmbeddingsResult | null> {
  // Branch 1 — embeddings disabled. Skip entirely (the OFF path is unchanged).
  if (!embeddingsEnabled()) return null;

  // Branch 2 — no notes → nothing to embed; never load/fetch the model.
  if (walkVaultMarkdownFiles(args.vaultPath).length === 0) return null;

  const modelCachePresent = args.modelCachePresentFn ?? defaultModelCachePresent;

  // Branch 3 — model already cached → build silently (one-time fetch paid).
  if (modelCachePresent()) {
    return rebuildEmbeddingsFlow({ vault: args.vault, registryDb: args.registryDb });
  }

  // Model is ABSENT below here — a build WOULD fetch ~23MB.
  const interactive = args.interactive === true;
  if (!interactive) {
    // Branch 5 — non-interactive (incl. the self-heal path): NEVER fetch.
    // Skip, degrade to lexical, emit the one-line hint.
    emitHint(EMBEDDINGS_NONINTERACTIVE_HINT);
    return null;
  }

  // Branch 4 — interactive TTY + model absent → PROMPT. Reuse the repo's
  // confirm primitive (ReadlinePromptHandler.confirm shape) via the injected
  // promptConfirm; default to a real readline confirm when not supplied.
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
  // YES → VISIBLE fetch (showDownloadProgress:true) + build.
  return rebuildEmbeddingsFlow({
    vault: args.vault,
    registryDb: args.registryDb,
    showDownloadProgress: true,
  });
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
