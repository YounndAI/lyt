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

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import { isGitRepo, listBranchesWithPrefix, type BranchInfo } from "../util/git-run.js";
import { SNAPSHOT_BRANCH_PREFIX } from "./snapshot.js";

export interface ListSnapshotsArgs {
  name: string;
}

export interface ListSnapshotsResult {
  vault: VaultRow;
  snapshots: BranchInfo[];
}

export async function listSnapshotsFlow(args: ListSnapshotsArgs): Promise<ListSnapshotsResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, args.name);
    if (!vault) {
      throw new Error(`No vault registered with name '${args.name}'.`);
    }
    if (!(await isGitRepo(vault.path))) {
      throw new Error(`Vault '${args.name}' is not a Git repo (snapshots require a Git repo).`);
    }
    const snapshots = await listBranchesWithPrefix(vault.path, SNAPSHOT_BRANCH_PREFIX);
    return { vault, snapshots };
  } finally {
    await closeRegistry(db);
  }
}
