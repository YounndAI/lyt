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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readPackageVersion } from "./agent-manual.js";

/** The globally-installed package users run. */
export const CURRENCY_PACKAGE = "@younndai/lyt";
/** Compatibility default for callers that explicitly opt into a channel. */
export const CURRENCY_DIST_TAG = "alpha";
export const UPDATE_CHANNELS = ["alpha", "latest"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
/** Passive-surface cache TTL — a fresh network probe at most once per day. */
export const CURRENCY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Registry probe timeout — bounded so a hung npm invocation cannot block a command. */
const CURRENCY_PROBE_TIMEOUT_MS = 4000;
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";
const CACHE_SCHEMA_VERSION = 1;
const CHANNEL_SCHEMA_VERSION = 1;

/** Runs a binary, returns stdout, or `null` on ANY failure (never throws). */
export type CommandRunner = (command: string, args: string[]) => string | null;

function npmCliPath(): string | null {
  const candidates = [
    process.env.npm_execpath,
    process.env.NPM_EXECPATH,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  return found === undefined ? null : resolve(found);
}

const defaultRunner: CommandRunner = (_command, args) => {
  const npmCli = npmCliPath();
  if (npmCli === null) return null;
  try {
    return execFileSync(process.execPath, [npmCli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CURRENCY_PROBE_TIMEOUT_MS,
      // Execute Node and a resolved npm-cli.js directly. Do not invoke a Windows
      // npm.cmd shim through a shell; that is both less deterministic and emits
      // Node's shell-argument deprecation warning.
      shell: false,
    });
  } catch {
    return null;
  }
};

export interface CurrencyResult {
  /** Stable machine-readable result discriminator. */
  status: "ok" | "offline" | "channel-unconfigured";
  /** The locally installed Lyt version. Callers that own the meta CLI must pass it. */
  installed: string;
  /** The selected release channel, or null when no explicit selection exists. */
  channel: UpdateChannel | null;
  /** Where the channel selection came from. */
  channelSource: "explicit" | "persisted" | "unconfigured";
  /** Normalized npm registry URL used for this observation. */
  registry: string;
  /** Package whose dist-tag was observed. */
  packageName: string;
  /** The observed dist-tag (equal to channel for a valid observation). */
  observedTag: UpdateChannel | null;
  /** The published version on the tracked dist-tag, or null when unavailable. */
  latest: string | null;
  /** The registry-provided SRI integrity for `latest`, never inferred. */
  integrity: string | null;
  /** True iff latest is known AND strictly newer than installed. */
  stale: boolean;
  /** True iff the selected channel is known but its target is lower than installed. */
  aheadOfChannel: boolean;
  /** True iff no published version could be determined (offline / registry down). */
  offline: boolean;
  /** True iff update checking was refused because a channel is not selected. */
  channelUnconfigured: boolean;
  /** Whether latest came from the on-disk cache rather than a fresh probe. */
  fromCache: boolean;
  /** ISO timestamp of when latest was determined. */
  checkedAt: string;
  /** One deterministic corrective action for a channel-unconfigured result. */
  nextAction?: string;
}

export interface CurrencyOptions {
  /** Bypass the cache and force a fresh registry probe (used by outdated/update). */
  force?: boolean;
  /** Override the installed version (the meta CLI MUST pass its own version). */
  installedVersion?: string;
  /** Override the registry probe (tests). */
  runner?: CommandRunner;
  /** Explicit alpha/latest selection. Does not persist by itself. */
  channel?: UpdateChannel;
  /** Override the registry URL (tests and controlled callers). */
  registryUrl?: string;
  /** Override the package target (tests). */
  packageName?: string;
  /** Override the passive-surface cache TTL. */
  ttlMs?: number;
  /** Override the clock (tests). */
  now?: () => number;
  /** Override the pod home (tests) — where selection and cache live. */
  homeDir?: string;
  /** Never probe the registry — surface only a FRESH cached result, else offline. */
  cacheOnly?: boolean;
}

export interface UpdateChannelPreference {
  schemaVersion: 1;
  channel: UpdateChannel;
}

interface CurrencyObservation {
  registry: string;
  packageName: string;
  channel: UpdateChannel;
  observedTag: UpdateChannel;
  version: string;
  integrity: string;
  checkedAt: string;
}

export interface CurrencyStateInspectionV1 {
  readonly channel: UpdateChannel | null;
  readonly channelStatus: "current" | "missing" | "malformed";
  readonly cacheStatus: "current" | "missing" | "malformed" | "tampered" | "stale";
  readonly observation: Readonly<CurrencyObservation> | null;
}

interface CurrencyCacheV1 {
  schemaVersion: 1;
  observations: Record<string, CurrencyObservation>;
}

/** Mirrors the postinstall/federation-root convention for the pod home. */
function podHome(opts: CurrencyOptions): string {
  return opts.homeDir ?? process.env.LYT_HOME ?? join(homedir(), "lyt");
}

function cachePath(opts: CurrencyOptions): string {
  return join(podHome(opts), ".currency-checks.json");
}

function channelPath(opts: Pick<CurrencyOptions, "homeDir">): string {
  return join(podHome(opts), ".update-channel.json");
}

export function isUpdateChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly string[]).includes(value);
}

export function normalizeRegistryUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_REGISTRY_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return DEFAULT_REGISTRY_URL;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return DEFAULT_REGISTRY_URL;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/`;
  return parsed.toString();
}

function cacheKey(registry: string, packageName: string, channel: UpdateChannel): string {
  return JSON.stringify([registry, packageName, channel]);
}

function validIntegrity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+(?:\s+sha(?:1|256|384|512)-[A-Za-z0-9+/=]+)*$/u.test(
      value,
    )
  );
}

function readChannelPreference(
  opts: Pick<CurrencyOptions, "homeDir">,
): UpdateChannelPreference | null {
  try {
    const parsed = JSON.parse(
      readFileSync(channelPath(opts), "utf8"),
    ) as Partial<UpdateChannelPreference>;
    if (parsed.schemaVersion !== CHANNEL_SCHEMA_VERSION || typeof parsed.channel !== "string")
      return null;
    if (!isUpdateChannel(parsed.channel)) return null;
    return { schemaVersion: CHANNEL_SCHEMA_VERSION, channel: parsed.channel };
  } catch {
    return null;
  }
}

export function readUpdateChannel(
  opts: Pick<CurrencyOptions, "homeDir"> = {},
): UpdateChannel | null {
  return readChannelPreference(opts)?.channel ?? null;
}

export function writeUpdateChannel(
  channel: UpdateChannel,
  opts: Pick<CurrencyOptions, "homeDir"> = {},
): void {
  const path = channelPath(opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: CHANNEL_SCHEMA_VERSION, channel }, null, 2),
    "utf8",
  );
}

function isObservation(value: unknown): value is CurrencyObservation {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<CurrencyObservation>;
  return (
    typeof item.registry === "string" &&
    typeof item.packageName === "string" &&
    typeof item.channel === "string" &&
    isUpdateChannel(item.channel) &&
    typeof item.observedTag === "string" &&
    isUpdateChannel(item.observedTag) &&
    typeof item.version === "string" &&
    looksLikeVersion(item.version) &&
    validIntegrity(item.integrity) &&
    typeof item.checkedAt === "string" &&
    Number.isFinite(Date.parse(item.checkedAt))
  );
}

function readCache(opts: CurrencyOptions): CurrencyCacheV1 | null {
  try {
    const raw = readFileSync(cachePath(opts), "utf8");
    const parsed = JSON.parse(raw) as Partial<CurrencyCacheV1>;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      typeof parsed.observations !== "object" ||
      parsed.observations === null
    ) {
      return null;
    }
    const observations: Record<string, CurrencyObservation> = {};
    for (const [key, observation] of Object.entries(parsed.observations)) {
      if (!isObservation(observation)) continue;
      if (cacheKey(observation.registry, observation.packageName, observation.channel) !== key)
        continue;
      if (observation.observedTag !== observation.channel) continue;
      observations[key] = observation;
    }
    return { schemaVersion: CACHE_SCHEMA_VERSION, observations };
  } catch {
    return null;
  }
}

/** Strict, local-only inspection for doctor. Never probes npm and never rewrites cache state. */
export function inspectCurrencyStateV1(opts: CurrencyOptions = {}): CurrencyStateInspectionV1 {
  let channel: UpdateChannel | null = null;
  let channelStatus: CurrencyStateInspectionV1["channelStatus"] = "missing";
  const preferencePath = channelPath(opts);
  if (existsSync(preferencePath)) {
    try {
      const parsed = JSON.parse(
        readFileSync(preferencePath, "utf8"),
      ) as Partial<UpdateChannelPreference>;
      if (
        parsed.schemaVersion === CHANNEL_SCHEMA_VERSION &&
        typeof parsed.channel === "string" &&
        isUpdateChannel(parsed.channel)
      ) {
        channel = parsed.channel;
        channelStatus = "current";
      } else channelStatus = "malformed";
    } catch {
      channelStatus = "malformed";
    }
  }
  const path = cachePath(opts);
  if (!existsSync(path))
    return Object.freeze({ channel, channelStatus, cacheStatus: "missing", observation: null });
  let parsed: Partial<CurrencyCacheV1>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CurrencyCacheV1>;
  } catch {
    return Object.freeze({ channel, channelStatus, cacheStatus: "malformed", observation: null });
  }
  if (
    parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
    typeof parsed.observations !== "object" ||
    parsed.observations === null ||
    Array.isArray(parsed.observations)
  ) {
    return Object.freeze({ channel, channelStatus, cacheStatus: "malformed", observation: null });
  }
  if (channel === null)
    return Object.freeze({ channel, channelStatus, cacheStatus: "current", observation: null });
  const registry = normalizeRegistryUrl(opts.registryUrl);
  const packageName = opts.packageName ?? CURRENCY_PACKAGE;
  for (const [storedKey, stored] of Object.entries(parsed.observations)) {
    if (!isObservation(stored)) {
      return Object.freeze({ channel, channelStatus, cacheStatus: "malformed", observation: null });
    }
    if (
      storedKey !== cacheKey(stored.registry, stored.packageName, stored.channel) ||
      stored.observedTag !== stored.channel
    ) {
      return Object.freeze({ channel, channelStatus, cacheStatus: "tampered", observation: null });
    }
  }
  const key = cacheKey(registry, packageName, channel);
  const candidate = parsed.observations[key];
  if (candidate === undefined) {
    const misplaced = Object.entries(parsed.observations).some(([storedKey, value]) => {
      if (!isObservation(value)) return false;
      return (
        value.registry === registry &&
        value.packageName === packageName &&
        value.channel === channel &&
        storedKey !== cacheKey(value.registry, value.packageName, value.channel)
      );
    });
    if (misplaced)
      return Object.freeze({ channel, channelStatus, cacheStatus: "tampered", observation: null });
    return Object.freeze({ channel, channelStatus, cacheStatus: "missing", observation: null });
  }
  if (!isObservation(candidate))
    return Object.freeze({ channel, channelStatus, cacheStatus: "malformed", observation: null });
  if (
    candidate.registry !== registry ||
    candidate.packageName !== packageName ||
    candidate.channel !== channel ||
    candidate.observedTag !== channel ||
    cacheKey(candidate.registry, candidate.packageName, candidate.channel) !== key
  ) {
    return Object.freeze({ channel, channelStatus, cacheStatus: "tampered", observation: null });
  }
  const age = (opts.now ?? Date.now)() - Date.parse(candidate.checkedAt);
  const stale = age < 0 || age > (opts.ttlMs ?? CURRENCY_CACHE_TTL_MS);
  return Object.freeze({
    channel,
    channelStatus,
    cacheStatus: stale ? "stale" : "current",
    observation: Object.freeze({ ...candidate }),
  });
}

function writeCache(opts: CurrencyOptions, cache: CurrencyCacheV1): void {
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
  const candPre = hasPrerelease(candidate);
  const basePre = hasPrerelease(base);
  if (candPre !== basePre) return basePre;
  return false;
}

function parseProbe(
  raw: string,
  registry: string,
  packageName: string,
  channel: UpdateChannel,
  checkedAt: string,
): CurrencyObservation | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const version = record.version;
    const integrity =
      record["dist.integrity"] ?? (record.dist as Record<string, unknown> | undefined)?.integrity;
    if (typeof version !== "string" || !looksLikeVersion(version) || !validIntegrity(integrity))
      return null;
    return { registry, packageName, channel, observedTag: channel, version, integrity, checkedAt };
  } catch {
    return null;
  }
}

function probeLatest(
  runner: CommandRunner,
  registry: string,
  packageName: string,
  channel: UpdateChannel,
  checkedAt: string,
): CurrencyObservation | null {
  const out = runner("npm", [
    "view",
    `${packageName}@${channel}`,
    "version",
    "dist.integrity",
    "--json",
    "--registry",
    registry,
  ]);
  return out === null ? null : parseProbe(out, registry, packageName, channel, checkedAt);
}

function unconfiguredResult(
  installed: string,
  registry: string,
  packageName: string,
  checkedAt: string,
): CurrencyResult {
  return {
    status: "channel-unconfigured",
    installed,
    channel: null,
    channelSource: "unconfigured",
    registry,
    packageName,
    observedTag: null,
    latest: null,
    integrity: null,
    stale: false,
    aheadOfChannel: false,
    offline: false,
    channelUnconfigured: true,
    fromCache: false,
    checkedAt,
    nextAction: "lyt update --channel alpha",
  };
}

function resultFromObservation(
  installed: string,
  observation: CurrencyObservation,
  source: CurrencyResult["channelSource"],
  fromCache: boolean,
): CurrencyResult {
  return {
    status: "ok",
    installed,
    channel: observation.channel,
    channelSource: source,
    registry: observation.registry,
    packageName: observation.packageName,
    observedTag: observation.observedTag,
    latest: observation.version,
    integrity: observation.integrity,
    stale: isNewerVersion(observation.version, installed),
    aheadOfChannel: isNewerVersion(installed, observation.version),
    offline: false,
    channelUnconfigured: false,
    fromCache,
    checkedAt: observation.checkedAt,
  };
}

function offlineResult(
  installed: string,
  channel: UpdateChannel,
  channelSource: CurrencyResult["channelSource"],
  registry: string,
  packageName: string,
  checkedAt: string,
): CurrencyResult {
  return {
    status: "offline",
    installed,
    channel,
    channelSource,
    registry,
    packageName,
    observedTag: null,
    latest: null,
    integrity: null,
    stale: false,
    aheadOfChannel: false,
    offline: true,
    channelUnconfigured: false,
    fromCache: false,
    checkedAt,
  };
}

/**
 * Determines whether the local install is behind a deliberately selected
 * release channel. Legacy `.currency-check.json` is intentionally never read:
 * it lacks registry/package/channel/integrity identity and is unsafe to reuse.
 */
export async function checkCurrency(opts: CurrencyOptions = {}): Promise<CurrencyResult> {
  const installed = opts.installedVersion ?? readPackageVersion();
  const registry = normalizeRegistryUrl(
    opts.registryUrl ?? process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY,
  );
  const packageName = opts.packageName ?? CURRENCY_PACKAGE;
  const persisted = readUpdateChannel(opts);
  const channel = opts.channel ?? persisted;
  const channelSource: CurrencyResult["channelSource"] =
    opts.channel !== undefined ? "explicit" : persisted !== null ? "persisted" : "unconfigured";
  const nowMs = opts.now ? opts.now() : Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  if (channel === null) return unconfiguredResult(installed, registry, packageName, checkedAt);

  const runner = opts.runner ?? defaultRunner;
  const ttl = opts.ttlMs ?? CURRENCY_CACHE_TTL_MS;
  const force = opts.force === true;
  const cache = readCache(opts);
  const key = cacheKey(registry, packageName, channel);
  const cached = cache?.observations[key] ?? null;
  const cacheFresh = cached !== null && nowMs - Date.parse(cached.checkedAt) < ttl;

  if (!force && cacheFresh && cached !== null) {
    return resultFromObservation(installed, cached, channelSource, true);
  }

  if (opts.cacheOnly === true) {
    return offlineResult(installed, channel, channelSource, registry, packageName, checkedAt);
  }

  const probed = probeLatest(runner, registry, packageName, channel, checkedAt);
  if (probed !== null) {
    const next: CurrencyCacheV1 = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      observations: { ...(cache?.observations ?? {}), [key]: probed },
    };
    writeCache(opts, next);
    return resultFromObservation(installed, probed, channelSource, false);
  }

  if (cached !== null) return resultFromObservation(installed, cached, channelSource, true);
  return offlineResult(installed, channel, channelSource, registry, packageName, checkedAt);
}

/** The exact command a user (or `lyt update`) runs to get current. */
export function updateCommandString(channel: UpdateChannel = CURRENCY_DIST_TAG): string {
  return `npm i -g ${CURRENCY_PACKAGE}@${channel}`;
}

export type UpdateAction =
  | { kind: "channel-unconfigured"; message: string; nextAction: string }
  | { kind: "offline"; message: string }
  | { kind: "ahead-of-channel"; message: string }
  | { kind: "current"; message: string }
  | { kind: "needs-confirm"; message: string }
  | { kind: "blocked-noninteractive"; message: string }
  | { kind: "proceed"; message: string };

export function resolveUpdateAction(
  result: CurrencyResult,
  opts: { yes?: boolean; interactive?: boolean; allowDowngrade?: boolean } = {},
): UpdateAction {
  if (result.channelUnconfigured) {
    return {
      kind: "channel-unconfigured",
      message: formatCurrencyLine(result),
      nextAction: result.nextAction ?? "lyt update --channel alpha",
    };
  }
  if (result.offline) return { kind: "offline", message: formatCurrencyLine(result) };
  if (result.aheadOfChannel && opts.allowDowngrade !== true) {
    return { kind: "ahead-of-channel", message: formatCurrencyLine(result) };
  }
  if (!result.stale && !result.aheadOfChannel)
    return { kind: "current", message: formatCurrencyLine(result) };
  const target = `Lyt ${result.installed} → ${result.latest}`;
  const cmd = updateCommandString(result.channel!);
  if (opts.yes === true) return { kind: "proceed", message: `Updating ${target} (\`${cmd}\`)…` };
  if (opts.interactive === true)
    return { kind: "needs-confirm", message: `Update ${target}? This runs \`${cmd}\`.` };
  return {
    kind: "blocked-noninteractive",
    message: `A different Lyt version (${result.latest}) is selected on ${result.channel}. Refusing to modify a global install non-interactively — re-run \`lyt update --yes\`, or run \`${cmd}\` yourself.`,
  };
}

/** One-line human summary shared by outdated, doctor, and init. */
export function formatCurrencyLine(result: CurrencyResult): string {
  if (result.channelUnconfigured) {
    return `Lyt ${result.installed} — update channel is unconfigured. Run \`${result.nextAction ?? "lyt update --channel alpha"}\`.`;
  }
  if (result.offline) {
    return `Lyt ${result.installed} (${result.channel}) — could not reach ${result.registry} to check for updates.`;
  }
  if (result.aheadOfChannel) {
    return `Lyt ${result.installed} is ahead of ${result.channel} (${result.latest}); refusing to downgrade implicitly. Re-run with \`lyt update --channel ${result.channel} --allow-downgrade\` if intended.`;
  }
  if (result.stale) {
    return `Lyt ${result.installed} — a newer ${result.channel} version (${result.latest}) is available. Run \`lyt update\` (or \`${updateCommandString(result.channel!)}\`).`;
  }
  return `Lyt ${result.installed} — up to date on ${result.channel}.`;
}
