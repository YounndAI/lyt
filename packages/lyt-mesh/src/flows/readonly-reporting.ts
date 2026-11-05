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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPrivateVaultMetadataPath, normalizeGitHubRepoCoordinate, resolveSpawnInvocation,
  PUBLICATION_PERMISSION_PROMPT_GUARDS, type VaultSnapshot } from "@younndai/lyt-vault";

export function isReadonlyOperationalMetadata(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return isPrivateVaultMetadataPath(normalized) ||
    normalized === ".lyt/indexes/lanes.yon" || normalized === ".lyt/indexes/arcs.yon";
}

export function readonlyUserRecords<T extends { path: string; sourcePath?: string }>(records: readonly T[]): T[] {
  return records.filter((record) =>
    ![record.path, record.sourcePath].filter((path): path is string => path !== undefined).every(isReadonlyOperationalMetadata));
}

/** Read-only reporting evidence only; this does not grant publication authority. */
export async function observeReadonlyForCheck(vault: Pick<VaultSnapshot, "source" | "gitUrl">, deps: {
  gh?: (args: readonly string[]) => Promise<string>;
} = {}): Promise<"readonly" | "writable" | "unknown"> {
  if (vault.source === "subscribed") return "readonly";
  if (vault.source === "own") return "writable";
  const repository = vault.gitUrl === null ? null : normalizeGitHubRepoCoordinate(vault.gitUrl);
  if (repository === null) return "unknown";
  try {
    const raw = await (deps.gh ?? observeViewerPermission)(["repo", "view", repository, "--json", "viewerPermission", "--jq", ".viewerPermission"]);
    const permission = raw.trim().toUpperCase();
    if (["ADMIN", "MAINTAIN", "WRITE"].includes(permission)) return "writable";
    if (["READ", "TRIAGE"].includes(permission)) return "readonly";
    return "unknown";
  } catch { return "unknown"; }
}

async function observeViewerPermission(args: readonly string[]): Promise<string> {
  const invocation = resolveSpawnInvocation("gh", args);
  const result = await promisify(execFile)(invocation.command, invocation.args as string[], {
    encoding: "utf8", shell: invocation.shell, timeout: 10_000, maxBuffer: 16 * 1024,
    windowsHide: true, env: { ...process.env, ...PUBLICATION_PERMISSION_PROMPT_GUARDS },
  });
  return result.stdout;
}
