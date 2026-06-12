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

// V-C-1 Phase B (L2) — reindex-on-inbound.
//
// When a vault is BROUGHT IN — `lyt vault adopt` (a local Obsidian folder),
// `lyt mesh subscribe` (clone-on-subscribe), the pod-adopt prime, a `lyt sync`
// pull — its content caches must be (re)built so `lyt search` / `recall` /
// `primer` hit with NO manual reindex. This closes V-B-6: the adopt/subscribe
// paths previously built FTS-only (or FTS + lanes), leaving arcs/lanes/keywords
// empty until a manual `lyt reindex`.
//
// This is the ALL-TIER rebuild (lanes → arcs → fts → rollup) via
// rebuildVaultFlow — a full per-vault re-cluster FROM the brought-in markdown,
// NOT a reflect-the-committed-YON-SoT upsert. Inbound is the right moment to
// re-cluster: a freshly cloned/adopted vault may carry a stale or absent
// lanes.yon/arcs.yon, and re-clustering guarantees every tier populates from
// the actual content. (The recurring `lyt sync` pull deliberately does NOT use
// this — it reflects the committed SoT to avoid rewriting lanes.yon on every
// pull, which would churn the git tree; see lyt-mesh/flows/sync.ts. Sync stamps
// the watermark directly instead.)
//
// Stamps the L3 index watermark on success so the empty-result self-heal does
// not redundantly fire right after an inbound (re)index.
//
// Best-effort + non-fatal (matches the established adopt/subscribe posture):
// the markdown is the source of truth and already on disk; an index failure
// returns `reindexed:false` + an error string for the caller to log, never
// throws into the inbound flow.

import type { Client } from "@libsql/client";

import { writeIndexWatermark } from "../util/index-watermark.js";
import { rebuildVaultFlow } from "./rebuild-vault.js";

export interface ReindexInboundArgs {
  // Registered vault name (rebuildVaultFlow resolves its path via the registry).
  vault: string;
  // Vault path — used to stamp the index watermark (L3 input).
  vaultPath: string;
  // Open-once seam (v1.A.5 CR-B1). Threaded to rebuildVaultFlow when supplied.
  registryDb?: Client | undefined;
}

export interface ReindexInboundResult {
  vaultName: string;
  // True when all content tiers rebuilt + the watermark was stamped.
  reindexed: boolean;
  // Present on failure (the inbound flow logs it; the markdown SoT is intact).
  error?: string;
}

export async function reindexInboundVault(args: ReindexInboundArgs): Promise<ReindexInboundResult> {
  try {
    await rebuildVaultFlow({
      vault: args.vault,
      ...(args.registryDb !== undefined ? { registryDb: args.registryDb } : {}),
    });
    writeIndexWatermark(args.vaultPath);
    return { vaultName: args.vault, reindexed: true };
  } catch (err) {
    return {
      vaultName: args.vault,
      reindexed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
