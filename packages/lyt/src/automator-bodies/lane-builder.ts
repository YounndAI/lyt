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

// Lane-builder automator body (v1.D.1c, block-B Commit 7 pattern).
//
// Per arc-thoughts §6.13 / master-plan §v1.D.1c — archetype=aggregator,
// runtime=deterministic, llm_capability=none. Delegates to
// `rebuildLanesFlow` (lyt-vault) which walks <vault>/notes/**/*.md,
// clusters figments by frontmatter tag frequency, emits
// `<vault>/.lyt/indexes/lanes.yon` SoT, and refreshes the lyt.db cache
// (via the rebuild flow's atomic SoT+cache emission added in v1.D.1b).
//
// Lifecycle:
// - Scheduled (cron @ 03:00 UTC daily) per the bundled lane-builder.yon
// declaration.
// - Triggered by write-threshold:50 (post-v1.D.1c runtime hook will
// dispatch when ≥50 vault writes accumulate since last lanes build).
// - Manual: `lyt automator run lane-builder --run-now` (this code path).
//
// default: this automator wrapper co-exists with the manual
// `lyt vault rebuild-lanes` verb shipped in v1.D.1a — the verb stays as
// evidence-of-life for the underlying flow; this wrapper adds scheduling
// + provenance routing through the 5-step protocol.
//
// Caller-side OPT-1 (v1.A.5 CR-B10) — the body receives ledgerClients via
// AutomatorBodyArgs so any downstream @STAMP-routed writes share the
// pre-opened audit + provenance clients. Lanes don't write notes
// directly today, but threading the bundle keeps the contract symmetric
// with metadata-filler for future archetype evolution.

import type { LytRunContext } from "@younndai/lyt-runner";
import { rebuildLanesFlow } from "@younndai/lyt-vault";

import type { AutomatorBodyArgs } from "./index.js";

export interface LaneBuilderOutcome {
  vaultPath: string;
  lanesWritten: number;
  membersWritten: number;
  cacheLanesUpserted: number | null;
  cacheMembersUpserted: number | null;
  durationMs: number;
}

export async function runLaneBuilderBody(
  _ctx: LytRunContext,
  args: AutomatorBodyArgs,
): Promise<LaneBuilderOutcome> {
  const result = await rebuildLanesFlow({
    vaultPathOverride: args.vaultPath,
    // Use the default threshold (DEFAULT_LANE_THRESHOLD = 2) — the
    // bundled lane-builder.yon does not surface a configurable
    // threshold yet; that ships as an @META field on the automator
    // declaration in v1.D.2+ alongside arc-builder.
  });
  return {
    vaultPath: result.vaultPath,
    lanesWritten: result.lanesWritten,
    membersWritten: result.membersWritten,
    cacheLanesUpserted: result.cacheLanesUpserted,
    cacheMembersUpserted: result.cacheMembersUpserted,
    durationMs: result.durationMs,
  };
}
