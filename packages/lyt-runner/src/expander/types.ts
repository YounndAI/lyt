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

// Shared expander types. Mirrors the @AUTOMATOR / @DIRECTIVE field set from
// arc-thoughts §6.10 (LOCKED 2026-05-27) — see
// the LYT design doc `lyt-yai-domain.md` L168-214.

export type AutomatorRuntime = "deterministic" | "llm" | "hybrid";

export type AutomatorTransactionMode = "none" | "checkpoint" | "atomic";

export type AutomatorScope = "vault" | "mesh";

export type AutomatorSource = "system" | "user" | "mesh" | "marketplace";

export type AutomatorArchetype =
  | "filler"
  | "propagator"
  | "generator"
  | "aggregator"
  | "observer"
  | "validator"
  | "pruner"
  | "integrator"
  | "router"
  | "enricher"
  | "transformer"
  | "scheduler"
  | "notifier"
  | "archiver"
  | "custom";

// The 9 mandatory @AUTOMATOR fields plus the field-set's optional fields that
// the expander reads. Optional fields default to undefined; the expander emits
// defaults at expansion time (matches arc §6.10:370-382 "Optional with sensible
// defaults" semantics).
export interface AutomatorRecord {
  rid: string;            // convention `automator:<name>`
  name: string;
  version: string;
  archetype: AutomatorArchetype;
  description: string;
  source: AutomatorSource;
  runtime: AutomatorRuntime;
  transaction_mode: AutomatorTransactionMode;
  scope: AutomatorScope;
  // Optional (subset relevant to Commit 1 expander):
  signed_by?: string;
  reads_scope?: string[];
  writes_scope?: string[];
  external_calls?: string[];
  field_ownership?: string[];
  rules?: string[];
  handler_gates?: string[];
  llm_capability?: string;
  llm_source_preference?: string[];
  llm_hard_constraints?: string[];
}

// The 7 mandatory @DIRECTIVE fields (arc §6.10:384-398 + yai-domain L200-210).
export interface DirectiveRecord {
  rid: string;            // convention `directive:<id>`
  scope: string; // company:<name>|vault:<owner/repo>|project:<key>|artifact:<rid>
  subject: string;
  rule: string;
  inviolable: boolean;
  owner: string;
  created: string; // ts
  // Optional:
  precedence?: number;
  applies_to?: string[];
  enforced_by?: string[];
}
