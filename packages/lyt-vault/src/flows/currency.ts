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

// Stay-current core — the single source of "is this install behind the
// published version?" reused by `lyt outdated`, `lyt update`, `doctor`, and
// `init`. Design invariants (per the stay-current slice plan):
//   - THROTTLED: passive surfaces (doctor/init) read a ~once/day cache; they do
//     not hammer the registry on every command. `lyt outdated`/`update` force fresh.
//   - NON-BLOCKING + OFFLINE-SILENT: a registry probe that times out or fails
//     NEVER throws — it degrades to `offline`, so a currency check can never slow
//     or break `init`/`doctor` when the network is down.
//   - DIST-TAG `alpha`: users install `@younndai/lyt@alpha`, so currency is
//     measured against the alpha channel (equal to `latest` today; may diverge).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readPackageVersion } from "./agent-manual.js";

/** The globally-installed package users run (`npm i -g @younndai/lyt@alpha`). */
export const CURRENCY_PACKAGE = "@younndai/lyt";
/** The install channel currency is measured against. */
export const CURRENCY_DIST_TAG = "alpha";
/** Passive-surface cache TTL — a fresh network probe at most once per day. */
export const CURRENCY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Registry probe timeout — bounded so a hung `npm view` cannot block a command. */
const CURRENCY_PROBE_TIMEOUT_MS = 4000;

/** Runs a binary, returns stdout, or `null` on ANY failure (never throws). */
export type CommandRunner = (command: string, args: string[]) => string | null;

const defaultRunner: CommandRunner = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // npm/gh/git are .cmd shims on Windows — need a shell to resolve them.
      shell: process.platform === "win32",
      timeout: CURRENCY_PROBE_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
};

export interface CurrencyResult {
  /**
   * The locally installed Lyt version — read from the lyt-vault package.json,
   * which publishes in lockstep with the `@younndai/lyt` meta CLI (the package
   * `latest` is measured against), so the two are the same version by contract.
   */
  installed: string;
  /** The published version on the tracked dist-tag, or `null` when unreachable. */
  latest: string | null;
  /** True iff `latest` is known AND strictly newer than `installed`. */
  stale: boolean;
  /** True iff no published version could be determined (offline / registry down). */
  offline: boolean;
  /** Whether `latest` came from the on-disk cache rather than a fresh probe. */
  fromCache: boolean;
  /** ISO timestamp of when `latest` was determined. */
  checkedAt: string;
}

export interface CurrencyOptions {
  /** Bypass the cache and force a fresh registry probe (used by `outdated`/`update`). */
  force?: boolean;
  /** Override the installed version (tests). */
  installedVersion?: string;
  /** Override the registry probe (tests). */
  runner?: CommandRunner;
  /** Override the tracked dist-tag. */
  distTag?: string;
  /** Override the passive-surface cache TTL. */
  ttlMs?: number;
  /** Override the clock (tests). */
  now?: () => number;
  /** Override the pod home (tests) — where the throttle cache lives. */
  homeDir?: string;
  /**
   * Never probe the registry — surface only a FRESH cached result, else report
   * offline. For hot paths (e.g. `init`) that must stay strictly non-blocking and
   * never make a network call. Ignored when `force` is set.
   */
  cacheOnly?: boolean;
}

interface CurrencyCache {
  checkedAt: string;
  latest: string | null;
}

/** Mirrors the postinstall/federation-root convention for the pod home. */
function podHome(opts: CurrencyOptions): string {
  return opts.homeDir ?? process.env.LYT_HOME ?? join(homedir(), "lyt");
}

function cachePath(opts: CurrencyOptions): string {
  return join(podHome(opts), ".currency-check.json");
}

function readCache(opts: CurrencyOptions): CurrencyCache | null {
  try {
    const raw = readFileSync(cachePath(opts), "utf8");
    const json = JSON.parse(raw) as Partial<CurrencyCache>;
    if (typeof json.checkedAt !== "string") return null;
    // Validate the cached `latest` the SAME way the live probe does — a tampered
    // or corrupt cache must not surface a bogus "update available" line that a
    // fresh probe would have rejected (release review: cache/probe validation parity).
    const latest = typeof json.latest === "string" && looksLikeVersion(json.latest) ? json.latest : null;
    return { checkedAt: json.checkedAt, latest };
  } catch {
    return null;
  }
}

function writeCache(opts: CurrencyOptions, cache: CurrencyCache): void {
  try {
    const path = cachePath(opts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    /* cache is best-effort — a write failure must never break a currency check. */
  }
}

/** `x.y.z` (ignoring any `-prerelease`) → `[x, y, z]`; non-numeric parts → 0. */
function parseVersion(v: string): number[] {
  const core = v.trim().split("-")[0] ?? v;
  return core.split(".").map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function looksLikeVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+/.test(v.trim());
}

function hasPrerelease(v: string): boolean {
  return v.trim().includes("-");
}

/** True iff `candidate` is strictly a newer release than `base`. */
export function isNewerVersion(candidate: string, base: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(base);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  // Equal cores: a plain release outranks a prerelease of the same core (semver
  // precedence — 0.10.0 > 0.10.0-alpha.1). Matters because the tracked channel is
  // `alpha`, so an installed prerelease must read as behind the published release.
  const candPre = hasPrerelease(candidate);
  const basePre = hasPrerelease(base);
  if (candPre !== basePre) return basePre; // candidate newer iff ONLY base is a prerelease
  return false; // same core + same prerelease-ness → not strictly newer
}

/** Probes the registry for the published version on the tracked dist-tag. */
function probeLatest(runner: CommandRunner, pkg: string, distTag: string): string | null {
  const out = runner("npm", ["view", `${pkg}@${distTag}`, "version"]);
  if (out === null) return null;
  // `npm view <pkg>@<tag> version` prints just the bare version line.
  const line = out
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .pop();
  if (line === undefined) return null;
  // Tolerate a quoted form (`'0.10.0'`) just in case.
  const cleaned = line.replace(/['"]/g, "");
  return looksLikeVersion(cleaned) ? cleaned : null;
}

/**
 * Determines whether the local install is behind the published dist-tag.
 *
 * Passive callers (doctor/init) pass no `force` → a fresh probe runs at most once
 * per TTL, otherwise the cached answer is returned with zero network cost. Explicit
 * callers (`lyt outdated`/`lyt update`) pass `force: true` for an always-fresh read.
 * NEVER throws: an unreachable registry yields `offline: true`.
 */
export async function checkCurrency(opts: CurrencyOptions = {}): Promise<CurrencyResult> {
  const installed = opts.installedVersion ?? readPackageVersion();
  const runner = opts.runner ?? defaultRunner;
  const distTag = opts.distTag ?? CURRENCY_DIST_TAG;
  const ttl = opts.ttlMs ?? CURRENCY_CACHE_TTL_MS;
  const nowMs = opts.now ? opts.now() : Date.now();
  const force = opts.force === true;

  const cache = readCache(opts);
  const cacheFresh =
    cache !== null && Number.isFinite(Date.parse(cache.checkedAt)) && nowMs - Date.parse(cache.checkedAt) < ttl;

  // Passive path: a fresh cache answers without touching the network.
  if (!force && cacheFresh && cache !== null) {
    const latest = cache.latest;
    return {
      installed,
      latest,
      stale: latest !== null && isNewerVersion(latest, installed),
      offline: latest === null,
      fromCache: true,
      checkedAt: cache.checkedAt,
    };
  }

  // Cache-only callers (e.g. `init`) never probe — a hot path stays strictly
  // non-blocking + network-free. Reaching here means no fresh cache, so stay
  // silent (offline). `force` overrides this and probes.
  if (opts.cacheOnly === true && !force) {
    return {
      installed,
      latest: null,
      stale: false,
      offline: true,
      fromCache: false,
      checkedAt: new Date(nowMs).toISOString(),
    };
  }

  // Otherwise probe the registry (forced, or cache missing/stale).
  const probed = probeLatest(runner, CURRENCY_PACKAGE, distTag);
  if (probed !== null) {
    const checkedAt = new Date(nowMs).toISOString();
    writeCache(opts, { checkedAt, latest: probed });
    return {
      installed,
      latest: probed,
      stale: isNewerVersion(probed, installed),
      offline: false,
      fromCache: false,
      checkedAt,
    };
  }

  // Probe failed. Fall back to a stale cached value if we have one (better than
  // nothing); only truly `offline` when we have no published version at all.
  if (cache !== null && cache.latest !== null) {
    return {
      installed,
      latest: cache.latest,
      stale: isNewerVersion(cache.latest, installed),
      offline: false,
      fromCache: true,
      checkedAt: cache.checkedAt,
    };
  }

  return {
    installed,
    latest: null,
    stale: false,
    offline: true,
    fromCache: false,
    checkedAt: new Date(nowMs).toISOString(),
  };
}

/** The exact command a user (or `lyt update`) runs to get current. */
export function updateCommandString(distTag: string = CURRENCY_DIST_TAG): string {
  return `npm i -g ${CURRENCY_PACKAGE}@${distTag}`;
}

/**
 * Policy for `lyt update` — kept here (tested core) because the load-bearing rule
 * is a SAFETY gate: never silently mutate a global install. `proceed` is returned
 * only with an explicit `--yes` or an interactive confirmation; a non-interactive
 * run without `--yes` is `blocked` rather than auto-installing.
 */
export type UpdateAction =
  | { kind: "offline"; message: string }
  | { kind: "current"; message: string }
  | { kind: "needs-confirm"; message: string }
  | { kind: "blocked-noninteractive"; message: string }
  | { kind: "proceed"; message: string };

export function resolveUpdateAction(
  result: CurrencyResult,
  opts: { yes?: boolean; interactive?: boolean } = {},
): UpdateAction {
  if (result.offline) return { kind: "offline", message: formatCurrencyLine(result) };
  if (!result.stale) return { kind: "current", message: formatCurrencyLine(result) };
  const target = `Lyt ${result.installed} → ${result.latest}`;
  const cmd = updateCommandString();
  if (opts.yes === true) return { kind: "proceed", message: `Updating ${target} (\`${cmd}\`)…` };
  if (opts.interactive === true)
    return { kind: "needs-confirm", message: `Update ${target}? This runs \`${cmd}\`.` };
  return {
    kind: "blocked-noninteractive",
    message: `A newer version (${result.latest}) is available. Refusing to modify a global install non-interactively — re-run \`lyt update --yes\`, or run \`${cmd}\` yourself.`,
  };
}

/** One-line human summary shared by `outdated`, `doctor`, and `init`. */
export function formatCurrencyLine(result: CurrencyResult): string {
  if (result.offline) {
    return `Lyt ${result.installed} — could not reach the npm registry to check for updates.`;
  }
  if (result.stale) {
    return `Lyt ${result.installed} — a newer version (${result.latest}) is available. Run \`lyt update\` (or \`${updateCommandString()}\`).`;
  }
  return `Lyt ${result.installed} — up to date.`;
}
