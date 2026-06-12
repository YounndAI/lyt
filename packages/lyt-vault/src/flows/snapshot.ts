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

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { closeRegistry, openRegistry } from "../registry/client.js";
import { getVaultByName, type VaultRow } from "../registry/repo.js";
import {
  branchExists,
  gitStatusPorcelain,
  isGitRepo,
  runGit,
  slugify,
  timestampForBranchName,
} from "../util/git-run.js";

export const SNAPSHOT_BRANCH_PREFIX = "lyt-snapshot/";

export interface SnapshotFlowArgs {
  name: string;
  label?: string;
  now?: Date;
}

export interface SnapshotFlowResult {
  vault: VaultRow;
  branch: string;
  sha: string;
  // Track C Wave 3 F11 — whether the snapshot commit captured uncommitted
  // working-tree state (tracked edits + untracked files). false = the tree
  // was clean and the branch points at HEAD, the pre-F11 behavior.
  workingTreeIncluded: boolean;
  // Count of dirty/untracked paths folded into the snapshot (0 when clean).
  uncommittedPathCount: number;
}

// Track C Wave 3 F11 — snapshot used to be `git branch` at HEAD: committed
// state only. But Lyt's own write path never commits (capture writes the
// file; `lyt sync` commits later), so the FRESHEST figments — exactly what
// a user snapshots to protect — were silently excluded, and restore could
// not bring back an accidentally-deleted uncommitted note (demonstrated
// live: one fixture note permanently lost). Violates the D46 never-
// silently-lose floor.
//
// Now: when the working tree is dirty (tracked edits OR untracked files),
// build the snapshot commit from the FULL working tree via temp-index
// plumbing — GIT_INDEX_FILE + `git add -A` + write-tree + commit-tree —
// parented on HEAD and branch there. The user's real index, HEAD, and
// branch are never touched; .gitignore is respected (gitignored derived
// state like .lyt/indexes/ stays out, same as a real commit).
export async function snapshotVaultFlow(args: SnapshotFlowArgs): Promise<SnapshotFlowResult> {
  const db = await openRegistry();
  try {
    const vault = await getVaultByName(db, args.name);
    if (!vault) {
      throw new Error(`No vault registered with name '${args.name}'.`);
    }
    if (vault.status === "tombstoned") {
      throw new Error(`Vault '${args.name}' is tombstoned; cannot snapshot a buried vault.`);
    }
    if (!(await isGitRepo(vault.path))) {
      throw new Error(`Vault '${args.name}' is not a Git repo (snapshot requires a Git repo).`);
    }
    const ts = timestampForBranchName(args.now);
    const labelSlug = args.label && args.label.length > 0 ? slugify(args.label) : "";
    const branch = `${SNAPSHOT_BRANCH_PREFIX}${ts}${labelSlug ? `-${labelSlug}` : ""}`;
    if (await branchExists(vault.path, branch)) {
      throw new Error(`Snapshot branch already exists: ${branch}`);
    }

    const status = await gitStatusPorcelain(vault.path);
    if (status.clean) {
      // Clean tree — branch at HEAD, pre-F11 behavior.
      await runGit(["branch", branch], { cwd: vault.path });
      const shaRes = await runGit(["rev-parse", "--short", branch], { cwd: vault.path });
      return {
        vault,
        branch,
        sha: shaRes.stdout.trim(),
        workingTreeIncluded: false,
        uncommittedPathCount: 0,
      };
    }

    // Dirty tree — capture it without touching the user's index/HEAD.
    const gitDirRes = await runGit(["rev-parse", "--git-dir"], { cwd: vault.path });
    const gitDir = gitDirRes.stdout.trim();
    // pid + random suffix (release review): pid alone collides when two
    // snapshotVaultFlow calls run concurrently IN-PROCESS (library surface) —
    // call A's cleanup could delete call B's live index between `add -A` and
    // `write-tree`, and git write-tree on a MISSING index file silently
    // emits the empty tree: a poison "everything deleted" snapshot.
    const tempIndex = join(
      gitDir.startsWith("/") || /^[A-Za-z]:/.test(gitDir) ? gitDir : join(vault.path, gitDir),
      `lyt-snapshot-index-${process.pid}-${randomUUID().slice(0, 8)}`,
    );
    const env = { GIT_INDEX_FILE: tempIndex };
    try {
      await runGit(["read-tree", "HEAD"], { cwd: vault.path, env });
      await runGit(["add", "-A"], { cwd: vault.path, env });
      const treeRes = await runGit(["write-tree"], { cwd: vault.path, env });
      const tree = treeRes.stdout.trim();
      // commit-tree needs author identity, which `git branch` (the clean
      // path + the entire pre-F11 surface) never did — a local-only vault
      // on a box with no global git identity would regress from success to
      // a raw git 128 (release review). Prefer the user's real identity;
      // fall back to a snapshot-local one ONLY when none is configured
      // (snapshot commits are local recovery artifacts, never pushed).
      const identityProbe = await runGit(["config", "user.email"], {
        cwd: vault.path,
        allowFailure: true,
      });
      const identityArgs =
        identityProbe.code === 0 && identityProbe.stdout.trim().length > 0
          ? []
          : ["-c", "user.name=lyt snapshot", "-c", "user.email=snapshot@lyt.local"];
      const commitRes = await runGit(
        [
          ...identityArgs,
          "commit-tree",
          tree,
          "-p",
          "HEAD",
          "-m",
          `lyt snapshot: working tree (${status.dirtyCount} uncommitted path(s))${labelSlug ? ` [${labelSlug}]` : ""}`,
        ],
        { cwd: vault.path, env },
      );
      const commitSha = commitRes.stdout.trim();
      await runGit(["branch", branch, commitSha], { cwd: vault.path });
    } finally {
      try {
        rmSync(tempIndex, { force: true });
      } catch {
        // best-effort temp-index cleanup
      }
    }

    const shaRes = await runGit(["rev-parse", "--short", branch], { cwd: vault.path });
    return {
      vault,
      branch,
      sha: shaRes.stdout.trim(),
      workingTreeIncluded: true,
      uncommittedPathCount: status.dirtyCount,
    };
  } finally {
    await closeRegistry(db);
  }
}
