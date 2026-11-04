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
import {
  GIT_READ_ONLY_POLICY,
  GIT_REMOTE_OBSERVATION_POLICY,
  type GitRunOptions,
  type GitRunResult,
} from "./git-run.js";
import { realGhClient } from "./gh.js";

export async function observePublicVaultVisibility(owner: string, repo: string): Promise<boolean> {
  const info = await realGhClient.getRepo(owner, repo);
  if (info.visibility !== "public" && info.visibility !== "private") {
    throw new Error("Public publication refused: repository visibility could not be verified.");
  }
  return info.visibility === "public";
}

type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

/** Operational records are local-only for public vaults, including old flat ledgers. */
export function isPrivateVaultMetadataPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return /^\.lyt\/(?:sync-provenance-pending(?:\/|$)|ledgers\/(?:sync|audit|provenance)(?:\.yon$|\/|$))/u.test(normalized);
}

const PRIVATE_PATHS = [
  ".lyt/sync-provenance-pending",
  ".lyt/ledgers/sync",
  ".lyt/ledgers/sync.yon",
  ".lyt/ledgers/audit",
  ".lyt/ledgers/audit.yon",
  ".lyt/ledgers/provenance",
  ".lyt/ledgers/provenance.yon",
] as const;

const REMEDY = "Public publication refused: operational metadata is present in the Git index or reachable history, or history could not be verified. Keep this repository private and arrange a separately reviewed clean public repository; Lyt will not rewrite history or remove files.";

/**
 * Fail closed before a public flip or push. Inspect the exact local HEAD and,
 * when supplied, every advertised branch/tag on the remote. Remote objects must
 * already exist locally: this check never fetches or rewrites the repository.
 */
export async function assertPublicVaultHistorySafe(args: {
  cwd: string;
  git: GitRunner;
  remoteUrl?: string;
}): Promise<void> {
  const read = async (argv: readonly string[]) => {
    const result = await args.git(argv, {
      cwd: args.cwd,
      allowFailure: true,
      policy: GIT_READ_ONLY_POLICY,
    });
    if (result.code !== 0 || result.stdoutTruncated === true) throw new Error(REMEDY);
    return result.stdout;
  };

  const indexed = await read(["ls-files", "--cached", "-z", "--", ...PRIVATE_PATHS]);
  if (indexed.length !== 0) throw new Error(REMEDY);
  const shallow = (await read(["rev-parse", "--is-shallow-repository"])).trim();
  if (shallow !== "false") throw new Error(REMEDY);

  const roots: string[] = [];
  const head = await args.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    cwd: args.cwd,
    allowFailure: true,
    policy: GIT_READ_ONLY_POLICY,
  });
  if (head.stdoutTruncated === true) throw new Error(REMEDY);
  if (head.code === 0) roots.push(head.stdout.trim());
  else if (head.code !== 1) throw new Error(REMEDY);

  if (args.remoteUrl !== undefined) {
    const remote = await args.git(["ls-remote", "--heads", "--tags", "--", args.remoteUrl], {
      cwd: args.cwd,
      allowFailure: true,
      policy: GIT_REMOTE_OBSERVATION_POLICY,
    });
    if (remote.code !== 0 || remote.stdoutTruncated === true) throw new Error(REMEDY);
    for (const line of remote.stdout.split(/\r?\n/u)) {
      if (line.length === 0) continue;
      const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/(?:heads|tags)\/[^\s]+)$/u.exec(line);
      if (match === null) throw new Error(REMEDY);
      // A tag's peeled commit is checked independently; the tag object itself
      // may also be resolved by rev-parse. Missing objects are a refusal.
      const resolved = (await read(["rev-parse", "--verify", `${match[1]}^{commit}`])).trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(resolved)) throw new Error(REMEDY);
      roots.push(resolved);
    }
  }
  for (const root of new Set(roots)) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(root)) throw new Error(REMEDY);
    const history = await read(["rev-list", "--full-history", "--max-count=1", root, "--", ...PRIVATE_PATHS]);
    if (history.trim().length !== 0) throw new Error(REMEDY);
  }
}
