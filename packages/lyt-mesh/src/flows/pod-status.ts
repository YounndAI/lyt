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

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  closeRegistry,
  getDefaultVaultsRoot,
  getFederationRepoDir,
  isProvisionalIdentity,
  listFederationStates,
  listVaults,
  openRegistry,
  readIdentityCache,
  readPodIdentity,
  runGit as defaultRunGit,
  type GitRunOptions,
  type GitRunResult,
  type VaultRow,
} from "@younndai/lyt-vault";

// Brief B (B.4) — `lyt status`: the TRUST SURFACE. Per-vault + pod
// local⇄remote drift, the "is my stuff safe / published?" answer. Read-only
// (no network beyond an optional fetch; no writes). Distinct from the
// mesh-graph renderer (`lyt mesh status`) — that draws the federation topology;
// THIS reports publish drift.

export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

export type VaultDriftStatus =
  | "clean"
  | "unpushed"
  | "no-remote"
  | "stale-index"
  | "unregistered"
  | "missing"
  | "not-git-repo";

export interface VaultDriftReport {
  name: string;
  path: string;
  status: VaultDriftStatus;
  ahead: number;
  dirtyCount: number;
  hasRemote: boolean;
  detail: string;
}

export type PodDriftStatus =
  | "clean"
  | "unpushed"
  | "no-remote"
  // a provisional (no-gh) pod: real local git, but NOT
  // connected to GitHub. The honest trust-surface state distinct from "no-remote"
  // (which implies gh is wired but the remote is unset).
  | "local-only"
  | "no-pod";

export interface PodDriftReport {
  handle: string | null;
  status: PodDriftStatus;
  ahead: number;
  dirtyCount: number;
  detail: string;
}

export interface PodStatusResult {
  pod: PodDriftReport;
  vaults: VaultDriftReport[];
  // Vault dirs found on disk (carrying `.lyt/vault.yon`) that the registry does
  // not know about — surfaced so the handler can `lyt vault adopt`/register them.
  unregistered: string[];
  summary: { clean: number; needsPublish: number; total: number };
  // true when the pod + every vault are clean (published, nothing pending).
  ok: boolean;
}

export interface PodStatusArgs {
  runGit?: GitRunner;
  // Skip `git fetch` (faster, but ahead counts may be stale). Default false.
  noFetch?: boolean;
}

async function probeGitDrift(
  path: string,
  runGit: GitRunner,
  noFetch: boolean,
): Promise<{
  isRepo: boolean;
  hasRemote: boolean;
  hasUpstream: boolean;
  ahead: number;
  dirty: number;
}> {
  const gitDir = await runGit(["rev-parse", "--git-dir"], { cwd: path, allowFailure: true });
  if (gitDir.code !== 0) {
    return { isRepo: false, hasRemote: false, hasUpstream: false, ahead: 0, dirty: 0 };
  }
  const origin = await runGit(["remote", "get-url", "origin"], { cwd: path, allowFailure: true });
  const hasRemote = origin.code === 0;
  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: path,
    allowFailure: true,
  });
  const hasUpstream = upstream.code === 0;
  if (hasUpstream && !noFetch) {
    await runGit(["fetch", "--quiet"], { cwd: path, allowFailure: true });
  }
  let ahead = 0;
  if (hasUpstream) {
    const ab = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
      cwd: path,
      allowFailure: true,
    });
    if (ab.code === 0) ahead = Number(ab.stdout.trim().split(/\s+/)[0]) || 0;
  } else {
    // No upstream — count local commits (everything is "ahead" of nothing).
    const count = await runGit(["rev-list", "--count", "HEAD"], { cwd: path, allowFailure: true });
    if (count.code === 0) ahead = Number(count.stdout.trim()) || 0;
  }
  const status = await runGit(["status", "--porcelain"], { cwd: path, allowFailure: true });
  const dirty =
    status.code === 0 ? status.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length : 0;
  return { isRepo: true, hasRemote, hasUpstream, ahead, dirty };
}

// Best-effort stale-index probe: a clean+pushed vault whose newest note is more
// recent than its on-disk index db. Cheap mtime compare; if the index db isn't
// found, returns false (NOT stale) — we never fabricate a stale signal.
function isIndexStale(vaultPath: string): boolean {
  const dbCandidates = [join(vaultPath, ".lyt", "lyt.db"), join(vaultPath, ".lyt", "indexes")];
  let dbMtime = 0;
  for (const c of dbCandidates) {
    if (existsSync(c)) {
      try {
        dbMtime = Math.max(dbMtime, statSync(c).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  }
  if (dbMtime === 0) return false; // no index db located → cannot assert stale
  const notesDir = join(vaultPath, "notes");
  if (!existsSync(notesDir)) return false;
  let newestNote = 0;
  try {
    for (const f of readdirSync(notesDir)) {
      if (!f.endsWith(".md")) continue;
      newestNote = Math.max(newestNote, statSync(join(notesDir, f)).mtimeMs);
    }
  } catch {
    return false;
  }
  return newestNote > dbMtime;
}

function classifyVault(
  drift: { isRepo: boolean; hasRemote: boolean; ahead: number; dirty: number },
  vaultPath: string,
): { status: VaultDriftStatus; detail: string } {
  if (!drift.isRepo)
    return { status: "not-git-repo", detail: "no .git — run `lyt sync` to initialize + publish" };
  if (!drift.hasRemote)
    return {
      status: "no-remote",
      detail: "no remote configured — run `lyt sync` to create + publish",
    };
  if (drift.dirty > 0 || drift.ahead > 0) {
    const parts: string[] = [];
    if (drift.dirty > 0) parts.push(`${drift.dirty} uncommitted`);
    if (drift.ahead > 0) parts.push(`${drift.ahead} unpushed commit(s)`);
    return { status: "unpushed", detail: parts.join(", ") };
  }
  if (isIndexStale(vaultPath)) {
    return { status: "stale-index", detail: "search index behind content — run `lyt sync`" };
  }
  return { status: "clean", detail: "published + up to date" };
}

export async function podStatusFlow(args: PodStatusArgs = {}): Promise<PodStatusResult> {
  const runGit = args.runGit ?? defaultRunGit;
  const noFetch = args.noFetch === true;

  const db = await openRegistry();
  let vaults: VaultRow[];
  let handle: string | null;
  try {
    vaults = (await listVaults(db)).filter((v) => v.status !== "tombstoned");
    const states = await listFederationStates(db);
    handle = states.length === 1 ? states[0]!.handle : null;
  } finally {
    await closeRegistry(db);
  }

  const vaultReports: VaultDriftReport[] = [];
  const registeredPaths = new Set<string>();
  for (const v of vaults) {
    registeredPaths.add(v.path);
    if (!existsSync(v.path)) {
      vaultReports.push({
        name: v.name,
        path: v.path,
        status: "missing",
        ahead: 0,
        dirtyCount: 0,
        hasRemote: false,
        detail: "registered path not found on disk",
      });
      continue;
    }
    const drift = await probeGitDrift(v.path, runGit, noFetch);
    const { status, detail } = classifyVault(drift, v.path);
    vaultReports.push({
      name: v.name,
      path: v.path,
      status,
      ahead: drift.ahead,
      dirtyCount: drift.dirty,
      hasRemote: drift.hasRemote,
      detail,
    });
  }

  // Pod drift.
  let pod: PodDriftReport;
  if (handle === null) {
    pod = {
      handle: null,
      status: "no-pod",
      ahead: 0,
      dirtyCount: 0,
      detail: "no pod forged yet — run `lyt init`",
    };
  } else {
    const podDir = getFederationRepoDir(handle);
    if (!existsSync(podDir)) {
      pod = { handle, status: "no-pod", ahead: 0, dirtyCount: 0, detail: "pod dir missing" };
    } else {
      const d = await probeGitDrift(podDir, runGit, noFetch);
      // a PROVISIONAL identity means the pod is local-only
      // (never connected). This takes precedence over the remote/drift checks:
      // a local pod has no remote BY DESIGN, so report it honestly as "not
      // connected" rather than the generic "no-remote".
      const podIdentity = readPodIdentity(podDir) ?? readIdentityCache();
      const localOnly = podIdentity !== null && isProvisionalIdentity(podIdentity);
      if (localOnly) {
        pod = {
          handle,
          status: "local-only",
          ahead: d.ahead,
          dirtyCount: d.dirty,
          detail: "local-only (not connected to GitHub) — run `lyt sync` to connect + back up",
        };
      } else if (!d.isRepo || !d.hasRemote) {
        pod = {
          handle,
          status: "no-remote",
          ahead: d.ahead,
          dirtyCount: d.dirty,
          detail: "pod has no remote — run `lyt sync`",
        };
      } else if (d.ahead > 0 || d.dirty > 0) {
        pod = {
          handle,
          status: "unpushed",
          ahead: d.ahead,
          dirtyCount: d.dirty,
          detail: "pod.yon not yet pushed — run `lyt sync`",
        };
      } else {
        pod = {
          handle,
          status: "clean",
          ahead: 0,
          dirtyCount: 0,
          detail: "published + up to date",
        };
      }
    }
  }

  const unregistered = scanUnregistered(registeredPaths);

  const needsPublish = vaultReports.filter(
    (r) => r.status === "unpushed" || r.status === "no-remote" || r.status === "not-git-repo",
  ).length;
  const clean = vaultReports.filter((r) => r.status === "clean").length;
  const podClean = pod.status === "clean" || pod.status === "no-pod";
  return {
    pod,
    vaults: vaultReports,
    unregistered,
    summary: { clean, needsPublish, total: vaultReports.length },
    ok: podClean && needsPublish === 0 && vaultReports.every((r) => r.status !== "missing"),
  };
}

// Bounded scan (depth 2: <root>/<mesh>/<vault>) for vault dirs carrying
// `.lyt/vault.yon` that the registry doesn't know about. lyt-pod-map (the
// generated pod-map vault) is excluded — it isn't a registered home vault.
function scanUnregistered(registeredPaths: ReadonlySet<string>): string[] {
  const root = getDefaultVaultsRoot();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const hasVaultYon = (dir: string): boolean => existsSync(join(dir, ".lyt", "vault.yon"));
  let level1: string[];
  try {
    level1 = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const name of level1) {
    if (name === "lyt-pod-map") continue;
    const dir = join(root, name);
    if (hasVaultYon(dir) && !registeredPaths.has(dir)) {
      out.push(dir);
      continue;
    }
    // Depth 2: <root>/<mesh>/<vault>.
    let children: string[];
    try {
      children = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const child of children) {
      const childDir = join(dir, child);
      if (hasVaultYon(childDir) && !registeredPaths.has(childDir)) {
        out.push(childDir);
      }
    }
  }
  return out;
}
