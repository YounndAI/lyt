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

import { addEdgeFlow } from "../flows/add-edge.js";

export function buildAddEdgeCommand(): Command {
  const cmd = new Command("add-edge");
  cmd
    .description(
      "Add a mesh edge to a vault: --share-with <peer-rid> (peer connection, recorded in .lyt/vault.yon only) or --parent <peer-rid> (hierarchical parent; writes vaults.parent_vault + .lyt/vault.yon + the registry mesh_edges row that rollup walks, when both sides have local home meshes). Use 'lyt mesh validate' after to confirm reciprocity.",
    )
    .argument("<vault-name>", "Local vault name (as shown by 'lyt vault list')")
    .option("--share-with <peer-rid>", "Add a share_with edge to <peer-rid>")
    .option("--parent <peer-rid>", "Set this vault's parent_vault to <peer-rid>")
    .option(
      "--force",
      "Replace an existing parent (otherwise --parent refuses when one is already set)",
    )
    .action(
      async (vaultName: string, opts: { shareWith?: string; parent?: string; force?: boolean }) => {
        if (opts.shareWith && opts.parent) {
          process.stderr.write(
            "Choose only one of --share-with or --parent (they are mutually exclusive).\n",
          );
          process.exitCode = 1;
          return;
        }
        if (!opts.shareWith && !opts.parent) {
          process.stderr.write("Pass --share-with <peer-rid> or --parent <peer-rid>.\n");
          process.exitCode = 1;
          return;
        }
        try {
          const result = await addEdgeFlow({
            vaultName,
            peerRid: (opts.shareWith ?? opts.parent)!,
            edge: opts.shareWith ? "share_with" : "parent",
            force: opts.force === true,
          });
          if (result.yonAlreadyHadEdge) {
            // eslint-disable-next-line no-console
            console.log(
              `Edge already present in ${result.yonPath} (registry row updated; no .yon change).`,
            );
          } else {
            // eslint-disable-next-line no-console
            console.log(
              `Added ${result.edge} edge to '${result.vaultName}' → ${result.peerRidHex}. ` +
                `Updated ${result.yonPath}.`,
            );
          }
          if (!result.peerInLocalRegistry) {
            process.stderr.write(
              `Warning: peer rid ${result.peerRidHex} is not in the local registry. ` +
                `Edge inserted; run 'lyt mesh validate' once the peer is cloned to confirm reciprocity.\n`,
            );
          }
          // F6 — say honestly whether the rollup-visible edge landed durably
          // (@MESH_EDGE SoT + mesh_edges cache via the mesh add-edge writer).
          if (result.edge === "parent" && !result.meshEdgeWritten) {
            process.stderr.write(
              `Warning: rollup-visible @MESH_EDGE NOT written (${result.meshEdgeSkipReason ?? "unknown reason"}). ` +
                `'lyt vault rebuild-rollup' will not traverse this edge until it lands.\n`,
            );
          }
          // a review finding — surface what happened to a replaced parent's edge.
          if (result.oldParentEdgeNote !== null) {
            process.stderr.write(`Replaced-parent edge: ${result.oldParentEdgeNote}\n`);
          }
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    );
  return cmd;
}
