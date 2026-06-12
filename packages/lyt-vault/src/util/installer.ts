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

import { spawnSync } from "node:child_process";

// v1.G.4 — cross-platform installer helpers for the setup wizard.
//
// detectTool(): probes whether a binary is on PATH by invoking `<tool>
// --version` via spawnSync with argv-array shape (PG-8: NO exec/execSync,
// NO shell interpretation by default — `shell: process.platform === "win32"`
// is required ONLY because Windows .cmd shims (winget, gh, npm) cannot be
// spawned without a shell hop; the argv stays array-shaped so handler input
// never reaches a shell parser).
//
// installTool(): dispatches `<install-cmd>` from a hardcoded
// INSTALLER_COMMAND_TABLE. Per brief PG-8 item 3, the table NEVER concats
// handler input into installer commands — every argv is a string literal
// from this module. Linux distro detection (apt vs dnf) probes for the
// package manager binary before dispatch; falls back to a manual-URL
// message if neither is present.

export type Platform = "win32" | "darwin" | "linux";
export type Tool = "node" | "gh";

export interface DetectToolResult {
  present: boolean;
  version?: string;
}

export interface InstallToolResult {
  ok: boolean;
  message: string;
  manualUrl?: string;
}

// Hardcoded per-platform installer dispatch table. Per brief PG-8:
// installer arguments are STRING LITERALS, never built from handler input.
// Linux entry intentionally NULL — Linux dispatch probes apt-then-dnf at
// installTool() time (different distros ship different package managers).
const INSTALLER_COMMAND_TABLE: Record<
  Exclude<Platform, "linux">,
  Record<Tool, readonly string[]>
> = {
  win32: {
    node: ["winget", "install", "--id", "OpenJS.NodeJS", "-e", "--silent"],
    gh: ["winget", "install", "--id", "GitHub.cli", "-e", "--silent"],
  },
  darwin: {
    node: ["brew", "install", "node"],
    gh: ["brew", "install", "gh"],
  },
};

const LINUX_APT_COMMANDS: Record<Tool, readonly string[]> = {
  node: ["sudo", "apt-get", "install", "-y", "nodejs", "npm"],
  gh: ["sudo", "apt-get", "install", "-y", "gh"],
};

const LINUX_DNF_COMMANDS: Record<Tool, readonly string[]> = {
  node: ["sudo", "dnf", "install", "-y", "nodejs", "npm"],
  gh: ["sudo", "dnf", "install", "-y", "gh"],
};

const MANUAL_INSTALL_URLS: Record<Tool, string> = {
  node: "https://nodejs.org/en/download/",
  gh: "https://cli.github.com/",
};

function isWindows(): boolean {
  return process.platform === "win32";
}

export function currentPlatform(): Platform | "unsupported" {
  const p = process.platform;
  if (p === "win32" || p === "darwin" || p === "linux") return p;
  return "unsupported";
}

export function detectTool(tool: Tool): DetectToolResult {
  const result = spawnSync(tool, ["--version"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    shell: isWindows(),
  });
  if (result.error !== undefined || result.status !== 0) {
    return { present: false };
  }
  const raw = (result.stdout ?? "").trim();
  if (raw.length === 0) return { present: true };
  return { present: true, version: raw.split(/\r?\n/)[0] };
}

function probeBinary(name: string): boolean {
  const probe = spawnSync(name, ["--version"], {
    stdio: ["ignore", "ignore", "ignore"],
    shell: isWindows(),
  });
  return probe.error === undefined && probe.status !== null;
}

export function installTool(tool: Tool, platform: Platform): InstallToolResult {
  if (platform === "linux") {
    const cmd = probeBinary("apt-get")
      ? LINUX_APT_COMMANDS[tool]
      : probeBinary("dnf")
        ? LINUX_DNF_COMMANDS[tool]
        : null;
    if (cmd === null) {
      return {
        ok: false,
        message: `No supported Linux package manager (apt-get or dnf) found on PATH. Install ${tool} manually:`,
        manualUrl: MANUAL_INSTALL_URLS[tool],
      };
    }
    return runInstallerCommand(tool, cmd);
  }
  const cmd = INSTALLER_COMMAND_TABLE[platform][tool];
  return runInstallerCommand(tool, cmd);
}

function runInstallerCommand(tool: Tool, cmd: readonly string[]): InstallToolResult {
  const [exe, ...args] = cmd;
  if (exe === undefined) {
    return {
      ok: false,
      message: `Installer command table for ${tool} is empty (defensive — should not happen).`,
    };
  }
  const result = spawnSync(exe, args, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: isWindows(),
  });
  if (result.error !== undefined) {
    return {
      ok: false,
      message: `Failed to invoke ${exe}: ${result.error.message}`,
      manualUrl: MANUAL_INSTALL_URLS[tool],
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: `${exe} ${args.join(" ")} exited with status ${result.status}.`,
      manualUrl: MANUAL_INSTALL_URLS[tool],
    };
  }
  return {
    ok: true,
    message: `${tool} installed via ${exe}.`,
  };
}

export function getInstallerCommand(
  tool: Tool,
  platform: Exclude<Platform, "linux">,
): readonly string[] {
  return INSTALLER_COMMAND_TABLE[platform][tool];
}

export function getManualInstallUrl(tool: Tool): string {
  return MANUAL_INSTALL_URLS[tool];
}
