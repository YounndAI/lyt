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

// Parser for the `--until` flag on `lyt vault freeze`. Accepts:
// - Relative durations: `1h`, `24h`, `7d`, `30d` (case-insensitive suffix).
// - Absolute ISO dates: `2026-06-15`, `2026-06-15T18:00`, `2026-06-15T18:00:00Z`, etc.
// Returns the resolved target as an ISO-8601 UTC string.

import { parseIsoDateStrict } from "./iso-date.js";

export const DEFAULT_FREEZE_DURATION = "24h";

export function parseFreezeDuration(input: string, now: Date = new Date()): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("--until: value is required (e.g. '24h', '7d', '2026-06-15')");
  }
  const m = trimmed.match(/^(\d+)([smhd])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--until: invalid duration: ${input}`);
    }
    const multipliers: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 60 * 60_000,
      d: 24 * 60 * 60_000,
    };
    const ms = n * multipliers[unit]!;
    return new Date(now.getTime() + ms).toISOString();
  }
  // A.4.5 polish #5: shared strictness with audit-export.parseDate. The prior
  // lenient `new Date(trimmed)` accepted `2026-13-99` (rolls over to a finite
  // Date around 2027-04-08) — frozen-until-wrong-date is the bug class a review finding
  // closed for audit-export. Closes the same door here.
  try {
    return parseIsoDateStrict(trimmed).toISOString();
  } catch {
    throw new Error(
      `--until: not a recognized duration or ISO date: '${input}'. ` +
        `Try '1h', '24h', '7d', or an ISO date like '2026-06-15'.`,
    );
  }
}

export function formatRemaining(untilIso: string, now: Date = new Date()): string {
  const until = Date.parse(untilIso);
  if (Number.isNaN(until)) return "unknown";
  const diff = until - now.getTime();
  if (diff <= 0) return "expired";
  const sec = Math.floor(diff / 1_000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}
