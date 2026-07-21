/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readlinkSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { newUuidv7Bytes, uuid7BytesToDashedString } from "../../util/uuid7.js";
import { assertSafeWritePath } from "../../util/write-path-guard.js";

export const POD_RECOVERY_REF_PREFIX = "refs/lyt/recovery/pod/";
export const POD_RECOVERY_MAX_PATHS = 4_096;
export const POD_RECOVERY_MAX_PATH_LENGTH = 512;
export const POD_RECOVERY_MAX_INDEX_BYTES = 16 * 1024 * 1024;
export const POD_RECOVERY_MAX_MATERIAL_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_GIT_METADATA_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface PlannedPath {
  readonly path: string;
  readonly kind: "file" | "symlink" | "missing";
  readonly mode: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly symlink_target_base64?: string;
}

export interface PodRecoverySnapshotPlan {
  readonly repository_root: string;
  readonly git_dir: string;
  readonly index_path: string;
  readonly shared_index_path: string | null;
  readonly head: string;
  readonly branch: string | null;
  readonly index_bytes: Uint8Array;
  readonly shared_index_bytes: Uint8Array | null;
  readonly index_sha256: string;
  readonly shared_index_sha256: string | null;
  readonly worktree_fingerprint: string;
  readonly material_bytes: number;
  readonly paths: readonly PlannedPath[];
}

interface PodRecoveryManifestV1 {
  readonly schema: "lyt.pod-recovery-snapshot";
  readonly version: 1;
  readonly snapshot_id: string;
  readonly ref: string;
  readonly head: string;
  readonly branch: string | null;
  readonly index: { readonly bytes: number; readonly sha256: string; readonly tree: string };
  readonly shared_index: {
    readonly bytes: number;
    readonly sha256: string;
    readonly filename: string;
  } | null;
  readonly worktree: {
    readonly tree: string;
    readonly fingerprint: string;
    readonly material_bytes: number;
    readonly paths: readonly PlannedPath[];
  };
}

export interface PodRecoverySnapshotReceipt {
  readonly snapshot_id: string;
  readonly ref: string;
  readonly commit_sha: string;
  readonly manifest_sha256: string;
}

export interface PodRecoverySnapshotVerification extends PodRecoverySnapshotReceipt {
  readonly valid: true;
  readonly manifest: PodRecoveryManifestV1;
}

export interface PodRecoverySnapshotHooks {
  /** Test seam. Throwing or changing source state must leave the ref absent. */
  readonly beforeRefUpdate?: () => void;
  readonly afterRefUpdate?: () => void;
  /** Test seam. Throwing proves verification failure cannot publish a ref. */
  readonly beforeCommitVerification?: () => void;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
}

function gitText(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_GIT_METADATA_BYTES,
    env: gitEnvironment(),
  }).trim();
}

function branchOrDetached(root: string): string | null {
  try {
    return gitText(root, ["symbolic-ref", "-q", "HEAD"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { status?: number }).status === 1) return null;
    throw error;
  }
}

function gitBytes(root: string, args: readonly string[], input?: Uint8Array): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    input,
    encoding: "buffer",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_GIT_METADATA_BYTES,
    env: gitEnvironment(),
  });
}

function objectIdLength(root: string): number {
  const format = gitText(root, ["rev-parse", "--show-object-format"]);
  if (format === "sha1") return 40;
  if (format === "sha256") return 64;
  throw new Error(`Unsupported Git object format: ${format}`);
}

function isObjectId(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/u.test(value);
}

function boundedObjectBytes(root: string, oid: string, oidLength: number, maxBytes: number, label: string): Buffer {
  if (!isObjectId(oid, oidLength)) throw new Error(`${label} has an invalid object id.`);
  const rawSize = gitText(root, ["cat-file", "-s", oid]);
  if (!/^\d+$/u.test(rawSize)) throw new Error(`${label} has an invalid object size.`);
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new Error(`${label} exceeds its bounded read limit.`);
  }
  const bytes = execFileSync("git", ["cat-file", "blob", oid], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: Math.max(1024, size + 1),
    env: gitEnvironment(),
  });
  if (bytes.length !== size) throw new Error(`${label} size changed during read.`);
  return bytes;
}

function resolveGitPath(root: string, raw: string): string {
  return resolve(isAbsolute(raw) ? raw : join(root, raw));
}

function assertRegularControlledPath(path: string, label: string): void {
  assertSafeWritePath(path);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-reparse file: ${path}`);
  }
}

function readExactRegularFile(path: string, maxBytes: number, label: string): Buffer {
  assertSafeWritePath(path);
  const noFollow = "O_NOFOLLOW" in constants ? (constants as typeof constants & { O_NOFOLLOW: number }).O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) {
      throw new Error(`${label} exceeds its bounded read limit or is not regular.`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed during read.`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`${label} changed during read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readExactSymlink(path: string, maxBytes: number, label: string): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isSymbolicLink() || before.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds its bounded read limit or is not a symlink.`);
  }
  const bytes = readlinkSync(path, { encoding: "buffer" });
  const after = lstatSync(path, { bigint: true });
  if (
    bytes.length > maxBytes || before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`${label} changed during read.`);
  }
  return bytes;
}

function assertContained(root: string, target: string, label: string): void {
  const canonicalRoot = resolve(root);
  const canonicalTarget = resolve(target);
  const prefix = `${canonicalRoot}${process.platform === "win32" ? "\\" : "/"}`;
  const comparableTarget = process.platform === "win32" ? canonicalTarget.toLowerCase() : canonicalTarget;
  const comparablePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  if (!comparableTarget.startsWith(comparablePrefix)) {
    throw new Error(`${label} escapes its controlled root: ${canonicalTarget}`);
  }
}

function splitNul(raw: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    if (index > start) parts.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (start !== raw.length) throw new Error("Git returned an unterminated NUL record.");
  return parts;
}

function decodeGitPath(raw: Buffer): string {
  const path = raw.toString("utf8");
  if (!Buffer.from(path, "utf8").equals(raw)) {
    throw new Error("Pod recovery snapshot refuses a non-UTF-8 Git path.");
  }
  return path;
}

interface StageEntry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: string;
  readonly path: string;
}

function parseStageEntries(raw: Buffer, oidLength: number): StageEntry[] {
  return splitNul(raw).map((record): StageEntry => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("Git returned a malformed staged path record.");
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/u.exec(header);
    if (match === null || !isObjectId(match[2], oidLength)) throw new Error("Git returned a malformed staged entry.");
    return { mode: match[1]!, oid: match[2]!, stage: match[3]!, path: decodeGitPath(record.subarray(tab + 1)) };
  });
}

function assertSupportedIndex(root: string): void {
  for (const entry of parseStageEntries(
    gitBytes(root, ["ls-files", "--stage", "-z"]),
    objectIdLength(root),
  )) {
    if (entry.stage !== "0") throw new Error("Pod recovery snapshot refuses an unmerged index.");
    if (entry.mode === "160000") throw new Error("Pod recovery snapshot refuses a gitlink entry.");
    if (entry.mode === "040000") throw new Error("Pod recovery snapshot refuses a sparse-directory entry.");
    if (entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000") {
      throw new Error(`Pod recovery snapshot refuses unsupported index mode ${entry.mode}.`);
    }
  }
}

function listedPaths(root: string): string[] {
  const current = splitNul(gitBytes(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
  const ignored = splitNul(
    gitBytes(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
  );
  const capturedHead = splitNul(gitBytes(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]));
  const paths = [...new Set([...current, ...ignored, ...capturedHead].map(decodeGitPath))]
    .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  if (paths.length > POD_RECOVERY_MAX_PATHS) {
    throw new Error(`Pod recovery snapshot exceeds ${POD_RECOVERY_MAX_PATHS} paths.`);
  }
  if (new Set(paths).size !== paths.length) throw new Error("Git returned duplicate paths.");
  return paths;
}

function inspectPaths(root: string, paths: readonly string[]): {
  paths: PlannedPath[];
  materialBytes: number;
  fingerprint: string;
} {
  let materialBytes = 0;
  const planned = paths.map((relative): PlannedPath => {
    if (
      relative.length === 0 ||
      relative.length > POD_RECOVERY_MAX_PATH_LENGTH ||
      isAbsolute(relative) ||
      relative.split(/[\\/]/u).includes("..")
    ) {
      throw new Error(`Unsafe or overlong snapshot path: ${JSON.stringify(relative)}`);
    }
    const absolute = resolve(root, relative);
    const rootPrefix = `${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`;
    const comparableAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    const comparableRoot = process.platform === "win32" ? rootPrefix.toLowerCase() : rootPrefix;
    if (!comparableAbsolute.startsWith(comparableRoot)) {
      throw new Error(`Snapshot path escapes repository: ${relative}`);
    }
    // A tracked symlink leaf is content and is captured below. A symlink or
    // junction in its parent chain would instead make the read escape.
    assertSafeWritePath(dirname(absolute));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: relative, kind: "missing", mode: 0, bytes: 0, sha256: sha256("") };
      }
      throw error;
    }
    if (stat.isDirectory()) throw new Error(`Git path unexpectedly resolves to a directory: ${relative}`);
    if (stat.isSymbolicLink()) {
      if (stat.size > POD_RECOVERY_MAX_MATERIAL_BYTES - materialBytes) {
        throw new Error(`Pod recovery snapshot exceeds ${POD_RECOVERY_MAX_MATERIAL_BYTES} material bytes.`);
      }
      const bytes = readExactSymlink(
        absolute,
        POD_RECOVERY_MAX_MATERIAL_BYTES - materialBytes,
        `Snapshot symlink ${relative}`,
      );
      materialBytes += bytes.length;
      return {
        path: relative,
        kind: "symlink",
        mode: stat.mode & 0o7777,
        bytes: bytes.length,
        sha256: sha256(bytes),
        symlink_target_base64: bytes.toString("base64"),
      };
    }
    if (!stat.isFile()) throw new Error(`Unsupported worktree entry type: ${relative}`);
    const bytes = readExactRegularFile(
      absolute,
      POD_RECOVERY_MAX_MATERIAL_BYTES - materialBytes,
      `Snapshot path ${relative}`,
    );
    materialBytes += bytes.length;
    return {
      path: relative,
      kind: "file",
      mode: stat.mode & 0o7777,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  if (materialBytes > POD_RECOVERY_MAX_MATERIAL_BYTES) {
    throw new Error(`Pod recovery snapshot exceeds ${POD_RECOVERY_MAX_MATERIAL_BYTES} material bytes.`);
  }
  return {
    paths: planned,
    materialBytes,
    fingerprint: sha256(JSON.stringify(planned)),
  };
}

/** Read-only. Produces no ids, temporary files, Git objects, refs, config, or registry state. */
export function planPodRecoverySnapshot(repositoryRoot: string): PodRecoverySnapshotPlan {
  const root = resolve(repositoryRoot);
  assertSafeWritePath(root);
  const gitDir = resolveGitPath(root, gitText(root, ["rev-parse", "--absolute-git-dir"]));
  assertSafeWritePath(gitDir);
  const indexPath = resolveGitPath(root, gitText(root, ["rev-parse", "--git-path", "index"]));
  assertContained(gitDir, indexPath, "Git index");
  assertRegularControlledPath(indexPath, "Git index");
  const indexBytes = readExactRegularFile(indexPath, POD_RECOVERY_MAX_INDEX_BYTES, "Git index");
  const sharedRaw = gitText(root, ["rev-parse", "--shared-index-path"]);
  const sharedIndexPath = sharedRaw.length === 0 ? null : resolveGitPath(root, sharedRaw);
  let sharedIndexBytes: Buffer | null = null;
  if (sharedIndexPath !== null) {
    assertContained(gitDir, sharedIndexPath, "Git shared index");
    assertRegularControlledPath(sharedIndexPath, "Git shared index");
    sharedIndexBytes = readExactRegularFile(
      sharedIndexPath,
      POD_RECOVERY_MAX_INDEX_BYTES - indexBytes.length,
      "Git shared index",
    );
  }
  assertSupportedIndex(root);
  const inspected = inspectPaths(root, listedPaths(root));
  return {
    repository_root: root,
    git_dir: gitDir,
    index_path: indexPath,
    shared_index_path: sharedIndexPath,
    head: gitText(root, ["rev-parse", "HEAD"]),
    branch: branchOrDetached(root),
    index_bytes: indexBytes,
    shared_index_bytes: sharedIndexBytes,
    index_sha256: sha256(indexBytes),
    shared_index_sha256: sharedIndexBytes === null ? null : sha256(sharedIndexBytes),
    worktree_fingerprint: inspected.fingerprint,
    material_bytes: inspected.materialBytes,
    paths: inspected.paths,
  };
}

function samePlanState(left: PodRecoverySnapshotPlan, right: PodRecoverySnapshotPlan): boolean {
  return (
    left.repository_root === right.repository_root &&
    left.git_dir === right.git_dir &&
    left.index_path === right.index_path &&
    left.shared_index_path === right.shared_index_path &&
    left.head === right.head &&
    left.branch === right.branch &&
    left.index_sha256 === right.index_sha256 &&
    left.shared_index_sha256 === right.shared_index_sha256 &&
    left.worktree_fingerprint === right.worktree_fingerprint &&
    left.material_bytes === right.material_bytes
  );
}

function hashObject(root: string, bytes: Uint8Array): string {
  return gitBytes(root, ["hash-object", "-w", "--stdin"], bytes).toString("utf8").trim();
}

/**
 * Build the worktree snapshot from the exact bytes inspected in the plan.
 * `git add` is deliberately not used: attributes/clean filters could otherwise
 * turn an observed worktree byte sequence into a different object.
 */
function writeExactWorktreeTree(plan: PodRecoverySnapshotPlan, tempIndex: string): string {
  const env = {
    ...gitEnvironment(),
    GIT_INDEX_FILE: tempIndex,
  };
  execFileSync("git", ["read-tree", "--empty"], {
    cwd: plan.repository_root,
    env,
    windowsHide: true,
    timeout: 120_000,
  });
  const records: Buffer[] = [];
  for (const entry of plan.paths) {
    if (entry.kind === "missing") continue;
    const absolute = resolve(plan.repository_root, entry.path);
    assertContained(plan.repository_root, absolute, "Snapshot path");
    assertSafeWritePath(dirname(absolute));
    const stat = lstatSync(absolute);
    if (stat.size !== entry.bytes || entry.bytes > POD_RECOVERY_MAX_MATERIAL_BYTES) {
      throw new Error(`Pod changed during recovery snapshot capture: ${entry.path}`);
    }
    const bytes =
      entry.kind === "symlink" && stat.isSymbolicLink()
        ? readExactSymlink(absolute, entry.bytes, `Snapshot symlink ${entry.path}`)
        : entry.kind === "file" && stat.isFile()
          ? readExactRegularFile(absolute, entry.bytes, `Snapshot path ${entry.path}`)
          : null;
    if (
      bytes === null ||
      (stat.mode & 0o7777) !== entry.mode ||
      bytes.length !== entry.bytes ||
      sha256(bytes) !== entry.sha256
    ) {
      throw new Error(`Pod changed during recovery snapshot capture: ${entry.path}`);
    }
    const mode = entry.kind === "symlink" ? "120000" : (stat.mode & 0o111) === 0 ? "100644" : "100755";
    const oid = hashObject(plan.repository_root, bytes);
    records.push(Buffer.from(`${mode} ${oid}\t${entry.path}\0`, "utf8"));
  }
  if (records.length > 0) {
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: plan.repository_root,
      input: Buffer.concat(records),
      env,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  return execFileSync("git", ["write-tree"], {
    cwd: plan.repository_root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  }).trim();
}

function unlinkExactRegular(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  unlinkSync(path);
}

function reconcileRetainedTempIndex(gitDir: string, path: string): void {
  assertContained(gitDir, path, "Recovery temporary index");
  if (!existsSync(path)) return;
  assertSafeWritePath(dirname(path));
  assertSafeWritePath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Retained recovery temporary index is not a regular non-reparse file.");
  }
  unlinkSync(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeSize(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function canonicalManifestBytes(manifest: PodRecoveryManifestV1): Buffer {
  const paths = manifest.worktree.paths.map((entry) => entry.kind === "symlink"
    ? {
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        bytes: entry.bytes,
        sha256: entry.sha256,
        symlink_target_base64: entry.symlink_target_base64,
      }
    : {
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
  const canonical = {
    schema: manifest.schema,
    version: manifest.version,
    snapshot_id: manifest.snapshot_id,
    ref: manifest.ref,
    head: manifest.head,
    branch: manifest.branch,
    index: {
      bytes: manifest.index.bytes,
      sha256: manifest.index.sha256,
      tree: manifest.index.tree,
    },
    shared_index: manifest.shared_index === null ? null : {
      bytes: manifest.shared_index.bytes,
      sha256: manifest.shared_index.sha256,
      filename: manifest.shared_index.filename,
    },
    worktree: {
      tree: manifest.worktree.tree,
      fingerprint: manifest.worktree.fingerprint,
      material_bytes: manifest.worktree.material_bytes,
      paths,
    },
  };
  return Buffer.from(`${JSON.stringify(canonical)}\n`, "utf8");
}

function parseManifest(bytes: Buffer, ref: string, oidLength: number): PodRecoveryManifestV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Recovery manifest is not valid JSON.");
  }
  if (
    !isRecord(decoded) ||
    !hasExactKeys(decoded, ["schema", "version", "snapshot_id", "ref", "head", "branch", "index", "shared_index", "worktree"]) ||
    decoded.schema !== "lyt.pod-recovery-snapshot" ||
    decoded.version !== 1 ||
    typeof decoded.snapshot_id !== "string" ||
    !UUIDV7.test(decoded.snapshot_id) ||
    decoded.ref !== ref ||
    `${POD_RECOVERY_REF_PREFIX}${decoded.snapshot_id}` !== ref ||
    !isObjectId(decoded.head, oidLength) ||
    (decoded.branch !== null &&
      (typeof decoded.branch !== "string" || !decoded.branch.startsWith("refs/heads/"))) ||
    !isRecord(decoded.index) ||
    !hasExactKeys(decoded.index, ["bytes", "sha256", "tree"]) ||
    !isSafeSize(decoded.index.bytes, POD_RECOVERY_MAX_INDEX_BYTES) ||
    typeof decoded.index.sha256 !== "string" ||
    !SHA256.test(decoded.index.sha256) ||
    !isObjectId(decoded.index.tree, oidLength) ||
    !isRecord(decoded.worktree) ||
    !hasExactKeys(decoded.worktree, ["tree", "fingerprint", "material_bytes", "paths"]) ||
    !isObjectId(decoded.worktree.tree, oidLength) ||
    typeof decoded.worktree.fingerprint !== "string" ||
    !SHA256.test(decoded.worktree.fingerprint) ||
    !isSafeSize(decoded.worktree.material_bytes, POD_RECOVERY_MAX_MATERIAL_BYTES) ||
    !Array.isArray(decoded.worktree.paths) ||
    decoded.worktree.paths.length > POD_RECOVERY_MAX_PATHS
  ) {
    throw new Error("Recovery manifest violates its canonical schema.");
  }
  if (decoded.shared_index !== null) {
    if (
      !isRecord(decoded.shared_index) ||
      !hasExactKeys(decoded.shared_index, ["bytes", "sha256", "filename"]) ||
      !isSafeSize(decoded.shared_index.bytes, POD_RECOVERY_MAX_INDEX_BYTES) ||
      decoded.index.bytes + decoded.shared_index.bytes > POD_RECOVERY_MAX_INDEX_BYTES ||
      typeof decoded.shared_index.sha256 !== "string" ||
      !SHA256.test(decoded.shared_index.sha256) ||
      typeof decoded.shared_index.filename !== "string" ||
      !/^sharedindex\.[0-9a-f]{40,64}$/u.test(decoded.shared_index.filename)
    ) {
      throw new Error("Recovery manifest shared index violates its canonical schema.");
    }
  }
  const paths: PlannedPath[] = [];
  let material = 0;
  for (const raw of decoded.worktree.paths) {
    if (!isRecord(raw) || typeof raw.kind !== "string") {
      throw new Error("Recovery manifest path record is malformed.");
    }
    const keys = raw.kind === "symlink"
      ? ["path", "kind", "mode", "bytes", "sha256", "symlink_target_base64"]
      : ["path", "kind", "mode", "bytes", "sha256"];
    if (
      !hasExactKeys(raw, keys) ||
      (raw.kind !== "file" && raw.kind !== "symlink" && raw.kind !== "missing") ||
      typeof raw.path !== "string" ||
      raw.path.length === 0 ||
      raw.path.length > POD_RECOVERY_MAX_PATH_LENGTH ||
      isAbsolute(raw.path) ||
      raw.path.split(/[\\/]/u).includes("..") ||
      !Number.isSafeInteger(raw.mode) ||
      (raw.mode as number) < 0 ||
      (raw.mode as number) > 0o7777 ||
      !isSafeSize(raw.bytes, POD_RECOVERY_MAX_MATERIAL_BYTES) ||
      typeof raw.sha256 !== "string" ||
      !SHA256.test(raw.sha256)
    ) {
      throw new Error("Recovery manifest path record violates its canonical schema.");
    }
    if (raw.kind === "missing" && (raw.mode !== 0 || raw.bytes !== 0 || raw.sha256 !== sha256(""))) {
      throw new Error("Recovery manifest missing-path record is not canonical.");
    }
    if (raw.kind === "symlink") {
      if (typeof raw.symlink_target_base64 !== "string") {
        throw new Error("Recovery manifest symlink target is missing.");
      }
      const target = Buffer.from(raw.symlink_target_base64, "base64");
      if (target.toString("base64") !== raw.symlink_target_base64 || target.length !== raw.bytes) {
        throw new Error("Recovery manifest symlink target is not canonical.");
      }
    }
    material += raw.bytes;
    if (!Number.isSafeInteger(material) || material > POD_RECOVERY_MAX_MATERIAL_BYTES) {
      throw new Error("Recovery manifest material bound is invalid.");
    }
    paths.push(raw as unknown as PlannedPath);
  }
  const sorted = [...paths].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  if (
    paths.some((entry, index) => entry.path !== sorted[index]!.path) ||
    new Set(paths.map((entry) => entry.path)).size !== paths.length ||
    material !== decoded.worktree.material_bytes ||
    sha256(JSON.stringify(paths)) !== decoded.worktree.fingerprint
  ) {
    throw new Error("Recovery manifest path records are not sorted, unique, or self-consistent.");
  }
  const manifest = decoded as unknown as PodRecoveryManifestV1;
  if (!canonicalManifestBytes(manifest).equals(bytes)) {
    throw new Error("Recovery manifest bytes are not canonical.");
  }
  return manifest;
}

/** Local mutation only: writes unreachable objects first, then one atomic custom ref. */
export function createPodRecoverySnapshot(
  plan: PodRecoverySnapshotPlan,
  options: { hooks?: PodRecoverySnapshotHooks; snapshot_id?: string } = {},
): PodRecoverySnapshotReceipt {
  const initial = planPodRecoverySnapshot(plan.repository_root);
  if (!samePlanState(plan, initial)) throw new Error("Pod recovery snapshot plan is stale.");
  const frozenPlan = initial;
  const snapshotId = options.snapshot_id ?? uuid7BytesToDashedString(newUuidv7Bytes());
  if (!UUIDV7.test(snapshotId)) throw new Error("Invalid deterministic recovery snapshot id.");
  const ref = `${POD_RECOVERY_REF_PREFIX}${snapshotId}`;
  const existing = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd: frozenPlan.repository_root,
    windowsHide: true,
    timeout: 120_000,
    stdio: "ignore",
  });
  if (existing.status === 0) return verifyPodRecoverySnapshotAgainstPlan(frozenPlan, ref);
  if (existing.status !== 1) throw new Error("Unable to observe deterministic recovery ref.");
  const tempIndex = join(frozenPlan.git_dir, `lyt-recovery-index-${snapshotId}.tmp`);
  assertContained(frozenPlan.git_dir, tempIndex, "Recovery temporary index");
  assertSafeWritePath(dirname(tempIndex));
  reconcileRetainedTempIndex(frozenPlan.git_dir, tempIndex);
  assertSafeWritePath(tempIndex);
  copyFileSync(frozenPlan.index_path, tempIndex, constants.COPYFILE_EXCL);
  const env = {
    ...gitEnvironment(),
    GIT_INDEX_FILE: tempIndex,
  };
  try {
    execFileSync("git", ["update-index", "--no-split-index"], {
      cwd: frozenPlan.repository_root,
      env,
      windowsHide: true,
      timeout: 120_000,
    });
    const indexTree = execFileSync("git", ["write-tree"], {
      cwd: frozenPlan.repository_root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    }).trim();
    const worktreeTree = writeExactWorktreeTree(frozenPlan, tempIndex);
    const indexBlob = hashObject(frozenPlan.repository_root, frozenPlan.index_bytes);
    const sharedBlob =
      frozenPlan.shared_index_bytes === null
        ? null
        : hashObject(frozenPlan.repository_root, frozenPlan.shared_index_bytes);
    const manifest: PodRecoveryManifestV1 = {
      schema: "lyt.pod-recovery-snapshot",
      version: 1,
      snapshot_id: snapshotId,
      ref,
      head: frozenPlan.head,
      branch: frozenPlan.branch,
      index: { bytes: frozenPlan.index_bytes.length, sha256: frozenPlan.index_sha256, tree: indexTree },
      shared_index:
        frozenPlan.shared_index_bytes === null || frozenPlan.shared_index_sha256 === null
          ? null
          : {
              bytes: frozenPlan.shared_index_bytes.length,
              sha256: frozenPlan.shared_index_sha256,
              filename: frozenPlan.shared_index_path!.slice(
                Math.max(
                  frozenPlan.shared_index_path!.lastIndexOf("/"),
                  frozenPlan.shared_index_path!.lastIndexOf("\\"),
                ) + 1,
              ),
            },
      worktree: {
        tree: worktreeTree,
        fingerprint: frozenPlan.worktree_fingerprint,
        material_bytes: frozenPlan.material_bytes,
        paths: frozenPlan.paths,
      },
    };
    const manifestBytes = canonicalManifestBytes(manifest);
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("Recovery manifest is too large.");
    const manifestBlob = hashObject(frozenPlan.repository_root, manifestBytes);
    const entries = [
      `100644 blob ${manifestBlob}\tmanifest.json`,
      `100644 blob ${indexBlob}\tindex.bin`,
      ...(sharedBlob === null ? [] : [`100644 blob ${sharedBlob}\tshared-index.bin`]),
      `040000 tree ${indexTree}\tindex-tree`,
      `040000 tree ${worktreeTree}\tworktree`,
    ];
    const snapshotTree = gitBytes(
      frozenPlan.repository_root,
      ["mktree"],
      Buffer.from(`${entries.join("\n")}\n`, "utf8"),
    )
      .toString("utf8")
      .trim();
    const commit = execFileSync("git", ["commit-tree", snapshotTree, "-p", frozenPlan.head], {
      cwd: frozenPlan.repository_root,
      input: `lyt pod recovery snapshot ${snapshotId}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      env: gitEnvironment({
        GIT_AUTHOR_NAME: "Lyt recovery",
        GIT_AUTHOR_EMAIL: "recovery@lyt.local",
        GIT_COMMITTER_NAME: "Lyt recovery",
        GIT_COMMITTER_EMAIL: "recovery@lyt.local",
      }),
    }).trim();
    options.hooks?.beforeRefUpdate?.();
    // This re-reads HEAD, branch, raw index/shared-index bytes, and every
    // tracked/nonignored worktree entry. The fingerprint is over the complete
    // canonical path manifest, so no ref can publish after source drift.
    const finalPlan = planPodRecoverySnapshot(frozenPlan.repository_root);
    if (!samePlanState(frozenPlan, finalPlan)) {
      throw new Error("Pod changed during recovery snapshot capture; no ref was created.");
    }
    options.hooks?.beforeCommitVerification?.();
    const verified = verifySnapshotCommit(frozenPlan.repository_root, ref, commit);
    execFileSync("git", ["update-ref", ref, commit, "0".repeat(commit.length)], {
      cwd: frozenPlan.repository_root,
      env: gitEnvironment(),
      windowsHide: true,
      timeout: 120_000,
    });
    options.hooks?.afterRefUpdate?.();
    const published = gitText(frozenPlan.repository_root, ["rev-parse", "--verify", ref]);
    if (published !== commit || gitText(frozenPlan.repository_root, ["cat-file", "-t", published]) !== "commit") {
      throw new Error("Recovery snapshot ref publication binding failed.");
    }
    return {
      snapshot_id: verified.snapshot_id,
      ref: verified.ref,
      commit_sha: verified.commit_sha,
      manifest_sha256: verified.manifest_sha256,
    };
  } finally {
    unlinkExactRegular(tempIndex);
  }
}

function rootEntries(root: string, tree: string, oidLength: number): Map<string, { mode: string; type: string; oid: string }> {
  const raw = gitBytes(root, ["ls-tree", "-z", tree]).toString("utf8");
  const entries = new Map<string, { mode: string; type: string; oid: string }>();
  for (const item of raw.split("\0").filter(Boolean)) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/u.exec(item);
    if (match === null || !isObjectId(match[3], oidLength)) throw new Error("Malformed recovery tree entry.");
    if (entries.has(match[4]!)) throw new Error("Duplicate recovery tree entry.");
    entries.set(match[4]!, { mode: match[1]!, type: match[2]!, oid: match[3]! });
  }
  return entries;
}

interface RecursiveTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

function recursiveTreeEntries(root: string, tree: string, oidLength: number): RecursiveTreeEntry[] {
  const records = splitNul(gitBytes(root, ["ls-tree", "-r", "-t", "-z", tree]));
  return records.map((record): RecursiveTreeEntry => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("Malformed recursive recovery tree entry.");
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})$/u.exec(record.subarray(0, tab).toString("ascii"));
    if (match === null || !isObjectId(match[3], oidLength)) {
      throw new Error("Malformed recursive recovery tree header.");
    }
    return { mode: match[1]!, type: match[2]!, oid: match[3]!, path: decodeGitPath(record.subarray(tab + 1)) };
  });
}

function leafTreeEntries(entries: readonly RecursiveTreeEntry[]): RecursiveTreeEntry[] {
  const leaves = entries.filter((entry) => entry.type !== "tree");
  if (new Set(leaves.map((entry) => entry.path)).size !== leaves.length) {
    throw new Error("Recovery tree contains duplicate paths.");
  }
  for (const entry of entries.filter((candidate) => candidate.type === "tree")) {
    if (entry.mode !== "040000" || !leaves.some((leaf) => leaf.path.startsWith(`${entry.path}/`))) {
      throw new Error("Recovery tree contains an empty or malformed subtree.");
    }
  }
  return leaves;
}

function verifyMissingPathsWereTracked(root: string, manifest: PodRecoveryManifestV1, oidLength: number): void {
  const missing = manifest.worktree.paths.filter((entry) => entry.kind === "missing");
  if (missing.length === 0) return;
  const indexEntries = leafTreeEntries(recursiveTreeEntries(root, manifest.index.tree, oidLength));
  const headTree = gitText(root, ["rev-parse", `${manifest.head}^{tree}`]);
  const headEntries = leafTreeEntries(recursiveTreeEntries(root, headTree, oidLength));
  const tracked = new Map([...headEntries, ...indexEntries].map((entry) => [entry.path, entry]));
  for (const entry of missing) {
    const source = tracked.get(entry.path);
    if (
      source === undefined || source.type !== "blob" ||
      (source.mode !== "100644" && source.mode !== "100755" && source.mode !== "120000")
    ) {
      throw new Error(`Recovery missing path was not tracked by the captured state: ${entry.path}`);
    }
  }
}

function verifyWorktreeTree(root: string, manifest: PodRecoveryManifestV1, oidLength: number): void {
  const expected = manifest.worktree.paths.filter((entry) => entry.kind !== "missing");
  const actual = leafTreeEntries(recursiveTreeEntries(root, manifest.worktree.tree, oidLength));
  if (actual.length !== expected.length) throw new Error("Recovery worktree tree path count mismatch.");
  let remaining = POD_RECOVERY_MAX_MATERIAL_BYTES;
  for (let index = 0; index < expected.length; index += 1) {
    const planned = expected[index]!;
    const stored = actual[index]!;
    const expectedMode = planned.kind === "symlink" ? "120000" : (planned.mode & 0o111) === 0 ? "100644" : "100755";
    if (stored.path !== planned.path || stored.mode !== expectedMode || stored.type !== "blob") {
      throw new Error("Recovery worktree tree does not match its path manifest.");
    }
    if (planned.bytes > remaining) throw new Error("Recovery worktree tree exceeds its material bound.");
    const bytes = boundedObjectBytes(root, stored.oid, oidLength, remaining, `Recovery worktree blob ${planned.path}`);
    if (bytes.length !== planned.bytes || sha256(bytes) !== planned.sha256) {
      throw new Error("Recovery worktree blob does not match its path manifest.");
    }
    if (
      planned.kind === "symlink" &&
      bytes.toString("base64") !== planned.symlink_target_base64
    ) {
      throw new Error("Recovery symlink bytes do not match its path manifest.");
    }
    remaining -= bytes.length;
  }
}

function verifyIndexTree(
  root: string,
  snapshotId: string,
  manifest: PodRecoveryManifestV1,
  indexBytes: Buffer,
  sharedBytes: Buffer | null,
  oidLength: number,
): void {
  const scratchRoot = join(tmpdir(), `lyt-recovery-verify-${snapshotId}-${process.pid}`);
  const tempIndex = join(scratchRoot, "index");
  const scratchHead = join(scratchRoot, "HEAD");
  const scratchObjects = join(scratchRoot, "objects");
  const scratchRefs = join(scratchRoot, "refs");
  let ownsRoot = false;
  let ownsIndex = false;
  let ownsHead = false;
  let ownsObjects = false;
  let ownsRefs = false;
  let ownsShared = false;
  let scratchShared: string | null = null;
  try {
    assertSafeWritePath(scratchRoot);
    mkdirSync(scratchRoot);
    ownsRoot = true;
    mkdirSync(scratchObjects);
    ownsObjects = true;
    mkdirSync(scratchRefs);
    ownsRefs = true;
    writeFileSync(scratchHead, "ref: refs/heads/scratch\n", { flag: "wx" });
    ownsHead = true;
    writeFileSync(tempIndex, indexBytes, { flag: "wx" });
    ownsIndex = true;
    if (manifest.shared_index !== null && sharedBytes !== null) {
      scratchShared = join(scratchRoot, manifest.shared_index.filename);
      assertContained(scratchRoot, scratchShared, "Recovery verifier shared index");
      assertSafeWritePath(scratchShared);
      writeFileSync(scratchShared, sharedBytes, { flag: "wx" });
      ownsShared = true;
    }
    const scratchEnvironment = gitEnvironment({
      GIT_DIR: scratchRoot,
      GIT_INDEX_FILE: tempIndex,
      GIT_WORK_TREE: root,
    });
    const resolvedShared = execFileSync("git", ["rev-parse", "--shared-index-path"], {
      cwd: root,
      env: scratchEnvironment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: MAX_GIT_METADATA_BYTES,
    }).trim();
    if (manifest.shared_index === null) {
      if (resolvedShared !== "") throw new Error("Recovery normal index unexpectedly references a shared index.");
    } else if (
      scratchShared === null ||
      (resolve(resolvedShared) !== resolve(scratchShared) &&
        !(process.platform === "win32" && resolvedShared.replaceAll("/", "\\").endsWith(scratchShared)))
    ) {
      throw new Error(
        `Recovery split index does not reference its exact shared index bytes (${resolvedShared} != ${scratchShared ?? "none"}).`,
      );
    }
    const staged = parseStageEntries(
      execFileSync("git", ["ls-files", "--stage", "-z"], {
        cwd: root,
        env: scratchEnvironment,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: MAX_GIT_METADATA_BYTES,
      }),
      oidLength,
    );
    if (staged.some((entry) => entry.stage !== "0")) {
      throw new Error("Recovery index contains unmerged entries.");
    }
    const declared = leafTreeEntries(recursiveTreeEntries(root, manifest.index.tree, oidLength));
    if (staged.length !== declared.length) throw new Error("Recovery index tree path count mismatch.");
    for (let index = 0; index < staged.length; index += 1) {
      const actual = staged[index]!;
      const expected = declared[index]!;
      if (
        actual.path !== expected.path || actual.mode !== expected.mode ||
        actual.oid !== expected.oid || expected.type !== "blob"
      ) {
        throw new Error("Recovery index bytes do not match the declared index tree.");
      }
    }
  } finally {
    if (ownsShared && scratchShared !== null) unlinkExactRegular(scratchShared);
    if (ownsIndex) unlinkExactRegular(tempIndex);
    if (ownsHead) unlinkExactRegular(scratchHead);
    if (ownsRefs) rmdirSync(scratchRefs);
    if (ownsObjects) rmdirSync(scratchObjects);
    if (ownsRoot) rmdirSync(scratchRoot);
  }
}

function verifySnapshotCommit(
  root: string,
  ref: string,
  commit: string,
): PodRecoverySnapshotVerification & { readonly manifest: PodRecoveryManifestV1 } {
  const snapshotId = ref.slice(POD_RECOVERY_REF_PREFIX.length);
  if (!ref.startsWith(POD_RECOVERY_REF_PREFIX) || !UUIDV7.test(snapshotId)) {
    throw new Error("Invalid pod recovery snapshot ref.");
  }
  assertSafeWritePath(root);
  const oidLength = objectIdLength(root);
  if (!isObjectId(commit, oidLength) || gitText(root, ["cat-file", "-t", commit]) !== "commit") {
    throw new Error("Snapshot object must be a commit.");
  }
  const ancestry = gitText(root, ["rev-list", "--parents", "-n", "1", commit]).split(/\s+/u);
  if (ancestry.length !== 2 || ancestry[0] !== commit || !isObjectId(ancestry[1], oidLength)) {
    throw new Error("Recovery snapshot must have exactly one parent.");
  }
  const tree = gitText(root, ["rev-parse", `${commit}^{tree}`]);
  const entries = rootEntries(root, tree, oidLength);
  const required = new Set(["manifest.json", "index.bin", "index-tree", "worktree"]);
  if (entries.has("shared-index.bin")) required.add("shared-index.bin");
  if (entries.size !== required.size || [...required].some((name) => !entries.has(name))) {
    throw new Error("Snapshot tree has an incomplete or unexpected root entry set.");
  }
  const manifestEntry = entries.get("manifest.json")!;
  const indexEntry = entries.get("index.bin")!;
  const indexTree = entries.get("index-tree")!;
  const worktree = entries.get("worktree")!;
  if (
    manifestEntry.mode !== "100644" || manifestEntry.type !== "blob" ||
    indexEntry.mode !== "100644" || indexEntry.type !== "blob" ||
    indexTree.mode !== "040000" || indexTree.type !== "tree" ||
    worktree.mode !== "040000" || worktree.type !== "tree"
  ) {
    throw new Error("Recovery snapshot root entry modes or types are invalid.");
  }
  const manifestBytes = boundedObjectBytes(root, manifestEntry.oid, oidLength, MAX_MANIFEST_BYTES, "Recovery manifest");
  const manifest = parseManifest(manifestBytes, ref, oidLength);
  if (manifest.branch !== null) gitText(root, ["check-ref-format", manifest.branch]);
  if (ancestry[1] !== manifest.head) {
    throw new Error("Recovery snapshot parent does not match manifest HEAD.");
  }
  if (indexTree.oid !== manifest.index.tree || worktree.oid !== manifest.worktree.tree) {
    throw new Error("Recovery index/worktree tree identity mismatch.");
  }
  const indexBytes = boundedObjectBytes(root, indexEntry.oid, oidLength, POD_RECOVERY_MAX_INDEX_BYTES, "Recovery index");
  if (
    indexBytes.length !== manifest.index.bytes ||
    sha256(indexBytes) !== manifest.index.sha256
  ) {
    throw new Error("Recovery index bytes failed verification.");
  }
  const shared = entries.get("shared-index.bin");
  if (manifest.shared_index === null ? shared !== undefined : shared === undefined) {
    throw new Error("Recovery shared index presence mismatch.");
  }
  let sharedBytes: Buffer | null = null;
  if (shared !== undefined && manifest.shared_index !== null) {
    if (shared.mode !== "100644" || shared.type !== "blob") {
      throw new Error("Recovery shared index has the wrong mode or type.");
    }
    sharedBytes = boundedObjectBytes(
      root,
      shared.oid,
      oidLength,
      POD_RECOVERY_MAX_INDEX_BYTES - indexBytes.length,
      "Recovery shared index",
    );
    if (
      sharedBytes.length !== manifest.shared_index.bytes ||
      sha256(sharedBytes) !== manifest.shared_index.sha256
    ) {
      throw new Error("Recovery shared index bytes failed verification.");
    }
  }
  verifyWorktreeTree(root, manifest, oidLength);
  verifyMissingPathsWereTracked(root, manifest, oidLength);
  verifyIndexTree(root, snapshotId, manifest, indexBytes, sharedBytes, oidLength);
  return {
    valid: true,
    snapshot_id: manifest.snapshot_id,
    ref,
    commit_sha: commit,
    manifest_sha256: sha256(manifestBytes),
    manifest,
  };
}

/** Verify that an existing deterministic ref is the exact snapshot of this sealed plan. */
export function verifyPodRecoverySnapshotAgainstPlan(
  plan: PodRecoverySnapshotPlan,
  ref: string,
): PodRecoverySnapshotReceipt {
  const verified = verifyPodRecoverySnapshot(plan.repository_root, ref) as ReturnType<
    typeof verifySnapshotCommit
  >;
  const manifest = verified.manifest;
  const shared = manifest.shared_index;
  if (
    manifest.head !== plan.head ||
    manifest.branch !== plan.branch ||
    manifest.index.bytes !== plan.index_bytes.length ||
    manifest.index.sha256 !== plan.index_sha256 ||
    (shared === null ? null : shared.sha256) !== plan.shared_index_sha256 ||
    manifest.worktree.fingerprint !== plan.worktree_fingerprint ||
    manifest.worktree.material_bytes !== plan.material_bytes ||
    JSON.stringify(manifest.worktree.paths) !== JSON.stringify(plan.paths)
  ) {
    throw new Error("Deterministic recovery ref does not match the sealed snapshot plan.");
  }
  return {
    snapshot_id: verified.snapshot_id,
    ref: verified.ref,
    commit_sha: verified.commit_sha,
    manifest_sha256: verified.manifest_sha256,
  };
}

/** Object-read-only verification; transient scratch never touches the source repository. */
export function verifyPodRecoverySnapshot(
  repositoryRoot: string,
  ref: string,
): PodRecoverySnapshotVerification {
  const root = resolve(repositoryRoot);
  const snapshotId = ref.slice(POD_RECOVERY_REF_PREFIX.length);
  if (!ref.startsWith(POD_RECOVERY_REF_PREFIX) || !UUIDV7.test(snapshotId)) {
    throw new Error("Invalid pod recovery snapshot ref.");
  }
  const oidLength = objectIdLength(root);
  const commit = gitText(root, ["rev-parse", "--verify", ref]);
  if (!isObjectId(commit, oidLength) || gitText(root, ["cat-file", "-t", commit]) !== "commit") {
    throw new Error("Snapshot ref must point directly to a commit.");
  }
  return verifySnapshotCommit(root, ref, commit);
}
