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

import { formatBytes, infoVaultFlow, resolveVaultNameByPath } from "../flows/info.js";

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

// 0.11.0 write/publish-gate split — the LOCAL-write axis, human rendering. An own
// vault is a plain "yes" (writing here always works, no remote needed); a subscription
// reads as a redirect hint, not a hard "no".
export function formatLocalWritable(localWritable: boolean, reason: string): string {
  if (localWritable) {
    return reason === "own-vault" ? "yes" : "yes (subscribed — you have write access)";
  }
  if (reason === "provenance-unavailable") {
    return "no (registry provenance unavailable — run lyt doctor)";
  }
  return reason === "subscribed-unverifiable"
    ? "no (subscribed — can't verify; edits may not sync, capture to a home vault)"
    : "no (subscribed — edits won't sync; capture to a home vault)";
}

export function buildInfoCommand(): Command {
  const cmd = new Command("info");
  cmd
    .description("Show metadata for a registered vault (path, mesh edges, size)")
    .argument("[name]", "Registered vault name (omit when using --by-path)")
    .option("--json", "Emit machine-readable JSON")
    .option("--by-path <cwd>", "Resolve the vault that contains this path")
    .action(async (name: string | undefined, opts: { json?: boolean; byPath?: string }) => {
      // Exactly one of <name> / --by-path must be given.
      if (name && opts.byPath) {
        // eslint-disable-next-line no-console
        console.error("lyt vault info: pass either <name> or --by-path, not both.");
        process.exit(1);
      }
      if (!name && !opts.byPath) {
        // eslint-disable-next-line no-console
        console.error("lyt vault info: a vault <name> or --by-path <cwd> is required.");
        process.exit(1);
      }
      let resolvedName = name;
      if (opts.byPath) {
        const byPathName = await resolveVaultNameByPath(opts.byPath);
        if (byPathName === null) {
          // eslint-disable-next-line no-console
          console.error(`lyt vault info: ${opts.byPath} is not inside a registered vault.`);
          process.exit(1);
        }
        resolvedName = byPathName;
      }
      const result = await infoVaultFlow(resolvedName as string);
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
      console.log(`  acquisition:       ${v.acquisitionSource}`);
      // eslint-disable-next-line no-console
      console.log(`  destination:       ${formatDestination(v.destination)}`);
      // eslint-disable-next-line no-console
      console.log(
        `  local-writable:    ${formatLocalWritable(v.localWritable, v.localWritableReason)}`,
      );
      // eslint-disable-next-line no-console
      console.log(`  publishable:       ${formatWritable(v.publishable, v.publishableReason)}`);
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

function formatDestination(destination: {
  kind: "local" | "github" | "unconfigured";
  target: { owner: string; kind: "user" | "org"; repository: string | null } | null;
  source: string | null;
}): string {
  if (destination.kind === "github" && destination.target !== null) {
    return `${destination.kind}:${destination.target.kind}/${destination.target.owner}/${destination.target.repository ?? "-"} (${destination.source ?? "-"})`;
  }
  return `${destination.kind}${destination.source === null ? "" : ` (${destination.source})`}`;
}
