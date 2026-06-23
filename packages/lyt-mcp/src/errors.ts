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

import type { ToolResult } from "./registry.js";

/**
 * Phase A — structured MCP error mapping.
 *
 * Flow refusals (deriveWriteGate write-gate refusals, missing mandatory
 * frontmatter contract fields) and any unexpected throw must reach the client
 * as the SDK's structured error result (`isError: true`), NEVER as a raw stack,
 * SQLite string, or internal path. This centralizes that shaping so the
 * per-tool handlers stay thin and the generator (`generate-tools.ts`) is never
 * thickened.
 *
 * The flow refusals are already actionable, sanitized prose (see
 * SUBSCRIBER_CAPTURE_REFUSAL UNVERIFIED_WRITE_REFUSAL and the
 * mandatory-frontmatter-token validation message in lyt-vault). We surface the
 * `Error.message` verbatim — these are designed to be client-facing — and fall
 * back to a generic string for non-Error throws so no internal object is
 * stringified into the response.
 */
// Phase E (trust-boundary gate) — LANDED: toErrorResult no longer surfaces an
// arbitrary err.message verbatim. The designed flow refusals
// (SUBSCRIBER_CAPTURE_REFUSAL / UNVERIFIED_WRITE_REFUSAL / mandatory-token /
// scope-mandatory / handler-gated fail-closed) are sanitized client-facing prose
// and still pass through — but they are distinguishable from an UNEXPECTED throw
// (e.g. writeFileSync EACCES carrying an absolute path, a libSQL/SQLITE error with
// a DB file path, a stack frame, or a node_modules path) ONLY by message content:
// none of them carry a LEAK SIGNATURE. So we classify by leak signature, not by
// refusal identity — a message carrying an absolute path (Windows drive-letter /
// UNC / POSIX-rooted), a SQLITE_* code, a stack frame, or node_modules is replaced
// with a generic client message AND the real error is console.error'd to server
// stderr (never the client ToolResult). Everything else passes through verbatim so
// the sanitized designed refusals are preserved byte-for-byte. (Release review POV-2,
// Phase A → Phase E trust-boundary gate.)

const GENERIC_CLIENT_ERROR = "lyt-mcp: an internal error occurred.";

/**
 * A message LEAKS internal detail when it carries any of:
 *   - an absolute filesystem path:
 *       Windows drive-letter (`C:\…`, `C:/…`), UNC (`\\host\…`), or POSIX-rooted (`/usr/…`)
 *   - a SQLite error code (`SQLITE_*`)
 *   - a stack frame (`    at fn (file:line:col)` / `at …:NN`)
 *   - a `node_modules` path segment
 * Such a message is NOT a designed refusal (those carry none of these) and must be
 * suppressed before it reaches the client.
 */
function leaksInternalDetail(message: string): boolean {
  return (
    // Windows drive-letter absolute path: `C:\…` or `C:/…`
    /[A-Za-z]:[\\/]/.test(message) ||
    // Windows UNC path: `\\server\share`
    /\\\\[^\\]/.test(message) ||
    // POSIX absolute path: a rooted `/segment/…` (≥2 segments to avoid bare "/"
    // or sentence-ending slashes; the designed refusals use no such token). The
    // path may be preceded by start-of-string, whitespace, or a delimiter such
    // as a quote/paren (e.g. `open '/home/alex/…'`) — anything that is NOT a
    // path char — so the leading `/` is genuinely a root, not a mid-word slash
    // like the `company/handbook` in a refusal (that `/` follows a path char).
    /(?:^|[^A-Za-z0-9._/-])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+/.test(message) ||
    // SQLite error code.
    /SQLITE_[A-Z]+/.test(message) ||
    // A V8 stack frame.
    /\bat\s+.+:\d+(?::\d+)?\)?/.test(message) ||
    // A node_modules path segment.
    /node_modules/.test(message)
  );
}

export function toErrorResult(err: unknown): ToolResult {
  const rawMessage =
    err instanceof Error && typeof err.message === "string" && err.message.length > 0
      ? err.message
      : undefined;

  let message: string;
  if (rawMessage === undefined) {
    // Non-Error throw (or empty message) — never stringify an internal object.
    console.error("[lyt-mcp] non-Error thrown from tool handler:", err);
    message = GENERIC_CLIENT_ERROR;
  } else if (leaksInternalDetail(rawMessage)) {
    // Unexpected throw carrying a leak signature (path / SQLITE / stack /
    // node_modules) — log the real error to server stderr, return a generic
    // message to the client. The real detail NEVER reaches the ToolResult.
    console.error("[lyt-mcp] internal error (suppressed from client):", err);
    message = GENERIC_CLIENT_ERROR;
  } else {
    // A sanitized, designed refusal (or any leak-free message) — pass through
    // verbatim so the actionable client-facing prose is preserved.
    message = rawMessage;
  }

  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Wrap a tool handler body so any throw becomes a structured error result
 * instead of propagating (which the SDK would turn into a protocol-level error
 * carrying the raw message). Keeps the success path untouched.
 */
export async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return toErrorResult(err);
  }
}
