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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpRow, ToolResult } from "./registry.js";

/**
 * fed-v2 L2 Governance Phase 2 — dispatch-time enforcement options.
 *
 * `handlerApproved` is the OUT-OF-BAND server-startup approval. It is read ONCE
 * at launch from the process environment / server profile (see
 * `resolveHandlerApproval` in server.ts), NEVER from a tool-call `args` object.
 * It is threaded into `registerTools` as an explicit parameter so the gate
 * decision is fixed at registration time — before any client can issue a
 * CallTool — and is structurally outside the reach of the args a tool caller
 * controls.
 */
export interface RegisterToolsOptions {
  /**
   * True iff the server was launched with the out-of-band handler approval
   * present (env/profile). When false (the default), every `handlerGated` op
   * fails closed at dispatch. Forge-proof: a tool caller cannot set this — it
   * is not part of any tool's `inputSchema` and is resolved before dispatch.
   */
  handlerApproved: boolean;
}

/**
 * Reserved input-field name that would let a caller self-authorize a gated
 * mutation. The gate is server-side (env/profile, out-of-band); a mutation's
 * `inputSchema` must NEVER expose this field, so an attacker `confirmed:true`
 * is inexpressible through the tool-call surface. Enforced at registration
 * (Unit [P2-C]).
 *
 * SEE ALSO (coupled — keep in sync; a rename here MUST move with these sites):
 *   The string literal "confirmed" is also the defense-in-depth gate field the
 *   real gated-flow handlers hardcode `confirmed: false` against:
 *     - packages/lyt-mcp/src/registry.ts — the 4 gated-op handlers
 *       (vault.share / vault.unshare / vault.invites.accept / vault.abandon)
 *       each call their flow with `confirmed: false` (the second fail-closed
 *       beneath the dispatch gate).
 *     - packages/lyt-vault/src/flows/{share.ts,invites.ts,abandon.ts} — the
 *       flow-layer `if (!args.confirmed) throw ...` refusals those `false`s trip.
 *   Renaming this constant without renaming the flow/handler `confirmed` field
 *   would silently de-couple the strip (here) from the field it strips —
 *   re-exposing the smuggle. Grep `confirmed` across both packages before any
 *   rename (per /audit-coupled-constant).
 */
const CALLER_SETTABLE_GATE_FIELD = "confirmed";

/**
 * F-1 ([P2-C] clause 1 / threat-map F5) — registration-time STRUCTURAL
 * INVARIANT allowlist. These are the routine local/own-vault writers that are
 * CONSCIOUSLY ungated (handlerGated:false): they touch only the operator's own
 * local registry / own-vault state, not an irreversible cross-actor grant.
 * Handler-approved 2026-06-21. The invariant in `registerTools` THROWS at
 * registration for ANY `access:"write"` op that is neither handlerGated:true
 * nor named here — so a NEW write op cannot register ungated by accident.
 * Keep this set EXACTLY the censused routine writers; widening it is a
 * conscious governance decision, not a convenience.
 */
const SAFE_UNGATED_WRITE_OPS: ReadonlySet<string> = new Set<string>([
  "vault.reconnect",
  "mesh.source.add",
  "mesh.source.remove",
  "capture",
  "sync",
]);

/**
 * Unit [P2-C] — registration-time structural invariant. A write op's
 * `inputSchema` must NEVER carry a caller-settable `confirmed` field (the gate
 * is server-side, out-of-band). We STRIP the field at registration so it is
 * structurally absent from the schema the MCP client sees: the SDK validates
 * incoming args against the registered schema, so a smuggled `confirmed` arg is
 * not a declared field and cannot reach the handler as a recognized gate
 * signal. Stripping (vs. throwing) keeps the op registered so the dispatch gate
 * (Unit 1) still applies — defense-in-depth, not an all-or-nothing refusal.
 * Returns the (possibly new) schema with the forbidden field removed.
 *
 * F-6 — RAW-SHAPE CONVENTION (load-bearing for this strip). An op's
 * `inputSchema` MUST be a Zod RAW SHAPE — a plain object map of
 * `{ field: zType }` (the `ZodRawShape` typed on `OpRow.inputSchema`) — and
 * NOT a pre-built `z.object(...)` / `.passthrough()` / `.loose()` INSTANCE.
 * The strip below works by `hasOwnProperty` + `delete` on the shape's OWN
 * enumerable keys. A built `ZodObject` instance hides its fields behind
 * `.shape` / `._def`, so `confirmed` would NOT be an own-key here — the strip
 * would silently no-op, and a `.passthrough()`/`.loose()` schema would then
 * FORWARD a smuggled `confirmed` straight to the handler. The runtime guard
 * below fails loud if a non-raw-shape sneaks in.
 */
function stripCallerSettableGateField(
  inputSchema: OpRow["inputSchema"],
): OpRow["inputSchema"] {
  // F-6 runtime guard — reject a pre-built Zod schema instance masquerading as
  // a raw shape. A real `ZodObject` carries a `_def` (and/or a function-valued
  // `parse`); a raw shape is a plain map of field→zType with neither. Failing
  // loud here is cheaper than a silently-bypassed strip re-exposing the smuggle.
  const maybeSchema = inputSchema as Record<string, unknown>;
  if (
    inputSchema !== null &&
    typeof inputSchema === "object" &&
    (typeof maybeSchema["parse"] === "function" || "_def" in maybeSchema)
  ) {
    throw new Error(
      "op inputSchema must be a Zod raw shape ({ field: zType }), not a pre-built " +
        "z.object()/.passthrough()/.loose() instance — a built schema bypasses the " +
        "caller-settable-gate-field strip and could forward a smuggled `confirmed`.",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(inputSchema, CALLER_SETTABLE_GATE_FIELD)) {
    return inputSchema;
  }
  const sanitized: Record<string, unknown> = { ...(inputSchema as Record<string, unknown>) };
  delete sanitized[CALLER_SETTABLE_GATE_FIELD];
  return sanitized as OpRow["inputSchema"];
}

/**
 * Build the fail-closed ToolResult returned when a `handlerGated` op is
 * dispatched without the out-of-band approval. No raw jargon: it names the gate
 * and the remedy (launch the server with the approval present) so a client sees
 * an actionable refusal, not an internal flag name dump.
 */
function handlerGateRefusal(opName: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `Refused: '${opName}' is a handler-gated mutation and this MCP server ` +
          `was not launched with handler approval. The gate is server-side and ` +
          `out-of-band — it cannot be satisfied from tool-call input. To allow ` +
          `this operation, the operator must start the server with the handler ` +
          `approval enabled (set the LYT_MCP_HANDLER_APPROVAL launch variable).`,
      },
    ],
    isError: true,
  };
}

/**
 * fed-v2 L2 Governance Phase 2 — registers each op-registry row as an MCP tool,
 * enforcing `handlerGated` at DISPATCH (default-deny).
 *
 * Unit [P2-C] (registration-time structural invariant): a write op whose
 * `inputSchema` exposes a caller-settable `confirmed` field has that field
 * STRIPPED at registration, so the schema the MCP client sees never carries it.
 * This makes an attacker-supplied `confirmed:true` inexpressible through the
 * tool surface (the SDK validates args against the registered schema, where
 * `confirmed` is no longer a declared field) — the gate is server-side only.
 *
 * Unit 1 (default-deny dispatch): each row's dispatch is wrapped so that when
 * `row.handlerGated === true`, the wrapper FAILS CLOSED (returns an error
 * ToolResult, does NOT call `row.handler`) UNLESS the out-of-band server
 * approval (`opts.handlerApproved`, Unit 2) is present. When `handlerGated` is
 * falsy (read ops), dispatch is normal.
 *
 * Unit 2 (forge-proof transport): the approval arrives ONLY via `opts`, which
 * the server resolves at launch from env/profile — never from `args`. It is
 * therefore structurally impossible to satisfy the gate from the `args` object a
 * tool caller controls. NOTE: MCP `elicitInput` is explicitly NOT used as the
 * gate — it round-trips the approval back through the issuing (possibly
 * compromised) client, which is exactly the reach we are excluding; the gate
 * must be out-of-band, outside the agent's tool-call path.
 *
 * The per-flow `confirmed:false` hardcoded in the 4 real mutation handlers is
 * RETAINED as defense-in-depth (a second, independent fail-closed below
 * dispatch); this dispatch gate does not replace it.
 */
export function registerTools(
  server: McpServer,
  rows: OpRow[],
  opts: RegisterToolsOptions = { handlerApproved: false },
): void {
  for (const row of rows) {
    // F-1 ([P2-C] clause 1 / threat-map F5) — registration-time STRUCTURAL
    // INVARIANT, fail-loud. A write op MUST be either handlerGated:true OR an
    // explicitly allowlisted routine writer. Asserted BEFORE registration so a
    // NEW write op cannot register ungated by accident — this is what makes the
    // `handlerGated` flag structurally load-bearing rather than advisory.
    if (
      row.access === "write" &&
      row.handlerGated !== true &&
      !SAFE_UNGATED_WRITE_OPS.has(row.name)
    ) {
      throw new Error(
        `Registration refused: write op '${row.name}' is neither handlerGated:true ` +
          `nor allowlisted. A write op must be handlerGated:true or explicitly ` +
          `allowlisted in SAFE_UNGATED_WRITE_OPS (generate-tools.ts).`,
      );
    }

    // Unit [P2-C] — registration-time structural invariant. A write op must not
    // expose a caller-settable `confirmed` field; strip it so the registered
    // schema cannot carry a caller-expressible gate signal.
    const inputSchema =
      row.access === "write" ? stripCallerSettableGateField(row.inputSchema) : row.inputSchema;

    const dispatch = row.handlerGated
      ? // Unit 1 — default-deny: a handler-gated op fails closed at dispatch
        // unless the out-of-band approval was present at launch. We never call
        // row.handler in the refused case, so no mutation runs.
        (args: Record<string, unknown>): ToolResult | Promise<ToolResult> =>
          opts.handlerApproved ? row.handler(args) : handlerGateRefusal(row.name)
      : // Read / non-gated ops dispatch normally.
        (args: Record<string, unknown>): Promise<ToolResult> => row.handler(args);

    server.registerTool(
      row.name,
      { title: row.title, description: row.description, inputSchema },
      (args) => dispatch(args as Record<string, unknown>),
    );
  }
}
