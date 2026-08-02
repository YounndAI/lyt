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

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LYT_FALLBACK_GIT_EMAIL } from "../util/git-run.js";

export interface LocalCheckpointResult {
  status: "committed" | "deferred" | "skipped" | "failed" | "partial";
  commitSha?: string;
  /**
   * The observed HEAD immediately before staging. A missing value is normal
   * for a newly initialized repository with no commits yet.
   */
  beforeCommitSha?: string;
  paths: string[];
  affectedRepositoryCount: number;
  failure?: CheckpointFailure;
}

export interface CheckpointFailure {
  stage: "add" | "commit" | "resolve-commit";
  kind: "git-command-failed" | "commit-may-exist";
  /** A successful commit command was observed but its exact SHA could not be recovered. */
  commitMayExist?: boolean;
  /** Deterministic operator recovery, never an instruction to stage broadly. */
  recoveryAction?: string;
}

export type CheckpointGitRunner = (
  args: readonly string[],
  options: ExecFileSyncOptions,
) => Buffer | string;

const defaultRunner: CheckpointGitRunner = (args, options) => execFileSync("git", args, options);

export interface InitialCheckpointContext {
  vaultPath: string;
  paths: string[];
  expectedContentDigests: ReadonlyMap<string, string>;
}

export function createInitialCheckpointContext(
  vaultPath: string,
  paths: readonly string[],
  expectedContentDigests: ReadonlyMap<string, string> = new Map(),
): InitialCheckpointContext {
  return { vaultPath, paths: normalizePaths(paths), expectedContentDigests };
}

/** Append exact vault-relative Lyt-authored paths before finalization. */
export function recordInitialCheckpointPaths(
  context: InitialCheckpointContext,
  paths: readonly string[],
): void {
  context.paths = normalizePaths([...context.paths, ...paths]);
}

export function finalizeInitialCheckpoint(
  context: InitialCheckpointContext,
  runGit: CheckpointGitRunner = defaultRunner,
): LocalCheckpointResult {
  return createLocalCheckpoint(
    context.vaultPath,
    context.paths,
    runGit,
    context.expectedContentDigests,
  );
}

/**
 * Commits only the supplied vault-relative Lyt-authored files.  The NUL-delimited
 * literal pathspec input preserves unusual filenames and never broadens to a
 * directory or repository-wide add.
 */
export function createLocalCheckpoint(
  vaultPath: string,
  journaledPaths: readonly string[],
  runGit: CheckpointGitRunner = defaultRunner,
  expectedContentDigests: ReadonlyMap<string, string> = new Map(),
): LocalCheckpointResult {
  const paths = normalizePaths(journaledPaths);
  if (paths.length === 0) {
    return { status: "skipped", paths, affectedRepositoryCount: 0 };
  }

  // Capture HEAD before mutating the index.  It is evidence, not a precondition:
  // a fresh repository legitimately has no HEAD yet.
  const beforeCommitSha = tryReadHead(runGit, vaultPath);

  if (!contentDigestsMatch(vaultPath, expectedContentDigests)) {
    return {
      status: "failed",
      paths,
      affectedRepositoryCount: 1,
      ...(beforeCommitSha === undefined ? {} : { beforeCommitSha }),
      failure: { stage: "add", kind: "git-command-failed" },
    };
  }

  try {
    runGit(["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      cwd: vaultPath,
      input: Buffer.from(`${paths.join("\0")}\0`, "utf8"),
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch {
    return {
      status: "failed",
      paths,
      affectedRepositoryCount: 1,
      ...(beforeCommitSha === undefined ? {} : { beforeCommitSha }),
      failure: { stage: "add", kind: "git-command-failed" },
    };
  }

  try {
    runGit(
      [
        "-c",
        // Intentionally different from util/git-run.ts: this identifies the
        // narrower scaffold checkpoint rather than a general Lyt save.
        "user.name=Lyt Local Checkpoint",
        "-c",
        `user.email=${LYT_FALLBACK_GIT_EMAIL}`,
        "--literal-pathspecs",
        "commit",
        "--only",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
        "-m",
        "chore: lyt vault init scaffold",
      ],
      {
        cwd: vaultPath,
        input: Buffer.from(`${paths.join("\0")}\0`, "utf8"),
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
  } catch {
    return {
      status: "failed",
      paths,
      affectedRepositoryCount: 1,
      ...(beforeCommitSha === undefined ? {} : { beforeCommitSha }),
      failure: { stage: "commit", kind: "git-command-failed" },
    };
  }

  const sha = tryReadHead(runGit, vaultPath) ?? tryReadHeadFallback(runGit, vaultPath);
  if (sha !== undefined) {
    return {
      status: "committed",
      commitSha: sha,
      paths,
      affectedRepositoryCount: 1,
      ...(beforeCommitSha === undefined ? {} : { beforeCommitSha }),
    };
  }

  // `git commit` returned success, so an unknown SHA is not safely equivalent
  // to "no commit". Preserve the durable uncertainty for the command receipt
  // rather than reporting a false zero-commit outcome.
  return {
    status: "partial",
    paths,
    affectedRepositoryCount: 1,
    ...(beforeCommitSha === undefined ? {} : { beforeCommitSha }),
    failure: {
      stage: "resolve-commit",
      kind: "commit-may-exist",
      commitMayExist: true,
      recoveryAction:
        "Run 'git rev-parse HEAD' in the affected vault; if it advanced, record that SHA before any retry.",
    },
  };
}

function contentDigestsMatch(vaultPath: string, expected: ReadonlyMap<string, string>): boolean {
  try {
    for (const [path, digest] of expected) {
      const observed = createHash("sha256")
        .update(readFileSync(join(vaultPath, path)))
        .digest("hex");
      if (observed !== digest) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tryReadHead(runGit: CheckpointGitRunner, vaultPath: string): string | undefined {
  try {
    return normalizeCommitSha(
      runGit(["rev-parse", "HEAD"], {
        cwd: vaultPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).toString(),
    );
  } catch {
    return undefined;
  }
}

/** A distinct Git read gives a committed checkpoint one bounded recovery attempt. */
function tryReadHeadFallback(runGit: CheckpointGitRunner, vaultPath: string): string | undefined {
  try {
    return normalizeCommitSha(
      runGit(["show", "-s", "--format=%H", "HEAD"], {
        cwd: vaultPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).toString(),
    );
  } catch {
    return undefined;
  }
}

function normalizeCommitSha(value: string): string | undefined {
  const sha = value.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined;
}

function normalizePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
    .map((path) => path.replace(/\\/g, "/"))
    .filter((path) => path.length > 0 && path !== ".obsidian" && !path.startsWith(".obsidian/"))
    .map((path) => {
      if (
        path.startsWith("/") ||
        /^[A-Za-z]:\//.test(path) ||
        path === "." ||
        path.split("/").includes("..")
      ) {
        throw new Error(`Checkpoint path must be vault-relative: ${path}`);
      }
      return path;
    })
    .sort();
}
