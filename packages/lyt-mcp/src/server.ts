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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  infoVaultFlow,
  listVaultsFlow,
  reconnectVaultFlow,
  verifyVaultsFlow,
} from "@younndai/lyt-vault";
import {
  addSource,
  listSources,
  parseScope,
  removeSource,
  serializeScope,
  withRegistry,
} from "@younndai/lyt-mesh";

export const SERVER_NAME = "lyt-mcp";
export const SERVER_VERSION = "0.1.0";

export function buildLytMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ---- vault tools ----

  server.registerTool(
    "vault.list",
    {
      title: "List Lyt vaults",
      description:
        "List all registered Lyt vaults on this machine. Returns rid, name, path, status, edges-count, etc.",
      inputSchema: {
        includeTombstones: z
          .boolean()
          .optional()
          .describe("Include tombstoned vaults in the result (default: true)"),
      },
    },
    async ({ includeTombstones }) => {
      const noTombstones = includeTombstones === false;
      const { vaults } = await listVaultsFlow({ noTombstones });
      return {
        content: [{ type: "text", text: JSON.stringify({ vaults }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "vault.info",
    {
      title: "Vault info",
      description:
        "Show metadata for a registered vault: path, mesh edges (outbound + inbound), size, file count.",
      inputSchema: {
        name: z.string().describe("Registered vault name"),
      },
    },
    async ({ name }) => {
      const result = await infoVaultFlow(name);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "vault.verify",
    {
      title: "Verify vaults",
      description:
        "Walk the registry, stat each path, flip missing vaults to status='missing'. Read-only on files. Auto-promotes 'missing' rows to 'tombstoned' after threshold N failures (default 3; override via LYT_TOMBSTONE_THRESHOLD).",
      inputSchema: {
        thresholdN: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Auto-promotion threshold; defaults to env LYT_TOMBSTONE_THRESHOLD or 3"),
      },
    },
    async ({ thresholdN }) => {
      const result = await verifyVaultsFlow(thresholdN === undefined ? {} : { thresholdN });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "vault.reconnect",
    {
      title: "Reconnect vault",
      description:
        "Heal a missing or disconnected vault by repointing the registry row to a new filesystem path. Validates .lyt/vault.yon rid matches the registry row.",
      inputSchema: {
        name: z.string().describe("Registered vault name"),
        newPath: z.string().describe("New filesystem path containing the vault"),
      },
    },
    async ({ name, newPath }) => {
      const result = await reconnectVaultFlow({ name, newPath });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ---- mesh source tools ----

  server.registerTool(
    "mesh.source.list",
    {
      title: "List mesh sources",
      description: "List configured vault sources (where Lyt looks for vaults to clone).",
      inputSchema: {},
    },
    async () => {
      const sources = await withRegistry(listSources);
      const serialized = sources.map((s) => ({ ...s, scope: serializeScope(s.scope) }));
      return {
        content: [{ type: "text", text: JSON.stringify({ sources: serialized }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "mesh.source.add",
    {
      title: "Add mesh source",
      description: "Register a new vault source.",
      inputSchema: {
        name: z.string().describe("Soft label, e.g. 'younndai', 'acme', 'personal'"),
        host: z.string().describe("Git host hostname, e.g. 'github.com'"),
        owner: z.string().describe("Org or user under that host"),
        scope: z
          .string()
          .optional()
          .describe(
            "Which repos count: 'all' | 'topic=<tag>' | 'repos=<a,b,c>' (default: topic=lyt-vault)",
          ),
      },
    },
    async ({ name, host, owner, scope }) => {
      const parsed = parseScope(scope ?? "topic=lyt-vault");
      const row = await withRegistry((db) => addSource(db, { name, host, owner, scope: parsed }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...row, scope: serializeScope(row.scope) }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "mesh.source.remove",
    {
      title: "Remove mesh source",
      description: "Remove a configured vault source by name.",
      inputSchema: {
        name: z.string().describe("Source name to remove"),
      },
    },
    async ({ name }) => {
      const removed = await withRegistry((db) => removeSource(db, name));
      return {
        content: [{ type: "text", text: JSON.stringify({ name, removed }, null, 2) }],
      };
    },
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = buildLytMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
