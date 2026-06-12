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

import { generateMeshCanvasFlow } from "../flows/canvas-mesh.js";
import { meshInitFlow } from "../flows/mesh-init.js";
import { meshJoinFlow } from "../flows/mesh-join.js";
import { meshListFlow } from "../flows/mesh-list.js";
import type { MeshPushKind } from "../yon/mesh-write.js";
import { buildMeshAddEdgeSubcommand } from "./add-mesh-edge.js";
import { buildMeshAdoptSubcommand } from "./mesh-adopt.js";
import { buildMeshInfoSubcommand } from "./mesh-info.js";
import { buildMeshPublishSubcommand } from "./mesh-publish.js";
import { buildMeshSubscribeSubcommand } from "./subscribe.js";
import { buildMeshUpdateCadenceSubcommand } from "./mesh-update-cadence.js";
import { buildMeshValidateSubcommand } from "./mesh-validate.js";
import { buildMeshRebuildRollupCommand } from "./mesh-rebuild-rollup.js";
import { buildRebuildMeshRegistryCommand } from "./rebuild-mesh-registry.js";

// v1.B.1 — `lyt mesh init|join|list`. Mirrors the `commands/federation.ts`
// parent-with-subcommands shape so the CLI structure stays uniform across
// the v1.A.0 federation surface and the v1.B.1 mesh surface.
//
// Per Lock 0.3 (SAI-compatible), every subcommand exposes a deterministic
// `--json` mode. Human-readable output mirrors the existing `lyt vault list`
// style.

export function buildMeshCommand(): Command {
  const cmd = new Command("mesh").description(
    "Manage meshes — groups of vaults sharing a GitHub push target. v1.B.1 ships init/join/list; v1.D.5 adds canvas; v1.B.2 adds rebuild-registry; v1.B.6 adds publish + info (federation-design v2 §3 + §6 + lyt-public-mesh §2.1).",
  );
  cmd.addCommand(buildMeshInitSubcommand());
  cmd.addCommand(buildMeshJoinSubcommand());
  cmd.addCommand(buildMeshListSubcommand());
  cmd.addCommand(buildMeshCanvasSubcommand());
  cmd.addCommand(buildRebuildMeshRegistryCommand());
  cmd.addCommand(buildMeshRebuildRollupCommand());
  cmd.addCommand(buildMeshPublishSubcommand());
  cmd.addCommand(buildMeshInfoSubcommand());
  cmd.addCommand(buildMeshUpdateCadenceSubcommand());
  cmd.addCommand(buildMeshAddEdgeSubcommand());
  cmd.addCommand(buildMeshValidateSubcommand());
  cmd.addCommand(buildMeshSubscribeSubcommand());
  cmd.addCommand(buildMeshAdoptSubcommand());
  return cmd;
}

interface MeshInitCliOpts {
  pushTo?: string;
  pushKind?: string;
  parent?: string;
  // commander writes `push: false` for the `--no-push` flag (not `noPush`).
  // Same trap as v1.A.0 DO NOT SKIP #5 (federation.ts); fixed inline here.
  push?: boolean;
  json?: boolean;
}

function buildMeshInitSubcommand(): Command {
  return new Command("init")
    .description(
      "Provision a new mesh + scaffold its main vault ('<name>/main'). Per naming-convention.md, mesh names are bare ('alex', 'younndai', 'marlink'); the main vault is named 'main' automatically.",
    )
    .argument("<name>", "Mesh name (bare; no '/'; slug-safe)")
    .option(
      "--push-to <gh-target>",
      "GitHub handle or org to push the main vault repo to (defaults to your GH handle when push is enabled)",
    )
    .option("--push-kind <handle|org>", "Push target kind", "handle")
    .option(
      "--parent <existing-mesh>",
      "Parent mesh — the new main vault's parent_vault FK resolves to the parent mesh's main vault rid",
    )
    .option("--no-push", "Skip the initial git push (local commits only)")
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (name: string, opts: MeshInitCliOpts) => {
      const pushKind: MeshPushKind | undefined =
        opts.pushKind === "org" ? "org" : opts.pushKind === "handle" ? "handle" : undefined;
      // commander's `.option("--no-push", ...)` stores the inverse on `opts.push`.
      // Read it from the raw bag — the typed shape carries `push?: boolean` so
      // `opts.push === false` is the canonical "skip push" signal.
      const noPush = opts.push === false;
      const result = await meshInitFlow({
        name,
        ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
        ...(opts.pushTo !== undefined ? { pushTo: opts.pushTo } : {}),
        ...(pushKind !== undefined ? { pushKind } : {}),
        noPush,
      });

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              mesh: {
                rid: `mesh:${result.meshRidHex}`,
                rid_hex: result.meshRidHex,
                name: result.meshName,
                push_target: result.pushTarget,
                push_kind: result.pushKind,
              },
              main_vault: {
                rid: `vault:${result.mainVault.ridHex}`,
                rid_hex: result.mainVault.ridHex,
                name: result.mainVault.name,
                path: result.mainVault.path,
              },
              parent_vault:
                result.parentVault === null
                  ? null
                  : {
                      rid: `vault:${result.parentVault.ridHex}`,
                      rid_hex: result.parentVault.ridHex,
                      name: result.parentVault.name,
                    },
              pushed: result.pushed,
            },
            null,
            2,
          ),
        );
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`Mesh '${result.meshName}' created`);
      // eslint-disable-next-line no-console
      console.log(`  mesh rid:     mesh:${result.meshRidHex}`);
      // eslint-disable-next-line no-console
      console.log(`  main vault:   ${result.mainVault.name} (vault:${result.mainVault.ridHex})`);
      // eslint-disable-next-line no-console
      console.log(`  path:         ${result.mainVault.path}`);
      if (result.parentVault !== null) {
        // eslint-disable-next-line no-console
        console.log(
          `  parent vault: ${result.parentVault.name} (vault:${result.parentVault.ridHex})`,
        );
      }
      if (result.pushTarget !== null) {
        // eslint-disable-next-line no-console
        console.log(
          ` push target: ${result.pushKind}:${result.pushTarget}${result.pushed ? " (pushed)" : ""}`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.log(`  push:         skipped (--no-push)`);
      }
    });
}

interface MeshJoinCliOpts {
  from: string;
  cloneMembers?: boolean;
  json?: boolean;
}

function buildMeshJoinSubcommand(): Command {
  return new Command("join")
    .description(
      "Join an existing mesh from a GitHub source. Clones the main vault's repo, reads .lyt/mesh.yon, registers the mesh locally.",
    )
    .argument("<name>", "Local mesh name (typically matches the remote name)")
    .requiredOption(
      "--from <gh-target>",
      "GitHub handle or org owning the main vault repo (e.g. 'younndai' → github.com/younndai/main)",
    )
    .option(
      "--clone-members",
      "Also clone every @MESH_HOME-listed vault (out-of-scope in v1.B.1 — flag is currently a no-op; v1.B.3 wires the cascading clone)",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (name: string, opts: MeshJoinCliOpts) => {
      const result = await meshJoinFlow({
        name,
        from: opts.from,
        cloneMembers: opts.cloneMembers === true,
      });

      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              mesh: {
                rid: `mesh:${result.meshRidHex}`,
                rid_hex: result.meshRidHex,
                name: result.meshName,
                push_target: result.pushTarget,
                push_kind: result.pushKind,
              },
              main_vault: {
                rid: `vault:${result.mainVault.ridHex}`,
                rid_hex: result.mainVault.ridHex,
                name: result.mainVault.name,
                path: result.mainVault.path,
              },
              home_vaults_registered: result.homeVaultsRegistered,
              home_vaults_deferred: result.homeVaultsDeferred,
            },
            null,
            2,
          ),
        );
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`Joined mesh '${result.meshName}'`);
      // eslint-disable-next-line no-console
      console.log(`  mesh rid:    mesh:${result.meshRidHex}`);
      // eslint-disable-next-line no-console
      console.log(`  main vault:  ${result.mainVault.name} (vault:${result.mainVault.ridHex})`);
      // eslint-disable-next-line no-console
      console.log(`  path:        ${result.mainVault.path}`);
      // eslint-disable-next-line no-console
      console.log(
        ` homes: ${result.homeVaultsRegistered} registered, ${result.homeVaultsDeferred} deferred-clone`,
      );
    });
}

interface MeshCanvasCliOpts {
  mesh?: string;
  nowIso?: string;
  json?: boolean;
}

function buildMeshCanvasSubcommand(): Command {
  return new Command("canvas")
    .description(
      "v1.D.5: render the mesh as an Obsidian Canvas (.canvas) — mesh → vaults → cross-mesh subscriptions. Writes to <mesh-main-vault>/.lyt/canvases/mesh-graph.canvas.",
    )
    .requiredOption("--mesh <name>", "Mesh name (must exist in the local registry)")
    .option("--now-iso <iso>", "Pin the 'now' timestamp for deterministic testing (ISO 8601)")
    .option("--json", "Emit JSON result instead of human-readable output")
    .action(async (opts: MeshCanvasCliOpts) => {
      if (opts.mesh === undefined || opts.mesh.length === 0) {
        emitMeshCanvasError(opts.json === true, {
          error: "missing-mesh",
          message: "--mesh <name> is required.",
        });
        process.exitCode = 1;
        return;
      }
      try {
        const res = await generateMeshCanvasFlow({
          meshName: opts.mesh,
          ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
        });
        if (opts.json === true) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                canvasPath: res.canvasPath,
                meshRid: res.meshRid,
                meshName: res.meshName,
                vaultCount: res.vaultCount,
                crossMeshSubscriptionCount: res.crossMeshSubscriptionCount,
                nodeCount: res.nodeCount,
                edgeCount: res.edgeCount,
                durationMs: res.durationMs,
              },
              null,
              2,
            ),
          );
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `Mesh canvas for ${res.meshName} written to ${res.canvasPath} (${res.vaultCount} vaults, ${res.crossMeshSubscriptionCount} subscriptions, ${res.nodeCount} nodes, ${res.edgeCount} edges; ${res.durationMs}ms).`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitMeshCanvasError(opts.json === true, {
          error: "canvas-mesh-error",
          message,
        });
        process.exitCode = 2;
      }
    });
}

function emitMeshCanvasError(json: boolean, body: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(body, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(`lyt mesh canvas: ${String(body["message"] ?? body["error"])}`);
  }
}

interface MeshListCliOpts {
  json?: boolean;
}

function buildMeshListSubcommand(): Command {
  return new Command("list")
    .description(
      "List meshes the user participates in. ★ marks each mesh's main vault per naming-convention.md.",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(async (opts: MeshListCliOpts) => {
      const result = await meshListFlow();
      if (opts.json === true) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              meshes: result.meshes.map((m) => ({
                rid: `mesh:${m.ridHex}`,
                rid_hex: m.ridHex,
                name: m.name,
                push_target: m.pushTarget,
                push_kind: m.pushKind,
                main_vault:
                  m.mainVault === null
                    ? null
                    : {
                        rid: `vault:${m.mainVault.ridHex}`,
                        rid_hex: m.mainVault.ridHex,
                        name: m.mainVault.name,
                      },
                home_vaults: m.homeVaults.map((v) => ({
                  rid: `vault:${v.ridHex}`,
                  rid_hex: v.ridHex,
                  name: v.name,
                })),
                subscribed_vaults: m.subscribedVaults.map((v) => ({
                  rid: `vault:${v.ridHex}`,
                  rid_hex: v.ridHex,
                  name: v.name,
                })),
              })),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (result.meshes.length === 0) {
        // eslint-disable-next-line no-console
        console.log("No meshes yet. Run 'lyt mesh init <name>' to create one.");
        return;
      }
      for (const m of result.meshes) {
        // eslint-disable-next-line no-console
        console.log(`Mesh '${m.name}' (mesh:${m.ridHex})`);
        if (m.pushTarget !== null) {
          // eslint-disable-next-line no-console
          console.log(`  push target: ${m.pushKind}:${m.pushTarget}`);
        }
        for (const home of m.homeVaults) {
          const marker = m.mainVault !== null && home.ridHex === m.mainVault.ridHex ? "★" : " ";
          // eslint-disable-next-line no-console
          console.log(`  ${marker} ${home.name} (vault:${home.ridHex})`);
        }
        for (const sub of m.subscribedVaults) {
          // eslint-disable-next-line no-console
          console.log(`    ${sub.name} (subscribed; vault:${sub.ridHex})`);
        }
      }
    });
}
