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

// v1.A.5 v1.A.2d-CR-1 — Audit + Provenance YON → cache-args mapper extraction.
//
// Before v1.A.5: the conversion from a parsed-YON LedgerRecord (returned by
// walkLedger) to AuditLedgerFields / ProvenanceLedgerFields lived inline at
// four call sites: sync-post-pull-ledger.ts (audit + provenance) and
// rebuild-index.ts (audit + provenance, ledger-only branch). Each block was
// ~10-20 lines of `r.fields.get(...) ?? default` lookups + optional-field
// spread, byte-near-identical between the two consumers.
//
// After v1.A.5: both consumers call mapAuditYonToCacheArgs / mapProvenance
// YonToCacheArgs from this module. The per-record-type shape (chosen over
// a single generic with discriminator) preserves the asymmetric optional-
// field-ordering invariants — audit has 1 optional (details), provenance has
// 8 optionals with byte-stable emit order per v1.A.2 contract.
//
// Both helpers return null on records that can't be reasonably converted
// (missing ts, missing required targetType for provenance, non-finite ts).
// Callers loop with `const fields = mapXxxYonToCacheArgs(r); if (fields ===
// null) continue;` — same skip-and-continue semantics the inline blocks had.

import type { AuditLedgerFields } from "../audit-write.js";
import type { ProvenanceLedgerFields, ProvenanceWriteTargetType } from "../provenance-write.js";
import { safeParseJson } from "../../yon/_helpers.js";
import type { LedgerRecord } from "../../yon/ledger-read.js";

// Map a parsed AUDIT @LEDGER record to AuditLedgerFields. Returns null when
// the record cannot be salvaged (missing ts / non-finite parsed ts). The
// caller's loop should `continue` on null. `defaultAction` lets the caller
// override the fallback for the action field (sync uses "vault.access.lost";
// rebuild uses "vault.index.rebuilt") — preserves the prior call-site
// defaults verbatim.
export function mapAuditYonToCacheArgs(
  record: LedgerRecord,
  defaultAction = "vault.access.lost",
): AuditLedgerFields | null {
  if (record.recordType !== "AUDIT") return null;
  const tsRaw = record.fields.get("ts") ?? record.stampTs;
  if (!tsRaw) return null;
  const ts = Date.parse(tsRaw);
  if (!Number.isFinite(ts)) return null;
  const detailsRaw = record.fields.get("details_json");
  return {
    ts,
    actor: record.fields.get("actor") ?? "system:lyt",
    action: record.fields.get("action") ?? defaultAction,
    targetType: record.fields.get("target_type") ?? "vault",
    targetId: record.fields.get("target_id") ?? "",
    ...(record.fields.get("result") !== undefined
      ? { result: record.fields.get("result") as "success" | "failure" | "denied" }
      : {}),
    ...(detailsRaw !== undefined ? { details: safeParseJson(detailsRaw) } : {}),
  };
}

// Map a parsed PROVENANCE @LEDGER record to ProvenanceLedgerFields. Returns
// null when the record cannot be salvaged (missing ts / non-finite parsed
// ts / missing target_type). Preserves the v1.A.2 byte-stable optional-
// field ordering: method → confidence → hash → tokens → cost_usd → model
// → approver → details_json (matches recordProvenance's emit order).
export function mapProvenanceYonToCacheArgs(record: LedgerRecord): ProvenanceLedgerFields | null {
  if (record.recordType !== "PROVENANCE") return null;
  const tsRaw = record.fields.get("ts") ?? record.stampTs;
  if (!tsRaw) return null;
  const ts = Date.parse(tsRaw);
  if (!Number.isFinite(ts)) return null;
  const targetType = record.fields.get("target_type");
  if (targetType === undefined) return null;
  const detailsRaw = record.fields.get("details_json");
  const confidenceRaw = record.fields.get("confidence");
  const tokensRaw = record.fields.get("tokens");
  const costRaw = record.fields.get("cost_usd");
  return {
    ts,
    targetType: targetType as ProvenanceWriteTargetType,
    targetId: record.fields.get("target_id") ?? "",
    src: record.fields.get("src") ?? "system:lyt",
    ...(record.fields.get("method") !== undefined ? { method: record.fields.get("method")! } : {}),
    ...(confidenceRaw !== undefined && Number.isFinite(Number(confidenceRaw))
      ? { confidence: Number(confidenceRaw) }
      : {}),
    ...(record.fields.get("hash") !== undefined ? { hash: record.fields.get("hash")! } : {}),
    ...(tokensRaw !== undefined && Number.isFinite(Number(tokensRaw))
      ? { tokens: Number(tokensRaw) }
      : {}),
    ...(costRaw !== undefined && Number.isFinite(Number(costRaw))
      ? { costUsd: Number(costRaw) }
      : {}),
    ...(record.fields.get("model") !== undefined ? { model: record.fields.get("model")! } : {}),
    ...(record.fields.get("approver") !== undefined
      ? { approver: record.fields.get("approver")! }
      : {}),
    ...(detailsRaw !== undefined ? { details: safeParseJson(detailsRaw) } : {}),
  };
}
