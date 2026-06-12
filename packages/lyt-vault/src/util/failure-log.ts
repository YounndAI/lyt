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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getLytHome } from "./paths.js";

// Lane O Phase 0 — PROTO-StepOutcome init-failure instrumentation.
//
// `lyt init` / the setup wizard die at a handful of real runtime points
// (gh-auth, network probes, first-vault create). When they do, the user — who
// is by-design free / non-technical / unsupported / AI-first — gets a one-line
// console message and no durable trail. This module emits a LOCAL,
// AI-readable structured failure RECORD at each death point so a later
// `lyt doctor` (or an agent priming on the pod) can SURFACE what actually went
// wrong, in machine-parseable form.
//
// This is a PROTO-StepOutcome: a deliberately small struct. Phase 1 will
// formalize a StepOutcome contract + presenter; do NOT grow this past a flat
// record. No telemetry, no phone-home, no network — the record is written to
// the user's own lyt home and stays there.
//
// Storage: one append-only JSONL file at `<LYT_HOME>/init-failures.jsonl`
// (resolved via getLytHome() — NEVER hardcoded; respects $LYT_HOME so tests
// isolate cleanly + the file co-locates with registry.db / machine.yon /
// vaults/). One JSON object per line keeps writes atomic-ish (a single append)
// and the format trivially streamable + AI-readable.
//
// RESILIENCE INVARIANT (core objective): every write is wrapped in try/catch.
// Logging a failure must NEVER itself throw or crash init — a logging failure
// is silently swallowed (best-effort). The read path is likewise tolerant:
// malformed lines are skipped, a missing file yields an empty list.

// The real death points init/wizard reach. Kept as a string-union so the field
// is both constrained (a stable vocabulary doctor + agents can match on) and
// flat (no nested enum machinery — PROTO, not a contract).
export type InitFailureSite =
  | "gh-auth"
  | "network-probe"
  | "first-vault-create"
  | "federation-init"
  | "wizard"; // generic wizard-phase fallback

export interface InitFailureRecord {
  // ISO-8601 UTC timestamp of when the failure was recorded.
  ts: string;
  // Where it died — the real runtime site (see InitFailureSite).
  site: InitFailureSite;
  // The step/phase label (e.g. the wizard phase name, or the CLI verb) for
  // human + agent legibility. Free-form but short.
  step: string;
  // One-line error summary (the message the user would have seen, trimmed).
  summary: string;
  // Light, optional, structured context — handle, repo, phase number, etc.
  // Flat key→string map only (PROTO; no nested objects). Omitted when empty.
  context?: Record<string, string>;
}

// Argument shape for recordInitFailure — `ts` is auto-stamped so callers only
// supply the meaningful fields.
export interface RecordInitFailureInput {
  site: InitFailureSite;
  step: string;
  summary: string;
  context?: Record<string, string> | undefined;
}

// Resolve the failure-log path under the user's lyt home. Co-located with the
// other lyt-home artifacts so a `~/lyt` move/copy carries it along.
export function getInitFailureLogPath(): string {
  return join(getLytHome(), "init-failures.jsonl");
}

// Record ONE init-failure to the local JSONL log. Best-effort + NEVER throws:
// the whole body is wrapped in try/catch so a logging failure (read-only home,
// full disk, race) can never abort the init flow it's instrumenting. Returns
// true when the record was written, false when the write was swallowed.
//
// `path` is an injectable test seam (defaults to getInitFailureLogPath()).
export function recordInitFailure(input: RecordInitFailureInput, path?: string): boolean {
  try {
    const p = path ?? getInitFailureLogPath();
    const record: InitFailureRecord = {
      ts: new Date().toISOString(),
      site: input.site,
      step: input.step,
      // Trim + collapse the summary to a single line so one record = one JSONL
      // line (a stray newline in an error message would otherwise split a
      // record across two lines and break the per-line parse).
      summary: oneLine(input.summary),
      ...(input.context !== undefined && Object.keys(input.context).length > 0
        ? { context: input.context }
        : {}),
    };
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    // Resilience: swallow. Logging a failure must never become a new failure.
    return false;
  }
}

// Read recent init-failure records, most-recent LAST (file order = chronological
// since the log is append-only). `limit` caps how many are returned (the tail).
// Tolerant by design: a missing file → []; a malformed line → skipped (not
// fatal); any read error → [] (never throws into the doctor flow).
//
// `path` is an injectable test seam (defaults to getInitFailureLogPath()).
export function readInitFailures(limit = 20, path?: string): InitFailureRecord[] {
  try {
    const p = path ?? getInitFailureLogPath();
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf8");
    const records: InitFailureRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isInitFailureRecord(parsed)) records.push(parsed);
      } catch {
        // Skip a malformed line — a single bad row never poisons the read.
      }
    }
    if (limit >= 0 && records.length > limit) {
      return records.slice(records.length - limit);
    }
    return records;
  } catch {
    return [];
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Minimal structural guard — confirms the parsed JSON carries the required
// flat string fields. Defensive against a hand-edited / corrupt log line.
function isInitFailureRecord(value: unknown): value is InitFailureRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["ts"] === "string" &&
    typeof v["site"] === "string" &&
    typeof v["step"] === "string" &&
    typeof v["summary"] === "string"
  );
}
