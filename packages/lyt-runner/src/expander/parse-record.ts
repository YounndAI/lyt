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

// Field readers for YonRecord. Per yon-parser/src/types.ts L141-152, every
// YonRecord exposes `fields: Map<string, YonValue>`. YonValue is the
// scalar-or-list union from §3.1.2; the parser does NOT coerce — values are
// raw strings, lists are { kind, items[] } structures.
//
// These helpers extract typed projections of the field map without invoking
// runtime parser internals. Hand-rolled rather than depending on a yon-parser
// helper module so the surface stays minimal (arc §6.11 + project CLAUDE.md
// "hand-rolled parsers in lyt-vault" precedent).

import type { YonRecord, YonValue } from "@younndai/yon-parser";

import type {
  AutomatorRecord,
  AutomatorArchetype,
  AutomatorRuntime,
  AutomatorScope,
  AutomatorSource,
  AutomatorTransactionMode,
  DirectiveRecord,
} from "./types.js";

export class ExpanderError extends Error {
  constructor(
    message: string,
    public readonly tag: string,
    public readonly line: number,
  ) {
    super(`expander: ${message} (tag=@${tag}, line=${line})`);
    this.name = "ExpanderError";
  }
}

function asString(v: YonValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  return undefined;
}

function asList(v: YonValue | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return undefined;
  if (Array.isArray(v)) return undefined; // YonMapPair[] — not a flat list
  // Per yon-parser/src/types.ts L91-96, YonList = { kind, items[] }
  if (v.kind === "reference-tokens") {
    return v.items.filter((it): it is string => typeof it === "string");
  }
  if (v.kind === "field-items") {
    return v.items
      .map((it) =>
        typeof it === "string" ? it : "key" in it && "value" in it ? `${it.key}` : undefined,
      )
      .filter((s): s is string => typeof s === "string");
  }
  return undefined;
}

function asBool(v: YonValue | undefined): boolean | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

function require(field: string, value: string | undefined, tag: string, line: number): string {
  if (value === undefined || value === "") {
    throw new ExpanderError(`missing required field "${field}"`, tag, line);
  }
  return value;
}

const VALID_ARCHETYPES = new Set<string>([
  "filler",
  "propagator",
  "generator",
  "aggregator",
  "observer",
  "validator",
  "pruner",
  "integrator",
  "router",
  "enricher",
  "transformer",
  "scheduler",
  "notifier",
  "archiver",
  "custom",
]);

const VALID_RUNTIMES = new Set<string>(["deterministic", "llm", "hybrid"]);
const VALID_TXN_MODES = new Set<string>(["none", "checkpoint", "atomic"]);
const VALID_SCOPES = new Set<string>(["vault", "mesh"]);
const VALID_SOURCES = new Set<string>(["system", "user", "mesh", "marketplace"]);

export function parseAutomator(record: YonRecord): AutomatorRecord {
  if (record.tag !== "AUTOMATOR") {
    throw new ExpanderError(`expected @AUTOMATOR, got @${record.tag}`, record.tag, record.line);
  }
  const f = record.fields;
  const rid = require("rid", asString(f.get("rid")), "AUTOMATOR", record.line);
  const name = require("name", asString(f.get("name")), "AUTOMATOR", record.line);
  const version = require("version", asString(f.get("version")), "AUTOMATOR", record.line);
  const archetype = require("archetype", asString(f.get("archetype")), "AUTOMATOR", record.line);
  if (!VALID_ARCHETYPES.has(archetype)) {
    throw new ExpanderError(
      `archetype "${archetype}" is not one of the 15 valid archetypes`,
      "AUTOMATOR",
      record.line,
    );
  }
  const description = require("description", asString(
    f.get("description"),
  ), "AUTOMATOR", record.line);
  const source = require("source", asString(f.get("source")), "AUTOMATOR", record.line);
  if (!VALID_SOURCES.has(source)) {
    throw new ExpanderError(
      `source "${source}" is not one of system|user|mesh|marketplace`,
      "AUTOMATOR",
      record.line,
    );
  }
  const runtime = require("runtime", asString(f.get("runtime")), "AUTOMATOR", record.line);
  if (!VALID_RUNTIMES.has(runtime)) {
    throw new ExpanderError(
      `runtime "${runtime}" is not one of deterministic|llm|hybrid`,
      "AUTOMATOR",
      record.line,
    );
  }
  const transaction_mode = require("transaction_mode", asString(
    f.get("transaction_mode"),
  ), "AUTOMATOR", record.line);
  if (!VALID_TXN_MODES.has(transaction_mode)) {
    throw new ExpanderError(
      `transaction_mode "${transaction_mode}" is not one of none|checkpoint|atomic`,
      "AUTOMATOR",
      record.line,
    );
  }
  const scope = require("scope", asString(f.get("scope")), "AUTOMATOR", record.line);
  if (!VALID_SCOPES.has(scope)) {
    throw new ExpanderError(`scope "${scope}" is not one of vault|mesh`, "AUTOMATOR", record.line);
  }

  return {
    rid,
    name,
    version,
    archetype: archetype as AutomatorArchetype,
    description,
    source: source as AutomatorSource,
    runtime: runtime as AutomatorRuntime,
    transaction_mode: transaction_mode as AutomatorTransactionMode,
    scope: scope as AutomatorScope,
    signed_by: asString(f.get("signed_by")),
    reads_scope: asList(f.get("reads_scope")),
    writes_scope: asList(f.get("writes_scope")),
    external_calls: asList(f.get("external_calls")),
    field_ownership: asList(f.get("field_ownership")),
    rules: asList(f.get("rules")),
    handler_gates: asList(f.get("handler_gates")),
    llm_capability: asString(f.get("llm_capability")),
    llm_source_preference: asList(f.get("llm_source_preference")),
    llm_hard_constraints: asList(f.get("llm_hard_constraints")),
  };
}

export function parseDirective(record: YonRecord): DirectiveRecord {
  if (record.tag !== "DIRECTIVE") {
    throw new ExpanderError(`expected @DIRECTIVE, got @${record.tag}`, record.tag, record.line);
  }
  const f = record.fields;
  const inviolable = asBool(f.get("inviolable"));
  if (inviolable === undefined) {
    throw new ExpanderError(`missing required field "inviolable" (bool)`, "DIRECTIVE", record.line);
  }
  const precedence = asString(f.get("precedence"));
  return {
    rid: require("rid", asString(f.get("rid")), "DIRECTIVE", record.line),
    scope: require("scope", asString(f.get("scope")), "DIRECTIVE", record.line),
    subject: require("subject", asString(f.get("subject")), "DIRECTIVE", record.line),
    rule: require("rule", asString(f.get("rule")), "DIRECTIVE", record.line),
    inviolable,
    owner: require("owner", asString(f.get("owner")), "DIRECTIVE", record.line),
    created: require("created", asString(f.get("created")), "DIRECTIVE", record.line),
    precedence: precedence !== undefined ? Number.parseInt(precedence, 10) : undefined,
    applies_to: asList(f.get("applies_to")),
    enforced_by: asList(f.get("enforced_by")),
  };
}
