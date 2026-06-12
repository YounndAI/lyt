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

// Archetype → TS body resolver (block-B Commit 7).
//
// v1 ships three bundled archetype-body pairs: metadata-filler (filler),
// lane-builder (aggregator — tag-frequency search lanes), and arc-builder
// (aggregator — position-ordered narrative arcs). Future archetypes
// (rollup, ingest, log-compactor) add resolveAutomatorBody cases here as
// they land.
//
// The CLI + integration test consume this through resolveAutomatorBody —
// it returns either a body function or null when no v1 dispatch exists
// for the requested name. The CLI surfaces a clear error in the null case
// rather than running an empty body silently.

import type { Client } from "@libsql/client";
import type { LytRunContext } from "@younndai/lyt-runner";

import { runArcBuilderBody, type ArcBuilderOutcome } from "./arc-builder.js";
import { runLaneBuilderBody, type LaneBuilderOutcome } from "./lane-builder.js";
import { runMetadataFillerBody, type MetadataFillerOutcome } from "./metadata-filler.js";

export interface AutomatorBodyArgs {
  vaultPath: string;
  vaultDb: Client;
  automatorName: string;
  automatorVersion: string;
  // v1.A.5 OPT-1 caller-side: pre-opened audit + provenance clients to
  // thread through writeMarkdownWithStamp / writeYonWithStamp via
  // WriteWithStampArgs.ledgerClients. When supplied, the pre-write hook
  // skips its per-call open/close pair (~400ms × 2 saved on Windows
  // file-lock per fired stamp).
  ledgerClients?: {
    auditDb: Client;
    provenanceDb: Client;
  };
}

export type AutomatorBodyFn = (ctx: LytRunContext, args: AutomatorBodyArgs) => Promise<unknown>;

// Registered v1 archetype bodies. Add new entries here when shipping new
// archetype implementations; the CLI dispatch reads from this map.
const REGISTRY: Record<string, AutomatorBodyFn> = {
  "metadata-filler": runMetadataFillerBody,
  "lane-builder": runLaneBuilderBody,
  "arc-builder": runArcBuilderBody,
};

export function resolveAutomatorBody(name: string): AutomatorBodyFn | null {
  // Strip the optional `automator:` prefix in case callers pass the full rid.
  const stripped = name.startsWith("automator:") ? name.slice("automator:".length) : name;
  return REGISTRY[stripped] ?? null;
}

export { runMetadataFillerBody, runLaneBuilderBody, runArcBuilderBody };
export type { MetadataFillerOutcome, LaneBuilderOutcome, ArcBuilderOutcome };
