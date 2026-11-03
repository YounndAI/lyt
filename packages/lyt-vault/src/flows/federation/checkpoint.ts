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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Client } from "@libsql/client";

import { listFederationStates } from "../../registry/federation-state.js";
import { openRegistryReadOnly } from "../../registry/read-only-client.js";
import { createLocalCheckpoint, type CheckpointGitRunner, type LocalCheckpointResult } from "../../scaffold/local-checkpoint.js";
import { getFederationRoot } from "../../util/federation-paths.js";
import { parseHlc } from "../../util/hlc.js";
import { readPodIdentity } from "../../util/identity-cache.js";
import { assertNoSymlinkOnWritePath } from "../../util/write-path-guard.js";
import { validatePodManifestSemantics } from "../../yon/federation-manifest-validate.js";
import { parseFederationYon } from "../../yon/federation-read.js";
import { renderFederationYon } from "../../yon/federation-write.js";
import { parseLedgerText } from "../../yon/ledger-read.js";
import { parseMachineShardText } from "../../yon/machine-ledger.js";
import { podManifestDocsEqualIgnoringStamp, projectPodManifestReadOnly } from "./regenerate.js";

/**
 * Read-only evidence primitive, not a checkpoint approval or command. Callers
 * must first validate the pod identity, canonical projection, and each ledger
 * before using these observations to authorize any mutation.
 */
export interface PodCheckpointBoundary {
  repository: string;
  beforeHead: string;
  paths: string[];
  files: { path: string; sha256: string; bytesBase64: string; text: string }[];
  indexEntries: string;
  stagedDiff: string;
  worktreeDiff: string;
  digest: string;
}

const namespaces = new Set([
  "aliases", "destination-policy", "mesh-edges", "machines", "meshes", "subscriptions", "vaults",
]);

const tags: Readonly<Record<string, readonly string[]>> = {
  aliases: ["ALIAS", "ROTATION"],
  "destination-policy": ["DESTINATION_POLICY", "ROTATION"],
  "mesh-edges": ["MESH_EDGE", "ROTATION"],
  machines: ["MACHINE", "POD_ALIAS", "SYNC_OBSERVED", "ROTATION"],
  meshes: ["FED_MESH", "ROTATION"],
  subscriptions: ["SUBSCRIPTION", "ROTATION"],
  vaults: ["FED_VAULT", "ROTATION"],
};
const required: Readonly<Record<string, readonly string[]>> = {
  ALIAS: ["name", "target_rid", "kind", "created_at", "state"],
  DESTINATION_POLICY: ["schema_major", "pod_rid", "subject_kind", "subject_rid", "destination_kind", "source", "state", "hlc", "seq"],
  MESH_EDGE: ["ref_vault_rid", "home_vault_rid", "home_mesh_rid", "kind", "added_at", "state"],
  MACHINE: ["machine_id", "alias", "first_seen", "last_seen", "hlc", "seq"],
  POD_ALIAS: ["pod_rid", "alias", "changed_at", "hlc", "seq"],
  SYNC_OBSERVED: ["observer_machine_id", "vault_rid", "source_machine_id", "through_hlc", "through_seq", "observed_at", "publication", "hlc", "seq"],
  FED_MESH: ["mesh_rid", "fed_rid", "mesh_name", "push_kind", "role", "added_at", "state"],
  SUBSCRIPTION: ["coordinate", "rid", "entry_mode", "added_at", "state"],
  FED_VAULT: ["vault_rid", "vault_name", "home_mesh_rid", "repo", "visibility", "status", "registered_at", "state"],
  ROTATION: ["from_month", "to_month", "archived_path"],
};

function isCandidate(path: string): boolean {
  return path === "pod.yon" || /^ledger\/(?:aliases|destination-policy|mesh-edges|machines|meshes|subscriptions|vaults)\/[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[0-9]{4}-[0-9]{2})?\.yon$/u.test(path);
}

function readGit(root: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
}

/** Enumerate changed exact candidate paths, refusing ambiguous index states. */
export function changedPodCheckpointPaths(root: string): string[] {
  assertNoSymlinkOnWritePath(root, root);
  const entries = readGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]).split("\0").filter(Boolean);
  const selected: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const state = entry.slice(0, 2);
    const path = entry.slice(3);
    const rename = /[RC]/u.test(state);
    const source = rename ? entries[++i] : undefined;
    if (rename && source === undefined) throw new Error("Cannot inspect a pod rename.");
    if (rename && (isCandidate(path) || (source !== undefined && isCandidate(source)))) throw new Error("Renamed checkpoint files are not supported.");
    if (state === "!!" && /^ledger\/(?:aliases|destination-policy|mesh-edges|machines|meshes|subscriptions|vaults)\/$/u.test(path)) throw new Error(`Ignored ledger namespace cannot be inspected: ${path}`);
    if (!isCandidate(path)) continue;
    if (state === "!!") throw new Error(`Ignored candidate cannot be checkpointed: ${path}`);
    if (state.includes("D") || state.includes("U") || (state[0] !== " " && state[0] !== "?" && state[1] !== " ")) {
      throw new Error(`Checkpoint requires an unambiguous index and existing worktree file: ${path}`);
    }
    selected.push(path);
  }
  const paths = [...new Set(selected)].sort();
  const ignored = readGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "ledger", "pod.yon"]).split("\0").filter(isCandidate);
  if (ignored.length > 0) throw new Error(`Ignored candidate cannot be checkpointed: ${ignored[0]}`);
  if (paths.length > 0) {
    const flags = readGit(root, ["--literal-pathspecs", "ls-files", "-v", "-z", "--", ...paths]).split("\0").filter(Boolean);
    if (flags.some((entry) => !entry.startsWith("H "))) throw new Error("Checkpoint refuses nonstandard index flags or conflicts.");
    const attrs = readGit(root, ["--literal-pathspecs", "check-attr", "-z", "filter", "--", ...paths]).split("\0");
    for (let i = 2; i < attrs.length - 1; i += 3) {
      if (attrs[i] !== "unspecified" && attrs[i] !== "unset") throw new Error("Checkpoint refuses files with Git clean filters.");
    }
  }
  return paths;
}

/** Refuse redirects in every ledger tree the projection readers may traverse. */
function checkLedgerTrees(root: string): void {
  const ledger = join(root, "ledger");
  assertNoSymlinkOnWritePath(root, ledger);
  if (!existsSync(ledger)) return;
  for (const namespace of namespaces) {
    const dir = join(ledger, namespace);
    assertNoSymlinkOnWritePath(root, dir);
    if (!existsSync(dir)) continue;
    const inspect = (current: string, depth: number) => {
      if (depth > 2) throw new Error(`Unexpected nested ledger directory: ${current}`);
      for (const entry of readdirSync(current)) {
        const path = join(current, entry);
        assertNoSymlinkOnWritePath(root, path);
        const stat = lstatSync(path);
        if (stat.isDirectory()) inspect(path, depth + 1);
        else if (!stat.isFile()) throw new Error(`Unsupported ledger entry: ${path}`);
      }
    };
    if (!lstatSync(dir).isDirectory()) throw new Error(`Invalid ledger directory: ${dir}`);
    inspect(dir, 0);
  }
}

/** Strict framing and selected-field checks, not a proof of provenance. */
function validateSelectedLedger(path: string, bytes: Buffer): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.split(/\r?\n/u);
  // The generic ledger walker deliberately skips unknown lines. Reject them here.
  const field = '[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z]+)?=(?:"(?:[^"\\\\]|\\\\.)*"|[^\\s|]+)';
  const continuation = new RegExp(`^  \\| ${field}$`, "u");
  const record = new RegExp(`^@[A-Z_]+ ${field}$`, "u");
  const stamp = new RegExp(`^@STAMP ${field}(?: \\| ${field})+$`, "u");
  let open = false;
  let headers = 0;
  let metadata = 0;
  const metadataKeys = new Set<string>();
  let fields = new Set<string>();
  for (const line of lines) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("@DOC ")) { if (open || ++headers !== 1 || !/^@DOC ver=2\.0 \| id=ledger:[A-Za-z0-9._-]+:[0-9]{4}-[0-9]{2} \| domain=yai\.lyt@1\.0 \| kind=cfg \| profile=audit$/u.test(line)) throw new Error(`Malformed ledger header: ${path}`); continue; }
    if (line.startsWith("@META ")) { const match = /^@META key=(ledger_name|month) \| value=([^\s|]+)$/u.exec(line); if (open || headers !== 1 || ++metadata > 2 || match === null || metadataKeys.has(match[1]!)) throw new Error(`Malformed ledger metadata: ${path}`); metadataKeys.add(match[1]!); continue; }
    if (stamp.test(line)) { if (!open) throw new Error(`Orphan ledger stamp: ${path}`); open = false; continue; }
    if (record.test(line)) { if (open || headers !== 1 || metadata !== 2) throw new Error(`Unstamped ledger record: ${path}`); open = true; fields = new Set([line.slice(line.indexOf(" ") + 1).split(/[=:]/u)[0]!]); continue; }
    if (continuation.test(line) && open) { const key = line.slice(4).split(/[=:]/u)[0]!; if (fields.has(key)) throw new Error(`Duplicate ledger field: ${path}`); fields.add(key); continue; }
    throw new Error(`Unsupported ledger syntax: ${path}`);
  }
  if (open || headers !== 1 || metadata !== 2) throw new Error(`Incomplete ledger: ${path}`);
  const records = parseLedgerText(text, path);
  const family = path.split("/")[1]!;
  if (family === "machines") {
    const parts = path.split("/");
    const writer = parts[2]!.replace(/\.yon$/u, "");
    const parsed = parseMachineShardText(text, writer, path);
    if (parsed.machines.length !== records.filter((r) => r.recordType === "MACHINE").length || parsed.observations.length !== records.filter((r) => r.recordType === "SYNC_OBSERVED").length) throw new Error(`Invalid machine ledger record: ${path}`);
  }
  for (const item of records) {
    if (!tags[family]?.includes(item.recordType) || item.stampSrc === null || item.stampSrc === "" || item.stampTs === null || !Number.isFinite(Date.parse(item.stampTs)) || item.stampHash === null || !/^(?:-|[a-f0-9]{64})$/u.test(item.stampHash) || item.tamper === true) throw new Error(`Invalid ledger record or chain: ${path}`);
    if (required[item.recordType]?.some((key) => !item.fields.get(key))) throw new Error(`Missing ledger field: ${path}`);
    const hlc = item.fields.get("hlc");
    if (hlc !== undefined && parseHlc(hlc) === null) throw new Error(`Invalid ledger clock: ${path}`);
    const seq = item.fields.get("seq");
    if (seq !== undefined && (!/^\d+$/u.test(seq) || !Number.isSafeInteger(Number(seq)))) throw new Error(`Invalid ledger sequence: ${path}`);
    const state = item.fields.get("state");
    if (state !== undefined && !["active", "tombstoned"].includes(state)) throw new Error(`Invalid ledger state: ${path}`);
    if (item.recordType === "FED_MESH" && (!["own", "join"].includes(item.fields.get("role") ?? "") || !["handle", "org"].includes(item.fields.get("push_kind") ?? ""))) throw new Error(`Invalid mesh record: ${path}`);
    if (item.recordType === "FED_VAULT" && (!["public", "private"].includes(item.fields.get("visibility") ?? "") || !["active", "disconnected", "missing", "access_lost"].includes(item.fields.get("status") ?? ""))) throw new Error(`Invalid vault record: ${path}`);
  }
}

/** Validate current reviewed bytes against the read-only local pod projection. */
export async function previewPodCheckpoint(root = getFederationRoot()): Promise<PodCheckpointBoundary> {
  checkLedgerTrees(root);
  // The manifest and fold inputs must be visible to Git's dirty check, even
  // when they are not selected; otherwise the preview digest can miss drift.
  const manifestFlag = readGit(root, ["ls-files", "-v", "-z", "--", "pod.yon"]);
  if (manifestFlag !== "H pod.yon\0") throw new Error("Checkpoint requires a tracked manifest with ordinary index flags.");
  const inputFlags = readGit(root, ["ls-files", "-v", "-z", "--", ...[...namespaces].map((name) => `ledger/${name}`)]).split("\0").filter(Boolean);
  if (inputFlags.some((entry) => !entry.startsWith("H "))) throw new Error("Pod projection inputs have nonstandard index flags or conflicts.");
  const paths = changedPodCheckpointPaths(root);
  const boundary = capturePodCheckpointBoundary(root, paths);
  const manifestPath = join(root, "pod.yon");
  assertNoSymlinkOnWritePath(root, manifestPath);
  const manifestBytes = readFileSync(manifestPath, "utf8");
  const manifest = parseFederationYon(manifestBytes);
  if (renderFederationYon(manifest) !== manifestBytes || validatePodManifestSemantics(manifest).length > 0) throw new Error("Pod manifest is not canonical and coherent.");
  for (const file of boundary.files) if (file.path !== "pod.yon") validateSelectedLedger(file.path, Buffer.from(file.bytesBase64, "base64"));
  const identity = readPodIdentity(root);
  const registry = openRegistryReadOnly();
  if (registry.kind !== "open") throw new Error("Pod registry is unavailable.");
  try {
    const db = registry.client as unknown as Client;
    const states = await listFederationStates(db);
    if (states.length !== 1 || identity?.podRid !== states[0]!.fedRidHex || identity.handle !== states[0]!.handle || manifest.federation.fedRidHex !== identity.podRid || manifest.federation.handle !== identity.handle) throw new Error("Pod identity and registry do not agree.");
    const projection = await projectPodManifestReadOnly(db, { handle: identity.handle, visibility: manifest.federation.visibility, createdAt: manifest.federation.createdAt, nowIso: manifest.lastSyncedAt }, root);
    if (!podManifestDocsEqualIgnoringStamp(manifest, projection)) throw new Error("Pod manifest differs from the current local projection.");
  } finally { registry.close(); }
  if (capturePodCheckpointBoundary(root, changedPodCheckpointPaths(root)).digest !== boundary.digest) throw new Error("Pod changed during preview; retry.");
  return boundary;
}

/** Revalidate optimistically; this is not an exclusion lock against external writers. */
export async function applyPodCheckpoint(expectedDigest: string, root = getFederationRoot()): Promise<{ boundary: PodCheckpointBoundary; checkpoint: LocalCheckpointResult }> {
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error("Apply requires the exact preview SHA-256 digest.");
  const boundary = await previewPodCheckpoint(root);
  if (boundary.digest !== expectedDigest) throw new Error("Preview is stale; inspect a new preview.");
  if (capturePodCheckpointBoundary(root, changedPodCheckpointPaths(root)).digest !== boundary.digest) throw new Error("Pod changed before checkpoint.");
  const runner: CheckpointGitRunner = (args, options) => {
    const rewritten = [...args];
    const message = rewritten.indexOf("chore: lyt local creation checkpoint");
    if (message !== -1) rewritten[message] = "chore: lyt reviewed pod baseline";
    return execFileSync("git", ["-c", "core.fsmonitor=false", ...rewritten], options);
  };
  const checkpoint = createLocalCheckpoint(root, boundary.paths, runner, new Map(boundary.files.map((file) => [file.path, file.sha256])));
  return { boundary, checkpoint };
}

/** Snapshot exact caller-selected files; never stage, write, or contact a remote. */
export function capturePodCheckpointBoundary(repository: string, selected: readonly string[]): PodCheckpointBoundary {
  const root = resolve(repository);
  assertNoSymlinkOnWritePath(root, root);
  const gitDir = join(root, ".git");
  assertNoSymlinkOnWritePath(root, gitDir);
  if (!lstatSync(gitDir).isDirectory()) throw new Error("Checkpoint requires an in-place Git directory.");
  assertNoSymlinkOnWritePath(root, join(gitDir, "index"));
  assertNoSymlinkOnWritePath(root, join(gitDir, "HEAD"));
  const git = (args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const actualRoot = resolve(git(["rev-parse", "--show-toplevel"]).trim());
  const comparable = (p: string) => process.platform === "win32" ? p.toLowerCase() : p;
  if (comparable(actualRoot) !== comparable(root)) throw new Error("Pod path is not the repository root.");
  const headRef = git(["rev-parse", "--symbolic-full-name", "HEAD"]).trim();
  assertNoSymlinkOnWritePath(root, join(gitDir, "packed-refs"));
  assertNoSymlinkOnWritePath(root, join(gitDir, "logs", "HEAD"));
  if (headRef !== "HEAD") {
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(headRef) || headRef.split("/").includes("..")) throw new Error("Unsupported pod HEAD reference.");
    assertNoSymlinkOnWritePath(root, join(gitDir, ...headRef.split("/")));
    assertNoSymlinkOnWritePath(root, join(gitDir, "logs", ...headRef.split("/")));
  }
  const beforeHead = git(["rev-parse", "--verify", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(beforeHead)) throw new Error("Cannot resolve the pod HEAD.");
  const paths = [...new Set(selected)].sort();
  for (const path of paths) {
    const parts = path.split("/");
    if (path !== "pod.yon" && !(
      parts[0] === "ledger" && parts.length >= 3 && parts.length <= 4 &&
      namespaces.has(parts[1]!) && parts.slice(2).every((p) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(p)) &&
      parts[parts.length - 1]!.endsWith(".yon")
    )) throw new Error(`Unsupported checkpoint path: ${path}`);
  }
  const files = paths.map((path) => {
    const absolute = join(root, path);
    assertNoSymlinkOnWritePath(root, absolute);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Checkpoint requires a single-link regular file: ${path}`);
    const bytes = readFileSync(absolute);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64"), text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  });
  const scoped = paths.length === 0 ? [] : ["--", ...paths];
  const indexEntries = paths.length === 0 ? "" : git(["--literal-pathspecs", "ls-files", "--stage", "-z", ...scoped]);
  const stagedDiff = paths.length === 0 ? "" : git(["--literal-pathspecs", "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", ...scoped]);
  const worktreeDiff = paths.length === 0 ? "" : git(["--literal-pathspecs", "diff", "--binary", "--no-ext-diff", "--no-textconv", ...scoped]);
  const boundary = { repository: root, beforeHead, paths, files, indexEntries, stagedDiff, worktreeDiff };
  return { ...boundary, digest: createHash("sha256").update(JSON.stringify(boundary)).digest("hex") };
}
