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

// Inc-2 Phase B / #2 (0.12.1) — the SHARED reflect-the-committed-SoT indexer for
// a freshly RECEIVED foreign vault (clone-on-subscribe, clone-on-accept-share, or
// a standalone `lyt vault clone <url>` of a foreign vault). It UPSERTS the machine-
// local content caches (ledger → lanes → arcs → fts) from the vault's ALREADY-
// COMMITTED YON + markdown and stamps the L3 index watermark, so `lyt search` /
// `recall` / `primer` hit with NO manual `lyt reindex`.
//
// WHY REFLECT (upsert), NOT RE-CLUSTER (rebuildVaultFlow): re-clustering REWRITES
// `.lyt/indexes/lanes.yon` + `arcs.yon` from the markdown, which CHURNS the git
// tree. A RECEIVED foreign vault (subscribed = read-only; shared = the owner
// authors the cluster YON, the receiver CONSUMES it) must land with a CLEAN
// tracked tree — the churn would never be cleaned on a read-only clone and would
// collide with the owner's pushes on `git pull --rebase`. Reflecting the committed
// SoT (the owner is the cluster-YON author) leaves the tree clean while still
// populating every search tier. This is the exact reconcile the steady-state
// `lyt sync` pull runs.
//
// This is the single source of truth extracted from subscribe.ts's former private
// buildLocalIndex (audit-coupled-constant: one reflect cascade, three receive
// callers — subscribe, accept-share, clone auto-index — no drift). Each upsert
// early-returns ran=false when its SoT file is absent and NEVER throws into the
// receive flow (best-effort — the vault on disk is the durable side-effect).

import { upsertArcsCache } from "./upsert-arcs-cache.js";
import { upsertFtsCache } from "./upsert-fts-cache.js";
import { upsertLanesCache } from "./upsert-lanes-cache.js";
import { upsertLedgerCache } from "./sync-post-pull-ledger.js";
import { writeIndexWatermark } from "../util/index-watermark.js";

export interface ReflectInboundIndexResult {
  lanesRan: boolean;
  arcsRan: boolean;
  ftsRan: boolean;
}

// Reflect the committed SoT of the vault at `vaultPath` into the machine-local
// caches. `vaultName` is used only for the deferred-tier log line. Best-effort:
// a per-tier failure logs (naming the manual-reindex remedy) and continues.
export async function reflectInboundIndex(
  vaultName: string,
  vaultPath: string,
): Promise<ReflectInboundIndexResult> {
  try {
    await upsertLedgerCache(vaultPath);
  } catch (err) {
    logReflectDeferred(vaultName, "ledger", err);
  }
  let lanesRan = false;
  try {
    lanesRan = (await upsertLanesCache(vaultPath)).ran;
  } catch (err) {
    logReflectDeferred(vaultName, "lanes", err);
  }
  let arcsRan = false;
  try {
    arcsRan = (await upsertArcsCache(vaultPath)).ran;
  } catch (err) {
    logReflectDeferred(vaultName, "arcs", err);
  }
  let ftsRan = false;
  try {
    ftsRan = (await upsertFtsCache(vaultPath)).ran;
  } catch (err) {
    logReflectDeferred(vaultName, "fts", err);
  }
  // Stamp "indexed as of now" so the L3 empty-result self-heal does not
  // redundantly re-cluster the vault we just reconciled.
  writeIndexWatermark(vaultPath);
  return { lanesRan, arcsRan, ftsRan };
}

function logReflectDeferred(vaultName: string, tier: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(
    `lyt receive: post-clone ${tier} reflect of ${vaultName} deferred ` +
      `(${err instanceof Error ? err.message : String(err)}); ` +
      `markdown SoT intact — run \`lyt reindex --vault ${vaultName}\`.`,
  );
}
