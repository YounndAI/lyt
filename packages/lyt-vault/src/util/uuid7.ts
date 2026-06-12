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

import { parse as uuidParse, v7 as uuidv7 } from "uuid";

// libSQL's in-process client (@libsql/client@^0.15.15) does not expose the
// `uuid7()` SQL function (load_extension is "not authorized" for the embedded
// driver), so block-A PKs are TS-supplied: UUIDv7 generated in Node, encoded
// as a 16-byte Uint8Array, and bound as a BLOB to the INSERT.
//
// Verified empirically 2026-05-27 via `SELECT uuid7()` and
// `SELECT load_extension('uuid')` — both error against the local file driver.
// The schemas therefore declare `BLOB PRIMARY KEY` without a DEFAULT.
export function newUuidv7Bytes(): Uint8Array {
  return uuidParse(uuidv7());
}

// 16-byte UUID v7 has the high nibble of byte 6 set to 0x70-0x7F (version = 7
// per RFC 9562). Use to assert PK correctness in tests + at boundaries.
//
// Accepts Uint8Array (which Node `Buffer` is a subclass of) AND ArrayBuffer —
// libSQL's @libsql/client driver returns BLOB columns as plain ArrayBuffer
// on Windows in some build paths; tests would otherwise see a structurally
// valid UUIDv7 fail the type check.
export function isUuidv7Bytes(bytes: unknown): bytes is Uint8Array {
  const view = toUint8(bytes);
  if (!view) return false;
  if (view.length !== 16) return false;
  return (view[6]! & 0xf0) === 0x70;
}

function toUint8(b: unknown): Uint8Array | null {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  return null;
}

// 16-byte UUID → 32-char lowercase hex (no dashes). The CLI surface uses
// this when rendering audit_log/provenance row ids that handlers can paste
// back as arguments (e.g., `lyt friction resolve <hexid>`).
export function uuid7BytesToHex(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i++) {
    s += view[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

// Constant-time-ish equality on two UUIDv7 BLOB rids. Both sides may be
// null (e.g. comparing two `parentVault` columns where either could be
// NULL); two nulls compare equal, null vs bytes is unequal. Used widely
// across flows that previously compared rid strings with `===`.
export function ridsEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Convenience: dashed 8-4-4-4-12 form of a 16-byte UUIDv7. Used by
// `vault.yon` writers (per v1.A.1 step 7) and by surfaces that prefer
// the canonical RFC 9562 string form.
export function uuid7BytesToDashedString(bytes: Uint8Array | ArrayBuffer): string {
  const hex = uuid7BytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Accepts either 32 hex chars (the CLI-rendered shape) OR the canonical
// 8-4-4-4-12 dashed UUID form. Returns the 16-byte Uint8Array. Throws on
// any other input — the caller (CLI handler) surfaces the error verbatim.
export function hexToUuid7Bytes(hex: string): Uint8Array {
  const stripped = hex.replace(/-/g, "").toLowerCase();
  if (stripped.length !== 32 || !/^[0-9a-f]{32}$/.test(stripped)) {
    throw new Error(
      `Not a valid UUIDv7 hex string: ${JSON.stringify(hex)} (expected 32 hex chars or 8-4-4-4-12 dashed).`,
    );
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
