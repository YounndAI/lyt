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

// Shared ISO-8601 strict date parser. Extracted as part of A.4.5 release review
// polish #5 — `audit-export.parseDate` and `duration.parseFreezeDuration`
// both needed the same strictness (reject `2026-13-99` overflow, reject
// free-form strings) but were drifting toward separate fixes.
//
// Acceptance shape (matches what Python/Go/SQLite/Postgres emitters actually
// produce):
// - YYYY-MM-DD
// - YYYY-MM-DDTHH:MM(:SS(.fractional)?)?(Z|±HH:?MM)? (T separator)
// - YYYY-MM-DD HH:MM(:SS(.fractional)?)?(Z|±HH:?MM)? (space separator,
// ISO-8601 §4.3.4 + SQLite CURRENT_TIMESTAMP + Postgres timestamptz::text)
// - Fractional seconds: \d+ (V8 truncates extras gracefully past ms)
// - Timezone: Z or ±HH:?MM
//
// Rejection cases:
// - Out-of-range YYYY-MM-DD (2026-13-99 — `new Date` rolls over to a
// finite Date, so we verify via Date.UTC(yyyy, mm-1, dd) and compare
// parsed components against the literal — TZ-safe because we only check
// the date portion).
// - Non-ISO shapes (2026/05/01, 20260501, "not a date").
// - Whitespace-only / empty.

const ISO_DATE_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function parseIsoDateStrict(input: string): Date {
  if (typeof input !== "string") {
    throw new Error(`Not a string: ${JSON.stringify(input)}`);
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Empty date string");
  }
  const shapeMatch = ISO_DATE_SHAPE.exec(trimmed);
  if (!shapeMatch) {
    throw new Error(
      `Not an ISO-8601 date: ${JSON.stringify(input)}. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ.`,
    );
  }
  // Component-level overflow check runs BEFORE V8's Date parse — V8's
  // behaviour on invalid inputs is inconsistent (some roll over to a finite
  // Date, some return Invalid). Doing the check deterministically on regex
  // captures via Date.UTC + getUTC* component compare makes overflow
  // detection independent of engine semantics, and the error message stays
  // consistent ("Out-of-range") regardless of which path V8 would have
  // taken. TZ-safe because we only validate the date portion.
  const yyyy = Number(shapeMatch[1]);
  const mm = Number(shapeMatch[2]);
  const dd = Number(shapeMatch[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    throw new Error(
      `Out-of-range date component in ${JSON.stringify(input)}. Months are 01-12, days are 01-31.`,
    );
  }
  const utc = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (utc.getUTCFullYear() !== yyyy || utc.getUTCMonth() + 1 !== mm || utc.getUTCDate() !== dd) {
    throw new Error(
      `Out-of-range date component in ${JSON.stringify(input)}. Months are 01-12, days depend on month.`,
    );
  }
  const d = new Date(trimmed);
  if (!Number.isFinite(d.getTime())) {
    throw new Error(
      `Not a parseable date: ${JSON.stringify(input)}. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ.`,
    );
  }
  return d;
}
