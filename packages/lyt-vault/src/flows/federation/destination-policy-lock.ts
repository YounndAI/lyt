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

import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { GIT_COMMAND_TIMEOUT_MS } from "../../util/git-run.js";

export class DestinationPolicyLockError extends Error {
  readonly errorCode = "destination-policy-lock-unavailable";
}

export interface DestinationPolicyLockOptions {
  acquireTimeoutMs?: number;
  leaseMs?: number;
  pollMs?: number;
  /** Stable identity bound into renewable publication subject locks. */
  subject?: string;
  /** Test seam for forcing a generation change after initial renewal validation. */
  beforeRenewalClaim?: () => void;
}

export interface DestinationPolicyLockLease {
  /** Atomically extend this exact token/PID/subject lease from wall-clock now. */
  renew(): void;
}

interface LockPayload {
  schemaMajor: 1;
  pid: number;
  token: string;
  subject?: string;
  acquiredAt: string;
  expiresAt: string;
}

interface RecoveryClaimPayload {
  schemaMajor: 1;
  pid: number;
  token: string;
  acquiredAt: string;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
/**
 * A dead publication owner is quarantined for three minutes before recovery.
 * This is 50% headroom over the shared 120s Git/gh child ceiling and exceeds
 * the separate 10s gh permission-probe ceiling. Keep the invariant checked
 * below when editing.
 * SEE ALSO: util/git-run.ts GIT_COMMAND_TIMEOUT_MS — shared child ceiling.
 * SEE ALSO: util/gh-federation.ts spawnArgvVerbatim{Async}.
 */
export const PUBLICATION_LOCK_RECOVERY_QUARANTINE_MS = 180_000;
const DEFAULT_LEASE_MS = PUBLICATION_LOCK_RECOVERY_QUARANTINE_MS;
const DEFAULT_POLL_MS = 10;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

if (PUBLICATION_LOCK_RECOVERY_QUARANTINE_MS <= GIT_COMMAND_TIMEOUT_MS * 1.3) {
  throw new Error("Publication lock quarantine must exceed the Git timeout by at least 30%.");
}

/**
 * Serialise one complete destination-policy mutation. A timed-out live holder
 * is never stolen. Recovery removes a lock only when its recorded process is
 * provably dead AND its bounded-child quarantine has elapsed, then retries
 * O_EXCL acquisition so competing recoverers still cannot both enter.
 */
export function withDestinationPolicyLock<T>(
  lockPath: string,
  action: (lease: DestinationPolicyLockLease) => T,
  options: DestinationPolicyLockOptions = {},
): T {
  const acquireTimeoutMs = boundedNonNegative(
    options.acquireTimeoutMs,
    DEFAULT_ACQUIRE_TIMEOUT_MS,
    "acquireTimeoutMs",
  );
  const leaseMs = boundedPositive(options.leaseMs, DEFAULT_LEASE_MS, "leaseMs");
  const pollMs = boundedPositive(options.pollMs, DEFAULT_POLL_MS, "pollMs");
  const token = randomUUID();
  const deadline = Date.now() + acquireTimeoutMs;

  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    const acquiredAtMs = Date.now();
    const payload: LockPayload = {
      schemaMajor: 1,
      pid: process.pid,
      token,
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      expiresAt: new Date(acquiredAtMs + leaseMs).toISOString(),
    };
    try {
      if (publishAtomicExclusive(lockPath, payload)) break;
      if (tryRecoverDeadLock(lockPath, payload, leaseMs)) break;
      if (Date.now() >= deadline) {
        throw new DestinationPolicyLockError(
          `Destination-policy ledger is locked by a live or unverifiable owner at ${lockPath}.`,
        );
      }
      Atomics.wait(sleeper, 0, 0, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    } catch (error) {
      throw error;
    }
  }

  try {
    const lease: DestinationPolicyLockLease = {
      renew: () =>
        renewOwnedLockLease(lockPath, token, options.subject, leaseMs, options.beforeRenewalClaim),
    };
    const result = action(lease);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => releaseOwnedLock(lockPath, token)) as T;
    }
    releaseOwnedLock(lockPath, token);
    return result;
  } catch (error) {
    releaseOwnedLock(lockPath, token);
    throw error;
  }
}

/**
 * Replace one owned lease payload atomically. The pre-publication identity
 * check binds renewal to the current token, PID, and publication subject; a
 * changed or malformed canonical lock fails closed instead of extending it.
 */
function renewOwnedLockLease(
  lockPath: string,
  token: string,
  subject: string | undefined,
  leaseMs: number,
  beforeRenewalClaim: (() => void) | undefined,
): void {
  const initiallyObserved = readValidLockPayload(lockPath);
  if (
    initiallyObserved === null ||
    initiallyObserved.pid !== process.pid ||
    initiallyObserved.token !== token ||
    initiallyObserved.subject !== subject
  ) {
    throw new DestinationPolicyLockError(
      `Destination-policy lock changed before lease renewal at ${lockPath}.`,
    );
  }
  beforeRenewalClaim?.();

  // Renewal and stale recovery are both canonical-lock replacements. Serialize
  // them through the same tokenized claim, then re-read ownership only after
  // the claim is ours. This closes the validation/rename race: a recovery that
  // installs a new generation before this claim is acquired is observed and
  // preserved instead of being overwritten by the old owner's renewal.
  const replacementPath = `${lockPath}.recovery`;
  const claim = acquireRecoveryClaim(replacementPath, leaseMs);
  if (claim === null) {
    throw new DestinationPolicyLockError(
      `Destination-policy lock replacement is already claimed at ${lockPath}.`,
    );
  }
  try {
    if (!recoveryClaimIsOwned(replacementPath, claim)) {
      throw new DestinationPolicyLockError(
        `Destination-policy lock replacement claim changed at ${lockPath}.`,
      );
    }
    const current = readValidLockPayload(lockPath);
    if (
      current === null ||
      current.pid !== process.pid ||
      current.token !== token ||
      current.subject !== subject
    ) {
      throw new DestinationPolicyLockError(
        `Destination-policy lock changed before lease renewal at ${lockPath}.`,
      );
    }
    const renewed: LockPayload = {
      schemaMajor: 1,
      pid: current.pid,
      token: current.token,
      ...(current.subject === undefined ? {} : { subject: current.subject }),
      acquiredAt: current.acquiredAt,
      expiresAt: new Date(Date.now() + leaseMs).toISOString(),
    };
    publishAtomicReplacement(lockPath, renewed);
    const published = readValidLockPayload(lockPath);
    if (
      published === null ||
      published.pid !== process.pid ||
      published.token !== token ||
      published.subject !== subject ||
      published.acquiredAt !== renewed.acquiredAt ||
      published.expiresAt !== renewed.expiresAt
    ) {
      throw new DestinationPolicyLockError(
        `Destination-policy lock renewal could not be verified at ${lockPath}.`,
      );
    }
  } finally {
    releaseRecoveryClaim(replacementPath, claim);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function tryRecoverDeadLock(
  lockPath: string,
  replacement: LockPayload,
  malformedQuarantineMs: number,
): boolean {
  const recoveryPath = `${lockPath}.recovery`;
  const claim = acquireRecoveryClaim(recoveryPath, malformedQuarantineMs);
  if (claim === null) return false;

  try {
    if (!recoveryClaimIsOwned(recoveryPath, claim)) return false;
    const observed = readValidLockPayload(lockPath);
    if (observed !== null && !publicationLockRecoveryEligible(observed.pid, observed.expiresAt)) {
      return false;
    }
    if (observed === null && !malformedArtifactRecoveryEligible(lockPath, malformedQuarantineMs)) {
      return false;
    }

    // The recovery claim serializes every stale-lock displacer. Re-read the
    // identity immediately before the atomic rename so a changed token/PID is
    // never displaced based on an earlier observation. Malformed canonical
    // artifacts have no usable identity, so they are eligible only after the
    // full bounded quarantine and are preserved under a quarantine name.
    const current = readValidLockPayload(lockPath);
    if (observed === null) {
      if (current !== null || !malformedArtifactRecoveryEligible(lockPath, malformedQuarantineMs)) {
        return false;
      }
    } else {
      if (
        current === null ||
        current.pid !== observed.pid ||
        current.token !== observed.token ||
        !publicationLockRecoveryEligible(current.pid, current.expiresAt)
      ) {
        return false;
      }
    }
    if (!recoveryClaimIsOwned(recoveryPath, claim)) return false;
    const quarantinePath = `${lockPath}.${randomUUID()}.stale`;
    try {
      renameSync(lockPath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const moved = readValidLockPayload(quarantinePath);
    const movedIdentityMatches =
      observed === null
        ? moved === null
        : moved !== null && moved.pid === observed.pid && moved.token === observed.token;
    if (!movedIdentityMatches) return false;
    const acquired = publishAtomicExclusive(lockPath, replacement);
    if (observed !== null) {
      try {
        unlinkSync(quarantinePath);
      } catch {
        // It is already quarantined and can no longer grant lock authority.
      }
    }
    return acquired;
  } finally {
    releaseRecoveryClaim(recoveryPath, claim);
  }
}

function acquireRecoveryClaim(
  path: string,
  malformedQuarantineMs: number,
): RecoveryClaimPayload | null {
  const claim: RecoveryClaimPayload = {
    schemaMajor: 1,
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (publishAtomicExclusive(path, claim)) return claim;

    const observed = readValidRecoveryClaim(path);
    if (observed !== null && !processIsProvablyDead(observed.pid)) return null;
    if (observed === null && !malformedArtifactRecoveryEligible(path, malformedQuarantineMs)) {
      return null;
    }
    const quarantinePath = `${path}.${randomUUID()}.stale`;
    try {
      // Atomic rename removes one path generation. A concurrently displaced
      // live claimant revalidates its token before touching the canonical lock
      // and therefore aborts safely.
      renameSync(path, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const moved = readValidRecoveryClaim(quarantinePath);
      if (
        observed !== null &&
        (moved === null ||
          moved.pid !== observed.pid ||
          moved.token !== observed.token ||
          !processIsProvablyDead(moved.pid))
      ) {
        return null;
      }
    } finally {
      if (observed !== null) {
        try {
          unlinkSync(quarantinePath);
        } catch {
          // The quarantined path never grants recovery authority.
        }
      }
    }
  }
  return null;
}

/**
 * Publish a fully-written payload into the canonical path with one exclusive,
 * atomic hard-link operation. A crash before the link leaves only an inert
 * pending artifact; a crash after it leaves a complete canonical identity.
 */
function publishAtomicExclusive(
  path: string,
  payload: LockPayload | RecoveryClaimPayload,
): boolean {
  const pendingPath = `${path}.pending.${process.pid}.${randomUUID()}`;
  writeFileSync(pendingPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
  try {
    linkSync(pendingPath, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(pendingPath);
    } catch {
      // A pending artifact is never an authority-bearing canonical lock.
    }
  }
}

/** Publish a complete new generation over an already-owned canonical lock. */
function publishAtomicReplacement(path: string, payload: LockPayload): void {
  const pendingPath = `${path}.renew.${process.pid}.${randomUUID()}`;
  writeFileSync(pendingPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
  try {
    renameSync(pendingPath, path);
  } catch (error) {
    throw new DestinationPolicyLockError(
      `Destination-policy lock lease renewal failed at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    try {
      unlinkSync(pendingPath);
    } catch {
      // A pending renewal artifact never grants lock authority.
    }
  }
}

function malformedArtifactRecoveryEligible(path: string, quarantineMs: number): boolean {
  try {
    return Date.now() >= statSync(path).mtimeMs + quarantineMs;
  } catch {
    return false;
  }
}

function readValidLockPayload(lockPath: string): LockPayload | null {
  let payload: LockPayload;
  try {
    payload = JSON.parse(readFileSync(lockPath, "utf8")) as LockPayload;
  } catch {
    return null;
  }
  if (!isValidLockPayload(payload)) return null;
  return payload;
}

function isValidLockPayload(payload: LockPayload): boolean {
  return (
    payload.schemaMajor === 1 &&
    Number.isSafeInteger(payload.pid) &&
    payload.pid > 0 &&
    typeof payload.token === "string" &&
    payload.token.length > 0 &&
    (payload.subject === undefined ||
      (typeof payload.subject === "string" && payload.subject.length > 0)) &&
    Number.isFinite(Date.parse(payload.acquiredAt)) &&
    Number.isFinite(Date.parse(payload.expiresAt))
  );
}

function processIsProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Exact fail-closed recovery predicate shared by the filesystem recovery path and regression. */
export function publicationLockRecoveryEligible(
  pid: number,
  expiresAt: string,
  nowMs: number = Date.now(),
): boolean {
  return processIsProvablyDead(pid) && nowMs >= Date.parse(expiresAt);
}

function readValidRecoveryClaim(path: string): RecoveryClaimPayload | null {
  let payload: RecoveryClaimPayload;
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as RecoveryClaimPayload;
  } catch {
    return null;
  }
  if (
    payload.schemaMajor !== 1 ||
    !Number.isSafeInteger(payload.pid) ||
    payload.pid <= 0 ||
    typeof payload.token !== "string" ||
    payload.token.length === 0 ||
    !Number.isFinite(Date.parse(payload.acquiredAt))
  ) {
    return null;
  }
  return payload;
}

function recoveryClaimIsOwned(path: string, claim: RecoveryClaimPayload): boolean {
  const current = readValidRecoveryClaim(path);
  return current?.pid === claim.pid && current.token === claim.token;
}

function releaseRecoveryClaim(path: string, claim: RecoveryClaimPayload): void {
  try {
    if (!recoveryClaimIsOwned(path, claim)) return;
    unlinkSync(path);
  } catch {
    // Fail closed: never unlink a recovery claim whose identity changed.
  }
}

function releaseOwnedLock(lockPath: string, token: string): void {
  try {
    const payload = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockPayload>;
    if (payload.pid !== process.pid || payload.token !== token) return;
    unlinkSync(lockPath);
  } catch {
    // Fail closed: never unlink a lock whose ownership cannot be proved.
  }
}

function boundedNonNegative(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new DestinationPolicyLockError(`${name} must be a non-negative integer.`);
  }
  return resolved;
}

function boundedPositive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new DestinationPolicyLockError(`${name} must be a positive integer.`);
  }
  return resolved;
}
