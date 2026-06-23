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

import { Command } from "commander";

import { captureMetricRecordFlow, parseCaptureMetricPayload } from "../flows/capture-metric.js";

interface CaptureMetricRecordOpts {
  json?: string;
}

// CLI helper that gives the harness-side /lyt-capture skill write access to
// ~/lyt/registry.db.dogfooding_capture_metrics. Per arc §9.2 + the lyt v1
// frontmatter contract (arc §3) — the final-week ergonomics test reads from
// this table to compute per-field fill rates, average capture time, post-
// capture-edit rate. Skill-layer write access via shell-out (the skill runs
// in Claude Code's harness sandbox and cannot import @younndai/lyt-vault
// directly).
export function buildCaptureMetricCommand(): Command {
  const cmd = new Command("capture-metric").description(
    "Skill-side helper for the v1 frontmatter ergonomics test. Internal: writes per-capture rows to ~/lyt/registry.db.dogfooding_capture_metrics.",
  );

  cmd
    .command("record")
    .description(
      'Record one dogfooding capture metric. Payload: {"time_to_complete_ms":<int>,"field_values_json":"<json-snapshot>","llm_assist":<bool>,"edited_post_capture":<bool?>}',
    )
    .requiredOption("--json <payload>", "JSON-encoded CaptureMetricPayload")
    .action(async (opts: CaptureMetricRecordOpts) => {
      const payload = parseCaptureMetricPayload(opts.json ?? "");
      const result = await captureMetricRecordFlow(payload);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result));
    });

  return cmd;
}
