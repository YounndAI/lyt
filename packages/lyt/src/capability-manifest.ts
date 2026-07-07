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

// Increment 1 · Phase 0 (gate 2) — the capability manifest: the declared list of
// ops that MUST be reachable on BOTH the CLI and the MCP surface (the
// agent-operable core). DATA ONLY — no generator (deferred until surface churn
// justifies it).
//
// WHAT THE PARITY TEST ENFORCES FROM THIS MANIFEST (and its limits — do not
// over-read the guarantee):
//   • a declared op missing from EITHER surface fails CI;
//   • the MCP registry growing a tool NOT declared here fails CI (undeclared-MCP
//     drift) — the enforceable half. It is NOT a universal "no CLI-only op"
//     guarantee: the manifest is a hand-kept allowlist, so a brand-new
//     agent-relevant CLI verb that nobody declared is invisible to the gate — the
//     residual the deferred capability-registry generator (plan §Scope) would close.
//   • access + handlerGated parity is checked; OUTPUT-SHAPE (`--json`) parity is
//     NOT — intentionally out of scope (a generator's job). Known live asymmetry:
//     the MCP `search` tool returns a lossy `LeanSearchResult` projection vs the
//     CLI; a future `outputContract` field on CapabilityOp is where that'd be pinned.
//
// SCOPE: this is the PARITY set, not every verb. Many CLI verbs are intentionally
// CLI-only (`doctor`, `init`, `repair`, `discover`, `skills`, `bench`, the
// `vault rebuild-*` maintenance family, …) — local/maintenance operations an agent
// drives through higher-level ops, not 1:1 MCP tools. They are out of this set by
// design; only ops that are part of the agent's read/write loop are parity-bound.

/** How an op accesses state. Must match the MCP OpRow.access. */
export type OpAccess = "read" | "write";

/** One parity-required op — reachable on both CLI and MCP. */
export interface CapabilityOp {
  /** Stable op id — the MCP tool name (dotted). */
  id: string;
  /** MCP tool name as registered in buildOpRegistry(). */
  mcp: string;
  /** CLI command path (space-separated), as reachable in buildProgram(). */
  cli: string;
  /** read | write — cross-checked against the MCP OpRow.access. */
  access: OpAccess;
  /** True when the op mutates behind a handler-approval gate — cross-checked against OpRow.handlerGated. */
  handlerGated: boolean;
  /** One-line side-effect summary. */
  sideEffects: string;
  /** Optional note for a deliberate CLI/MCP shape asymmetry. */
  note?: string;
}

export const CAPABILITY_MANIFEST: readonly CapabilityOp[] = [
  { id: "vault.list", mcp: "vault.list", cli: "vault list", access: "read", handlerGated: false, sideEffects: "none" },
  { id: "vault.info", mcp: "vault.info", cli: "vault info", access: "read", handlerGated: false, sideEffects: "none" },
  { id: "vault.verify", mcp: "vault.verify", cli: "vault verify", access: "read", handlerGated: false, sideEffects: "flips missing/tombstoned status in the registry (no file writes)" },
  { id: "vault.reconnect", mcp: "vault.reconnect", cli: "vault reconnect", access: "write", handlerGated: false, sideEffects: "repoints a registry row to a new path" },
  { id: "mesh.source.list", mcp: "mesh.source.list", cli: "mesh source list", access: "read", handlerGated: false, sideEffects: "none" },
  { id: "mesh.source.add", mcp: "mesh.source.add", cli: "mesh source add", access: "write", handlerGated: false, sideEffects: "registers a vault source" },
  { id: "mesh.source.remove", mcp: "mesh.source.remove", cli: "mesh source remove", access: "write", handlerGated: false, sideEffects: "removes a vault source" },
  { id: "capture", mcp: "capture", cli: "capture", access: "write", handlerGated: false, sideEffects: "writes a Figment + indexes it" },
  { id: "search", mcp: "search", cli: "search", access: "read", handlerGated: false, sideEffects: "none" },
  { id: "sync", mcp: "sync", cli: "sync", access: "write", handlerGated: false, sideEffects: "writes GitHub repo metadata + regenerates agents.md (on --apply)" },
  { id: "primer", mcp: "primer", cli: "primer", access: "read", handlerGated: false, sideEffects: "writes a primer file unless --dry-run" },
  { id: "vault.share", mcp: "vault.share", cli: "vault share", access: "write", handlerGated: true, sideEffects: "grants a gh repo-collaborator" },
  { id: "vault.unshare", mcp: "vault.unshare", cli: "vault unshare", access: "write", handlerGated: true, sideEffects: "revokes a gh repo-collaborator" },
  { id: "vault.access", mcp: "vault.access", cli: "vault access", access: "read", handlerGated: false, sideEffects: "none" },
  { id: "vault.invites", mcp: "vault.invites", cli: "vault invites", access: "read", handlerGated: false, sideEffects: "none" },
  { id: "vault.invites.accept", mcp: "vault.invites.accept", cli: "vault invites", access: "write", handlerGated: true, sideEffects: "accepts a gh repo invitation", note: "CLI folds accept into `vault invites` (an --accept flag), not a distinct subcommand; MCP splits list vs accept into two tools." },
  { id: "vault.abandon", mcp: "vault.abandon", cli: "vault abandon", access: "write", handlerGated: true, sideEffects: "removes local .lyt/ adoption state + deregisters" },
] as const;
