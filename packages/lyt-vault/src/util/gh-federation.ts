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

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { withSpinner, type SpinnerOp } from "./spinner.js";

const execFileAsync = promisify(execFile);

// Injectable client for the federation-repo GH + git operations. v1.A.0
// uses this for `lyt federation init` (create or adopt the remote +
// clone-like materialise locally + initial commit + push).
//
// Pattern mirrors util/identity.ts (IdentityRunner) and util/gh.ts (GhClient) —
// a single typed interface + a real implementation that shells out + an
// injectable seam for tests. Real impl shells out via `gh` + `git`; tests
// pass a fake that records calls + simulates filesystem effects.

export type FederationRepoVisibility = "private" | "public";

export interface FederationGhClient {
  repoExists(handle: string, repoName: string): Promise<boolean>;
  createRepo(
    handle: string,
    repoName: string,
    visibility: FederationRepoVisibility,
    description: string,
  ): Promise<void>;
  // set GitHub repo topics on the pod repo after create. Separate
  // from createRepo because `gh repo create` does NOT accept --topic;
  // topics must be applied via `gh repo edit --add-topic` (verified — same
  // mechanism util/gh.ts:editRepo + util/gh-mesh-publish.ts already use).
  // Non-fatal at the caller: a topic failure must not unwind a successful
  // repo create (the caller logs + continues).
  setRepoTopics(handle: string, repoName: string, topics: readonly string[]): Promise<void>;
  // Materialise the federation repo locally. v1.A.0 ships a hybrid path:
  // when the remote was JUST created by us, we `git init` locally + write
  // pod.yon + commit (no clone — the remote is empty). When the
  // remote pre-exists, we `git clone`. Either way the local directory ends
  // up as a working tree at `localDir` with origin pointing at the remote.
  initLocalFromFresh(handle: string, repoName: string, localDir: string): Promise<void>;
  // (2026-06-04) — materialise the pod repo LOCALLY with NO
  // remote. Used by `lyt init` on a no-gh box (or the local-only choice): the
  // pod is a real git repo with local history, but no `origin` is wired until
  // the user connects (§2.4 — "only GitHub repo names ... aren't created
  // until connect"). Connect (`lyt sync` self-heal) creates the gh repo + sets
  // the remote under the REAL handle. The `handle` is used only to pin a
  // local-repo commit identity (user.name/email), never a remote URL.
  initLocalNoRemote(handle: string, localDir: string): Promise<void>;
  cloneExisting(handle: string, repoName: string, localDir: string): Promise<void>;
  commitAndOptionallyPush(localDir: string, message: string, push: boolean): Promise<void>;
}

const isWindows = process.platform === "win32";

// v1.GP F6 fix-pass — argv-verbatim spawn (closes the Windows word-split BUG
// + the G.14 a review finding shell-injection class at the spawn layer).
//
// Prior impl: `execFileSync("gh", args, { shell: isWindows })`. With
// `shell:true` on Windows, Node joins the argv array into a single cmd.exe
// command string WITHOUT quoting, so any arg containing whitespace (the
// multi-word `--description` value) word-splits into multiple tokens — gh's
// `repo create` then sees 11 positional args and rejects ("accepts at most
// 1 arg(s), received 11"). The same un-quoted join also re-opens the shell-
// metachar injection surface the G.14 a review finding handle-regex guard (wizard.ts)
// was added to defend.
//
// Fix: pass argv VERBATIM, never re-joined into a shell string.
// - POSIX: `execFileSync(exe, args)` with NO shell — Node passes argv
// elements directly to execvp; no quoting needed; no word-split possible.
// - Windows: resolve the executable on PATH (respecting PATHEXT). Node's
// execFileSync can spawn `.exe`/`.com` images DIRECTLY without a shell,
// passing argv verbatim — same safety as POSIX. Only `.cmd`/`.bat` shims
// (which the OS CreateProcess cannot launch without cmd.exe) fall back to
// `shell:true`; on that path EACH arg is quoted via cmdQuote() so a
// space-bearing arg stays a single token and shell metachars are inert.
//
// `gh` ships as `gh.exe` on a standard Windows install (winget / installer),
// so the common path is shell-free + verbatim. `git` ships as `git.exe`.

// Windows cmd.exe argument quoting. Wraps in double-quotes and escapes any
// embedded double-quote per CommandLineToArgvW + cmd.exe rules. Only used on
// the `.cmd`/`.bat` fallback path; the direct-`.exe` path never quotes.
// Exported for the F6 regression test (assert multi-word args stay 1 token).
export function cmdQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"^&|<>()%!]/.test(arg)) return arg;
  // Escape backslashes preceding a quote, then the quote, then wrap.
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

// Resolve an executable to a full path on Windows, scanning PATH × PATHEXT.
// Returns { path, needsShell } — needsShell=true ONLY for .cmd/.bat images
// that the OS cannot launch without cmd.exe. Returns null when unresolved
// (caller falls back to a shell hop on the bare name so a non-standard
// install — e.g. a .cmd shim on a directory not yet scanned — still works).
interface ResolvedExe {
  path: string;
  needsShell: boolean;
}

function resolveWindowsExecutable(name: string): ResolvedExe | null {
  const pathVar = process.env["PATH"] ?? process.env["Path"] ?? "";
  const dirs = pathVar.split(delimiter).filter((d) => d.length > 0);
  const pathext = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((e) => e.length > 0);
  const directExts = new Set([".EXE", ".COM"]);
  for (const dir of dirs) {
    // If the name already carries an extension, try it as-is first.
    const direct = join(dir, name);
    if (existsSync(direct) && /\.[A-Za-z]+$/.test(name)) {
      const ext = name.slice(name.lastIndexOf(".")).toUpperCase();
      return { path: direct, needsShell: !directExts.has(ext) };
    }
    for (const ext of pathext) {
      const candidate = join(dir, `${name}${ext.toLowerCase()}`);
      const candidateUpper = join(dir, `${name}${ext}`);
      const found = existsSync(candidate)
        ? candidate
        : existsSync(candidateUpper)
          ? candidateUpper
          : null;
      if (found !== null) {
        return { path: found, needsShell: !directExts.has(ext.toUpperCase()) };
      }
    }
  }
  return null;
}

// Spawn a command passing argv verbatim — no shell re-join on the direct
// path. `opts.encoding` selects string (gh stdout capture) vs void (git).
function spawnArgvVerbatim(
  exe: string,
  args: readonly string[],
  opts: { cwd?: string; encoding?: "utf8"; stdio: readonly ("ignore" | "pipe")[] },
): string {
  const baseOpts = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdio: opts.stdio as ("ignore" | "pipe")[],
    ...(opts.encoding !== undefined ? { encoding: opts.encoding } : {}),
  };

  if (!isWindows) {
    // POSIX: no shell, argv passed verbatim to execvp. No word-split.
    const out = execFileSync(exe, args as string[], baseOpts);
    return typeof out === "string" ? out : "";
  }

  const resolved = resolveWindowsExecutable(exe);
  if (resolved !== null && !resolved.needsShell) {
    // Direct .exe/.com image — Node launches without a shell; argv verbatim.
    const out = execFileSync(resolved.path, args as string[], baseOpts);
    return typeof out === "string" ? out : "";
  }

  // Fallback: .cmd/.bat shim (or unresolved name). MUST go through cmd.exe.
  // Quote the executable path + EACH arg so a space-bearing arg stays one
  // token and shell metachars are inert (closes G.14 a review finding + the word-split).
  const exePath = resolved !== null ? resolved.path : exe;
  const quoted = buildShellCommand(exePath, args);
  const out = execFileSync(quoted, [], { ...baseOpts, shell: true });
  return typeof out === "string" ? out : "";
}

// Build the single cmd.exe command string for the .cmd/.bat fallback path:
// exe + each arg quoted so whitespace never word-splits. Exported so the F6
// regression test can assert a multi-word `--description` survives as ONE
// shell token (the bug was Node's own un-quoted argv join under shell:true).
export function buildShellCommand(exe: string, args: readonly string[]): string {
  return [cmdQuote(exe), ...args.map(cmdQuote)].join(" ");
}

// v1.V Track-C (V-B-9) — spawn-shaped sibling of spawnArgvVerbatim, for the
// STREAMING async executors that must capture stdout AND preserve their own
// error semantics (the gh `defaultGh` in gh-discover.ts + lyt-mesh
// discovery/github.ts both parse err.message for "Not Found"/404, which
// execFileAsync would not surface the same way). Those two executors had
// drifted: bare `spawn("gh", args)` with NO win32 handling, so on Windows the
// `gh.cmd` shim never launches → ENOENT → checkPushPermission throws →
// `writable: "unknown"` (the V-B-9 papercut). This returns the `spawn()`
// triple so they get the SAME .exe-direct / .cmd-shell-quoted treatment the
// F6/G.14-hardened sync+async federation runners already have:
// - POSIX / win32 .exe|.com : { command: exe, args, shell:false } — verbatim.
// - win32 .cmd|.bat|unresolved: { command: cmd.exe string (each arg
// cmdQuote'd), args: [], shell:true } — so a space/metachar-bearing arg
// (the walk's `-q '<jq>'` filter) stays ONE token and injection is inert.
// Keep this in lockstep with spawnArgvVerbatim's branch logic above.
export interface SpawnInvocation {
  command: string;
  args: readonly string[];
  shell: boolean;
}

export function resolveSpawnInvocation(exe: string, args: readonly string[]): SpawnInvocation {
  if (!isWindows) {
    return { command: exe, args, shell: false };
  }
  const resolved = resolveWindowsExecutable(exe);
  if (resolved !== null && !resolved.needsShell) {
    return { command: resolved.path, args, shell: false };
  }
  const exePath = resolved !== null ? resolved.path : exe;
  return { command: buildShellCommand(exePath, args), args: [], shell: true };
}

function runGh(args: readonly string[]): string {
  return spawnArgvVerbatim("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runGit(cwd: string, args: readonly string[]): void {
  spawnArgvVerbatim("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// v1.GP F7 — ASYNC argv-verbatim spawn. Same word-split + shell-injection
// safety as spawnArgvVerbatim (the F6 fix), but non-blocking so the F7
// spinner's setInterval can actually tick while gh/git runs. A synchronous
// execFileSync would block the single-threaded event loop and freeze the
// spinner — the very "silent freeze" F7 set out to kill. Used only by the
// spinner-wrapped real-client network ops below.
async function spawnArgvVerbatimAsync(
  exe: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const baseOpts = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };

  if (!isWindows) {
    await execFileAsync(exe, args as string[], baseOpts);
    return;
  }
  const resolved = resolveWindowsExecutable(exe);
  if (resolved !== null && !resolved.needsShell) {
    await execFileAsync(resolved.path, args as string[], baseOpts);
    return;
  }
  // .cmd/.bat shim (or unresolved) — go through cmd.exe with each arg quoted
  // (identical posture to the sync fallback path).
  const exePath = resolved !== null ? resolved.path : exe;
  const quoted = buildShellCommand(exePath, args);
  await execFileAsync(quoted, [], { ...baseOpts, shell: true });
}

// Spinner-wrapped async gh/git runners. The spinner is a no-op when not on a
// TTY (prints the label once, zero escape codes) — see util/spinner.ts. The
// `op` selects the honest gerund (create→Forging, push→Unfurling, …).
async function spinGh(op: SpinnerOp, label: string, args: readonly string[]): Promise<void> {
  await withSpinner(label, () => spawnArgvVerbatimAsync("gh", args), { op });
}

async function spinGit(
  op: SpinnerOp,
  label: string,
  cwd: string,
  args: readonly string[],
): Promise<void> {
  await withSpinner(label, () => spawnArgvVerbatimAsync("git", args, { cwd }), { op });
}

// block-B release review (v1.A.1b a tracked follow-up — IN scope for block-B).
//
// `realFederationGhClient.repoExists` historically swallowed every non-zero
// `gh api /repos/<x>/<y>` exit, converting auth failures, network errors,
// missing-gh-binary, and rate-limits into "repo doesn't exist". The caller
// (`federationInitFlow`) then tried `createRepo`, which would fail with the
// same upstream issue — surfacing a misleading error trail.
//
// Fix: classify the gh-cli failure. HTTP 404 means "repo absent" — the only
// legitimate `false` return. Anything else (gh not installed, 401/403 auth,
// 5xx, network outage) propagates as a typed error so the caller can decide.
// Mirrors the v1.A.0 release review posture that `runGit + runGh` should fail
// loud rather than swallow (a tracked follow-up — out of scope here, queued v1.B.2).
export function inspectGhError(err: unknown): { is404: boolean; summary: string } {
  // execFileSync's thrown error has shape { code: <ENOENT|...>, status: <exit>,
  // stderr: Buffer|string, stdout: Buffer|string }. Decode stderr text and
  // look for the HTTP-404 marker gh emits.
  const e = err as { code?: string; status?: number; stderr?: unknown; message?: string };
  if (e.code === "ENOENT") {
    return { is404: false, summary: "gh CLI not installed or not on PATH" };
  }
  let stderrText = "";
  if (e.stderr !== undefined && e.stderr !== null) {
    stderrText =
      e.stderr instanceof Buffer
        ? e.stderr.toString("utf8")
        : typeof e.stderr === "string"
          ? e.stderr
          : "";
  }
  // gh prints "gh: ... (HTTP 404)" or "HTTP 404: Not Found" on missing repos.
  const is404 =
    /\bHTTP\s*404\b/i.test(stderrText) ||
    /\b404\b.*Not\s*Found/i.test(stderrText) ||
    /^Not\s*Found\b/im.test(stderrText);
  const summary =
    stderrText.trim().length > 0
      ? stderrText.trim().split(/\r?\n/)[0]!.slice(0, 200)
      : (e.message ?? `gh CLI exited with status ${e.status ?? "unknown"}`);
  return { is404, summary };
}

export const realFederationGhClient: FederationGhClient = {
  async repoExists(handle, repoName): Promise<boolean> {
    try {
      runGh(["api", "--silent", `/repos/${handle}/${repoName}`]);
      return true;
    } catch (err) {
      const { is404, summary } = inspectGhError(err);
      if (is404) return false;
      throw new Error(`realFederationGhClient.repoExists(${handle}/${repoName}): ${summary}`);
    }
  },

  async createRepo(handle, repoName, visibility, description): Promise<void> {
    const flag = visibility === "public" ? "--public" : "--private";
    // F7: spinner-wrapped (op=create → "Forging…"). This is the op the
    // dogfooding F7 finding flagged as a silent freeze.
    await spinGh("create", `${handle}/${repoName} on GitHub`, [
      "repo",
      "create",
      `${handle}/${repoName}`,
      flag,
      "--description",
      description,
    ]);
  },

  async setRepoTopics(handle, repoName, topics): Promise<void> {
    // `gh repo create` cannot set topics — apply them in a follow-up
    // `gh repo edit --add-topic a,b,c`. gh accepts a comma-joined list OR
    // repeated --add-topic flags; we pass one comma-joined arg (matches the
    // brief's `--add-topic a,b,c` shape). argv-verbatim spawn (no shell
    // word-split) per the F6 fix above.
    const cleaned = topics.map((t) => t.trim()).filter((t) => t.length > 0);
    if (cleaned.length === 0) return;
    runGh(["repo", "edit", `${handle}/${repoName}`, "--add-topic", cleaned.join(",")]);
  },

  async initLocalFromFresh(handle, repoName, localDir): Promise<void> {
    mkdirSync(dirname(localDir), { recursive: true });
    if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true });
    runGit(localDir, ["init", "--initial-branch=main"]);
    // Set origin so commitAndOptionallyPush can push when called.
    const url = `https://github.com/${handle}/${repoName}.git`;
    runGit(localDir, ["remote", "add", "origin", url]);
    // Release review Angle A + B + C: on a fresh machine with no global git
    // user.name / user.email (common on dev VMs + CI runners), the
    // subsequent `git commit` would throw "Please tell me who you are" —
    // leaving the federation repo half-initialised while
    // upsertFederationState writes a row claiming it succeeded. Pin a
    // local-repo identity derived from the GH handle so commits always
    // succeed without requiring the handler to fix global config first.
    runGit(localDir, ["config", "user.name", handle]);
    runGit(localDir, ["config", "user.email", `${handle}@users.noreply.github.com`]);
    // Drop a .gitignore so future cache files (if any) don't leak.
    const gitignore = ["# Lyt pod cache — keep pod.yon committed.", ""].join("\n");
    writeFileSync(`${localDir}/.gitignore`, gitignore, "utf8");
  },

  async initLocalNoRemote(handle, localDir): Promise<void> {
    // git init only; NO `git remote add`. Mirrors initLocalFromFresh's
    // fresh-machine guards (pin local commit identity + .gitignore) so commits
    // succeed without global git config, but wires no GitHub reference — the
    // handle never reaches a remote URL until connect.
    mkdirSync(dirname(localDir), { recursive: true });
    if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true });
    runGit(localDir, ["init", "--initial-branch=main"]);
    runGit(localDir, ["config", "user.name", handle]);
    runGit(localDir, ["config", "user.email", `${handle}@users.noreply.github.com`]);
    const gitignore = ["# Lyt pod cache — keep pod.yon committed.", ""].join("\n");
    writeFileSync(`${localDir}/.gitignore`, gitignore, "utf8");
  },

  async cloneExisting(handle, repoName, localDir): Promise<void> {
    mkdirSync(dirname(localDir), { recursive: true });
    const url = `https://github.com/${handle}/${repoName}.git`;
    // F7: spinner-wrapped (op=clone → "Summoning…"). git clone is the
    // longest single network op on the adopt path.
    await withSpinner(
      `${handle}/${repoName}`,
      () =>
        spawnArgvVerbatimAsync("git", ["clone", url, localDir], {
          // MF5 (V-A-11) — never hang a TTY-less `lyt init --auto` on a git
          // credential prompt for a private pod/vault repo. GIT_TERMINAL_PROMPT=0
          // makes git fail FAST with a non-zero exit (→ the adopt-path catch
          // surfaces an AI-actionable error) instead of blocking on an invisible
          // username prompt. Covers BOTH the pod clone and the @FED_VAULT clones
          // (recover-pod's default clone fn routes through cloneExisting).
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }),
      { op: "clone" },
    );
    // Same fresh-machine guard as initLocalFromFresh — pin local-repo
    // identity so subsequent commits never block on missing global git
    // config. Release review Angle A + B + C.
    runGit(localDir, ["config", "user.name", handle]);
    runGit(localDir, ["config", "user.email", `${handle}@users.noreply.github.com`]);
  },

  async commitAndOptionallyPush(localDir, message, push): Promise<void> {
    // add + commit are local + fast — keep sync (no spinner overhead).
    runGit(localDir, ["add", "."]);
    // Allow empty diff (re-running init with no changes is a no-op, not a
    // failure). `--allow-empty` keeps idempotency.
    runGit(localDir, ["commit", "--allow-empty", "-m", message]);
    if (push) {
      // F7: push is the network op (op=push → Unfurling, →Publishing→Syncing
      // on >3s). Wrapped so it never freezes silently.
      await spinGit("push", "your pod to GitHub", localDir, ["push", "-u", "origin", "main"]);
    }
  },
};
