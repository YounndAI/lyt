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

// @AUTOMATOR → @AGENT transformation.
//
// Per arc-thoughts §6.11 (LOCKED 2026-05-27 — `lyt-runner = thin wrapper on
// yon-runner + yai.lyt expander`), the yai.lyt expander transforms @AUTOMATOR
// records into core YON @AGENT + @STEP + ops + @TENET refs BEFORE yon-runner
// executes them.
//
// This module implements the @AUTOMATOR → @AGENT half of the transform.
// The @STEP / op-invocation half lands in Commit 4 alongside the 5-step
// protocol (arc §6.6). For now, @STEP emission is deferred — the @AGENT
// record carries enough metadata for downstream tooling to introspect; the
// runner only executes @STEPs, so a doc with @AGENT + no @STEP is a valid
// no-op (matches the "register the metadata; defer the execution" Commit 1
// scaffold posture).

import type { YonRecord, YonValue } from "@younndai/yon-parser";

import type { AutomatorRecord } from "./types.js";

// Builds an @AGENT YonRecord from a parsed AutomatorRecord. The output
// mirrors yai.lyt-domain L358-368 @AGENT shape:
//
// @AGENT rid=agent:lyt-memcycle | name="lyt-memcycle" | type=ai
//  | caps=[std:data.*,std:fs.read,lyt:db.write]
//  | streams=[stream:lyt-cmd,stream:lyt-events]
//
// Caps are derived from the automator's reads_scope ∪ writes_scope ∪
// external_calls — those declare what surfaces the automator must touch,
// which maps directly onto yon-runner's permission system (the caps list
// becomes the runner's allowlist patterns).
//
// The original @AUTOMATOR record's archetype/source/version/runtime/scope
// fields are preserved as adjacent @META records on the agent (yai-domain
// L222-271 @META pattern). This keeps the agent inspectable without losing
// information across the transform.
export function automatorToAgentRecords(automator: AutomatorRecord): YonRecord[] {
  // Convention: @AUTOMATOR's rid is `automator:<name>`; @AGENT's rid is
  // `agent:<name>`. The convention is captured in yai-domain L177 (@AUTOMATOR
  // rid convention) and L358 (@AGENT rid convention from the example).
  const agentRid = automator.rid.startsWith("automator:")
    ? `agent:${automator.rid.slice("automator:".length)}`
    : `agent:${automator.name}`;

  const caps = collectCaps(automator);

  const agentFields = new Map<string, YonValue>();
  agentFields.set("rid", agentRid);
  agentFields.set("name", automator.name);
  agentFields.set("type", automator.runtime === "deterministic" ? "deterministic" : "ai");
  if (caps.length > 0) {
    agentFields.set("caps", {
      kind: "reference-tokens",
      items: caps,
    });
  }

  // Typed-fields mirror — typeHint preserved for round-trip per parser §3.1.7.
  // Per parse-record.ts, we read fields via the simplified `fields` map; for
  // emission we keep typedFields aligned so a future round-trip caller can
  // reproduce the original surface.
  const agentTypedFields = new Map<string, { key: string; value: YonValue }>();
  for (const [key, value] of agentFields) {
    agentTypedFields.set(key, { key, value });
  }

  const agent: YonRecord = {
    tag: "AGENT",
    fields: agentFields,
    typedFields: agentTypedFields,
    line: 0,
    column: 0,
  };

  const metaRecords: YonRecord[] = [
    metaRecord("automator_archetype", automator.archetype),
    metaRecord("automator_source", automator.source),
    metaRecord("automator_version", automator.version),
    metaRecord("automator_runtime", automator.runtime),
    metaRecord("automator_scope", automator.scope),
    metaRecord("automator_transaction_mode", automator.transaction_mode),
    metaRecord("description", automator.description),
  ];

  if (automator.signed_by !== undefined) {
    metaRecords.push(metaRecord("signed_by", automator.signed_by));
  }

  return [agent, ...metaRecords];
}

function metaRecord(key: string, value: string): YonRecord {
  const fields = new Map<string, YonValue>([
    ["key", key],
    ["value", value],
  ]);
  const typedFields = new Map<string, { key: string; value: YonValue }>();
  typedFields.set("key", { key: "key", value: key });
  typedFields.set("value", { key: "value", value });
  return {
    tag: "META",
    fields,
    typedFields,
    line: 0,
    column: 0,
  };
}

function collectCaps(automator: AutomatorRecord): string[] {
  const caps = new Set<string>();
  // Permission-shape caps from reads/writes scope.
  for (const s of automator.reads_scope ?? []) {
    if (s === "vault") {
      caps.add("std:fs.read");
      caps.add("std:fs.list");
    } else if (s === "external:git") {
      caps.add("std:exec");
    } else if (s.startsWith("child-vault") || s === "child-vaults") {
      caps.add("lyt:mesh.pull");
    }
  }
  for (const s of automator.writes_scope ?? []) {
    if (s === "vault") {
      caps.add("std:fs.write");
      caps.add("lyt:vault.write");
    } else if (s === "libsql" || s === "registry") {
      caps.add("lyt:db.write");
    }
  }
  // External-calls verbatim — these are pre-qualified op patterns.
  for (const c of automator.external_calls ?? []) {
    caps.add(c);
  }
  // LLM capability — if the automator declares any, advertise std:llm.* caps.
  if (automator.llm_capability !== undefined && automator.llm_capability !== "none") {
    caps.add("std:llm.generate");
  }
  return Array.from(caps).sort();
}
