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

import { buildAddEdgeCommand } from "./commands/add-edge.js";
import { buildAdoptCommand } from "./commands/adopt.js";
import { buildCloneCommand } from "./commands/clone.js";
import { buildDeleteCommand } from "./commands/delete.js";
import { buildDisconnectCommand } from "./commands/disconnect.js";
import { buildForgetCommand } from "./commands/forget.js";
import { buildFreezeCommand } from "./commands/freeze.js";
import { buildInfoCommand } from "./commands/info.js";
import { buildInitCommand } from "./commands/init.js";
import { buildJoinCommand } from "./commands/join.js";
import { buildListCommand } from "./commands/list.js";
import { buildListSnapshotsCommand } from "./commands/list-snapshots.js";
import { buildMoveCommand } from "./commands/move.js";
import { buildOpenCommand } from "./commands/open.js";
import { buildRenameCommand } from "./commands/rename.js";
import { buildRebuildArcsCommand } from "./commands/rebuild-arcs.js";
import { buildRebuildFtsCommand } from "./commands/rebuild-fts.js";
import { buildRebuildIndexCommand } from "./commands/rebuild-index.js";
import { buildRebuildLanesCommand } from "./commands/rebuild-lanes.js";
import { buildRebuildRollupCommand } from "./commands/rebuild-rollup.js";
import { buildRebuildVaultCommand } from "./commands/rebuild-vault.js";
import { buildReconnectCommand } from "./commands/reconnect.js";
import { buildRefreshCommand } from "./commands/refresh.js";
import { buildRegenContextCommand } from "./commands/regen-context.js";
import { buildRegistryCommand } from "./commands/registry.js";
import { buildRestoreCommand } from "./commands/restore.js";
import { buildSnapshotCommand } from "./commands/snapshot.js";
import { buildSyncMetadataCommand } from "./commands/sync-metadata.js";
import { buildUnfreezeCommand } from "./commands/unfreeze.js";
import { buildVaultUpdateCadenceCommand } from "./commands/vault-update-cadence.js";
import { buildVerifyCommand } from "./commands/verify.js";

export function buildVaultSubcommand(): Command {
  const vault = new Command("vault").description("Manage individual Lyt vaults");
  vault.addCommand(buildInitCommand());
  vault.addCommand(buildAdoptCommand());
  vault.addCommand(buildJoinCommand());
  vault.addCommand(buildCloneCommand());
  vault.addCommand(buildListCommand());
  vault.addCommand(buildInfoCommand());
  vault.addCommand(buildRefreshCommand());
  vault.addCommand(buildOpenCommand());
  vault.addCommand(buildForgetCommand());
  vault.addCommand(buildDisconnectCommand());
  vault.addCommand(buildDeleteCommand());
  vault.addCommand(buildVerifyCommand());
  vault.addCommand(buildReconnectCommand());
  vault.addCommand(buildRebuildIndexCommand());
  vault.addCommand(buildRebuildLanesCommand());
  vault.addCommand(buildRebuildRollupCommand());
  vault.addCommand(buildRebuildArcsCommand());
  vault.addCommand(buildRebuildFtsCommand());
  vault.addCommand(buildRebuildVaultCommand());
  vault.addCommand(buildAddEdgeCommand());
  vault.addCommand(buildMoveCommand());
  vault.addCommand(buildRenameCommand());
  vault.addCommand(buildRegenContextCommand());
  vault.addCommand(buildSyncMetadataCommand());
  vault.addCommand(buildFreezeCommand());
  vault.addCommand(buildUnfreezeCommand());
  vault.addCommand(buildSnapshotCommand());
  vault.addCommand(buildRestoreCommand());
  vault.addCommand(buildListSnapshotsCommand());
  vault.addCommand(buildVaultUpdateCadenceCommand());
  return vault;
}

export function buildRegistrySubcommand(): Command {
  return buildRegistryCommand();
}
