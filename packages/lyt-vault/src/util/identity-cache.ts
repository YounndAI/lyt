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
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

import { getLytHome } from "./paths.js";
import { assertNoReparsePointInPath } from "./write-path-guard.js";
import { escapeQuoted, unescapeQuoted } from "../yon/_helpers.js";

// W2.3 (2026-06-03) — the pod repo is the DURABLE identity SoT (the
// recovery path). `<podRepoDir>/identity.yon` carries the same @IDENTITY shape
// as the machine cache. SoT precedence is pod > local `~/lyt/machine.yon` >
// derive-from-gh (see resolvePodIdentity). Persisting identity into the pod
// repo on pod-create lets a fresh machine recover its identity by cloning the
// pod — without re-deriving from gh.
//
// Brief F (2026-06-05) — the machine cache + the pod SoT used to share BOTH the
// filename `identity.yon` AND the doc-id `lyt-machine-identity`, so neither was
// legible as "the single SoT" and the two drifted on `verified_at`. They are
// now distinct by NAME and by DOC-ID:
// - machine cache → `~/lyt/machine.yon` (@DOC id=lyt-machine)
// - pod SoT → `<pod>/identity.yon` (@DOC id=lyt-pod-identity)
// `parseIdentityYon` stays permissive (reads `@IDENTITY` regardless of doc-id)
// so old committed pod files + old caches still parse.

// Brief F — distinct @DOC ids per file (legible SoT-vs-cache).
const MACHINE_DOC_ID = "lyt-machine";
const POD_DOC_ID = "lyt-pod-identity";

export interface CachedIdentity {
  provider: string;
  handle: string;
  verifiedAtMs: number;
  source: string;
}

// The synced pod identity extends the account identity additively. `podRid`
// is the existing federation RID (not a new identity); `podAlias` is mutable
// presentation metadata. Both are optional on read for legacy identity.yon.
export interface PodIdentity extends CachedIdentity {
  podRid?: string;
  podAlias?: string;
}

export class PodIdentityMismatchError extends Error {
  readonly errorCode = "pod-identity-mismatch";
}

// (2026-06-04) — identity `source` values for the
// local-first init. A PROVISIONAL identity is minted at a no-gh `lyt init`
// (handle prompted, default OS username) and carries no GitHub verification;
// it is reconciled to the real gh handle (`source=gh-cli`) at connect
// (`lyt sync` self-heal). `local` is an accepted alias for hand-authored
// provisional caches. resolvePodIdentity precedence (pod > local > gh) is
// unchanged — provisional is simply a local-cache identity that connect
// later overwrites with the gh-verified one.
export const IDENTITY_SOURCE_PROVISIONAL = "provisional";
export const IDENTITY_SOURCE_GH = "gh-cli";

// True when the identity was minted locally (no gh verification) and should be
// reconciled to the real gh handle at connect. Drives the "not connected"
// trust surface (pod card + `lyt status`) and the `lyt sync` connect self-heal.
export function isProvisionalIdentity(id: CachedIdentity): boolean {
  return id.source === IDENTITY_SOURCE_PROVISIONAL || id.source === "local";
}

// write a PROVISIONAL identity to the local cache (no pod, no gh). The
// handle is the prompted value (default OS username via deriveProvisionalHandle
// in identity.ts); the caller validates it with isValidGhHandle before this.
export function writeProvisionalIdentity(
  handle: string,
  nowMs?: number,
  path?: string,
): CachedIdentity {
  const id: CachedIdentity = {
    provider: "github",
    handle,
    verifiedAtMs: nowMs ?? Date.now(),
    source: IDENTITY_SOURCE_PROVISIONAL,
  };
  writeIdentityCache(id, path);
  return id;
}

// Machine cache file lives at `${LYT_HOME}/machine.yon` (Brief F rename from
// `identity.yon` — legible as the machine-local CACHE, distinct from the pod
// SoT which keeps the `identity.yon` name). We use the existing `getLytHome()`
// path (which respects $LYT_HOME) so the cache is co-located with registry.db
// and vaults/, and so tests can isolate via LYT_HOME override.
// (Path difference recorded in the block-A.1 retro.)
export function getIdentityCachePath(): string {
  return join(getLytHome(), "machine.yon");
}

// Brief F — the legacy machine-cache filename (pre-rename). Used only by the
// idempotent migration below.
export function getLegacyIdentityCachePath(): string {
  return join(getLytHome(), "identity.yon");
}

// Brief F (P4) — migrate the legacy `~/lyt/identity.yon` machine cache to
// `~/lyt/machine.yon`. Idempotent + safe: only renames when the legacy file
// exists AND the new file does NOT (the cache is re-derivable, so on a collision
// the new file wins and the legacy is left untouched for the handler to inspect).
// Returns true when a rename happened. Fired on `lyt init` + `lyt doctor`.
export function migrateIdentityCache(): boolean {
  const legacy = getLegacyIdentityCachePath();
  const current = getIdentityCachePath();
  if (legacy === current) return false; // (paranoia — names differ by construction)
  if (existsSync(legacy) && !existsSync(current)) {
    mkdirSync(dirname(current), { recursive: true });
    renameSync(legacy, current);
    return true;
  }
  return false;
}

export function readIdentityCache(path?: string): CachedIdentity | null {
  const p = path ?? getIdentityCachePath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  return parseIdentityYon(raw);
}

// Brief F — the machine cache renders the `lyt-machine` doc-id.
export function writeIdentityCache(identity: CachedIdentity, path?: string): void {
  const p = path ?? getIdentityCachePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, renderMachineIdentity(identity), "utf8");
}

// W2.3 — the pod-repo identity SoT at `<podRepoDir>/identity.yon` (filename
// UNCHANGED by Brief F; only its doc-id is distinct — `lyt-pod-identity`).
export function getPodIdentityPath(podRepoDir: string): string {
  return join(podRepoDir, "identity.yon");
}

export function readPodIdentity(podRepoDir: string): PodIdentity | null {
  const path = getPodIdentityPath(podRepoDir);
  assertNoReparsePointInPath(path);
  return readIdentityCache(path);
}

// Brief F — the pod SoT renders the `lyt-pod-identity` doc-id (NOT the machine
// id). It does NOT route through writeIdentityCache (that one stamps the machine
// doc-id) — it writes the pod-flavoured render directly to the pod path.
export function writePodIdentity(identity: PodIdentity, podRepoDir: string): void {
  const p = getPodIdentityPath(podRepoDir);
  assertNoReparsePointInPath(p);
  mkdirSync(dirname(p), { recursive: true });
  assertNoReparsePointInPath(p);
  // Account-handle reconciliation must not erase synchronized pod metadata.
  const existing = existsSync(p) ? parseIdentityYon(readFileSync(p, "utf8")) : null;
  const merged: PodIdentity = {
    ...identity,
    ...(identity.podRid === undefined && existing?.podRid !== undefined
      ? { podRid: existing.podRid }
      : {}),
    ...(identity.podAlias === undefined && existing?.podAlias !== undefined
      ? { podAlias: existing.podAlias }
      : {}),
  };
  atomicWritePodIdentity(p, renderPodIdentity(merged));
}

function atomicWritePodIdentity(path: string, content: string): void {
  const tmp = `${path}.${process.pid}-${podIdentityTmpCounter()}.tmp`;
  assertNoReparsePointInPath(tmp);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
    // Both the destination and the same-directory temporary leaf are checked
    // again immediately before replacement. A linked parent/leaf is never
    // followed by the pod identity migration or alias projection paths.
    assertNoReparsePointInPath(path);
    assertNoReparsePointInPath(tmp);
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let podIdentityTmpValue = 0;
function podIdentityTmpCounter(): number {
  podIdentityTmpValue += 1;
  return podIdentityTmpValue;
}

export function sanitizePodAlias(value: string): string | null {
  const alias = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return alias.length > 0 ? alias : null;
}

export function fallbackPodAlias(podRid: string): string {
  return `pod-${podRid.slice(0, 8).toLowerCase()}`;
}

export function deriveInitialPodAlias(podRid: string, osUsername?: string): string {
  let username = osUsername;
  if (username === undefined) {
    try {
      username = userInfo().username;
    } catch {
      username = "";
    }
  }
  return sanitizePodAlias(username ?? "") ?? fallbackPodAlias(podRid);
}

export function ensurePodIdentityMetadata(
  podRepoDir: string,
  podRid: string,
  options: { freshPod: boolean; osUsername?: string } = { freshPod: false },
): PodIdentity | null {
  const identity = readPodIdentity(podRepoDir);
  if (identity === null) return null;
  if (identity.podRid !== undefined && identity.podRid !== podRid) {
    throw new PodIdentityMismatchError(
      `pod identity mismatch: identity.yon declares ${identity.podRid}, expected ${podRid}`,
    );
  }
  const podAlias =
    identity.podAlias ??
    (options.freshPod
      ? deriveInitialPodAlias(podRid, options.osUsername)
      : fallbackPodAlias(podRid));
  const next: PodIdentity = { ...identity, podRid, podAlias };
  if (identity.podRid !== podRid || identity.podAlias !== podAlias) {
    writePodIdentity(next, podRepoDir);
  }
  return next;
}

export function updatePodAlias(podRepoDir: string, alias: string): PodIdentity {
  const identity = readPodIdentity(podRepoDir);
  if (identity === null || identity.podRid === undefined) {
    throw new Error("Cannot update pod alias before pod identity metadata is initialized.");
  }
  const podAlias = sanitizePodAlias(alias);
  if (podAlias === null) throw new Error("Pod alias must contain at least one letter or number.");
  const next: PodIdentity = { ...identity, podAlias };
  writePodIdentity(next, podRepoDir);
  return next;
}

export interface ResolvePodIdentityOptions {
  // The cloned/forged pod repo dir; its identity.yon is the highest-precedence
  // source. Omit when no pod is materialised yet.
  podRepoDir?: string | undefined;
  // gh-derive fallback (returns the handle). Omit to skip the derive tier
  // (resolver returns null when pod + local both miss).
  deriveHandle?: (() => string) | undefined;
  nowMs?: number | undefined;
  // Test seam — override the local cache path.
  localCachePath?: string | undefined;
}

// W2.3 — resolve identity by precedence: pod > local > derive-from-gh.
// - Pod identity present → use it; mirror to the LOCAL cache when local is
// absent (recovery seeding) — pod effectively becomes the top of the chain.
// - Else local cache present → use it (an existing identity is RESPECTED, not
// overwritten — no fresh gh-derive clobbers it).
// - Else derive from gh (if a deriver was supplied) + persist to local.
// Returns null only when all tiers miss (no pod identity, no local cache, no
// deriver).
export function resolvePodIdentity(opts: ResolvePodIdentityOptions = {}): CachedIdentity | null {
  if (opts.podRepoDir !== undefined) {
    const pod = readPodIdentity(opts.podRepoDir);
    if (pod !== null) {
      if (readIdentityCache(opts.localCachePath) === null) {
        writeIdentityCache(pod, opts.localCachePath);
      }
      return pod;
    }
  }
  const local = readIdentityCache(opts.localCachePath);
  if (local !== null) return local;
  if (opts.deriveHandle !== undefined) {
    const derived: CachedIdentity = {
      provider: "github",
      handle: opts.deriveHandle(),
      verifiedAtMs: opts.nowMs ?? Date.now(),
      source: "gh-cli",
    };
    writeIdentityCache(derived, opts.localCachePath);
    return derived;
  }
  return null;
}

// Render @IDENTITY record per yai.lyt-domain §3, parameterised by doc-id
// (Brief F — machine cache + pod SoT carry DISTINCT @DOC ids):
// @DOC ver=2.0 | id=<docId> | domain=yai.lyt
// @IDENTITY rid=identity:local | type=user | provider=<p> | handle=<h>
// | verified_at:ts=<iso> | source=<src>
function renderIdentity(id: PodIdentity, docId: string): string {
  const verifiedIso = new Date(id.verifiedAtMs).toISOString();
  return (
    `@DOC ver=2.0 | id=${docId} | domain=yai.lyt\n` +
    `\n` +
    `@IDENTITY rid=identity:local | type=user | provider=${id.provider}` +
    ` | handle=${id.handle} | verified_at:ts=${verifiedIso}` +
    ` | source=${id.source}` +
    (docId === POD_DOC_ID && id.podRid !== undefined ? ` | pod_rid=pod:${id.podRid}` : ``) +
    (docId === POD_DOC_ID && id.podAlias !== undefined
      ? ` | pod_alias="${escapeQuoted(id.podAlias)}"`
      : ``) +
    `\n`
  );
}

// Brief F — the machine-cache render (@DOC id=lyt-machine).
export function renderMachineIdentity(id: CachedIdentity): string {
  return renderIdentity(id, MACHINE_DOC_ID);
}

// Brief F — the pod-SoT render (@DOC id=lyt-pod-identity).
export function renderPodIdentity(id: PodIdentity): string {
  return renderIdentity(id, POD_DOC_ID);
}

// Brief F — back-compat alias. Historically `renderIdentityYon` rendered the
// machine doc-id; keep the name pointing at the machine render so existing
// callers + the index.ts barrel are unbroken.
export function renderIdentityYon(id: CachedIdentity): string {
  return renderMachineIdentity(id);
}

// Brief F (P3) — reconcile the machine cache against the pod SoT (the drift
// fix). Precedence is pod > local, so:
// - both exist + handles DIFFER → pod wins; rewrite the machine cache from the
// pod (a real conflict the handler should know about → reported WARN at
// doctor; here we just make the disk agree).
// - handles EQUAL but verified_at DIFFERS → re-stamp the pod copy to the
// FRESHER verified_at so the two stop lagging (close the §7 drift at source)
// — INFO, not WARN.
// Returns a structured outcome so callers (doctor --apply) can report what they
// did. No-op (and returns kind="none") when a side is missing or already agrees.
export type ReconcileIdentityOutcome =
  | { kind: "none"; reason: string }
  | { kind: "handle-conflict"; podHandle: string; machineHandle: string }
  | { kind: "verified-at-restamped"; handle: string; fromMs: number; toMs: number };

export function reconcileIdentity(
  podRepoDir: string,
  localCachePath?: string,
): ReconcileIdentityOutcome {
  const pod = readPodIdentity(podRepoDir);
  const machine = readIdentityCache(localCachePath);
  if (pod === null || machine === null) {
    return { kind: "none", reason: pod === null ? "no pod identity" : "no machine cache" };
  }
  if (pod.handle !== machine.handle) {
    // Pod wins (precedence). Rewrite the machine cache from the pod.
    writeIdentityCache(pod, localCachePath);
    return { kind: "handle-conflict", podHandle: pod.handle, machineHandle: machine.handle };
  }
  if (pod.verifiedAtMs !== machine.verifiedAtMs) {
    // Handles agree; only verified_at drifted. Re-stamp the pod copy to the
    // FRESHER value so it stops lagging the machine cache (the §7 drift source).
    const fresher = Math.max(pod.verifiedAtMs, machine.verifiedAtMs);
    if (pod.verifiedAtMs !== fresher) {
      writePodIdentity({ ...pod, verifiedAtMs: fresher }, podRepoDir);
    }
    if (machine.verifiedAtMs !== fresher) {
      writeIdentityCache({ ...machine, verifiedAtMs: fresher }, localCachePath);
    }
    return {
      kind: "verified-at-restamped",
      handle: pod.handle,
      fromMs: Math.min(pod.verifiedAtMs, machine.verifiedAtMs),
      toMs: fresher,
    };
  }
  return { kind: "none", reason: "already consistent" };
}

// Permissive parse: pulls provider/handle/verified_at/source from the first
// @IDENTITY line. We do not invoke yon-parser here — kept dependency-free per
// plan §"Commit 2" ("trivial YON shape; no parser needed for write").
export function parseIdentityYon(raw: string): PodIdentity | null {
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("@IDENTITY "));
  if (!line) return null;
  const provider = matchField(line, "provider");
  const handle = matchField(line, "handle");
  const verifiedRaw = matchField(line, "verified_at:ts");
  const source = matchField(line, "source") ?? "gh-cli";
  if (!provider || !handle || !verifiedRaw) return null;
  const verifiedAtMs = Date.parse(verifiedRaw);
  if (Number.isNaN(verifiedAtMs)) return null;
  const podRidRaw = matchField(line, "pod_rid");
  if (podRidRaw !== null && !/^pod:[0-9a-f]{32}$/.test(podRidRaw)) return null;
  const podRid = podRidRaw === null ? undefined : podRidRaw.slice(4);
  const podAliasRaw = matchField(line, "pod_alias");
  const podAlias =
    podAliasRaw?.startsWith('"') === true && podAliasRaw.endsWith('"')
      ? unescapeQuoted(podAliasRaw.slice(1, -1))
      : undefined;
  return {
    provider,
    handle,
    verifiedAtMs,
    source,
    ...(podRid === undefined ? {} : { podRid }),
    ...(podAlias === undefined ? {} : { podAlias }),
  };
}

function matchField(line: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${escapeRe(key)}=([^|\\s][^|]*?)(?=\\s*\\||$)`);
  const m = line.match(re);
  return m && m[1] ? m[1].trim() : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
