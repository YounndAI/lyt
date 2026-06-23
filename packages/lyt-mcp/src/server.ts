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

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildOpRegistry } from "./registry.js";
import { registerTools } from "./generate-tools.js";

export const SERVER_NAME = "lyt-mcp";

/**
 * fed-v2 L2 Governance Phase 2 — Unit 2: the out-of-band handler-approval read.
 *
 * The MCP-dispatch gate for `handlerGated` mutations (generate-tools.ts) is
 * satisfied ONLY by this launch-time signal, resolved ONCE at server
 * construction from the process environment — NEVER from a tool-call `args`
 * object. Because it is read here, before any transport is connected and any
 * CallTool can arrive, and is threaded into `registerTools` as an explicit
 * parameter, it is structurally impossible for a tool caller to set it: the
 * value lives outside the agent's tool-call reach.
 *
 * Why env/profile and NOT MCP `elicitInput`: elicitInput would route the
 * approval prompt back through the issuing (possibly compromised) client — the
 * very surface we are trying to gate. The approval MUST come from outside the
 * client's control. An operator launches the server with this variable set; the
 * agent that issues tool calls has no path to it.
 *
 * Truthy values ("1", "true", "yes", "on", case-insensitive) enable the gate;
 * anything else (incl. unset) leaves it default-deny — every handler-gated op
 * fails closed.
 */
export function resolveHandlerApproval(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["LYT_MCP_HANDLER_APPROVAL"];
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

// C1 (0.9.x Phase A) — report the REAL package version, never a hardcoded stub
// (was pinned at "0.1.0" while the package shipped 0.9.5). Reads
// packages/lyt-mcp/package.json relative to the compiled file: src/server.ts →
// dist/server.js, so 2 levels up reaches the package root in both layouts.
function readPackageVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = pathResolve(here, "..", "..", "package.json");
    const raw = readFileSync(candidate, "utf8");
    const json = JSON.parse(raw) as { version?: string };
    if (typeof json.version === "string" && json.version.length > 0) return json.version;
  } catch {
    /* fall through — a packaging defect must not crash the server */
  }
  return "0.0.0";
}

export const SERVER_VERSION = readPackageVersion();

export function buildLytMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  // fed-v2 L2 Phase 2 — resolve the out-of-band handler approval at launch and
  // thread it into registerTools so handlerGated mutations are gated at
  // dispatch. Default-deny: absent/falsy env → every gated op fails closed.
  registerTools(server, buildOpRegistry(), { handlerApproved: resolveHandlerApproval() });
  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = buildLytMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
