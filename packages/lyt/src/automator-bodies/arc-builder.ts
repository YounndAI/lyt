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

// Arc-builder automator body (v1.D.2c, block-B Commit 7 pattern; mirror
// to v1.D.1c lane-builder).
//
// Per master-plan §v1.D.2a (Commit 1) + §v1.D.2b (Commit 2) + the
// inferred-by-symmetry §v1.D.2c — archetype=aggregator,
// runtime=deterministic, llm_capability=none. Delegates to
// `rebuildArcsFlow` (lyt-vault) which walks `<vault>/notes/**/*.md`,
// harvests arc membership from frontmatter `arcs:` fields + embedded
// @ARC/@ARC_MEMBER records in markdown bodies, resolves positions
// (manual wins; frontmatter auto-assigned skipping reserved slots),
// emits `<vault>/.lyt/indexes/arcs.yon` SoT, and refreshes the
// lyt.db cache (via the rebuild flow's atomic SoT+cache emission
// added in v1.D.2b).
//
// Lifecycle:
// - Scheduled (cron @ 03:00 UTC daily) per the bundled arc-builder.yon
// declaration — same schedule as lane-builder; concurrency=parallel
// so both run side-by-side at the boundary.
// - Triggered by write-threshold:50 (post-v1.D.2c runtime hook will
// dispatch when ≥50 vault writes accumulate since last arcs build).
// - Manual: `lyt automator run arc-builder --run-now` (this code path).
//
// default (mirrors v1.D.1c): this automator wrapper co-exists with
// the manual `lyt vault rebuild-arcs` verb shipped in v1.D.2a Commit 1
// — the verb stays as evidence-of-life for the underlying flow; this
// wrapper adds scheduling + provenance routing through the 5-step
// protocol.
//
// Caller-side OPT-1 (v1.A.5 CR-B10 + v1.D.1c precedent) — the body
// receives ledgerClients via AutomatorBodyArgs so any downstream
// @STAMP-routed writes share the pre-opened audit + provenance
// clients. Arcs don't write notes directly today, but threading the
// bundle keeps the contract symmetric with metadata-filler +
// lane-builder for future archetype evolution.

import type { LytRunContext } from "@younndai/lyt-runner";
import { rebuildArcsFlow } from "@younndai/lyt-vault";

import type { AutomatorBodyArgs } from "./index.js";

export interface ArcBuilderOutcome {
  vaultPath: string;
  arcsWritten: number;
  membersWritten: number;
  cacheArcsUpserted: number | null;
  cacheMembersUpserted: number | null;
  warnings: readonly string[];
  durationMs: number;
}

export async function runArcBuilderBody(
  _ctx: LytRunContext,
  args: AutomatorBodyArgs,
): Promise<ArcBuilderOutcome> {
  const result = await rebuildArcsFlow({
    vaultPathOverride: args.vaultPath,
    // No registry roundtrip needed — lyt-runner already resolved the
    // vault for the run-plan. No threshold parameter on arcs (unlike
    // lanes); arcs are always explicit declarations.
  });
  return {
    vaultPath: result.vaultPath,
    arcsWritten: result.arcsWritten,
    membersWritten: result.membersWritten,
    cacheArcsUpserted: result.cacheArcsUpserted,
    cacheMembersUpserted: result.cacheMembersUpserted,
    warnings: result.warnings,
    durationMs: result.durationMs,
  };
}
