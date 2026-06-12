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

import { startStdioServer } from "./server.js";

export function buildMcpSubcommand(): Command {
  const mcp = new Command("mcp").description(
    "Run the Lyt MCP server (exposes vault + mesh operations to MCP clients)",
  );

  mcp
    .command("start")
    .description("Start the MCP server (stdio transport by default; --port reserved for v1.5+)")
    .option("--stdio", "Use stdio transport (default)")
    .option("--port <port>", "TCP port (NOT IMPLEMENTED in the Phase-5 stub; stdio only)")
    .action(async (opts: { stdio?: boolean; port?: string }) => {
      if (opts.port !== undefined) {
        throw new Error(
          "--port is reserved for v1.5+. Phase 5 stub supports stdio transport only.",
        );
      }
      await startStdioServer();
    });

  return mcp;
}
