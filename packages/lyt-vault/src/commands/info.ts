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

import { formatBytes, infoVaultFlow } from "../flows/info.js";

// Exported so tests can pin the human-readable rendering against the
// actual production string mapping rather than re-deriving the same
// logic in test fixtures (release review mi-2).
export function formatWritable(writable: true | false | "unknown", reason: string): string {
  if (writable === true) return "yes";
  if (writable === false) return "no";
  if (reason === "gh-unavailable") return "unknown (gh offline)";
  if (reason === "no-remote") return "unknown (no remote)";
  if (reason === "orphan-vault") return "unknown (not in a mesh)";
  return "unknown";
}

export function buildInfoCommand(): Command {
  const cmd = new Command("info");
  cmd
    .description("Show metadata for a registered vault (path, mesh edges, size)")
    .argument("<name>", "Registered vault name")
    .option("--json", "Emit machine-readable JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      const result = await infoVaultFlow(name);
      if (opts.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const v = result.vault;
      // eslint-disable-next-line no-console
      console.log(`Vault: ${v.name}`);
      if (v.status === "tombstoned") {
        // eslint-disable-next-line no-console
        console.log(
          ` [BURIED — this vault used to exist here. Edges below are as-of tombstoning.]`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(`  rid:               ${v.rid}`);
      // eslint-disable-next-line no-console
      console.log(`  path:              ${v.path}`);
      // eslint-disable-next-line no-console
      console.log(`  status:            ${v.status}`);
      // eslint-disable-next-line no-console
      console.log(`  writable:          ${formatWritable(v.writable, v.writableDetermination)}`);
      // eslint-disable-next-line no-console
      console.log(`  memscope:          ${v.memscopeRid ?? "-"}`);
      // eslint-disable-next-line no-console
      console.log(`  parent_vault:      ${v.parentVault ?? "-"}`);
      // eslint-disable-next-line no-console
      console.log(`  home_mesh:         ${v.homeMeshRid ?? "-"}`);
      // eslint-disable-next-line no-console
      console.log(`  tier_hint:         ${v.tierHint ?? "-"}`);
      // eslint-disable-next-line no-console
      console.log(`  git_url:           ${v.gitUrl ?? "-"}`);
      // eslint-disable-next-line no-console
      console.log(`  created_at:        ${v.createdAt ?? "-"}`);
      // eslint-disable-next-line no-console
      console.log(`  registered_at:     ${v.registeredAt}`);
      // eslint-disable-next-line no-console
      console.log(`  last_verified_at:  ${v.lastVerifiedAt ?? "-"}`);
      // eslint-disable-next-line no-console
      console.log(`  verify_fail_count: ${v.verifyFailCount}`);
      // eslint-disable-next-line no-console
      console.log(`  files:             ${result.fileCount}`);
      // eslint-disable-next-line no-console
      console.log(`  size:              ${formatBytes(result.sizeBytes)}`);
      // eslint-disable-next-line no-console
      console.log(`  outbound edges:    ${result.edges.length}`);
      // eslint-disable-next-line no-console
      console.log(`  inbound edges:     ${result.inboundEdges.length}`);
      for (const e of result.inboundEdges) {
        // eslint-disable-next-line no-console
        console.log(`    ${e.sourceVaultRid} ${e.edgeType}→ here`);
      }
    });
  return cmd;
}
