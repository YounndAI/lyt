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

// yai.lyt expander — main entry point.
//
// Per arc-thoughts §6.11 (LOCKED 2026-05-27): the lyt-runner architecture is
// Pattern A — a thin wrapper on @younndai/yon-runner — with the yai.lyt
// expander transforming @AUTOMATOR + @DIRECTIVE records into core YON
// (@AGENT + @STEP + ops + @TENET refs) BEFORE yon-runner.run() executes.
//
// This module is the public entry point. The transformation is split across
// sub-modules: parse-record.ts (typed projections of YonRecord fields),
// automator-to-agent.ts (@AUTOMATOR → @AGENT + @META projection),
// directive-passthrough.ts (@DIRECTIVE handling).

import type { YonDocument, YonRecord } from "@younndai/yon-parser";

import { parseAutomator, parseDirective } from "./parse-record.js";
import { automatorToAgentRecords } from "./automator-to-agent.js";

export { ExpanderError } from "./parse-record.js";
export { parseAutomator, parseDirective } from "./parse-record.js";
export { automatorToAgentRecords } from "./automator-to-agent.js";
export type {
  AutomatorRecord,
  DirectiveRecord,
  AutomatorArchetype,
  AutomatorRuntime,
  AutomatorScope,
  AutomatorSource,
  AutomatorTransactionMode,
} from "./types.js";

export interface ExpandOptions {
  // Reserved for Commit 4 — archetype-specific @STEP generation hooks
  // (5-step protocol, etc.). Per the brief, expander stays pure-data-transform
  // in Commit 1; @STEP generation lands alongside the protocol implementation.
  emitSteps?: boolean;
}

export interface ExpandResult {
  document: YonDocument;
  // Diagnostic summary: how many @AUTOMATOR / @DIRECTIVE records were seen,
  // how many records the output has. Callers (and tests) use this to confirm
  // the expansion shape without walking the records array themselves.
  automatorsExpanded: number;
  directivesPreserved: number;
  recordsIn: number;
  recordsOut: number;
}

// Expand a parsed YON document: replace each @AUTOMATOR record with the
// @AGENT + @META projection (yai.lyt-domain L168-191 → yai-domain L352-368),
// preserve @DIRECTIVE records unchanged (Commit 4 may transform them to
// @TENET refs), pass every other tag through unchanged.
//
// The input document is not mutated — a new document object is returned with
// a fresh `records` array. `nodes` and `blocks` carry through unchanged
// (Commit 4 lands the node-stream awareness when @STEP emission requires it).
export function lytExpand(doc: YonDocument, _opts: ExpandOptions = {}): ExpandResult {
  let automatorsExpanded = 0;
  let directivesPreserved = 0;
  const outRecords: YonRecord[] = [];

  for (const record of doc.records) {
    if (record.tag === "AUTOMATOR") {
      const parsed = parseAutomator(record);
      const emitted = automatorToAgentRecords(parsed);
      outRecords.push(...emitted);
      automatorsExpanded++;
    } else if (record.tag === "DIRECTIVE") {
      // Validate but pass through. Commit 4 may convert to @TENET ref form.
      parseDirective(record);
      outRecords.push(record);
      directivesPreserved++;
    } else {
      outRecords.push(record);
    }
  }

  const expanded: YonDocument = {
    ...doc,
    records: outRecords,
  };

  return {
    document: expanded,
    automatorsExpanded,
    directivesPreserved,
    recordsIn: doc.records.length,
    recordsOut: outRecords.length,
  };
}
