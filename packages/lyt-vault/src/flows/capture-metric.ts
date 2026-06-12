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

import { closeRegistry, openRegistry } from "../registry/client.js";
import { newUuidv7Bytes, uuid7BytesToHex } from "../util/uuid7.js";

// Per yai.lyt v1 frontmatter contract (arc §3) + §9.2 ergonomics test
// (Layer 2 — auto-collected metrics). On every Figment capture, the
// /lyt-capture skill shells out to `lyt capture-metric record --json=<p>`
// so the per-machine `~/lyt/registry.db.dogfooding_capture_metrics` table
// gets one row per capture. The skill runs in the Claude Code harness and
// does not import @younndai/lyt-vault directly — the CLI helper is the
// shim that gives it write access to the registry (per plan Open Q6).

export interface CaptureMetricPayload {
  time_to_complete_ms?: number;
  field_values_json?: string;
  llm_assist?: boolean;
  edited_post_capture?: boolean;
  captured_at?: number;
}

export interface CaptureMetricRecordResult {
  idHex: string;
  capturedAt: number;
}

export async function captureMetricRecordFlow(
  payload: CaptureMetricPayload,
): Promise<CaptureMetricRecordResult> {
  const id = newUuidv7Bytes();
  const capturedAt = payload.captured_at ?? Date.now();
  const db = await openRegistry();
  try {
    await db.execute({
      sql:
        "INSERT INTO dogfooding_capture_metrics (id, captured_at, time_to_complete_ms, field_values_json, llm_assist, edited_post_capture)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        id,
        capturedAt,
        payload.time_to_complete_ms ?? null,
        payload.field_values_json ?? null,
        payload.llm_assist === true ? 1 : payload.llm_assist === false ? 0 : null,
        payload.edited_post_capture === true ? 1 : 0,
      ],
    });
  } finally {
    await closeRegistry(db);
  }
  return { idHex: uuid7BytesToHex(id), capturedAt };
}

// Parse + validate the JSON payload supplied to `lyt capture-metric record
// --json <payload>`. Surfaces actionable errors when the skill or test
// fixture passes a malformed shape.
export function parseCaptureMetricPayload(raw: string): CaptureMetricPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--json must be a valid JSON object: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--json must be a JSON object (not an array, number, or null).");
  }
  const obj = parsed as Record<string, unknown>;
  const out: CaptureMetricPayload = {};
  if (obj["time_to_complete_ms"] !== undefined) {
    if (typeof obj["time_to_complete_ms"] !== "number") {
      throw new Error("--json.time_to_complete_ms must be a number.");
    }
    out.time_to_complete_ms = obj["time_to_complete_ms"];
  }
  if (obj["field_values_json"] !== undefined) {
    if (typeof obj["field_values_json"] !== "string") {
      throw new Error("--json.field_values_json must be a string (a JSON-encoded snapshot).");
    }
    out.field_values_json = obj["field_values_json"];
  }
  if (obj["llm_assist"] !== undefined) {
    if (typeof obj["llm_assist"] !== "boolean") {
      throw new Error("--json.llm_assist must be a boolean.");
    }
    out.llm_assist = obj["llm_assist"];
  }
  if (obj["edited_post_capture"] !== undefined) {
    if (typeof obj["edited_post_capture"] !== "boolean") {
      throw new Error("--json.edited_post_capture must be a boolean.");
    }
    out.edited_post_capture = obj["edited_post_capture"];
  }
  if (obj["captured_at"] !== undefined) {
    if (typeof obj["captured_at"] !== "number") {
      throw new Error("--json.captured_at must be a number (epoch ms).");
    }
    out.captured_at = obj["captured_at"];
  }
  return out;
}
