#!/usr/bin/env node
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

import { createRequire } from "node:module";

import { Command } from "commander";

import { buildMcpSubcommand } from "./mcp-command.js";

const program = new Command();

program
  .name("lyt-mcp")
  .description("Lyt MCP server — exposes vault + mesh operations to MCP clients")
  .version((createRequire(import.meta.url)("../package.json") as { version: string }).version);

program.addCommand(buildMcpSubcommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`lyt-mcp: ${message}`);
  process.exit(1);
});
