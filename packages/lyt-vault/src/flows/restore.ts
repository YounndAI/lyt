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
import { enforceNotFrozen } from "../util/freeze-check.js";
import {
  branchExists,
  getDefaultBranch,
  gitStatusPorcelain,
  isGitRepo,
  listBranchesWithPrefix,
  runGit,
} from "../util/git-run.js";
import { SNAPSHOT_BRANCH_PREFIX } from "./snapshot.js";

export interface RestoreFlowArgs {
  name: string;
  fromSnapshot: string;
  force?: boolean;
}

export interface RestoreFlowResult {
  vault: VaultRow;
  branch: string;
  restoredFrom: string;
  commitCreated: boolean;
  commitSha: string | null;
}

export async function restoreVaultFlow(args: RestoreFlowArgs): Promise<RestoreFlowResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, args.name);
    if (!vault) {
      throw new Error(`No vault registered with name '${args.name}'.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(`Vault '${args.name}' is tombstoned; cannot restore a buried vault.`);
    }
    // hardening pass (fix-pass): restore REWRITES the working tree — the sharpest
    // mutation in the frozen-advisory list. F13 chokepoint at flow entry.
    await enforceNotFrozen(vault.path, vault.name);
    if (!(await isGitRepo(vault.path))) {
      throw new Error(`Vault '${args.name}' is not a Git repo (restore requires a Git repo).`);
    }

    // Resolve <label> to a full branch name.
    let resolvedBranch: string;
    if (args.fromSnapshot.startsWith(SNAPSHOT_BRANCH_PREFIX)) {
      if (!(await branchExists(vault.path, args.fromSnapshot))) {
        throw new Error(`No such snapshot branch: ${args.fromSnapshot}`);
      }
      resolvedBranch = args.fromSnapshot;
    } else {
      const all = await listBranchesWithPrefix(vault.path, SNAPSHOT_BRANCH_PREFIX);
      const matches = all.filter((b) => b.label === args.fromSnapshot);
      if (matches.length === 0) {
        throw new Error(
          `No snapshot found with label '${args.fromSnapshot}'. Run 'lyt vault list-snapshots ${args.name}' to see available snapshots.`,
        );
      }
      resolvedBranch = matches[0]!.branch;
    }

    const status = await gitStatusPorcelain(vault.path);
    if (!status.clean && args.force !== true) {
      throw new Error(
        `Working tree has ${status.dirtyCount} uncommitted change(s). Re-run with --force to discard them, or commit/stash first.`,
      );
    }

    const defaultBranch = await getDefaultBranch(vault.path);
    // Make sure we're on the default branch (so restore lands as a commit there).
    await runGit(["checkout", defaultBranch], { cwd: vault.path });
    // Plumbing: read-tree --reset -u makes the index + working tree match the
    // snapshot tree exactly (including deletions of files present in HEAD but
    // not in the snapshot). HEAD stays at the current default-branch commit.
    // Untracked files are preserved.
    await runGit(["read-tree", "--reset", "-u", resolvedBranch], { cwd: vault.path });

    // Are there any staged changes vs HEAD?
    const diff = await runGit(["diff", "--cached", "--quiet"], {
      cwd: vault.path,
      allowFailure: true,
    });
    const hasStagedChanges = diff.code !== 0;
    if (!hasStagedChanges) {
      return {
        vault,
        branch: defaultBranch,
        restoredFrom: resolvedBranch,
        commitCreated: false,
        commitSha: null,
      };
    }
    await runGit(["commit", "-m", `lyt restore: from ${resolvedBranch}`], { cwd: vault.path });
    const shaRes = await runGit(["rev-parse", "--short", "HEAD"], { cwd: vault.path });
    return {
      vault,
      branch: defaultBranch,
      restoredFrom: resolvedBranch,
      commitCreated: true,
      commitSha: shaRes.stdout.trim(),
    };
  } finally {
    await closeRegistry(db);
  }
}
