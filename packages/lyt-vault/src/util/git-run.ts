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

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { firewall } from "./git-error-firewall.js";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Exact bounded bytes captured from stdout/stderr. */
  stdoutRaw?: Uint8Array;
  stderrRaw?: Uint8Array;
  // Optional for compatibility with injected runners that predate bounded
  // output. The production runner always supplies both flags.
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface GitRunRawResult extends GitRunResult {
  stdoutRaw: Uint8Array;
  stderrRaw: Uint8Array;
}

export type GitRunPolicyKind = "read-only" | "local-mutation" | "remote-observation";

export interface GitRunPolicy {
  readonly kind: GitRunPolicyKind;
  readonly allowedCommands: readonly string[] | null;
  readonly environment: Readonly<Record<string, string>>;
}

const PROMPT_GUARD_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
});

const OBSERVATION_ENV = Object.freeze({
  ...PROMPT_GUARD_ENV,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
});

// `diff` and `show` accept --output[=<path>] and Git accepts unambiguous
// long-option abbreviations. A read-only policy must reject the option itself,
// not merely a supplied filename, so neither spelling can redirect output to
// the filesystem.
function isReadOnlyWriteCapableOption(arg: string): boolean {
  const option = arg.split("=", 1)[0]!;
  return option.startsWith("--") && option.length > 2 && "--output".startsWith(option);
}

// `ls-remote` calls its remote helper through all of these spellings. The
// short form may carry its value in the same argv item, so test the prefix.
function isRemoteExecutableOverride(arg: string): boolean {
  const option = arg.split("=", 1)[0]!;
  return (
    arg === "-u" ||
    (arg.startsWith("-u") && !arg.startsWith("--")) ||
    (option.startsWith("--") &&
      option.length > 2 &&
      ("--upload-pack".startsWith(option) || "--exec".startsWith(option)))
  );
}

function isReadOnlyConfigInspection(args: readonly string[]): boolean {
  if (
    args.length === 4 &&
    args[1] === "--bool" &&
    args[2] === "--get" &&
    args[3] === "core.longpaths"
  ) {
    return true;
  }
  return (
    args.length === 3 &&
    args[1] === "--get-all" &&
    /^remote\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\.url$/.test(args[2] ?? "")
  );
}

export const GIT_READ_ONLY_POLICY: GitRunPolicy = Object.freeze({
  kind: "read-only" as const,
  allowedCommands: Object.freeze([
    "cat-file",
    "check-ignore",
    "config",
    "diff",
    "for-each-ref",
    "log",
    "ls-files",
    "ls-tree",
    "merge-base",
    "rev-list",
    "rev-parse",
    "show",
    "show-ref",
    "status",
    "symbolic-ref",
  ]),
  environment: OBSERVATION_ENV,
});

export const GIT_LOCAL_MUTATION_POLICY: GitRunPolicy = Object.freeze({
  kind: "local-mutation" as const,
  allowedCommands: null,
  environment: PROMPT_GUARD_ENV,
});

export const GIT_REMOTE_OBSERVATION_POLICY: GitRunPolicy = Object.freeze({
  kind: "remote-observation" as const,
  allowedCommands: Object.freeze(["ls-remote"]),
  environment: OBSERVATION_ENV,
});

export interface GitRunOptions {
  cwd: string;
  // When true, a non-zero exit doesn't throw — caller inspects `code`.
  allowFailure?: boolean;
  // Extra environment entries merged over process.env (e.g. GIT_INDEX_FILE
  // for temp-index plumbing in snapshot's working-tree capture — F11).
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string | Uint8Array;
  maxOutputBytes?: number;
  policy?: GitRunPolicy;
}

/**
 * Hard ceiling for Git children, including outward fetch/pull/push work. The
 * gh-federation wrappers import the same bound, so every production child held
 * under a publication subject lock shares one ceiling. Publication-lock
 * recovery waits 180s, leaving 50% headroom over this 120s bound.
 * SEE ALSO: util/gh-federation.ts spawnArgvVerbatim{Async}.
 * SEE ALSO: flows/federation/destination-policy-lock.ts — recovery quarantine.
 */
export const GIT_COMMAND_TIMEOUT_MS = 120_000;

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const TERMINATION_VERIFY_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

interface ProcessIdentity {
  pid: number;
  parentPid: number;
  created: string;
}

export interface GitTerminationEvidence {
  readonly reason: "timeout" | "aborted";
  readonly rootPid: number;
  readonly trackedPids: readonly number[];
  readonly verifiedGone: boolean;
}

export class GitRunTerminatedError extends Error {
  readonly errorCode: "git-timeout" | "git-aborted";
  readonly evidence: GitTerminationEvidence;

  constructor(reason: "timeout" | "aborted", timeoutMs: number, evidence: GitTerminationEvidence) {
    super(
      reason === "timeout" ? `git command timed out after ${timeoutMs}ms` : "git command aborted",
    );
    this.name = "GitRunTerminatedError";
    this.errorCode = reason === "timeout" ? "git-timeout" : "git-aborted";
    this.evidence = evidence;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function preparePolicy(
  args: readonly string[],
  policy: GitRunPolicy,
): { args: readonly string[]; env: Record<string, string> } {
  const commandIndex = args[0] === "--literal-pathspecs" ? 1 : 0;
  const command = args[commandIndex];
  if (command === undefined || command.length === 0) throw new TypeError("git command is required");
  if (policy.allowedCommands !== null && !policy.allowedCommands.includes(command)) {
    throw new Error(`git ${command} is not allowed by the ${policy.kind} policy`);
  }
  if (
    policy.kind === "read-only" &&
    command === "config" &&
    !isReadOnlyConfigInspection(args.slice(commandIndex))
  ) {
    throw new Error(
      "only exact read-only config inspections are allowed by the read-only policy",
    );
  }
  if (
    policy.kind === "read-only" &&
    args.some((arg) => ["--ext-diff", "--textconv", "--filters"].includes(arg))
  ) {
    throw new Error(`git ${command} external filters are not allowed by the read-only policy`);
  }
  if (policy.kind === "read-only" && args.some(isReadOnlyWriteCapableOption)) {
    throw new Error(
      `git ${command} write-capable output options are not allowed by the read-only policy`,
    );
  }
  if (
    policy.kind === "remote-observation" &&
    args.some((arg) => isRemoteExecutableOverride(arg) || arg.toLowerCase().startsWith("ext::"))
  ) {
    throw new Error("git ls-remote executable overrides are not allowed");
  }
  let policyArgs = [...args];
  if (policy.kind === "read-only" && ["diff", "log", "show"].includes(command)) {
    policyArgs = [
      ...args.slice(0, commandIndex),
      command,
      "--no-ext-diff",
      "--no-textconv",
      ...args.slice(commandIndex + 1),
    ];
  }
  const preparedArgs =
    policy.kind === "local-mutation" ? policyArgs : ["-c", "core.fsmonitor=false", ...policyArgs];
  return { args: preparedArgs, env: { ...policy.environment } };
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
): { bytes: number; truncated: boolean } {
  if (currentBytes >= maxBytes) return { bytes: currentBytes, truncated: chunk.length > 0 };
  const remaining = maxBytes - currentBytes;
  const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  if (accepted.length > 0) chunks.push(Buffer.from(accepted));
  return { bytes: currentBytes + accepted.length, truncated: chunk.length > accepted.length };
}

function decodeBounded(chunks: readonly Buffer[], truncated: boolean): string {
  // With stream=true TextDecoder retains (and therefore does not replace) an
  // incomplete trailing code point. We intentionally do not flush it when the
  // byte ceiling caused truncation; callers receive only complete UTF-8.
  return new TextDecoder().decode(Buffer.concat(chunks), { stream: truncated });
}

async function windowsProcessInventory(): Promise<readonly ProcessIdentity[]> {
  const command =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress";
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      timeout: TERMINATION_VERIFY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1_048_576,
    },
  );
  const text = String(result.stdout).trim();
  if (text.length === 0) return [];
  const parsed = JSON.parse(text) as
    | { ProcessId: number; ParentProcessId: number; CreationDate: string }
    | Array<{ ProcessId: number; ParentProcessId: number; CreationDate: string }>;
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: Number(entry.ProcessId),
    parentPid: Number(entry.ParentProcessId),
    created: String(entry.CreationDate),
  }));
}

function collectProcessTree(
  inventory: readonly ProcessIdentity[],
  rootPid: number,
): readonly ProcessIdentity[] {
  const byParent = new Map<number, ProcessIdentity[]>();
  for (const process of inventory) {
    const children = byParent.get(process.parentPid) ?? [];
    children.push(process);
    byParent.set(process.parentPid, children);
  }
  const byPid = new Map(inventory.map((process) => [process.pid, process] as const));
  const root = byPid.get(rootPid);
  const result: ProcessIdentity[] = root === undefined ? [] : [root];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

function processIdentityStillPresent(
  inventory: readonly ProcessIdentity[],
  identity: ProcessIdentity,
): boolean {
  return inventory.some(
    (candidate) => candidate.pid === identity.pid && candidate.created === identity.created,
  );
}

async function terminateWindowsTree(
  pid: number,
  reason: "timeout" | "aborted",
): Promise<GitTerminationEvidence> {
  const before = await windowsProcessInventory();
  const tracked = collectProcessTree(before, pid);
  try {
    await execFileAsync("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
      encoding: "utf8",
      timeout: TERMINATION_VERIFY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 65_536,
    });
  } catch {
    // A process may exit between inventory and taskkill. Verification below is
    // authoritative; taskkill's localized exit text is not.
  }

  const deadline = Date.now() + TERMINATION_VERIFY_TIMEOUT_MS;
  while (true) {
    const after = await windowsProcessInventory();
    if (tracked.every((identity) => !processIdentityStillPresent(after, identity))) {
      return Object.freeze({
        reason,
        rootPid: pid,
        trackedPids: Object.freeze(tracked.map((identity) => identity.pid)),
        verifiedGone: true,
      });
    }
    if (Date.now() >= deadline) {
      const survivors = tracked
        .filter((identity) => processIdentityStillPresent(after, identity))
        .map((identity) => identity.pid);
      throw new Error(
        `git process tree termination could not be verified; survivors: ${survivors.join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function terminatePosixTree(
  pid: number,
  reason: "timeout" | "aborted",
): Promise<GitTerminationEvidence> {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone; verified below.
    }
  }
  const deadline = Date.now() + TERMINATION_VERIFY_TIMEOUT_MS;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch {
      return Object.freeze({
        reason,
        rootPid: pid,
        trackedPids: Object.freeze([pid]),
        verifiedGone: true,
      });
    }
    if (Date.now() >= deadline) throw new Error(`git process ${pid} survived termination`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function terminateProcessTree(
  pid: number,
  reason: "timeout" | "aborted",
): Promise<GitTerminationEvidence> {
  return process.platform === "win32"
    ? terminateWindowsTree(pid, reason)
    : terminatePosixTree(pid, reason);
}

export function runGit(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    assertPositiveInteger(timeoutMs, "timeoutMs");
    assertPositiveInteger(maxOutputBytes, "maxOutputBytes");
    const policy = opts.policy ?? GIT_LOCAL_MUTATION_POLICY;
    const prepared = preparePolicy(args, policy);
    if (opts.signal?.aborted === true) {
      reject(
        new GitRunTerminatedError(
          "aborted",
          timeoutMs,
          Object.freeze({
            reason: "aborted" as const,
            rootPid: -1,
            trackedPids: Object.freeze([]),
            verifiedGone: true,
          }),
        ),
      );
      return;
    }

    const child = spawn("git", prepared.args, {
      cwd: opts.cwd,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      // Callers may add benign environment, but a named policy's prompt/lock
      // guards are authoritative and cannot be overridden at the call site.
      env: { ...process.env, ...(opts.env ?? {}), ...prepared.env },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let closeSeen = false;
    let closeCode = -1;
    let spawnError: Error | null = null;
    let terminationReason: "timeout" | "aborted" | null = null;
    let terminationPromise: Promise<GitTerminationEvidence> | null = null;

    const timeout = setTimeout(() => requestTermination("timeout"), timeoutMs);
    const abortListener = () => requestTermination("aborted");
    opts.signal?.addEventListener("abort", abortListener, { once: true });

    function cleanup(): void {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", abortListener);
    }

    function requestTermination(reason: "timeout" | "aborted"): void {
      if (terminationReason !== null || settled) return;
      terminationReason = reason;
      clearTimeout(timeout);
      const pid = child.pid;
      terminationPromise =
        pid === undefined
          ? Promise.resolve(
              Object.freeze({
                reason,
                rootPid: -1,
                trackedPids: Object.freeze([]),
                verifiedGone: true,
              }),
            )
          : terminateProcessTree(pid, reason);
      // A failed kill/verification can prevent Node from ever emitting
      // `close`. Settle from the bounded termination attempt as well so the
      // caller cannot hang beyond the termination-verification ceiling.
      void terminationPromise.then(
        () => void finalize(true),
        () => void finalize(true),
      );
      void finalize();
    }

    async function finalize(terminationFinished = false): Promise<void> {
      if (settled || (!closeSeen && !terminationFinished)) return;
      settled = true;
      cleanup();
      try {
        const stdout = decodeBounded(stdoutChunks, stdoutTruncated);
        const stderr = decodeBounded(stderrChunks, stderrTruncated);
        if (terminationReason !== null) {
          const evidence = await terminationPromise!;
          reject(new GitRunTerminatedError(terminationReason, timeoutMs, evidence));
          return;
        }
        if (spawnError !== null) {
          const e = spawnError as NodeJS.ErrnoException;
          if (e.code === "ENOENT") {
            reject(
              firewall(
                Object.assign(
                  new Error("`git` not found on PATH. Install Git: https://git-scm.com/."),
                  { code: "ENOENT" },
                ),
              ),
            );
            return;
          }
          reject(firewall(spawnError));
          return;
        }
        const result: GitRunResult = {
          code: closeCode,
          stdout,
          stderr,
          stdoutRaw: Buffer.concat(stdoutChunks),
          stderrRaw: Buffer.concat(stderrChunks),
          stdoutTruncated,
          stderrTruncated,
        };
        if (closeCode !== 0 && opts.allowFailure !== true) {
          reject(
            firewall(
              Object.assign(
                new Error(
                  `git ${args.join(" ")} exited ${closeCode}: ${stderr.trim() || stdout.trim()}`,
                ),
                { stderr },
              ),
            ),
          );
          return;
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    child.stdout!.on("data", (b: Buffer) => {
      const appended = appendBounded(stdoutChunks, b, stdoutBytes, maxOutputBytes);
      stdoutBytes = appended.bytes;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr!.on("data", (b: Buffer) => {
      const appended = appendBounded(stderrChunks, b, stderrBytes, maxOutputBytes);
      stderrBytes = appended.bytes;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("close", (code) => {
      closeSeen = true;
      closeCode = code ?? -1;
      void finalize();
    });

    if (opts.stdin !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => {
        // A child may close stdin before consuming all input. Its close code is
        // the terminal outcome; avoid a second settlement through EPIPE.
      });
      child.stdin.end(opts.stdin);
    }
  });
}

export function runGitReadOnly(
  args: readonly string[],
  opts: Omit<GitRunOptions, "policy">,
): Promise<GitRunResult> {
  return runGit(args, { ...opts, policy: GIT_READ_ONLY_POLICY });
}

export async function runGitReadOnlyRaw(
  args: readonly string[],
  opts: Omit<GitRunOptions, "policy">,
): Promise<GitRunRawResult> {
  const result = await runGitReadOnly(args, opts);
  if (result.stdoutRaw === undefined || result.stderrRaw === undefined) {
    throw new Error("production Git runner did not return raw output bytes");
  }
  return { ...result, stdoutRaw: result.stdoutRaw, stderrRaw: result.stderrRaw };
}

export function runGitLocalMutation(
  args: readonly string[],
  opts: Omit<GitRunOptions, "policy">,
): Promise<GitRunResult> {
  return runGit(args, { ...opts, policy: GIT_LOCAL_MUTATION_POLICY });
}

export function runGitRemoteObservation(
  args: readonly string[],
  opts: Omit<GitRunOptions, "policy">,
): Promise<GitRunResult> {
  return runGit(args, { ...opts, policy: GIT_REMOTE_OBSERVATION_POLICY });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGitReadOnly(["rev-parse", "--git-dir"], {
    cwd,
    allowFailure: true,
  });
  return r.code === 0;
}

export interface PorcelainStatus {
  clean: boolean;
  dirtyCount: number;
  lines: string[];
}

export async function gitStatusPorcelain(cwd: string): Promise<PorcelainStatus> {
  const r = await runGitReadOnly(["status", "--porcelain"], { cwd });
  const lines = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return { clean: lines.length === 0, dirtyCount: lines.length, lines };
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const r = await runGitReadOnly(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return r.stdout.trim();
}

export async function getDefaultBranch(cwd: string): Promise<string> {
  // Prefer origin/HEAD symbolic ref; fall back to current branch.
  const r = await runGitReadOnly(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd, allowFailure: true },
  );
  if (r.code === 0) {
    const ref = r.stdout.trim();
    const idx = ref.lastIndexOf("/");
    if (idx >= 0) return ref.slice(idx + 1);
  }
  return getCurrentBranch(cwd);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const r = await runGitReadOnly(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd, allowFailure: true },
  );
  return r.code === 0;
}

export async function hasUpstream(cwd: string): Promise<boolean> {
  const r = await runGitReadOnly(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd, allowFailure: true },
  );
  return r.code === 0;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export async function aheadBehind(cwd: string): Promise<AheadBehind | null> {
  const r = await runGitReadOnly(
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    { cwd, allowFailure: true },
  );
  if (r.code !== 0) return null;
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length < 2) return { ahead: 0, behind: 0 };
  return { ahead: Number(parts[0]) || 0, behind: Number(parts[1]) || 0 };
}

export interface BranchInfo {
  branch: string;
  timestamp: string;
  label: string | null;
  sha: string;
  subject: string;
}

export async function listBranchesWithPrefix(cwd: string, prefix: string): Promise<BranchInfo[]> {
  // Sort by refname descending — the embedded ISO timestamp in branch names
  // (lyt-snapshot/<YYYY-MM-DDTHH-mm-ss>[-<slug>]) sorts lexically, so newer
  // snapshots come first. Falls back to committerdate sort only when branch
  // names don't follow the prefix scheme — but listBranchesWithPrefix only
  // returns branches with the prefix, so refname ordering is the right primary.
  const r = await runGitReadOnly(
    [
      "for-each-ref",
      "--sort=-refname",
      "--format=%(refname:short)|%(committerdate:iso-strict)|%(objectname:short)|%(subject)",
      `refs/heads/${prefix}*`,
    ],
    { cwd },
  );
  const out: BranchInfo[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split("|");
    const branch = parts[0];
    const isoDate = parts[1];
    const sha = parts[2];
    if (!branch || !sha) continue;
    // Branch shape: <prefix><YYYY-MM-DDTHH-mm-ss>[-<slug>]
    const after = branch.startsWith(prefix) ? branch.slice(prefix.length) : branch;
    const m = after.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2})(?:-(.+))?$/);
    const timestamp = m ? m[1]! : (isoDate ?? "");
    const label = m && m[2] ? m[2]! : null;
    out.push({
      branch,
      timestamp,
      label,
      sha,
      subject: parts.slice(3).join("|"),
    });
  }
  return out;
}

export function timestampForBranchName(now: Date = new Date()): string {
  // YYYY-MM-DDTHH-mm-ss (filesystem/branch-safe ISO variant)
  const iso = now.toISOString();
  return iso.slice(0, 19).replace(/:/g, "-");
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
