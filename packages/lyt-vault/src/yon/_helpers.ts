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

// Shared YON string-quoting primitives.
//
// Closes v1.A.0 release review #8 (yon/federation-read.ts duplicates parsing
// helper) + #9 (yon/federation-write.ts escapeQuoted duplicated) by giving
// both federation-{read,write}.ts AND ledger-{read,write}.ts a single source
// of truth for the YON quoted-string escape contract.
//
// The escape contract: backslashes double, then quote characters become \".
// Inverse: \" becomes " then \\ becomes \. This pairing must round-trip
// byte-identically — every caller depends on it.
//
// Why this file does NOT consolidate the field walkers as well: the four
// YON readers in this package split into two shapes, not one. ledger-read.ts
// walks linearly (record N → @STAMP → record N+1; @STAMP carries forward the
// chain hash) and needs the full key-by-key collectFields state machine.
// federation-read.ts uses regex-keyed field readers (readQuotedField,
// readBareField, readMetaBare) that look up specific keys by name without
// walking. Both are correct shapes for their respective documents — ledgers
// are append-only sequences; pod.yon is a small structured document
// with known keys — and consolidating them would require choosing one shape
// for both, regressing the other. Full consolidation lands at v1.A.3 when
// the @younndai/yon-parser runtime dep replaces both hand-rolled walkers.

import { createHash } from "node:crypto";

export function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function unescapeQuoted(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// Parse a `details_json` field value (written via JSON.stringify on the
// emit side) back into a Record. Returns undefined for non-object JSON,
// invalid JSON, or any thrown shape. Shared between rebuild-index.ts +
// sync-post-pull-ledger.ts (closes v1.A.2d release review R1 — byte-identical
// duplication across both ledger-rebuild paths).
export function safeParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

// The ledger chain-hash primitive — single source of truth for BOTH the writer
// (ledger-write.ts, which stamps `hash=sha256(prior-record-bytes)`) and the
// reader's recompute-and-warn (ledger-read.ts). These two MUST hash byte-
// identically forever or tamper detection silently breaks (a false positive on
// every chained record, or a missed tamper) — and the divergence would have NO
// compile-time guard. Consolidated here (per the coupled-constant directive)
// rather than duplicated; this file is the established home for exactly this
// (see escapeQuoted above, #8/#9). Domain is UTF-8 → hex.
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
